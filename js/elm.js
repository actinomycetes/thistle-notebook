// ELM proxy API client (OpenAI-compatible, https://elm.edina.ac.uk/api/v1), called straight from the browser.
// ELM is the ONLY network destination for user data; the page's Content-Security-Policy enforces this.

export const DEFAULT_BASE = 'https://elm.edina.ac.uk/api/v1';

// Context windows from the ELM help page (Nov 2026); others are estimated in classify().
const KNOWN_CONTEXT = {
  'utter-project/EuroLLM-22B-Instruct-2512': 32768,
  'Qwen/Qwen3.5-397B-A17B-FP8': 262144,
  'mistralai/Mistral-Small-4-119B-2603': 262144,
  'meta-llama/Llama-3.3-70B-Instruct': 128000,
};

export function classify(id) {
  const low = id.toLowerCase();
  const local = id.includes('/'); // ELM's University-hosted vLLM models use "org/name" ids
  let kind = 'chat';
  if (low.includes('embed')) kind = 'embedding';
  else if (/whisper|transcribe/.test(low)) kind = 'transcription';
  else if (/tts|dall-e|gpt-image|-audio|realtime/.test(low)) kind = 'other';
  else if (/moderation|safety|guard/.test(low)) kind = 'moderation';
  else if (/^(babbage|davinci)|^gpt-3\.5-turbo-instruct/.test(low)) kind = 'other';
  let vision, reasoning, context;
  if (local) {
    vision = /qwen3\.5|mistral-small-4/.test(low);
    reasoning = /qwen3\.5|mistral-small-4/.test(low) ? ['none', 'high'] : [];
    context = KNOWN_CONTEXT[id] || 32768;
  } else {
    vision = /^(gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|gpt-6|o1|o3|o4|chatgpt)/.test(low) && !low.includes('search');
    reasoning = /^(o1|o3|o4|gpt-5|gpt-6)/.test(low) ? ['low', 'medium', 'high'] : [];
    context = low.startsWith('gpt-4.1') ? 1000000 : /^(gpt-5|gpt-6)/.test(low) ? 400000 : /^(o1|o3|o4)/.test(low) ? 200000 : 128000;
  }
  return { id, local, kind, vision, reasoning, context, webSearch: !local && kind === 'chat' };
}

export const REFUSED = 'ELM refused this request. Browsers cannot show ELM\'s reason (its error replies lack the CORS header browsers need); ' +
  'usually the model, tool or option is not available to API keys. ⚙ Settings → Test web search shows a Terminal command that reveals the reason.';
const clean = p => { const { _stripped, ...rest } = p; return rest; };

export class ELMError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

export class ELM {
  constructor({ apiKey, baseUrl = DEFAULT_BASE, serviceTier = 'auto' }) {
    this.key = apiKey; this.base = (baseUrl || DEFAULT_BASE).replace(/\/+$/, ''); this.tier = serviceTier;
    this._models = null;
  }

  async req(path, { method = 'POST', body, form, signal, raw = false } = {}) {
    if (!this.key) throw new ELMError('No ELM API key. Open ⚙ Settings and paste your key (elm-xxxxxxxx-…).', 401);
    const headers = { Authorization: `Bearer ${this.key}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let r;
    for (let attempt = 0; ; attempt++) {
      try {
        r = await fetch(this.base + path, { method, headers, signal, body: form || (body !== undefined ? JSON.stringify(body) : undefined) });
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        // ELM's error replies carry no CORS header, so the browser hides them and fetch() fails as if offline.
        // If ELM has answered this page before, it is reachable: the request was refused (status -1, reason unreadable).
        if (this.reachable) throw new ELMError(REFUSED, -1);
        throw new ELMError('Could not reach ELM. Check your connection (University network or VPN if required) and that the API key is valid.', 0);
      }
      this.reachable = true;
      if (r.status === 429 && attempt < 2) {
        const ra = Number(r.headers.get('Retry-After'));
        const wait = Math.min(30, Number.isFinite(ra) && ra >= 0 ? ra : 5);
        await new Promise((res, rej) => {
          const abortErr = () => (signal?.reason?.name === 'AbortError' ? signal.reason : new DOMException('Aborted', 'AbortError'));
          if (signal?.aborted) return rej(abortErr());
          const onAbort = () => { clearTimeout(timer); rej(abortErr()); };
          const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); res(); }, wait * 1000);
          signal?.addEventListener('abort', onAbort, { once: true });
        });
        continue;
      }
      break;
    }
    if (!r.ok) {
      let msg = `${r.status} ${r.statusText}`;
      try { const j = await r.json(); msg = j.error?.message || j.message || JSON.stringify(j).slice(0, 300); } catch { }
      const hint = { 401: ' — the API key was rejected.', 413: ' — request over ELM\'s 10 MiB limit; use fewer/smaller sources.', 429: ' — quota or rate limit reached (see Costs).' }[r.status] || '';
      throw new ELMError(msg + hint, r.status);
    }
    return raw ? r : r.json();
  }

  // ---------- models ----------
  async models(refresh = false) {
    if (this._models && !refresh) return this._models;
    const j = await this.req('/models', { method: 'GET' });
    this._models = (j.data || []).map(m => classify(m.id)).sort((a, b) => (b.local - a.local) || a.id.localeCompare(b.id));
    return this._models;
  }
  info(id) { return (this._models || []).find(m => m.id === id) || classify(id); }
  pick(kind, preferLocal = true) {
    const ms = (this._models || []).filter(m => m.kind === kind);
    return (preferLocal && ms.find(m => m.local)) || ms[0] || null;
  }

  // ---------- chat ----------
  _params(model, messages, { reasoning, maxTokens, temperature, stream } = {}) {
    const inf = this.info(model);
    const p = { model, messages, stream: !!stream };
    // OpenAI reasoning models (o-series, GPT-5/6) take max_completion_tokens instead of max_tokens
    if (maxTokens) p[!inf.local && inf.reasoning.length ? 'max_completion_tokens' : 'max_tokens'] = maxTokens;
    if (reasoning && reasoning !== 'default' && inf.reasoning.length)
      p.reasoning_effort = inf.reasoning.includes(reasoning) ? reasoning : inf.reasoning[inf.reasoning.length - 1];
    if (this.tier && this.tier !== 'auto' && !inf.local) p.service_tier = this.tier;
    if (temperature != null && !inf.reasoning.length) p.temperature = temperature;
    return p;
  }

  // If the model rejects an optional parameter, drop it and try again.
  async _withFallback(p, fn) {
    let lastErr;
    for (let i = 0; i < 5; i++) {
      try { return await fn(p); } catch (e) {
        lastErr = e;
        if (e.status === -1) { // refused, reason hidden: retry once without every optional parameter
          const opt = ['service_tier', 'reasoning_effort', 'temperature', 'max_tokens', 'max_completion_tokens'].filter(k => k in p);
          if (!opt.length || p._stripped) throw e;
          opt.forEach(k => delete p[k]); p._stripped = opt; continue;
        }
        if (e.status !== 400) throw e;
        const m = e.message.toLowerCase();
        if (p.max_tokens && /max_tokens/.test(m)) { p.max_completion_tokens = p.max_tokens; delete p.max_tokens; continue; }
        const k = ['service_tier', 'reasoning_effort', 'temperature'].find(k => k in p && (m.includes(k) || m.includes(k.split('_')[0])));
        if (!k) throw e;
        delete p[k];
      }
    }
    throw lastErr || new ELMError('Request failed after retries.', 400);
  }

  // onDelta({text|thinking|usage}); returns the full text
  async chatStream(model, messages, opts = {}, onDelta = () => { }) {
    const p = this._params(model, messages, { ...opts, stream: true });
    const r = await this._withFallback(p, p => this.req('/chat/completions', { body: clean(p), signal: opts.signal, raw: true }));
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '', full = '';
    const handleLine = raw => {
      const line = raw.trim();
      if (!line.startsWith('data:')) return;
      const d = line.slice(5).trim();
      if (d === '[DONE]') return;
      let j; try { j = JSON.parse(d); } catch { return; }
      if (j.error) throw new ELMError(j.error.message || 'Stream error', 500);
      if (j.usage) onDelta({ usage: j.usage });
      const delta = j.choices?.[0]?.delta;
      if (!delta) return;
      const th = delta.reasoning_content || delta.reasoning;
      if (th) onDelta({ thinking: th });
      if (delta.content) { full += delta.content; onDelta({ text: delta.content }); }
    };
    for (; ;) {
      const { value, done } = await reader.read();
      if (done) {
        buf += dec.decode();
        for (const line of buf.split('\n')) handleLine(line);
        break;
      }
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        handleLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    }
    return full;
  }

  async chat(model, messages, opts = {}) {
    const p = this._params(model, messages, opts);
    const j = await this._withFallback(p, p => this.req('/chat/completions', { body: clean(p), signal: opts.signal }));
    return stripThink(j.choices?.[0]?.message?.content || '');
  }

  // ---------- embeddings ----------
  async embed(texts, model, batch = 32) {
    const out = [];
    for (let i = 0; i < texts.length; i += batch) {
      const input = texts.slice(i, i + batch).map(t => (t || ' ').slice(0, 6000));
      const j = await this.req('/embeddings', { body: { model, input } });
      j.data.sort((a, b) => a.index - b.index).forEach(d => out.push(d.embedding));
    }
    return out;
  }

  // ---------- web search ----------
  // ELM's OpenAPI spec lists two routes (copied from OpenAI's schema; ELM's own help page does not mention web search):
  //  A. /responses with the web_search_preview (or web_search) tool, on an OpenAI chat model
  //  B. /chat/completions with web_search_options, on an OpenAI "*-search-preview" model
  // A route only counts as working if the reply shows a real search (a web_search_call item or URL citations):
  // a proxy that silently drops the tool would otherwise give an answer from memory that looks like search results.
  webSearchRoutes(model) {
    const routes = [
      { name: 'Responses API + web_search_preview tool', model, tool: { type: 'web_search_preview', search_context_size: 'medium' } },
      { name: 'Responses API + web_search tool', model, tool: { type: 'web_search' } },
    ];
    (this._models || []).filter(m => !m.local && /search/.test(m.id)).forEach(m => routes.push({ name: 'Chat completions + web_search_options', model: m.id, chat: true }));
    return routes;
  }

  async _searchRoute(r, query) {
    const instructions = 'You are a research assistant. Search the web and report the most relevant, reliable, up-to-date ' +
      'findings for the query. Prefer peer-reviewed papers, preprints and official sources. Be concise and factual; cite every claim.';
    let text = '', cites = [], searched = false;
    const add = a => { if (a?.type === 'url_citation') { const u = a.url || a.url_citation?.url; if (u) cites.push({ title: a.title || a.url_citation?.title || u, url: u.replace(/[?&]utm_source=openai$/, '') }); } };
    if (r.chat) {
      const j = await this.req('/chat/completions', { body: { model: r.model, web_search_options: { search_context_size: 'medium' }, messages: [{ role: 'system', content: instructions }, { role: 'user', content: query }] } });
      const msg = j.choices?.[0]?.message || {};
      text = msg.content || ''; (msg.annotations || []).forEach(add);
      searched = cites.length > 0;
    } else {
      const j = await this.req('/responses', { body: { model: r.model, instructions, input: query, tools: [r.tool] } });
      for (const item of j.output || []) {
        if (/web_search/.test(item.type || '')) searched = true;
        if (item.type === 'message') for (const c of item.content || []) { if (c.text) text += c.text; (c.annotations || []).forEach(add); }
      }
      text ||= j.output_text || '';
      searched ||= cites.length > 0;
    }
    const seen = new Set();
    cites = cites.filter(c => !seen.has(c.url) && seen.add(c.url));
    return { text, citations: cites, model: r.model, route: r.name, searched };
  }

  // Tries each route; returns the first real search. Throws an error whose .attempts lists every route's outcome.
  async webSearch(model, query) {
    const attempts = [];
    for (const r of this.webSearchRoutes(model)) {
      try {
        const res = await this._searchRoute(r, query);
        if (res.searched) return { ...res, attempts };
        attempts.push({ route: r.name, model: r.model, ok: false, error: 'ELM answered, but no web search took place (the search tool appears to be ignored).' });
      } catch (e) {
        attempts.push({ route: r.name, model: r.model, ok: false, status: e.status, error: e.message });
        if (e.status === 401 || e.status === 429 || e.status === 0) break; // key, quota or offline: other routes will fail too
      }
    }
    const err = new ELMError('Web search is not available through ELM with this key: ' + attempts.map(a => `${a.route} (${a.model}): ${a.error}`).join(' | '), attempts.at(-1)?.status || 0);
    err.attempts = attempts;
    throw err;
  }

  // ---------- audio ----------
  async transcribe(file, model = 'whisper-1') {
    const form = new FormData(); form.append('file', file); form.append('model', model);
    const j = await this.req('/audio/transcriptions', { form });
    return j.text || '';
  }

  async costs() { return this.req('/costs', { method: 'GET' }); }
}

export const stripThink = t => (t || '').replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
