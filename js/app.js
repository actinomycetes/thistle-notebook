// Thistle Notebook controller: notebooks, sources, chat, Studio, notes, and the Thistle Plot / Flow bridge.
import { APP_VERSION, FILE_EXT } from './version.js';
import { $, $$, h, esc, uid, toast, saveBlob, saveText, safeName, dateStamp, estTokens, sleep, IS_IOS } from './util.js';
import { ELM, DEFAULT_BASE, classify } from './elm.js';
import * as db from './store.js';
import { parseFile, ROLES, guessRole, ACCEPT, splitLines, profileTable } from './ingest.js';
import { chunkSegments, buildContext } from './retrieval.js';
import { MODES, TONES, STUDIO, TP_TESTS, systemPrompt } from './prompts.js';
import { renderMarkdown, markdownToDocx } from './md.js';
import { parseSpecs, findTable, buildG, tplotFile, ThistlePlot, ThistleFlow, defaultSuiteUrl } from './thistle.js';

if (window.pdfjsLib) window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ---------------- settings ----------------
const SETTINGS_DEFAULTS = {
  baseUrl: DEFAULT_BASE, chatModel: '', embeddingModel: '', searchModel: '', visionModel: '', transcriptionModel: '',
  serviceTier: 'auto', fulltextBudget: 90000, retrievalChunks: 40, maxOutputTokens: 8000,
  tpUrl: '', tfUrl: '', autoRunRounds: 2,
};
function loadSettings() {
  let s = {}; try { s = JSON.parse(localStorage.getItem('tn.settings') || '{}'); } catch { }
  let key = ''; try { key = sessionStorage.getItem('tn.key') || localStorage.getItem('tn.key') || ''; } catch { }
  return { ...SETTINGS_DEFAULTS, ...s, apiKey: key, rememberKey: (() => { try { return !!localStorage.getItem('tn.key'); } catch { return false; } })() };
}
function saveSettings(s) {
  const { apiKey, rememberKey, ...rest } = s;
  try {
    localStorage.setItem('tn.settings', JSON.stringify(rest));
    sessionStorage.setItem('tn.key', apiKey || '');
    if (rememberKey && apiKey) localStorage.setItem('tn.key', apiKey); else localStorage.removeItem('tn.key');
  } catch { }
}

const S = {
  settings: loadSettings(), elm: null, models: [], modelsError: '', nb: null, sources: [], notes: [], messages: [],
  chunkCache: new Map(), busy: false, abort: null, tp: null, tf: null,
};
const makeElm = () => (S.elm = new ELM({ apiKey: S.settings.apiKey, baseUrl: S.settings.baseUrl, serviceTier: S.settings.serviceTier }));

// ---------------- models & privacy ----------------
const onCampus = () => !!S.nb?.onCampusOnly;
const allowed = m => m && (!onCampus() || classify(typeof m === 'string' ? m : m.id).local);
const chatModels = () => S.models.filter(m => m.kind === 'chat');
const currentModel = () => $('#modelSelect').value || '';
function pickModel(pref, kind, filter = () => true) {
  if (pref && allowed(pref)) return pref;
  const ms = S.models.filter(m => m.kind === kind && allowed(m) && filter(m));
  return (ms.find(m => m.local) || ms[0])?.id || '';
}
const embeddingModel = () => pickModel(S.settings.embeddingModel, 'embedding');
const visionModel = () => pickModel(S.settings.visionModel, 'chat', m => m.vision);
const transcriptionModel = () => pickModel(S.settings.transcriptionModel, 'transcription');
function searchModel() {
  if (S.settings.searchModel) return S.settings.searchModel;
  const ms = S.models.filter(m => m.webSearch && !/search|^o\d/.test(m.id)).map(m => m.id);
  for (const p of ['mini', 'luna', 'terra', 'nano']) { const f = ms.find(m => m.includes(p)); if (f) return f; }
  return ms[0] || 'gpt-4o-mini';
}

async function loadModels(refresh = false) {
  S.modelsError = '';
  if (!S.settings.apiKey) { S.modelsError = 'nokey'; renderModelSelect(); renderChat(); return; }
  try { S.models = await S.elm.models(refresh); }
  catch (e) { S.models = []; S.modelsError = e.message; }
  renderModelSelect(); renderChat(); refreshCosts();
}
function renderModelSelect() {
  const sel = $('#modelSelect'), prev = sel.value || S.nb?.model || S.settings.chatModel;
  sel.innerHTML = '';
  const ms = chatModels();
  if (!ms.length) { sel.append(h('option', { value: '' }, S.modelsError ? 'not connected' : 'loading…')); return; }
  const grp = (label, list) => list.length && sel.append(h('optgroup', { label }, list.map(m =>
    h('option', { value: m.id, disabled: !allowed(m) }, `${m.local ? '🏛' : '☁'} ${m.id}${m.vision ? ' 👁' : ''}`))));
  grp('On-campus (University-hosted: data stays on campus)', ms.filter(m => m.local));
  grp('OpenAI via ELM (zero data retention)', ms.filter(m => !m.local));
  const want = [prev, 'Qwen/Qwen3.5-397B-A17B-FP8'].find(id => id && ms.some(m => m.id === id && allowed(m)));
  sel.value = want || ms.find(allowed)?.id || '';
  updateReasonSelect();
}
function updateReasonSelect() {
  const info = S.elm?.info(currentModel()) || { reasoning: [] };
  $$('#reasonSelect option').forEach(o => (o.disabled = o.value !== 'default' && !info.reasoning.includes(o.value) && !(o.value === 'none' && info.reasoning.includes('none'))));
  if ($('#reasonSelect').selectedOptions[0]?.disabled) $('#reasonSelect').value = 'default';
  $('#reasonSelect').title = info.reasoning.length ? `This model supports: ${info.reasoning.join(', ')}` : 'This model has no adjustable reasoning';
}
function renderPrivacy() {
  const b = $('#privacyBadge'), on = onCampus();
  b.className = 'badge-hdr ' + (on ? 'campus' : 'cloud');
  b.textContent = on ? '🏛 On-campus only' : '☁ ELM (on-campus + OpenAI ZDR)';
  b.title = on ? 'This notebook only uses University-hosted models; web search is off. Nothing leaves the University.'
    : 'This notebook may use OpenAI models through ELM (zero data retention) and web search.';
  $('#privacyHint').innerHTML = (on
    ? '<b>🏛 On-campus only.</b> Sources are processed in this browser; requests go only to ELM\'s University-hosted models.'
    : '<b>Privacy.</b> Files are read in this browser. Only the text needed for each request is sent to ELM; ☁ models are OpenAI with zero data retention. For student work or personal data, switch this notebook to on-campus only (✎ Notebook).')
    + ' Nothing is sent anywhere else: the page blocks all other connections.';
  $('#webToggle').disabled = on; if (on) $('#webToggle').checked = false;
  $('#webWrap').style.opacity = on ? .5 : 1;
  renderModelSelect();
}
async function refreshCosts() {
  if (!S.settings.apiKey) return;
  try {
    const c = await S.elm.costs(); const cur = c.currency === 'GBP' ? '£' : (c.currency || '') + ' ';
    $('#costBadge').textContent = `${cur}${(+c.usage).toFixed(2)} / ${cur}${(+c.limit).toFixed(0)}`;
    $('#costBadge').title = `ELM API spend (as of ${c.asOf ? new Date(c.asOf).toLocaleString() : '?'})`;
  } catch { $('#costBadge').textContent = '£ –'; }
}

// ---------------- notebooks ----------------
async function renderNbSelect() {
  const list = await db.listNotebooks(), sel = $('#nbSelect');
  sel.innerHTML = '';
  list.forEach(n => sel.append(h('option', { value: n.id }, (n.onCampusOnly ? '🏛 ' : '') + n.name)));
  if (S.nb) sel.value = S.nb.id;
}
async function openNotebook(id) {
  S.nb = await db.get('notebooks', id);
  if (!S.nb) return;
  localStorage.setItem('tn.lastNb', id);
  S.chunkCache.clear();
  [S.sources, S.notes, S.messages] = await Promise.all([db.byNb('sources', id), db.byNb('notes', id), db.byNb('messages', id)]);
  S.sources.sort((a, b) => a.created - b.created); S.notes.sort((a, b) => b.t - a.t); S.messages.sort((a, b) => a.t - b.t);
  $('#modeSelect').value = S.nb.mode || 'general'; $('#toneSelect').value = S.nb.tone || 'scientist';
  await renderNbSelect(); renderPrivacy(); renderSources(); renderNotes(); renderChat();
}
function newNotebookDialog() {
  const name = h('input', { type: 'text', value: 'Untitled notebook' }), oc = h('input', { type: 'checkbox' });
  modal('New notebook', h('div', {},
    h('div', { class: 'form-grid' }, h('label', {}, 'Name'), name,
      h('label', {}, 'Privacy'), h('label', { class: 'check-row' }, oc, '🏛 On-campus models only')),
    h('div', { class: 'hint-box' }, 'Tick "on-campus only" for exam scripts, dissertations, unpublished data or anything personal: only University-hosted models are used and web search is disabled.'),
    h('div', { class: 'modal-foot' }, h('button', { class: 'btn primary', onclick: async () => {
      const nb = await db.createNotebook(name.value.trim() || 'Untitled notebook', oc.checked); closeModal(); await openNotebook(nb.id);
    } }, 'Create'))));
  setTimeout(() => name.select(), 50);
}
function notebookDialog() {
  const nb = S.nb, name = h('input', { type: 'text', value: nb.name }), oc = h('input', { type: 'checkbox', checked: nb.onCampusOnly });
  modal('Notebook', h('div', {},
    h('div', { class: 'form-grid' }, h('label', {}, 'Name'), name,
      h('label', {}, 'Privacy'), h('label', { class: 'check-row' }, oc, '🏛 On-campus models only (no OpenAI models, no web search)')),
    h('div', { class: 'modal-foot' },
      h('button', { class: 'btn danger', onclick: async () => {
        if (!confirm(`Delete notebook "${nb.name}" with its sources, chat and notes from this browser?`)) return;
        await db.deleteNotebook(nb.id); closeModal();
        const list = await db.listNotebooks(); if (!list.length) list.push(await db.createNotebook('My first notebook'));
        openNotebook(list[0].id);
      } }, '🗑 Delete notebook'), h('span', { class: 'grow' }),
      h('button', { class: 'btn primary', onclick: async () => {
        nb.name = name.value.trim() || nb.name; nb.onCampusOnly = oc.checked; await db.touch(nb); closeModal();
        await renderNbSelect(); renderPrivacy(); renderSources();
      } }, 'Save'))));
}

// ---------------- sources ----------------
const KIND_ICON = { pdf: '📄', docx: '📝', pptx: '📊', dataset: '📈', text: '📃', image: '🖼', audio: '🎙', web: '🌐', note: '🗒' };
function renderSources() {
  const ul = $('#srcList'); ul.innerHTML = '';
  $('#srcCount').textContent = S.sources.length ? `(${S.sources.filter(s => s.enabled).length}/${S.sources.length} selected)` : '';
  $('#dropHint').style.display = S.sources.length > 3 ? 'none' : '';
  for (const s of S.sources) {
    const role = h('select', { title: 'What this source is (guides the assistant, e.g. rubric vs submission)', onchange: async e => { s.role = e.target.value; await db.put('sources', s); } },
      Object.entries(ROLES).map(([k, v]) => h('option', { value: k, selected: s.role === k }, v)));
    const cb = h('input', { type: 'checkbox', checked: s.enabled, title: 'Include in chat and Studio', onchange: async e => { s.enabled = e.target.checked; await db.put('sources', s); renderSources(); } });
    const tk = Math.ceil((s.chars || 0) / 3.6), tokens = !s.chars ? '' : tk < 1000 ? `${tk} tok` : `~${Math.round(tk / 1000)}k tok`;
    ul.append(h('li', { class: 'src-item' + (s.status === 'busy' ? ' busy' : s.status === 'error' ? ' err' : '') },
      cb, h('span', { class: 'name', title: s.name, onclick: () => viewSource(s) }, `${KIND_ICON[s.kind] || '📃'} ${s.name}`),
      h('button', { class: 'icon', title: 'Remove source', onclick: async () => { if (!confirm(`Remove "${s.name}"?`)) return; await db.deleteSource(s.id); S.sources = S.sources.filter(x => x !== s); S.chunkCache.delete(s.id); renderSources(); } }, '✕'),
      h('div', { class: 'sub' }, s.status === 'busy' ? h('span', {}, s.progress || 'Reading…') : s.status === 'error' ? h('span', { title: s.error }, '⚠ ' + s.error) :
        [role, h('span', {}, tokens), s.meta?.embModel ? h('span', { title: `Semantic search: ${s.meta.embModel}` }, '🧭') : null,
          s.tables ? h('span', { title: 'Table kept for Thistle Plot' }, '📊') : null])));
  }
}
async function addFiles(files) {
  if (!S.nb) return;
  for (const file of files) {
    if (file.name.toLowerCase().endsWith('.tnote')) { await openTnote(file); continue; }
    const s = { id: uid(), nb: S.nb.id, name: file.name, kind: 'text', role: 'reference', enabled: true, created: Date.now(), status: 'busy', chars: 0, meta: {} };
    S.sources.push(s); renderSources();
    try {
      const ctx = { elm: S.elm, visionModel: visionModel(), transcriptionModel: transcriptionModel() || 'whisper-1', onCampusOnly: onCampus(),
        log: m => { s.progress = m; renderSources(); } };
      if (/\.(mp3|m4a|wav|webm|mp4|mpeg|mpga|ogg|flac)$/i.test(file.name) && onCampus() && !transcriptionModel()) throw new Error('No on-campus transcription model on ELM; this notebook is on-campus only.');
      const r = await parseFile(file, ctx);
      await finishSource(s, r);
    } catch (e) {
      console.error(e); s.status = 'error'; s.error = e.message; renderSources();
    }
  }
}
async function finishSource(s, r) {
  s.kind = r.kind; s.role = r.role || guessRole(s.name, r.kind); s.segments = r.segments; s.tables = r.tables || null;
  s.meta = { ...(r.meta || {}) }; s.chars = r.segments.reduce((n, x) => n + x.text.length, 0);
  const chunks = chunkSegments(r.segments).map((c, i) => ({ id: uid(), nb: s.nb, src: s.id, idx: i, loc: c.loc, text: c.text, emb: null, embModel: null }));
  const em = embeddingModel();
  if (em && chunks.length) {
    s.progress = `Indexing ${chunks.length} passages…`; renderSources();
    try {
      const vecs = await S.elm.embed(chunks.map(c => c.text), em);
      chunks.forEach((c, i) => { c.emb = new Float32Array(vecs[i]); c.embModel = em; }); s.meta.embModel = em;
    } catch (e) { s.meta.embError = e.message; }
  }
  await db.putMany('chunks', chunks); S.chunkCache.set(s.id, chunks);
  s.status = 'ready'; delete s.progress; await db.put('sources', s); await db.touch(S.nb); renderSources();
}
async function addTextSource(name, text, kind = 'text', role = 'reference', extra = {}) {
  const s = { id: uid(), nb: S.nb.id, name, kind, role, enabled: true, created: Date.now(), status: 'busy', chars: 0, meta: {} };
  S.sources.push(s); renderSources();
  await finishSource(s, { kind, role, segments: splitLines(text), ...extra });
  return s;
}
function pasteDialog() {
  const t = h('input', { type: 'text', value: 'Pasted text' }), ta = h('textarea', { class: 'note-edit', placeholder: 'Paste text here…' });
  const role = h('select', {}, Object.entries(ROLES).map(([k, v]) => h('option', { value: k }, v)));
  modal('Paste text as a source', h('div', {}, h('div', { class: 'form-grid' }, h('label', {}, 'Title'), t, h('label', {}, 'Role'), role), h('p'), ta,
    h('div', { class: 'modal-foot' }, h('button', { class: 'btn primary', onclick: async () => { if (!ta.value.trim()) return; closeModal(); await addTextSource(t.value || 'Pasted text', ta.value, 'text', role.value); } }, 'Add source'))));
}
async function chunksOf(src) {
  if (!S.chunkCache.has(src.id)) S.chunkCache.set(src.id, await db.bySrc(src.id));
  return S.chunkCache.get(src.id);
}
function viewSource(s, highlight) {
  const body = h('div', { class: 'src-view' });
  if (s.status === 'error') body.append(h('div', { class: 'err-box' }, s.error));
  (s.segments || []).forEach(seg => {
    const div = h('div', { class: 'chunk' }, h('div', { class: 'loc' }, seg.loc));
    const txt = seg.text;
    const hit = highlight && seg.loc === highlight.loc ? txt.indexOf(highlight.text.slice(0, 80)) : -1;
    if (hit >= 0) { div.classList.add('hl'); div.append(txt.slice(0, hit), h('mark', {}, txt.slice(hit, hit + highlight.text.length)), txt.slice(hit + highlight.text.length)); }
    else div.append(txt);
    body.append(div);
  });
  modal(`${KIND_ICON[s.kind] || ''} ${s.name}`, body);
  setTimeout(() => body.querySelector('mark')?.scrollIntoView({ block: 'center' }), 60);
}

// ---------------- chat ----------------
function renderChat() {
  const log = $('#chatLog'); log.innerHTML = '';
  if (!S.messages.length) {
    const status = S.modelsError === 'nokey' ? '<div class="warn-box">No ELM API key yet: open <b>⚙ Settings</b> and paste the key you requested on ELM.</div>'
      : S.modelsError ? `<div class="err-box">Could not connect to ELM: ${esc(S.modelsError)}</div>` : '';
    log.innerHTML = `<div class="empty"><h2>Ask questions about your sources</h2>${status}
      <p>1. <b>＋ Add sources</b>: papers, rubrics and answers, datasets (CSV/Excel), drafts, images, audio, Thistle Plot / Flow files.<br>
      2. Set each source's <b>role</b> (e.g. rubric, submission, dataset) and tick the ones to use.<br>
      3. Pick a <b>Mode</b>, ask in the box below, or use a <b>Studio</b> report on the right.</p>
      <p>Answers cite numbered passages: click a number to see the passage. Statistics are not calculated by the AI: when a test is needed it is run in <b>Thistle Plot</b> on your original data, and the results are sent back for interpretation.</p></div>`;
    return;
  }
  S.messages.forEach(m => log.append(messageEl(m)));
  log.scrollTop = log.scrollHeight;
}
function messageEl(m) {
  const wrap = h('div', { class: 'msg ' + m.role, 'data-id': m.id });
  if (m.role === 'user') { wrap.append(h('div', { class: 'who' }, 'You'), h('div', { class: 'bubble' }, m.content)); return wrap; }
  if (m.role === 'results') {
    wrap.append(h('div', { class: 'who' }, '🔬 Thistle Plot results sent to the model'),
      h('div', { class: 'bubble' }, h('details', {}, h('summary', {}, `${m.meta.count || ''} result(s) — show what was sent`), h('pre', { style: { whiteSpace: 'pre-wrap', fontSize: '11px' } }, m.content))));
    return wrap;
  }
  const meta = m.meta || {};
  const who = h('div', { class: 'who' }, `${meta.model?.includes('/') ? '🏛' : '☁'} ${meta.model || 'assistant'}`,
    meta.ctxMode && meta.ctxMode !== 'none' ? h('span', {}, `· ${meta.ctxMode === 'full' ? 'full text' : 'retrieved passages'} of ${meta.nSources} source(s)`) : null,
    meta.studio ? h('span', {}, `· Studio: ${meta.studio}`) : null);
  const bubble = h('div', { class: 'bubble' });
  if (meta.web?.citations?.length) bubble.append(h('details', { class: 'web-list' }, h('summary', {}, `🌐 Web findings (${meta.web.citations.length} sources, via ${meta.web.model})`),
    h('ol', {}, meta.web.citations.map(c => h('li', {}, h('a', { href: c.url, target: '_blank', rel: 'noopener noreferrer' }, c.title))))));
  bubble.append(renderMarkdown(m.content, { cites: meta.cites || {}, web: meta.web?.citations || [], onCite: (n, c, e) => showCite(c, e), cardSlot: (k, slot) => slot.replaceWith(tpCard(m, k)) }));
  if (meta.error) bubble.append(h('div', { class: 'err-box' }, meta.error));
  wrap.append(who, bubble, h('div', { class: 'msg-actions' },
    h('button', { class: 'btn', onclick: () => saveNote(m.content.replace(/```thistle-plot[\s\S]*?```/g, ''), firstLine(m.content), meta.cites, meta.web) }, '🗒 Save as note'),
    h('button', { class: 'btn', onclick: () => navigator.clipboard.writeText(m.content).then(() => toast('Copied')) }, '📋 Copy')));
  return wrap;
}
const firstLine = t => (String(t).replace(/[#*`>]/g, '').split('\n').find(l => l.trim()) || 'Note').trim().slice(0, 70);
function showCite(c, e) {
  const p = $('#popover');
  p.innerHTML = ''; p.append(h('div', {}, h('b', {}, c.source), ` — ${c.loc}`), h('div', { class: 'ex' }, c.text),
    h('button', { class: 'btn small', onclick: () => { p.hidden = true; const s = S.sources.find(x => x.id === c.srcId || x.name === c.source); if (s) viewSource(s, c); else toast('That source is no longer in this notebook', true); } }, 'Open in source'));
  p.hidden = false;
  const r = e.target.getBoundingClientRect();
  p.style.left = Math.min(r.left, innerWidth - p.offsetWidth - 10) + 'px';
  p.style.top = (r.bottom + 6 + p.offsetHeight > innerHeight ? Math.max(10, r.top - p.offsetHeight - 6) : r.bottom + 6) + 'px';
}

const enabledSources = () => S.sources.filter(s => s.enabled && s.status === 'ready');
async function prepare(query, sources, budgetOverride) {
  const model = currentModel(), info = S.elm.info(model);
  const chunksBySrc = new Map();
  for (const s of sources) chunksBySrc.set(s.id, await chunksOf(s));
  const budget = Math.max(4000, Math.min(budgetOverride || +S.settings.fulltextBudget, Math.floor(info.context * 0.6) - 8000));
  const embedQuery = async (q, m) => (allowed(m) ? (await S.elm.embed([q], m))[0] : null);
  return buildContext({ sources, chunksBySrc, query, budgetTokens: budget, maxChunks: +S.settings.retrievalChunks, embedQuery });
}
function historyFor(upto) {
  const msgs = S.messages.slice(0, upto).slice(-12);
  return msgs.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: (m.role === 'results' ? '[Thistle Plot results]\n' : '') + m.content.slice(0, 8000) }));
}

async function send(text, extra = {}) {
  if (S.busy) return;
  if (!S.settings.apiKey) { settingsDialog(); return; }
  const model = currentModel();
  if (!model) { toast('No model available: check ⚙ Settings', true); return; }
  if (!allowed(model)) { toast('This notebook is on-campus only: choose a 🏛 model', true); return; }
  const u = { id: uid(), nb: S.nb.id, role: extra.role || 'user', content: text, t: Date.now(), meta: extra.meta || {} };
  S.messages.push(u); await db.put('messages', u);
  if (S.messages.length === 1) $('#chatLog').innerHTML = '';
  $('#chatLog').append(messageEl(u));
  await assistantTurn(extra.query || text, { studio: extra.studio, depth: extra.depth || 0, mode: extra.mode, tone: extra.tone });
}

async function assistantTurn(query, { studio, depth = 0, mode, tone } = {}) {
  const model = currentModel();
  const a = { id: uid(), nb: S.nb.id, role: 'assistant', content: '', t: Date.now(), meta: { model, studio } };
  const el = h('div', { class: 'msg assistant' }, h('div', { class: 'who' }, `${model.includes('/') ? '🏛' : '☁'} ${model} · preparing…`), h('div', { class: 'bubble' }, h('div', { class: 'md streaming' })));
  $('#chatLog').append(el); el.scrollIntoView({ block: 'end' });
  setBusy(true);
  try {
    const sources = enabledSources();
    const { context, cites, mode: ctxMode } = await prepare(query, sources);
    Object.assign(a.meta, { cites, ctxMode, nSources: sources.length });
    let web = null;
    if ($('#webToggle').checked && !onCampus() && depth === 0) {
      el.querySelector('.who').textContent = `🌐 searching the web via ${searchModel()}…`;
      try { web = await S.elm.webSearch(searchModel(), query); a.meta.web = web; }
      catch (e) { toast('Web search failed: ' + e.message, true); }
    }
    const datasets = sources.filter(s => s.tables).map(s => ({ name: s.name, tables: s.tables }));
    const sys = systemPrompt({ mode: mode || $('#modeSelect').value, tone: tone ?? $('#toneSelect').value, hasSources: !!sources.length, ctxMode,
      webEnabled: !!web, datasets, today: new Date().toDateString() })
      + (context ? `\n\n# SOURCES\n${context}` : '')
      + (S.messages[S.messages.length - 1]?.role === 'results' ? `\n\n# NOW\n${RESULT_NUDGE}` : '')
      + (web ? `\n\n# WEB FINDINGS (via ${web.model})\n${web.text}\n\nWeb sources: ${web.citations.map((c, i) => `[W${i + 1}] ${c.title} <${c.url}>`).join('\n')}` : '');
    const msgs = [{ role: 'system', content: sys }, ...historyFor(S.messages.length)];
    $('#ctxInfo').textContent = `${ctxMode === 'full' ? 'Full text' : ctxMode === 'retrieval' ? `${Object.keys(cites).length} passages` : 'No sources'} · ~${Math.round(estTokens(sys) / 1000)}k tokens sent`;
    el.querySelector('.who').textContent = `${model.includes('/') ? '🏛' : '☁'} ${model} · writing…`;
    S.abort = new AbortController();
    let md = el.querySelector('.md'), pending = false, thinking = '';
    const paint = () => {
      pending = false;
      const r = renderMarkdown(a.content || (thinking ? `<think>${thinking}` : '…'), { cites, web: web?.citations || [] });
      r.classList.add('streaming'); md.replaceWith(r); md = r;
    };
    await S.elm.chatStream(model, msgs, { reasoning: $('#reasonSelect').value, maxTokens: +S.settings.maxOutputTokens, signal: S.abort.signal }, d => {
      if (d.text) a.content += d.text; if (d.thinking) thinking += d.thinking;
      if (!pending) { pending = true; requestAnimationFrame(paint); }
    });
    if (thinking && !a.content.includes('<think>')) a.meta.thinking = thinking.slice(0, 20000);
  } catch (e) {
    if (e.name === 'AbortError') a.meta.error = 'Stopped.'; else { a.meta.error = e.message; console.error(e); }
  } finally { setBusy(false); S.abort = null; }
  S.messages.push(a); await db.put('messages', a); await db.touch(S.nb);
  el.replaceWith(messageEl(a));
  refreshCosts();
  // Analyses requested by the model → run in Thistle Plot, then hand results back (bounded rounds)
  const specs = parseSpecs(a.content).filter(s => s.ok);
  if (specs.length && $('#autoRunToggle').checked && depth < +S.settings.autoRunRounds && !a.meta.error) await runAllAndInterpret(a, depth);
}
function setBusy(b) { S.busy = b; $('#btnSend').disabled = b; $('#btnStop').disabled = !b; }

// ---------------- Thistle Plot analysis cards ----------------
function datasetsNow() { return S.sources.filter(s => s.tables).map(s => ({ name: s.name, tables: s.tables })); }
function tpCard(m, k) {
  const parsed = parseSpecs(m.content)[k];
  const card = h('div', { class: 'tp-card' });
  if (!parsed) return card;
  if (!parsed.ok) { card.append(h('div', { class: 'err-box' }, parsed.error), h('pre', {}, parsed.raw)); return card; }
  const spec = parsed.spec, res = m.meta?.tp?.[k];
  const testName = TP_TESTS[spec.test]?.[0] || spec.test;
  card.append(h('div', { class: 'tp-title' }, '📊 ', spec.title || testName,
    res ? h('span', { class: 'status ' + (res.status === 'ok' ? 'ok' : 'err') }, res.status === 'ok' ? 'run in Thistle Plot' : 'failed') : h('span', { class: 'status' }, 'proposed')),
  h('div', { class: 'tp-meta' }, `${testName} · ${spec.dataset || '?'}${spec.sheet ? ' [' + spec.sheet + ']' : ''} · ${describeSpec(spec)}`),
  spec.why ? h('div', {}, '💡 ', spec.why) : null);
  let built = null;
  try { const { table } = findTable(spec, datasetsNow()); built = buildG({ ...spec }, table); }
  catch (e) { card.append(h('div', { class: 'err-box' }, e.message)); }
  if (built) {
    const G = built.G;
    card.append(h('div', { class: 'preview hint' }, `Table for Thistle Plot: ${G.groups.length} column group(s) × ${G.nRows} row(s)${G.nReps > 1 ? ` × ${G.nReps} replicates` : ''} — `,
      G.groups.map(g => `${g.name} (n=${g.data.flat().filter(v => v !== '' && v != null).length})`).join(', '), built.notes.length ? ' · ' + built.notes.join(' ') : ''));
  }
  const btns = h('div', { class: 'tp-btns' });
  if (built) {
    btns.append(h('button', { class: 'btn small primary', onclick: async e => { e.target.disabled = true; await runSpec(m, k); } }, res ? '↻ Run again' : '▶ Run in Thistle Plot'),
      h('button', { class: 'btn small', title: 'Thistle Plot project with this table (and the result, if run)', onclick: () => saveText(tplotFile(built.G, res?.status === 'ok' ? res : null, res?.plot, res?.appVersion), `${safeName(spec.title || spec.test)}.tplot`, 'application/json') }, '⤓ .tplot'),
      h('button', { class: 'btn small', title: 'Show Thistle Plot with this table loaded', onclick: async () => { try { const w = await S.tp.ready(); w.applyG(built.G); openDrawer('tp'); } catch (e) { toast(e.message, true); } } }, '👁 Open in Thistle Plot'));
    if (res?.status === 'ok' && !m.meta.interpreted) btns.append(h('button', { class: 'btn small', onclick: () => sendResults(m, 0, true) }, '💬 Interpret results'));
  }
  card.append(btns);
  if (res?.status === 'ok') {
    const box = h('div', { class: 'tp-result' });
    box.innerHTML = window.DOMPurify.sanitize(res.html, { FORBID_TAGS: ['button', 'input', 'select', 'style'], FORBID_ATTR: ['style', 'onclick'] });
    if (res.plot) box.append(h('img', { src: res.plot.image, alt: res.plot.title }));
    if (res.unknown?.length) box.prepend(h('div', { class: 'warn-box' }, 'Options not found in Thistle Plot (defaults used): ' + res.unknown.join('; ')));
    if (res.alerts?.length) box.prepend(h('div', { class: 'warn-box' }, 'Thistle Plot says: ' + res.alerts.join(' ')));
    card.append(box);
  } else if (res?.status === 'err') card.append(h('div', { class: 'err-box' }, res.error));
  return card;
}
function describeSpec(s) {
  const j = v => [].concat(v).join(' × ');
  switch (s.layout) {
    case 'wide': return `columns ${j(s.columns || [])}`;
    case 'xy': return `X = ${s.x}, Y = ${s.y}`;
    case 'counts': return `${s.rows} × ${s.cols}${s.count ? ' (counts in ' + s.count + ')' : ''}`;
    case 'survival': return `time ${s.time}, event ${s.event}, by ${s.group}`;
    case 'matrix': return `features ${s.label}; ${Object.keys(s.groups || {}).join(' vs ')}`;
    default: return `${s.value} by ${j(s.group || '?')}${s.subject ? `, matched by ${s.subject}` : ''}${s.control ? `, control ${s.control}` : ''}`;
  }
}
async function runSpec(m, k) {
  const spec = parseSpecs(m.content)[k]?.spec;
  m.meta.tp ||= {};
  try {
    const { table } = findTable(spec, datasetsNow());
    const sp = { ...spec }, built = buildG(sp, table);
    const r = await S.tp.run(sp, built.G);
    m.meta.tp[k] = { status: 'ok', ...r, notes: built.notes, G: built.G };
  } catch (e) { console.error(e); m.meta.tp[k] = { status: 'err', error: e.message }; }
  await db.put('messages', m);
  const old = $(`.msg[data-id="${m.id}"]`); if (old) old.replaceWith(messageEl(m));
  return m.meta.tp[k];
}
async function runAllAndInterpret(m, depth) {
  const specs = parseSpecs(m.content);
  for (let k = 0; k < specs.length; k++) if (specs[k].ok) await runSpec(m, k);
  await sendResults(m, depth);
}
async function sendResults(m, depth, manual = false) {
  const specs = parseSpecs(m.content), parts = [];
  specs.forEach((p, k) => {
    const r = m.meta.tp?.[k]; if (!p.ok || !r) return;
    if (r.status !== 'ok') { parts.push(`## Analysis ${k + 1}: ${p.spec.title || p.spec.test}\nFAILED: ${r.error}`); return; }
    parts.push(`## Analysis ${k + 1}: ${p.spec.title || r.title} (Thistle Plot v${r.appVersion}, test "${p.spec.test}")\n` +
      (r.notes?.length ? `Data notes: ${r.notes.join(' ')}\n` : '') + (r.applied?.length ? `Options set: ${r.applied.join('; ')}\n` : '') +
      (r.unknown?.length ? `Options NOT found (defaults used): ${r.unknown.join('; ')}\n` : '') + (r.alerts?.length ? `Thistle Plot messages: ${r.alerts.join(' ')}\n` : '') +
      `\n${r.text.slice(0, 12000)}\n\nOptions available for this test: ${r.options.join('; ')}`);
  });
  if (!parts.length) return;
  m.meta.interpreted = true; await db.put('messages', m);
  const content = parts.join('\n\n---\n\n');
  await send(content, { role: 'results', meta: { count: parts.length, manual }, depth: depth + 1, query: m.content.slice(0, 500) });
}

// Added to the system prompt when the last message carries Thistle Plot results
const RESULT_NUDGE = 'The previous user message contains Thistle Plot results for the analyses you requested. Interpret them for the user: for each analysis report the test, statistic, degrees of freedom, p-value (and adjusted p), effect size/direction with units, and what it means for the research question. Check whether the test was appropriate (design, assumptions, n) and flag problems. Only request another thistle-plot analysis if it is clearly needed (e.g. a failed run or a wrong test).';

// ---------------- Studio ----------------
function renderStudio() {
  const box = $('#studio'); box.innerHTML = '';
  const groups = [...new Set(STUDIO.map(t => t.group))];
  for (const g of groups) box.append(h('div', { class: 'studio-group' }, h('h4', {}, g),
    h('div', { class: 'studio-btns' }, STUDIO.filter(t => t.group === g).map(t => h('button', { class: 'btn', title: t.prompt, onclick: () => runStudio(t) }, t.title)))));
  box.append(h('div', { class: 'hint' }, 'Audience for writing reports follows the Audience menu. Data reports run in the chat so their Thistle Plot analyses can run.'));
}
async function runStudio(t) {
  if (S.busy) return toast('Wait for the current answer to finish', true);
  const src = enabledSources();
  if (!src.length) return toast('Select at least one source', true);
  if (t.mode === 'data') { // into the chat, where Thistle Plot runs happen
    $('#modeSelect').value = 'data';
    return send(`Studio: ${t.title}\n\n${t.prompt}`, { studio: t.title, mode: 'data' });
  }
  const tone = t.toneFixed || (t.tone ? $('#toneSelect').value : null);
  const note = { id: uid(), nb: S.nb.id, title: `${t.title}${tone ? ' — ' + TONES[tone].label : ''}`, content: '', t: Date.now(), meta: { studio: t.id, cites: {}, busy: true } };
  S.notes.unshift(note); renderNotes();
  setBusy(true);
  try {
    if (t.perSubmission) {
      const subs = src.filter(s => s.role === 'submission'), others = src.filter(s => s.role !== 'submission');
      if (!subs.length) throw new Error('Mark at least one source as "Answer / submission" (role menu under each source).');
      if (!others.some(s => s.role === 'rubric')) toast('No source has the role "Rubric / marking scheme"', true);
      let offset = 0; const summary = [];
      for (const [i, sub] of subs.entries()) {
        note.meta.progress = `${i + 1}/${subs.length}: ${sub.name}`; renderNotes();
        const r = await complete(t, [...others, sub], tone, `Submission being marked: "${sub.name}".`);
        const shifted = r.text.replace(/\[(\d+(?:\s*[,–-]\s*\d+)*)\]/g, (_, g) => '[' + g.replace(/\d+/g, n => +n + offset) + ']');
        Object.entries(r.cites).forEach(([n, c]) => (note.meta.cites[+n + offset] = c));
        offset += Object.keys(r.cites).length;
        note.content += `\n\n## ${sub.name}\n\n${shifted}`;
        const mk = r.text.match(/Suggested overall mark:\**\s*([^\n]+)/i); summary.push(`| ${sub.name} | ${mk ? mk[1].replace(/\*/g, '').trim() : '—'} |`);
        await db.put('notes', note); renderNotes();
      }
      if (t.id === 'mark') note.content = `> Suggested marks are for the human marker to check; every decision is yours.\n\n| Submission | Suggested mark |\n|---|---|\n${summary.join('\n')}\n` + note.content;
    } else {
      const r = await complete(t, src, tone);
      note.content = r.text; note.meta.cites = r.cites; note.meta.web = r.web;
    }
    note.meta.model = currentModel();
  } catch (e) { note.content += `\n\n**Error:** ${e.message}`; }
  finally { delete note.meta.busy; delete note.meta.progress; setBusy(false); }
  await db.put('notes', note); renderNotes(); refreshCosts(); viewNote(note);
}
async function complete(t, sources, tone, extraUser = '') {
  const model = currentModel();
  if (!allowed(model)) throw new Error('This notebook is on-campus only: choose a 🏛 model.');
  const query = t.prompt + ' ' + extraUser;
  // Marking: give the whole submission + rubric when possible
  const { context, cites, mode: ctxMode } = await prepare(query, sources, t.perSubmission ? 200000 : undefined);
  const datasets = sources.filter(s => s.tables).map(s => ({ name: s.name, tables: s.tables }));
  const sys = systemPrompt({ mode: t.mode, tone, hasSources: true, ctxMode, webEnabled: false, datasets, today: new Date().toDateString() }) + `\n\n# SOURCES\n${context}`;
  S.abort = new AbortController();
  const text = await S.elm.chatStream(model, [{ role: 'system', content: sys }, { role: 'user', content: `${t.prompt}\n${extraUser}` }],
    { reasoning: $('#reasonSelect').value, maxTokens: +S.settings.maxOutputTokens, signal: S.abort.signal });
  return { text: text.replace(/<think>[\s\S]*?<\/think>\s*/g, ''), cites };
}

// ---------------- notes ----------------
function renderNotes() {
  const ul = $('#noteList'); ul.innerHTML = '';
  $('#noteCount').textContent = S.notes.length ? `(${S.notes.length})` : '';
  for (const n of S.notes) ul.append(h('li', { class: 'note-item' + (n.meta?.busy ? ' busy' : ''), onclick: () => viewNote(n) },
    h('div', { class: 't' }, n.title), h('div', { class: 'd' }, n.meta?.progress || `${new Date(n.t).toLocaleString()}${n.meta?.model ? ' · ' + n.meta.model : ''}`)));
}
async function saveNote(content, title, cites = {}, web = null) {
  const n = { id: uid(), nb: S.nb.id, title, content, t: Date.now(), meta: { cites, web } };
  S.notes.unshift(n); await db.put('notes', n); renderNotes(); toast('Saved to Notes');
}
function viewNote(n) {
  const body = h('div', {});
  const show = () => { body.innerHTML = ''; body.append(renderMarkdown(n.content, { cites: n.meta?.cites || {}, web: n.meta?.web?.citations || [], onCite: (_, c, e) => showCite(c, e) })); };
  show();
  const edit = () => {
    const ta = h('textarea', { class: 'note-edit' }); ta.value = n.content;
    const title = h('input', { type: 'text', value: n.title, style: { width: '100%', marginBottom: '6px' } });
    body.innerHTML = ''; body.append(title, ta, h('div', { class: 'modal-foot' }, h('button', { class: 'btn primary', onclick: async () => { n.content = ta.value; n.title = title.value; await db.put('notes', n); renderNotes(); show(); } }, 'Save')));
  };
  const name = safeName(n.title);
  modal(n.title, h('div', {}, h('div', { class: 'tp-btns', style: { marginBottom: '8px' } },
    h('button', { class: 'btn small', onclick: edit }, '✎ Edit'),
    h('button', { class: 'btn small', onclick: () => saveBlob(markdownToDocx(withRefs(n), n.title), `${name}.docx`) }, '⤓ Word'),
    h('button', { class: 'btn small', onclick: () => saveText(withRefs(n), `${name}.md`, 'text/markdown') }, '⤓ Markdown'),
    h('button', { class: 'btn small', onclick: () => navigator.clipboard.writeText(withRefs(n)).then(() => toast('Copied')) }, '📋 Copy'),
    h('button', { class: 'btn small', title: 'Use this note as a source for further questions', onclick: async () => { closeModal(); await addTextSource(n.title, n.content, 'note', 'draft'); } }, '→ Add as source'),
    h('button', { class: 'btn small danger', onclick: async () => { if (!confirm('Delete this note?')) return; await db.del('notes', n.id); S.notes = S.notes.filter(x => x !== n); renderNotes(); closeModal(); } }, '🗑 Delete')), body));
}
// Exported notes keep their citations readable outside the app: [n] → list of sources + locations
function withRefs(n) {
  const used = [...new Set([...n.content.matchAll(/\[(\d+(?:\s*[,–-]\s*\d+)*)\]/g)].flatMap(m => m[1].match(/\d+/g).map(Number)))].sort((a, b) => a - b);
  const c = n.meta?.cites || {};
  const refs = used.filter(i => c[i]).map(i => `[${i}] ${c[i].source}, ${c[i].loc}`);
  const web = (n.meta?.web?.citations || []).map((w, i) => `[W${i + 1}] ${w.title} — ${w.url}`);
  return n.content + (refs.length || web.length ? `\n\n---\n**Sources cited**\n\n${[...refs, ...web].map(r => '- ' + r).join('\n')}\n` : '');
}

// ---------------- Thistle apps drawer ----------------
function openDrawer(app = 'tp') {
  $('#suiteDrawer').classList.add('open'); $('#suiteDrawer').setAttribute('aria-hidden', 'false');
  $$('#suiteTabs button').forEach(b => b.classList.toggle('active', b.dataset.app === app));
  $('#tpHost').hidden = app !== 'tp'; $('#tfHost').hidden = app !== 'tf';
  const tools = $('#suiteTools'); tools.innerHTML = '';
  if (app === 'tp') {
    S.tp.ready().catch(e => { $('#tpHost').innerHTML = ''; $('#tpHost').append(h('div', { class: 'empty' }, h('div', { class: 'err-box' }, e.message))); S.tp.frame = null; });
    tools.append(h('button', { class: 'btn', title: "Add Thistle Plot's current data table to this notebook as a dataset", onclick: importFromTP }, '⬇ Add TP table as source'),
      h('button', { class: 'btn', title: 'Save the whole Thistle Plot session with its own project format', onclick: async () => { try { saveBlob(await S.tp.saveSession(), `thistle_project_${dateStamp()}.tplot`); } catch (e) { toast(e.message, true); } } }, '💾 Save TP session (.tplot)'));
  } else {
    S.tf.ready().catch(e => { $('#tfHost').innerHTML = ''; $('#tfHost').append(h('div', { class: 'empty' }, h('div', { class: 'err-box' }, e.message))); S.tf.frame = null; });
    tools.append(h('button', { class: 'btn primary', title: "Add Thistle Flow's Statistics table (all samples × populations) as a dataset source", onclick: importFromTF }, '⬇ Add TF statistics as source'));
  }
}
function closeDrawer() { $('#suiteDrawer').classList.remove('open'); $('#suiteDrawer').setAttribute('aria-hidden', 'true'); }
async function importFromTF() {
  try {
    const t = await S.tf.statistics();
    const name = `${t.workspace} statistics (Thistle Flow ${dateStamp()})`;
    await addTextSource(name, profileTable(t, name), 'dataset', 'dataset', { tables: { Statistics: { columns: t.columns, rows: t.rows } }, meta: { from: 'Thistle Flow' } });
    toast('Thistle Flow statistics added as a dataset source'); closeDrawer();
  } catch (e) { toast(e.message, true); }
}
async function importFromTP() {
  try {
    const w = await S.tp.ready(), G = w.eval('G');
    const cols = ['row'], rows = [];
    G.groups.forEach(g => g.reps.forEach(r => cols.push(G.groups.length > 1 || g.reps.length > 1 ? `${g.name} | ${r}` : g.name)));
    for (let i = 0; i < G.nRows; i++) rows.push([G.rowNames?.[i] ?? `Row ${i + 1}`, ...G.groups.flatMap(g => g.reps.map((_, k) => { const v = g.data?.[i]?.[k]; return v === '' || v == null ? null : isFinite(+v) ? +v : v; }))]);
    const name = `Thistle Plot table ${dateStamp()}`;
    await addTextSource(name, profileTable({ columns: cols, rows }, name), 'dataset', 'dataset', { tables: { 'Thistle Plot table': { columns: cols, rows } } });
    toast('Thistle Plot table added as a dataset source'); closeDrawer();
  } catch (e) { toast(e.message, true); }
}

// ---------------- settings, help, modal ----------------
function modal(title, content) {
  $('#modalTitle').textContent = title; const b = $('#modalBody'); b.innerHTML = ''; b.append(content); $('#modal').hidden = false;
}
function closeModal() { $('#modal').hidden = true; }

function settingsDialog() {
  const s = S.settings, f = {};
  const field = (key, label, el, hint) => { f[key] = el; return [h('label', { title: hint || '' }, label), el]; };
  const txt = (key, type = 'text', ph = '') => { const e = h('input', { type, placeholder: ph }); e.value = s[key] ?? ''; return e; };
  const modelSel = (key, kind, filter = () => true) => {
    const e = h('select', {}, h('option', { value: '' }, 'automatic'), S.models.filter(m => m.kind === kind && filter(m)).map(m => h('option', { value: m.id }, `${m.local ? '🏛' : '☁'} ${m.id}`)));
    e.value = s[key] || ''; return e;
  };
  const remember = h('input', { type: 'checkbox', checked: s.rememberKey });
  const status = h('div', {});
  modal('Settings', h('div', {},
    h('div', { class: 'form-grid' },
      ...field('apiKey', 'ELM API key', txt('apiKey', 'password', 'elm-xxxxxxxx-xxxxxxxxxxxxxxxx')),
      h('span'), h('label', { class: 'check-row' }, remember, 'Remember on this device (otherwise forgotten when the tab closes)'),
      ...field('baseUrl', 'ELM API address', txt('baseUrl', 'url')),
      ...field('chatModel', 'Default chat model', modelSel('chatModel', 'chat')),
      ...field('embeddingModel', 'Embedding model (search)', modelSel('embeddingModel', 'embedding'), 'Used to find relevant passages in long sources'),
      ...field('visionModel', 'Vision model (images, scans)', modelSel('visionModel', 'chat', m => m.vision)),
      ...field('transcriptionModel', 'Transcription model (audio)', modelSel('transcriptionModel', 'transcription')),
      ...field('searchModel', 'Web search model', modelSel('searchModel', 'chat', m => m.webSearch)),
      ...field('serviceTier', 'OpenAI service tier', (() => { const e = h('select', {}, h('option', { value: 'auto' }, 'standard'), h('option', { value: 'flex' }, 'flex (cheaper, slower — ELM recommends)')); e.value = s.serviceTier; return e; })()),
      ...field('fulltextBudget', 'Full-text limit (tokens)', txt('fulltextBudget', 'number'), 'If the selected sources are smaller than this, their full text is sent; otherwise the most relevant passages'),
      ...field('retrievalChunks', 'Passages when retrieving', txt('retrievalChunks', 'number')),
      ...field('maxOutputTokens', 'Max answer length (tokens)', txt('maxOutputTokens', 'number')),
      ...field('autoRunRounds', 'Thistle Plot auto-run rounds', txt('autoRunRounds', 'number'), 'How many times the assistant may request analyses and get results back automatically'),
      ...field('tpUrl', 'Thistle Plot address', txt('tpUrl', 'url', defaultSuiteUrl('thistle-plot'))),
      ...field('tfUrl', 'Thistle Flow address', txt('tfUrl', 'url', defaultSuiteUrl('thistle-flow'))),
    ),
    h('div', { class: 'hint-box' }, 'Your key is kept only in this browser. Request one on ELM (API keys → New Key Request). ELM asks API users to try lower-cost models first and to use flex where possible.'),
    status,
    h('div', { class: 'modal-foot' },
      h('button', { class: 'btn', onclick: async () => { apply(); status.innerHTML = '<div class="hint">Testing…</div>'; try { const ms = await S.elm.models(true); status.innerHTML = `<div class="hint-box">✅ Connected: ${ms.length} models (${ms.filter(m => m.local).length} on-campus).</div>`; } catch (e) { status.innerHTML = `<div class="err-box">${esc(e.message)}</div>`; } } }, 'Test connection'),
      h('button', { class: 'btn primary', onclick: () => { apply(); closeModal(); loadModels(true); } }, 'Save'))));
  function apply() {
    for (const [k, e] of Object.entries(f)) s[k] = e.type === 'number' ? +e.value : e.value.trim();
    s.rememberKey = remember.checked; saveSettings(s); makeElm();
    S.tp = new ThistlePlot(s.tpUrl || defaultSuiteUrl('thistle-plot'), $('#tpHost')); S.tf = new ThistleFlow(s.tfUrl || defaultSuiteUrl('thistle-flow'), $('#tfHost'));
    $('#tpHost').innerHTML = ''; $('#tfHost').innerHTML = '';
  }
}

function helpDialog() {
  modal('Thistle Notebook — help', renderMarkdown(`
**Thistle Notebook v${APP_VERSION} (beta)** is a source-grounded research assistant in the Thistle suite. It runs entirely in your browser and talks only to **ELM** (University of Edinburgh). Check important outputs yourself: AI text can be wrong, and suggested marks are suggestions.

### Where your data goes
- Files are read **in this browser**. Notebooks are stored in this browser (IndexedDB); **💾 Save** writes a \`.tnote\` file you can keep or share.
- For each question, only the needed text is sent to ELM. 🏛 models run in University data centres; ☁ models are OpenAI under ELM's zero-data-retention terms.
- **On-campus only** notebooks (✎ Notebook) never use ☁ models or web search — use this for student work, personal or unpublished data.
- The page's security policy makes the browser block every connection except to ELM, so nothing can be sent elsewhere.

### Sources
PDF (scanned pages are read by a vision model), Word, PowerPoint, Excel/CSV, text/Markdown/LaTeX/code, images (handwriting is transcribed), audio (transcribed), Thistle Plot \`.tplot\` and Thistle Flow \`.tflow\`. Set each source's **role** — the assistant treats rubrics, questions, submissions, datasets and drafts differently. Small selections are sent in full; large ones are searched and the most relevant passages are sent.

### Modes and Studio
- **Research papers**: summaries, comparison tables, gaps and contradictions, **hypotheses**.
- **Marking**: rubric + question + submissions → per-criterion suggested marks with quoted evidence, consistency checks, feedback drafts. Studio marks each submission separately.
- **Data analysis**: design, quality problems, appropriate tests, next experiments.
- **Scientific writing**: abstracts, lay summaries, introductions, discussions, rewrites — choose the **Audience** (lay public, scientists, field experts).

### Statistics with Thistle Plot and Thistle Flow
The AI never calculates p-values. It writes an analysis request (test + which columns), the app builds Thistle Plot's table **from your original file**, Thistle Plot runs the test here in the browser, and the results go back to the AI for interpretation. Each card can **⤓ .tplot** (open in Thistle Plot) or **👁 Open in Thistle Plot**.
In **🔬 Thistle apps → Thistle Flow**, load FCS files and gate as usual, then **⬇ Add TF statistics as source** to analyse population statistics here.
`), {});
}

// ---------------- save / open ----------------
async function saveTnote() {
  const json = await db.exportNotebook(S.nb.id);
  saveText(json, `${safeName(S.nb.name)}.${FILE_EXT}`, 'application/json');
}
async function openTnote(file) {
  const id = db.identifyFile(file.name, await file.text());
  if (!id.ok) return toast(id.msg, true, 6000);
  const nb = await db.importNotebook(id.data); await openNotebook(nb.id); toast(`Opened “${nb.name}”`);
}

// ---------------- wiring ----------------
async function init() {
  const theme = localStorage.getItem('tn.theme') || 'dark';
  document.documentElement.dataset.theme = theme; $('#btnTheme').textContent = theme === 'dark' ? '🌙' : '☀️';
  $('#modeSelect').append(...Object.entries(MODES).map(([k, v]) => h('option', { value: k }, v.label)));
  $('#toneSelect').append(...Object.entries(TONES).map(([k, v]) => h('option', { value: k }, v.label)));
  if (!IS_IOS) $('#fileInput').setAttribute('accept', ACCEPT);
  makeElm();
  S.tp = new ThistlePlot(S.settings.tpUrl || defaultSuiteUrl('thistle-plot'), $('#tpHost'));
  S.tf = new ThistleFlow(S.settings.tfUrl || defaultSuiteUrl('thistle-flow'), $('#tfHost'));
  renderStudio();
  let list = await db.listNotebooks();
  if (!list.length) list = [await db.createNotebook('My first notebook')];
  const last = localStorage.getItem('tn.lastNb');
  await openNotebook(list.find(n => n.id === last)?.id || list[0].id);
  loadModels();

  $('#nbSelect').onchange = e => openNotebook(e.target.value);
  $('#btnNewNb').onclick = newNotebookDialog;
  $('#btnNbSettings').onclick = notebookDialog;
  $('#btnSave').onclick = saveTnote;
  $('#openInput').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (f) await openTnote(f); };
  $('#modelSelect').onchange = async () => { updateReasonSelect(); S.nb.model = currentModel(); await db.put('notebooks', S.nb); };
  $('#modeSelect').onchange = async e => { S.nb.mode = e.target.value; await db.put('notebooks', S.nb); };
  $('#toneSelect').onchange = async e => { S.nb.tone = e.target.value; await db.put('notebooks', S.nb); };
  $('#fileInput').onchange = e => { const fs = [...e.target.files]; e.target.value = ''; addFiles(fs); };
  $('#btnPaste').onclick = pasteDialog;
  $('#srcAll').onchange = async e => { for (const s of S.sources) { s.enabled = e.target.checked; await db.put('sources', s); } renderSources(); };
  $('#btnSend').onclick = () => { const t = $('#prompt').value.trim(); if (!t) return; $('#prompt').value = ''; send(t); };
  $('#prompt').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#btnSend').click(); } };
  $('#btnStop').onclick = () => S.abort?.abort();
  $('#btnClearChat').onclick = async () => { if (!confirm('Delete this notebook\'s chat history? (Sources and notes stay.)')) return; await db.delWhere('messages', 'nb', S.nb.id); S.messages = []; renderChat(); };
  $('#btnNewNote').onclick = () => { const n = { id: uid(), nb: S.nb.id, title: 'New note', content: '', t: Date.now(), meta: {} }; S.notes.unshift(n); db.put('notes', n); renderNotes(); viewNote(n); };
  $('#btnThistle').onclick = () => openDrawer('tp');
  $('#btnCloseDrawer').onclick = closeDrawer;
  $$('#suiteTabs button').forEach(b => (b.onclick = () => openDrawer(b.dataset.app)));
  $('#btnSettings').onclick = settingsDialog;
  $('#btnHelp').onclick = helpDialog;
  $('#btnTheme').onclick = () => { const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = t; localStorage.setItem('tn.theme', t); $('#btnTheme').textContent = t === 'dark' ? '🌙' : '☀️'; };
  $('#modalClose').onclick = closeModal;
  $('#modal').onclick = e => { if (e.target.id === 'modal') closeModal(); };
  document.addEventListener('click', e => { if (!e.target.closest('#popover,.cite')) $('#popover').hidden = true; });
  document.addEventListener('keydown', e => {
    if (e.key === 'F1' || ((e.metaKey || e.ctrlKey) && e.key === '/')) { e.preventDefault(); helpDialog(); }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveTnote(); }
    if (e.key === 'Escape') { closeModal(); $('#popover').hidden = true; }
  });
  document.addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('dragging'); });
  document.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
  document.addEventListener('drop', e => { e.preventDefault(); document.body.classList.remove('dragging'); if (e.dataTransfer.files.length) addFiles([...e.dataTransfer.files]); });
}

init().catch(e => { console.error(e); document.body.prepend(h('div', { class: 'err-box' }, 'Thistle Notebook failed to start: ' + e.message)); });
window.thistleNotebook = S; // handy for debugging, like window.thistleFlow
