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
        throw new ELMError('Could not reach ELM. Check your connection (University network or VPN if required) and that the API key is valid.', 0);
      }
      if (r.status === 429 && attempt < 2) {
        const wait = Math.min(30, +(r.headers.get('Retry-After') || 5));
        await new Promise(res => setTimeout(res, wait * 1000)); continue;
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
    if (maxTokens) p.max_tokens = maxTokens;
    if (reasoning && reasoning !== 'default' && inf.reasoning.length)
      p.reasoning_effort = inf.reasoning.includes(reasoning) ? reasoning : inf.reasoning[inf.reasoning.length - 1];
    if (this.tier && this.tier !== 'auto' && !inf.local) p.service_tier = this.tier;
    if (temperature != null && !inf.reasoning.length) p.temperature = temperature;
    return p;
  }

  // If the model rejects an optional parameter, drop it and try again.
  async _withFallback(p, fn) {
    for (let i = 0; i < 5; i++) {
      try { return await fn(p); } catch (e) {
        if (e.status !== 400) throw e;
        const m = e.message.toLowerCase();
        if (p.max_tokens && /max_tokens/.test(m)) { p.max_completion_tokens = p.max_tokens; delete p.max_tokens; continue; }
        const k = ['service_tier', 'reasoning_effort', 'temperature'].find(k => k in p && (m.includes(k) || m.includes(k.split('_')[0])));
        if (!k) throw e;
        delete p[k];
      }
    }
  }

  // onDelta({text|thinking|usage}); returns the full text
  async chatStream(model, messages, opts = {}, onDelta = () => { }) {
    const p = this._params(model, messages, { ...opts, stream: true });
    const r = await this._withFallback(p, p => this.req('/chat/completions', { body: p, signal: opts.signal, raw: true }));
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '', full = '';
    for (; ;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const d = line.slice(5).trim();
        if (d === '[DONE]') continue;
        let j; try { j = JSON.parse(d); } catch { continue; }
        if (j.error) throw new ELMError(j.error.message || 'Stream error', 500);
        if (j.usage) onDelta({ usage: j.usage });
        const delta = j.choices?.[0]?.delta;
        if (!delta) continue;
        const th = delta.reasoning_content || delta.reasoning;
        if (th) onDelta({ thinking: th });
        if (delta.content) { full += delta.content; onDelta({ text: delta.content }); }
      }
    }
    return full;
  }

  async chat(model, messages, opts = {}) {
    const p = this._params(model, messages, opts);
    const j = await this._withFallback(p, p => this.req('/chat/completions', { body: p, signal: opts.signal }));
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

  // ---------- web search (OpenAI-hosted model + Responses API web search tool) ----------
  async webSearch(model, query, size = 'medium') {
    const instructions = 'You are a research assistant. Search the web and report the most relevant, reliable, up-to-date ' +
      'findings for the query. Prefer peer-reviewed papers, preprints and official sources. Be concise and factual; cite every claim.';
    let last;
    for (const tool of [{ type: 'web_search_preview', search_context_size: size }, { type: 'web_search' }]) {
      try {
        const j = await this.req('/responses', { body: { model, instructions, input: query, tools: [tool] } });
        let text = '', cites = [];
        for (const item of j.output || []) if (item.type === 'message') for (const c of item.content || []) {
          if (c.text) text += c.text;
          for (const a of c.annotations || []) if (a.type === 'url_citation' && a.url) cites.push({ title: a.title || a.url, url: a.url.replace(/[?&]utm_source=openai$/, '') });
        }
        const seen = new Set();
        cites = cites.filter(c => !seen.has(c.url) && seen.add(c.url));
        return { text: text || j.output_text || '', citations: cites, model };
      } catch (e) { last = e; if (e.status !== 400) throw e; }
    }
    throw last;
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
