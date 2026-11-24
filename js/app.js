// Thistle Notebook controller: notebooks, sources, chat, Studio, notes, and the Thistle Plot / Flow bridge.
import { APP_VERSION, FILE_EXT } from './version.js';
import { $, $$, h, esc, uid, toast, saveBlob, saveText, safeName, dateStamp, estTokens, sleep, IS_IOS, fmtBytes } from './util.js';
import { ELM, DEFAULT_BASE, classify } from './elm.js';
import * as db from './store.js';
import { parseFile, ROLES, guessRole, ACCEPT, splitLines, profileTable } from './ingest.js';
import { chunkSegments, buildContext } from './retrieval.js';
import { MODES, TONES, STUDIO, TP_TESTS, systemPrompt, SEARCH_PROMPT } from './prompts.js';
import { SEARCH_DBS, parseSuggestions, recentSince } from './search.js';
import { renderMarkdown, markdownToDocx } from './md.js';
import { extractTables, tableToCsv, tableToTsv, tablesToXlsx, reportHtml, markdownToHtml } from './export.js';
import { parseSpecs, findTable, buildG, tplotFile, ThistlePlot, ThistleFlow, defaultSuiteUrl } from './thistle.js';
// Set the title again from script (as Thistle Flow does): Orion 1.1 (WebKit) showed the favicon only on pages whose title
// changed after loading; the static <title> alone gave the generic github.io icon (v0.5.1, checked with test pages).
document.title = `Thistle Notebook v${APP_VERSION} (Beta)`;

if (window.pdfjsLib) window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ---------------- settings ----------------
const SETTINGS_DEFAULTS = {
  baseUrl: DEFAULT_BASE, chatModel: '', embeddingModel: '', searchModel: '', visionModel: '', transcriptionModel: '',
  serviceTier: 'auto', fulltextBudget: 90000, retrievalChunks: 40, maxOutputTokens: 8000,
  tpUrl: '', tfUrl: '', autoRunRounds: 2,
  webSearchStatus: '', webSearchDetail: '', // '' = not tried, 'ok', 'unavailable' (set by a real search or ⚙ Test web search)
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
  files: new Map(),      // source id → original File, for this browser session only (browsers cannot keep paths)
  tableCache: new Map(), // source id → tables re-read from a linked original (datasets too large to keep)
  histPos: -1,
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
function renderWebToggle() {
  const on = onCampus(), off = S.settings.webSearchStatus === 'unavailable';
  $('#webToggle').disabled = on || off; if (on || off) $('#webToggle').checked = false;
  $('#webWrap').style.opacity = on || off ? .5 : 1;
  $('#webWrap').title = on ? 'Web search is off in on-campus-only notebooks (it would use OpenAI and the public web).'
    : off ? `Web search did not work through ELM with your key: ${S.settings.webSearchDetail || ''} — ⚙ Settings → Test web search to try again.`
    : 'Search the web through ELM (OpenAI-hosted model). Only your question is sent, not your sources.';
}
function setWebStatus(status, detail = '') {
  S.settings.webSearchStatus = status; S.settings.webSearchDetail = String(detail).slice(0, 300); saveSettings(S.settings); renderWebToggle();
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
  renderWebToggle();
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
// Opening a notebook loads everything first and switches only if no later open has started meanwhile: a slower earlier
// load used to finish last, leaving one notebook selected with another's sources and chat (v0.6.6; the same race was
// found in Thistle Flow's session restore, TF v0.23.2)
let openSeq = 0;
async function openNotebook(id) {
  const my = ++openSeq;
  const nb = await db.get('notebooks', id);
  if (!nb || my !== openSeq) return;
  const slow = window.TN_OPEN_DELAY?.(id); if (slow) await sleep(slow); // test hook (tests/robust.e2e.cjs)
  const loaded = await Promise.all([db.byNb('sources', id), db.byNb('notes', id), db.byNb('messages', id)]);
  if (my !== openSeq) return; // a later open won
  S.nb = nb; localStorage.setItem('tn.lastNb', id); S.chunkCache.clear();
  [S.sources, S.notes, S.messages] = loaded;
  S.sources.sort((a, b) => a.created - b.created); S.notes.sort((a, b) => b.t - a.t); S.messages.sort((a, b) => a.t - b.t);
  S.files.clear(); S.tableCache.clear(); S.histPos = -1;
  await ensureTabs();
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
// ---------- source tabs: sets of sources in one notebook; only sources in ticked tabs are used ----------
async function ensureTabs() {
  const nb = S.nb; let changed = false;
  if (!Array.isArray(nb.tabs) || !nb.tabs.length) { nb.tabs = [{ id: uid(), name: 'Sources', active: true }]; changed = true; }
  if (!nb.tabs.some(t => t.id === nb.viewTab)) { nb.viewTab = nb.tabs[0].id; changed = true; }
  const ids = new Set(nb.tabs.map(t => t.id));
  for (const src of S.sources) {
    const keep = (src.tabs || []).filter(id => ids.has(id));
    if (!keep.length || keep.length !== (src.tabs || []).length) { src.tabs = keep.length ? keep : [nb.tabs[0].id]; await db.put('sources', src); }
  }
  if (changed) await db.put('notebooks', nb);
}
const tabOf = id => S.nb.tabs.find(t => t.id === id);
const activeTabIds = () => new Set(S.nb.tabs.filter(t => t.active).map(t => t.id));
const inActiveTab = src => (src.tabs || []).some(id => activeTabIds().has(id));
async function saveNb() { await db.touch(S.nb); }
function renderTabs() {
  const nav = $('#srcTabs'); nav.innerHTML = '';
  for (const t of S.nb.tabs) {
    const n = S.sources.filter(x => (x.tabs || []).includes(t.id)).length;
    const cb = h('input', { type: 'checkbox', checked: t.active, title: 'Use this tab\'s sources in chat and Studio', onclick: e => e.stopPropagation(),
      onchange: async e => { t.active = e.target.checked; await saveNb(); renderSources(); } });
    nav.append(h('div', { class: 'src-tab' + (t.id === S.nb.viewTab ? ' view' : '') + (t.active ? ' active' : ''), title: 'Click to show · double-click to rename · tick to use in chat',
      onclick: async () => { if (S.nb.viewTab === t.id) return; S.nb.viewTab = t.id; await db.put('notebooks', S.nb); renderSources(); },
      ondblclick: async () => { const v = prompt('Tab name', t.name); if (v && v.trim()) { t.name = v.trim().slice(0, 40); await saveNb(); renderSources(); } } },
      cb, h('span', { class: 'tab-name' }, t.name), h('small', {}, String(n)),
      S.nb.tabs.length > 1 ? h('button', { class: 'icon', title: 'Delete this tab', onclick: e => { e.stopPropagation(); deleteTab(t); } }, '✕') : null));
  }
  nav.append(h('button', { class: 'tab-add', title: 'New source tab', onclick: addTab }, '＋'));
}
async function addTab() {
  const name = prompt('Name of the new source tab', `Set ${S.nb.tabs.length + 1}`);
  if (!name || !name.trim()) return;
  const t = { id: uid(), name: name.trim().slice(0, 40), active: true };
  S.nb.tabs.push(t); S.nb.viewTab = t.id; await saveNb(); renderSources();
}
async function deleteTab(t) {
  const only = S.sources.filter(x => (x.tabs || []).length === 1 && x.tabs[0] === t.id);
  const rest = S.nb.tabs.filter(x => x.id !== t.id);
  if (!confirm(`Delete the tab “${t.name}”?` + (only.length ? `\n\nIts ${only.length} source(s) are not in any other tab and will move to “${rest[0].name}”.` : ''))) return;
  for (const x of S.sources) if ((x.tabs || []).includes(t.id)) { x.tabs = x.tabs.filter(id => id !== t.id); if (!x.tabs.length) x.tabs = [rest[0].id]; await db.put('sources', x); }
  S.nb.tabs = rest; if (S.nb.viewTab === t.id) S.nb.viewTab = rest[0].id;
  await saveNb(); renderSources();
}
function tabMenu(src, anchor) {
  const p = $('#popover'); p.innerHTML = '';
  p.append(h('div', { class: 'menu' }, h('div', { class: 'menu-head' }, `Tabs for “${src.name.slice(0, 40)}”`),
    ...S.nb.tabs.map(t => h('label', { class: 'check-row menu-item' }, h('input', { type: 'checkbox', checked: (src.tabs || []).includes(t.id), onchange: async e => {
      const set = new Set(src.tabs || []); e.target.checked ? set.add(t.id) : set.delete(t.id);
      if (!set.size) { e.target.checked = true; return toast('A source must be in at least one tab', true); }
      src.tabs = [...set]; await db.put('sources', src); await saveNb(); renderSources();
    } }), t.name)),
    h('div', { class: 'hint', style: { padding: '4px 6px' } }, 'A source can be in several tabs (e.g. one rubric for every set of answers).')));
  p.hidden = false; const r = anchor.getBoundingClientRect();
  p.style.left = Math.min(r.left, innerWidth - p.offsetWidth - 10) + 'px'; p.style.top = (r.bottom + 4) + 'px';
}

function renderSources() {
  renderTabs();
  const ul = $('#srcList'); ul.innerHTML = '';
  const view = S.sources.filter(x => (x.tabs || []).includes(S.nb.viewTab)), used = enabledSources().length;
  $('#srcCount').textContent = S.sources.length ? `(${used} of ${S.sources.length} used in chat)` : '';
  $('#srcAll').checked = view.length > 0 && view.every(x => x.enabled);
  $('#dropHint').style.display = view.length > 3 ? 'none' : '';
  const viewTab = tabOf(S.nb.viewTab);
  if (viewTab && !viewTab.active && view.length) ul.append(h('li', { class: 'warn-box' }, `This tab is not ticked, so its sources are not used in chat. Tick “${viewTab.name}” above to use them.`));
  for (const s of view) {
    const role = h('select', { title: 'What this source is (guides the assistant, e.g. rubric vs submission)', onchange: async e => { s.role = e.target.value; await db.put('sources', s); await saveNb(); } },
      Object.entries(ROLES).map(([k, v]) => h('option', { value: k, selected: s.role === k }, v)));
    const cb = h('input', { type: 'checkbox', checked: s.enabled, title: 'Include in chat and Studio', onchange: async e => { s.enabled = e.target.checked; await db.put('sources', s); await saveNb(); renderSources(); } });
    const tk = Math.ceil((s.chars || 0) / 3.6), tokens = !s.chars ? '' : tk < 1000 ? `${tk} tok` : `~${Math.round(tk / 1000)}k tok`;
    const nTabs = (s.tabs || []).length;
    ul.append(h('li', { class: 'src-item' + (s.status === 'busy' ? ' busy' : s.status === 'error' ? ' err' : ''), 'data-id': s.id },
      cb, h('span', { class: 'name', title: s.name, onclick: () => viewSource(s) }, `${KIND_ICON[s.kind] || '📃'} ${s.name}`),
      h('button', { class: 'icon', title: 'Remove source from the notebook', onclick: async () => { if (!confirm(`Remove "${s.name}" from the notebook${nTabs > 1 ? ' (all tabs)' : ''}?`)) return; await db.deleteSource(s.id); S.sources = S.sources.filter(x => x !== s); S.chunkCache.delete(s.id); S.files.delete(s.id); await saveNb(); renderSources(); } }, '✕'),
      h('div', { class: 'sub' }, s.status === 'busy' ? h('span', {}, s.progress || 'Reading…') : s.status === 'error' ? h('span', { title: s.error }, '⚠ ' + s.error) :
        [role, h('span', {}, tokens), s.meta?.embModel ? h('span', { title: `Semantic search: ${s.meta.embModel}` }, '🧭') : null,
          s.tables ? h('span', { title: 'Table kept for Thistle Plot' }, '📊') : null,
          S.files.has(s.id) ? h('span', { title: `Original file linked: ${S.files.get(s.id).name}` }, '🔗') : null,
          h('button', { class: 'icon tabs-btn', title: 'Which tabs this source is in', onclick: e => tabMenu(s, e.currentTarget) }, nTabs > 1 ? `📁${nTabs}` : '📁')])));
  }
}
async function addFiles(files) {
  if (!S.nb) return;
  for (const file of files) {
    if (file.name.toLowerCase().endsWith('.tnote')) { await openTnote(file); continue; }
    const s = { id: uid(), nb: S.nb.id, name: file.name, kind: 'text', role: 'reference', enabled: true, created: Date.now(), status: 'busy', chars: 0, meta: {},
      tabs: [S.nb.viewTab], file: fileInfo(file) };
    S.sources.push(s); S.files.set(s.id, file); renderSources();
    try {
      const ctx = { elm: S.elm, visionModel: visionModel(), transcriptionModel: transcriptionModel() || 'whisper-1', onCampusOnly: onCampus(),
        log: m => { s.progress = m; renderSources(); } };
      if (/\.(mp3|m4a|wav|webm|mp4|mpeg|mpga|ogg|flac)$/i.test(file.name) && onCampus() && !transcriptionModel()) throw new Error('No on-campus transcription model on ELM; this notebook is on-campus only.');
      s.file.sha256 = await fileHash(file);
      const r = await parseFile(file, ctx);
      await finishSource(s, r);
    } catch (e) {
      console.error(e); s.status = 'error'; s.error = e.message; renderSources();
    }
  }
}
async function finishSource(s, r, { replace = false } = {}) {
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
  s.status = 'ready'; delete s.progress;
  if (replace) await db.replaceSource(s, chunks); // all or nothing
  else { await db.putMany('chunks', chunks); await db.put('sources', s); }
  if (!s.tables && r.sessionTables) S.tableCache.set(s.id, r.sessionTables);
  else S.tableCache.delete(s.id);
  S.chunkCache.set(s.id, chunks); await db.touch(S.nb); renderSources();
}
const fileInfo = f => ({ name: f.name, size: f.size, lastModified: f.lastModified, path: f.webkitRelativePath || '' });
// Content fingerprint, so a moved or copied file (new date, same bytes) is not mistaken for an edited one
async function fileHash(f) {
  try { const d = await crypto.subtle.digest('SHA-256', await f.arrayBuffer()); return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join(''); }
  catch { return null; }
}
async function addTextSource(name, text, kind = 'text', role = 'reference', extra = {}) {
  const s = { id: uid(), nb: S.nb.id, name, kind, role, enabled: true, created: Date.now(), status: 'busy', chars: 0, meta: {}, tabs: [S.nb.viewTab], noFile: true };
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
  const f = S.files.get(s.id), tools = h('div', { class: 'tp-btns', style: { marginBottom: '8px' } });
  if (f) tools.append(h('button', { class: 'btn small', title: 'Open the original file in a new tab (PDFs open in the browser)', onclick: () => openOriginal(s) }, '📄 Open original'),
    h('button', { class: 'btn small', title: 'Read the file again (e.g. after you edited it) and rebuild the search index', onclick: () => { closeModal(); rereadSource(s); } }, '↻ Re-read from file'));
  else if (!s.noFile) tools.append(h('span', { class: 'hint' }, 'Original file not linked in this session. '),
    h('button', { class: 'btn small', onclick: async () => { const [file] = await pickFiles({}); if (file) { await linkFile(s, file); closeModal(); viewSource(s, highlight); } } }, '📂 Locate original…'));
  if (s.file) tools.append(h('span', { class: 'hint' }, ` ${s.file.path || s.file.name} · ${fmtBytes(s.file.size)} · ${new Date(s.file.lastModified).toLocaleDateString()}`));
  body.prepend(tools);
  modal(`${KIND_ICON[s.kind] || ''} ${s.name}`, body);
  setTimeout(() => body.querySelector('mark')?.scrollIntoView({ block: 'center' }), 60);
}

// ---------- original files (moved/renamed on disk) ----------
// Browsers cannot keep file paths or reopen files by themselves, so (as in Thistle Flow) the user points to the folder
// or the files; matching names are linked for this session. The notebook keeps the extracted text, so chat works without
// originals; they are needed to open the original, re-read a changed file, or analyse tables too large to keep.
function pickFiles({ folder = false, multiple = false, accept = '' } = {}) {
  return new Promise(res => {
    const inp = h('input', { type: 'file', class: 'file-input' });
    if (folder) inp.webkitdirectory = true; if (multiple || folder) inp.multiple = true; if (accept && !IS_IOS) inp.accept = accept;
    inp.onchange = () => { res([...inp.files]); inp.remove(); };
    inp.oncancel = () => { res([]); inp.remove(); };
    document.body.append(inp); inp.click();
  });
}
const fileSources = () => S.sources.filter(s => !s.noFile && s.kind !== 'note');
// Changed = different content (fingerprint); sources added before v0.4.0 have none, so size and date are compared
const changedOnDisk = (s, f) => !!(s.file && f && (s.file.sha256 && f._sha256 ? f._sha256 !== s.file.sha256 : (f.size !== s.file.size || f.lastModified !== s.file.lastModified)));
async function linkFile(s, file) {
  if (s.file?.sha256 && file._sha256 === undefined) file._sha256 = file.size === s.file.size ? await fileHash(file) : 'size-differs';
  S.files.set(s.id, file);
  if (s.kind === 'dataset' && !s.tables && !S.tableCache.has(s.id) && !changedOnDisk(s, file)) {
    try { const r = await parseFile(file, parseCtx(s)); const t = r.tables || r.sessionTables; if (t) S.tableCache.set(s.id, t); } catch (e) { toast(`Could not read the table in ${file.name}: ${e.message}`, true); }
  }
  renderSources();
}
const parseCtx = s => ({ elm: S.elm, visionModel: visionModel(), transcriptionModel: transcriptionModel() || 'whisper-1', onCampusOnly: onCampus(), log: m => { s.progress = m; renderSources(); } });
// Re-read: parse and index the new file first, then replace the source and its passages in one transaction. If reading
// or saving fails, the previous version (record, passages, tables) stays as it was (v0.6.2).
async function rereadSource(s) {
  const file = S.files.get(s.id); if (!file) return toast('Link the original file first (📂 Find files)', true);
  const before = s.status; s.status = 'busy'; renderSources();
  try {
    const r = await parseFile(file, parseCtx(s));
    const ns = { ...s, file: { ...fileInfo(file), sha256: await fileHash(file) } }; delete ns.error;
    await finishSource(ns, { ...r, role: s.role }, { replace: true });
    for (const k of Object.keys(s)) if (!(k in ns)) delete s[k];
    Object.assign(s, ns); file._sha256 = ns.file.sha256; renderSources(); toast(`Re-read “${s.name}”`);
  } catch (e) { s.status = before; delete s.progress; renderSources(); toast(`Could not re-read “${s.name}”: ${e.message}. The previous version is kept.`, true, 6000); }
}
function openOriginal(s) {
  const f = S.files.get(s.id); if (!f) return;
  const url = URL.createObjectURL(f); window.open(url, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(url), 120000);
}
function findFilesDialog() {
  const body = h('div');
  const match = async files => {
    const list = fileSources(); let n = 0;
    for (const s of list) {
      if (S.files.has(s.id)) continue;
      const want = (s.file?.name || s.name).toLowerCase();
      const cands = files.filter(f => f.name.toLowerCase() === want);
      const f = cands.find(c => s.file && c.size === s.file.size) || cands.find(c => s.file?.path && c.webkitRelativePath.endsWith(s.file.path.split('/').slice(1).join('/'))) || cands[0];
      if (f) { n++; await linkFile(s, f); }
    }
    return n;
  };
  const draw = () => {
    const list = fileSources(), missing = list.filter(s => !S.files.has(s.id));
    body.replaceChildren(
      h('div', { class: 'hint-box' }, 'The notebook keeps the text of every source, so chat works without the original files. Link them again after moving or renaming them to ',
        h('b', {}, 'open the original'), ', ', h('b', {}, 're-read a file you changed'), ', or analyse ', h('b', {}, 'tables too large to keep'), '. ',
        'Browsers cannot find files on their own: ', h('b', {}, 'choose the folder'), ' (every file with a matching name is linked) or the files; a renamed file can be assigned with ', h('b', {}, 'Choose…'), '. Links last until the page is closed.'),
      list.length ? h('table', { class: 'diag' }, h('tr', {}, h('th', {}, 'Source'), h('th', {}, 'Expected file'), h('th', {}, 'Status'), h('th', {})),
        list.map(s => { const f = S.files.get(s.id), ch = changedOnDisk(s, f);
          return h('tr', {}, h('td', {}, s.name), h('td', { class: 'hint' }, s.file ? `${s.file.path || s.file.name} · ${fmtBytes(s.file.size)} · ${new Date(s.file.lastModified).toLocaleDateString()}` : s.name),
            h('td', {}, f ? (ch ? '⚠ linked — the file has changed since it was added' : `🔗 linked${f.name !== (s.file?.name || s.name) ? ` (${f.name})` : ''}`) : 'not linked'),
            h('td', {}, f && ch ? h('button', { class: 'btn small primary', onclick: async () => { await rereadSource(s); draw(); } }, '↻ Re-read') : null,
              h('button', { class: 'btn small', onclick: async () => { const [x] = await pickFiles({}); if (x) { await linkFile(s, x); draw(); } } }, 'Choose…'))); })) : h('p', {}, 'This notebook has no file-based sources.'),
      h('div', { class: 'modal-foot' },
        IS_IOS ? null : h('button', { class: 'btn primary', onclick: async () => { const fs = await pickFiles({ folder: true }); const n = await match(fs); toast(n ? `Linked ${n} file(s)` : `None of the ${fs.length} file(s) in that folder has a matching name`, !n); draw(); } }, '📂 Choose folder…'),
        h('button', { class: 'btn', onclick: async () => { const fs = await pickFiles({ multiple: true }); const n = await match(fs); toast(n ? `Linked ${n} file(s)` : 'No matching file names', !n); draw(); } }, 'Choose files…'),
        h('button', { class: 'btn', onclick: closeModal }, missing.length ? 'Later' : 'Done')));
  };
  draw();
  modal(`Find the original files for “${S.nb.name}”`, body);
}

// ---------- closing a notebook ----------
async function closeNotebook() {
  if (S.busy) return toast('Wait for the current answer to finish', true);
  const nb = S.nb, empty = !S.sources.length && !S.messages.length && !S.notes.length;
  const dirty = (nb.updated || 0) > (nb.savedAt || 0);
  const finish = async () => {
    closeModal(); await db.deleteNotebook(nb.id);
    let list = await db.listNotebooks(); if (!list.length) list = [await db.createNotebook('Untitled notebook')];
    await openNotebook(list[0].id); toast(`Closed “${nb.name}”`);
  };
  if (empty) { if (confirm(`Close the empty notebook “${nb.name}”?`)) await finish(); return; }
  modal('Close notebook', h('div', {},
    h('p', {}, dirty ? h('b', {}, `“${nb.name}” has changes that are not saved in a .tnote file.`) : `“${nb.name}” has not changed since it was saved (${new Date(nb.savedAt).toLocaleString()}).`),
    h('p', { class: 'hint' }, 'Closing removes the notebook (sources\' text, chat and notes) from this browser. A saved .tnote file can be opened again with 📂 Open. Your original files on disk are not touched.'),
    h('div', { class: 'modal-foot' },
      h('button', { class: 'btn', onclick: closeModal }, 'Cancel'), h('span', { class: 'grow' }),
      h('button', { class: 'btn danger', onclick: finish }, dirty ? 'Close without saving' : 'Close'),
      dirty ? h('button', { class: 'btn primary', onclick: async () => { await saveTnote(); await finish(); } }, '💾 Save and close') : null)));
}

// ---------- resizable panes (as in Thistle Plot / Thistle Flow) ----------
function setupSplitters() {
  const L = $('#paneSources'), R = $('#paneStudio');
  let w = {}; try { w = JSON.parse(localStorage.getItem('tn.paneW') || '{}'); } catch { }
  if (w.l) L.style.width = w.l + 'px'; if (w.r) R.style.width = w.r + 'px';
  const save = () => { try { localStorage.setItem('tn.paneW', JSON.stringify({ l: L.style.width ? L.offsetWidth : null, r: R.style.width ? R.offsetWidth : null })); } catch { } };
  const drag = (el, onMove) => el.addEventListener('pointerdown', e => {
    if (e.button !== 0) return; e.preventDefault(); el.setPointerCapture(e.pointerId); document.body.classList.add('resizing');
    const move = ev => onMove(ev), up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); document.body.classList.remove('resizing'); save(); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  });
  const clamp = v => Math.max(180, Math.min(window.innerWidth * 0.45, v));
  drag($('#splitL'), e => { L.style.width = clamp(e.clientX - L.getBoundingClientRect().left) + 'px'; });
  drag($('#splitR'), e => { R.style.width = clamp(R.getBoundingClientRect().right - e.clientX) + 'px'; });
  const reset = pane => () => { pane.style.width = ''; save(); };
  [[$('#splitL'), reset(L)], [$('#splitR'), reset(R)]].forEach(([el, fn]) => { el.addEventListener('dblclick', fn); onDoubleTap(el, fn); });
}
// Double-tap for touch and pen (a mouse gives a real dblclick), as in Thistle Flow
function onDoubleTap(el, handler) {
  let last = null;
  el.addEventListener('pointerup', e => {
    if (e.pointerType === 'mouse') return;
    const now = performance.now();
    if (last && now - last.t < 350 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 16) { last = null; handler(e); }
    else last = { t: now, x: e.clientX, y: e.clientY };
  });
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
  const del = (label = '🗑') => h('button', { class: 'icon', title: 'Delete this from the chat', onclick: () => deleteMessage(m) }, label);
  if (m.role === 'user') {
    wrap.append(h('div', { class: 'who' }, 'You', h('span', { class: 'grow' }), del()), h('div', { class: 'bubble' }, m.content),
      h('div', { class: 'msg-actions' },
        h('button', { class: 'btn', title: 'Put this question in the box to adjust it (not sent)', onclick: () => toBox(m.content) }, '✎ Copy to box'),
        h('button', { class: 'btn', title: 'Ask this question again now, with the tabs and model selected now', onclick: () => rerun(m) }, '↻ Re-run')));
    return wrap;
  }
  if (m.role === 'searches') { searchesEl(m, wrap); wrap.querySelector('.who').append(h('span', { class: 'grow' }), del()); return wrap; }
  if (m.role === 'results') {
    wrap.append(h('div', { class: 'who' }, '🔬 Thistle Plot results sent to the model', h('span', { class: 'grow' }), del()),
      h('div', { class: 'bubble' }, h('details', {}, h('summary', {}, `${m.meta.count || ''} result(s) — show what was sent`), h('pre', { style: { whiteSpace: 'pre-wrap', fontSize: '11px' } }, m.content))));
    return wrap;
  }
  const meta = m.meta || {};
  const who = h('div', { class: 'who' }, `${meta.model?.includes('/') ? '🏛' : '☁'} ${meta.model || 'assistant'}`,
    meta.ctxMode && meta.ctxMode !== 'none' ? h('span', {}, `· ${meta.ctxMode === 'full' ? 'full text' : 'retrieved passages'} of ${meta.nSources} source(s)`) : null,
    meta.tabNames?.length ? h('button', { class: 'link-btn', title: 'Show the tabs and sources used for this answer', onclick: () => usedSourcesDialog(m) }, `· 📁 ${meta.tabNames.join(', ')}`) : null,
    meta.studio ? h('span', {}, `· Studio: ${meta.studio}`) : null, h('span', { class: 'grow' }), del());
  const bubble = h('div', { class: 'bubble' });
  if (meta.web?.citations?.length) bubble.append(h('details', { class: 'web-list' }, h('summary', {}, `🌐 Web findings (${meta.web.citations.length} sources, via ${meta.web.model})`),
    h('ol', {}, meta.web.citations.map(c => h('li', {}, h('a', { href: c.url, target: '_blank', rel: 'noopener noreferrer' }, c.title))))));
  const doc = { title: firstLine(m.content), content: m.content, cites: meta.cites || {}, web: meta.web };
  bubble.append(renderMarkdown(m.content, { cites: meta.cites || {}, web: meta.web?.citations || [], onCite: (n, c, e) => showCite(c, e), cardSlot: (k, slot) => slot.replaceWith(tpCard(m, k)), tableTools: tableTools(doc) }));
  if (meta.webNote && !meta.webError) bubble.prepend(h('div', { class: 'warn-box' }, `🌐 No web search for this answer: ${meta.webNote}. It is based on your sources and the model's own knowledge, which may be out of date. `,
    h('button', { class: 'btn small', onclick: () => suggestSearches(m) }, '🔎 Suggest searches I can run')));
  if (meta.webError) bubble.prepend(h('div', { class: 'warn-box' }, '🌐 Web search did not run, so this answer uses only your sources and the model\'s own knowledge. ', h('details', {}, h('summary', {}, 'Why'), meta.webError)));
  if (meta.error) bubble.append(h('div', { class: 'err-box' }, meta.error));
  wrap.append(who, bubble, h('div', { class: 'msg-actions' },
    questionOf(m) ? h('button', { class: 'btn', title: 'Ask the same question again (new answer below; this one is kept)', onclick: () => rerun(questionOf(m)) }, '↻ Regenerate') : null,
    h('button', { class: 'btn', onclick: () => saveNote(m.content.replace(/```thistle-plot[\s\S]*?```/g, ''), firstLine(m.content), meta.cites, meta.web) }, '🗒 Save as note'),
    h('button', { class: 'btn export-btn', title: 'Word, Excel, CSV, Markdown, HTML or PDF', onclick: e => exportMenu(e.currentTarget, doc) }, '⤓ Export ▾')));
  return wrap;
}
// ---------- chat housekeeping: delete, re-run, copy to box, trace sources ----------
function questionOf(a) { // the user question an answer belongs to
  const i = S.messages.indexOf(a);
  for (let k = i - 1; k >= 0; k--) { const m = S.messages[k]; if (m.role === 'user') return m; if (m.role === 'assistant' && !m.meta?.studio) break; }
  return null;
}
async function deleteMessage(m) {
  if (S.busy) return toast('Wait for the current answer to finish', true);
  let doomed = [m];
  if (m.role === 'user') { // the question and everything that answered it, up to the next question
    const i = S.messages.indexOf(m);
    for (let k = i + 1; k < S.messages.length && S.messages[k].role !== 'user'; k++) doomed.push(S.messages[k]);
    if (!confirm(doomed.length > 1 ? `Delete this question and its ${doomed.length - 1} answer(s)?` : 'Delete this question?')) return;
  } else if (!confirm(m.role === 'assistant' ? 'Delete this answer?' : 'Delete this from the chat?')) return;
  for (const x of doomed) await db.del('messages', x.id);
  S.messages = S.messages.filter(x => !doomed.includes(x)); await saveNb(); renderChat();
}
function toBox(text) {
  const ta = $('#prompt'); ta.value = text; ta.focus(); ta.setSelectionRange(text.length, text.length);
  ta.scrollIntoView({ block: 'nearest' }); toast('Question placed in the box: adjust it, then press Send');
}
function rerun(q) { if (q) send(q.content); }
const pastQuestions = () => [...new Set(S.messages.filter(m => m.role === 'user').map(m => m.content).reverse())];
function historyMenu(anchor) {
  const qs = pastQuestions().slice(0, 25), p = $('#popover'); p.innerHTML = '';
  p.append(h('div', { class: 'menu' }, h('div', { class: 'menu-head' }, qs.length ? 'Earlier questions: click to put in the box (not sent)' : 'No earlier questions in this notebook'),
    ...qs.map(q => h('button', { class: 'menu-item', title: q, onclick: () => { p.hidden = true; toBox(q); } }, h('span', {}, q.length > 110 ? q.slice(0, 110) + '…' : q)))));
  p.hidden = false; const r = anchor.getBoundingClientRect();
  p.style.left = Math.max(8, Math.min(r.left, innerWidth - p.offsetWidth - 10)) + 'px';
  p.style.top = Math.max(8, r.top - p.offsetHeight - 6) + 'px';
}
function usedSourcesDialog(m) {
  const meta = m.meta || {}, ids = meta.sourceIds || [];
  const rows = ids.map((id, i) => ({ id, name: meta.sourceNames?.[i] || id, src: S.sources.find(x => x.id === id) }));
  modal('Sources used for this answer', h('div', {},
    h('p', {}, `Tabs: ${(meta.tabNames || []).join(', ') || '—'} · model ${meta.model || '?'} · ${new Date(m.t).toLocaleString()}`),
    h('ul', { class: 'used-list' }, rows.map(r => h('li', {}, r.src ? h('button', { class: 'link-btn', onclick: () => viewSource(r.src) }, r.name) : h('span', { class: 'hint' }, `${r.name} (no longer in this notebook)`)))),
    h('div', { class: 'modal-foot' }, h('button', { class: 'btn', title: 'Tick exactly the tabs that were used for this answer', onclick: async () => {
      const want = new Set(meta.tabIds || []); if (!S.nb.tabs.some(t => want.has(t.id))) return toast('Those tabs no longer exist', true);
      S.nb.tabs.forEach(t => (t.active = want.has(t.id))); await saveNb(); renderSources(); closeModal(); toast('Tabs set as for that answer');
    } }, '📁 Use the same tabs now'))));
}
const firstLine = t => (String(t).replace(/[#*`>]/g, '').split('\n').find(l => l.trim()) || 'Note').trim().slice(0, 70);
// The cited source: by id; by file name only when exactly one source has that name (v0.6.2: a same-named earlier source won)
function citeSource(c, list = S.sources) {
  const byId = list.find(x => x.id === c.srcId); if (byId) return byId;
  const byName = list.filter(x => x.name === c.source); return byName.length === 1 ? byName[0] : null;
}
function showCite(c, e) {
  const p = $('#popover');
  p.innerHTML = ''; p.append(h('div', {}, h('b', {}, c.source), ` — ${c.loc}`), h('div', { class: 'ex' }, c.text),
    h('button', { class: 'btn small', onclick: () => { p.hidden = true; const s = citeSource(c); if (s) viewSource(s, c); else toast('That source is no longer in this notebook (or two sources share its name)', true); } }, 'Open in source'));
  p.hidden = false;
  const r = e.target.getBoundingClientRect();
  p.style.left = Math.min(r.left, innerWidth - p.offsetWidth - 10) + 'px';
  p.style.top = (r.bottom + 6 + p.offsetHeight > innerHeight ? Math.max(10, r.top - p.offsetHeight - 6) : r.bottom + 6) + 'px';
}

const enabledSources = () => S.sources.filter(s => s.enabled && s.status === 'ready' && inActiveTab(s));
async function prepare(query, sources, budgetOverride) {
  const model = currentModel(), info = S.elm.info(model);
  const chunksBySrc = new Map();
  for (const s of sources) chunksBySrc.set(s.id, await chunksOf(s));
  const budget = Math.max(4000, Math.min(budgetOverride || +S.settings.fulltextBudget, Math.floor(info.context * 0.6) - 8000));
  const embedQuery = async (q, m) => (allowed(m) ? (await S.elm.embed([q], m))[0] : null);
  return buildContext({ sources, chunksBySrc, query, budgetTokens: budget, maxChunks: +S.settings.retrievalChunks, embedQuery });
}
function historyFor(upto) {
  const msgs = S.messages.slice(0, upto).filter(m => m.role !== 'searches').slice(-12);
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
    Object.assign(a.meta, { cites, ctxMode, nSources: sources.length, sourceIds: sources.map(x => x.id), sourceNames: sources.map(x => x.name).slice(0, 200),
      tabIds: [...activeTabIds()], tabNames: S.nb.tabs.filter(t => t.active).map(t => t.name) });
    let web = null;
    if ($('#webToggle').checked && !onCampus() && depth === 0) {
      el.querySelector('.who').textContent = `🌐 searching the web via ${searchModel()}…`;
      try { web = await S.elm.webSearch(searchModel(), query); a.meta.web = web; setWebStatus('ok', web.route); }
      catch (e) {
        a.meta.webError = e.message;
        if (e.attempts) setWebStatus('unavailable', e.attempts.map(x => x.error).join(' / ')); // ELM refused every route
      }
    }
    // The question asks for a web search but none ran: say why, in the answer and to the model
    if (!web && depth === 0 && WANTS_WEB.test(query)) {
      a.meta.webNote = onCampus() ? 'this notebook is on-campus only, so web search is off'
        : a.meta.webError ? 'the search was refused by ELM'
        : S.settings.webSearchStatus === 'unavailable' ? 'ELM does not allow web search with this API key (⚙ Settings → Test web search)'
        : 'the 🌐 Web search box was not ticked';
    }
    const datasets = sources.filter(tablesOf).map(s => ({ name: s.name, tables: tablesOf(s) }));
    const sys = systemPrompt({ mode: mode || $('#modeSelect').value, tone: tone ?? $('#toneSelect').value, hasSources: !!sources.length, ctxMode,
      webEnabled: !!web, webNote: a.meta.webNote || (a.meta.webError ? 'the search was refused by ELM' : ''), datasets, today: new Date().toDateString() })
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
  } finally { S.abort = null; }
  // Save and show the answer before accepting the next request (no gap where a new message could jump ahead)
  try { S.messages.push(a); await db.put('messages', a); await db.touch(S.nb); el.replaceWith(messageEl(a)); }
  finally { setBusy(false); }
  refreshCosts();
  // Analyses requested by the model → run in Thistle Plot, then hand results back (bounded rounds)
  const specs = parseSpecs(a.content).filter(s => s.ok);
  if (specs.length && $('#autoRunToggle').checked && depth < +S.settings.autoRunRounds && !a.meta.error) await runAllAndInterpret(a, depth);
}
const WANTS_WEB = /\b(web[ -]?search|search (the )?(web|internet|online)|google|look (it )?up online|(latest|recent|new) (papers?|publications?|literature|studies|research)|up[ -]?to[ -]?date|current literature)\b/i;
// ---------------- Suggest searches ----------------
// ELM writes database queries; the app shows them as links. No request goes to those sites unless the user clicks.
async function suggestSearches(forMsg = null) {
  if (S.busy) return toast('Wait for the current answer to finish', true);
  if (!S.settings.apiKey) return settingsDialog();
  const model = currentModel();
  if (!allowed(model)) return toast('This notebook is on-campus only: choose a 🏛 model', true);
  const idx = forMsg ? S.messages.indexOf(forMsg) : S.messages.length;
  const typed = forMsg ? '' : $('#prompt').value.trim();
  const lastUser = [...S.messages.slice(0, idx)].reverse().find(m => m.role === 'user');
  const lastAns = forMsg || [...S.messages.slice(0, idx)].reverse().find(m => m.role === 'assistant' && !m.meta?.error);
  const question = typed || lastUser?.content || '';
  if (!question) return toast('Type a question first (or ask one in the chat)', true);
  const titles = enabledSources().map(s => s.name).slice(0, 40).join('; ');
  const user = `Question: ${question}\n\n` + (lastAns && !typed ? `Current answer to check or update (excerpt):\n${lastAns.content.replace(/```thistle-plot[\s\S]*?```/g, '').slice(0, 3000)}\n\n` : '') +
    (titles ? `The user already has these sources: ${titles}\n` : '') + `Year now: ${new Date().getFullYear()}.`;
  setBusy(true);
  const note = h('div', { class: 'msg searches' }, h('div', { class: 'who' }, `🔎 ${model} · writing searches…`));
  $('#chatLog').append(note); note.scrollIntoView({ block: 'end' });
  try {
    S.abort = new AbortController();
    const text = await S.elm.chat(model, [{ role: 'system', content: SEARCH_PROMPT }, { role: 'user', content: user }], { maxTokens: 1500, temperature: 0.2, signal: S.abort.signal });
    const items = parseSuggestions(text);
    const m = { id: uid(), nb: S.nb.id, role: 'searches', content: items.map(i => `${SEARCH_DBS[i.db].label}: ${i.query}`).join('\n'), t: Date.now(), meta: { items, model, question: question.slice(0, 300) } };
    S.messages.push(m); await db.put('messages', m);
    const shown = messageEl(m); note.replaceWith(shown); shown.scrollIntoView({ block: 'start' });
    if (typed) $('#prompt').value = '';
  } catch (e) { note.remove(); toast(e.message, true, 6000); }
  finally { setBusy(false); S.abort = null; refreshCosts(); }
}
function searchesEl(m, wrap) {
  const since = recentSince(), items = m.meta?.items || [];
  wrap.append(h('div', { class: 'who' }, `🔎 Suggested searches · ${m.meta?.model || ''}`),
    h('div', { class: 'bubble' },
      h('div', { class: 'hint' }, `For: “${(m.meta?.question || '').slice(0, 160)}”`),
      h('ul', { class: 'search-list' }, items.map(i => {
        const dbx = SEARCH_DBS[i.db];
        return h('li', {}, h('b', {}, dbx.label), ' ', h('code', {}, i.query), i.why ? h('div', { class: 'hint' }, i.why) : null,
          h('div', { class: 'search-links' },
            h('a', { class: 'btn small', href: dbx.url(i.query), target: '_blank', rel: 'noopener noreferrer' }, `Open in ${dbx.label} ↗`),
            i.db !== 'biorxiv' ? h('a', { class: 'btn small', href: dbx.url(i.query, since), target: '_blank', rel: 'noopener noreferrer' }, `Since ${since} ↗`) : null,
            h('button', { class: 'btn small', onclick: () => navigator.clipboard.writeText(i.query).then(() => toast('Search copied')) }, '📋 Copy')));
      })),
      h('div', { class: onCampus() ? 'warn-box' : 'hint-box' },
        (onCampus() ? 'Check the search words contain nothing confidential before opening them. ' : '') +
        'Thistle Notebook does not contact these sites: a link sends only its search words, and only when you click it. ' +
        'Download the papers you want and add them with ＋ Add sources, then ask again.')));
  return wrap;
}

function setBusy(b) { S.busy = b; $('#btnSend').disabled = b; $('#btnStop').disabled = !b; }

// ---------------- Thistle Plot analysis cards ----------------
// Tables kept in the notebook, or re-read this session from a linked original (datasets too large to keep)
const tablesOf = s => s.tables || S.tableCache.get(s.id) || null;
// Datasets an analysis card may use: ticked, ready and in an active tab (as offered to the model), and among the sources
// the answer was written from (v0.6.3: an unticked dataset could run and reach the interpretation)
function datasetsFor(m) {
  const used = Array.isArray(m?.meta?.sourceIds) ? new Set(m.meta.sourceIds) : null;
  return enabledSources().filter(s => tablesOf(s) && (!used || used.has(s.id))).map(s => ({ name: s.name, tables: tablesOf(s) }));
}
function findEligible(spec, m) {
  const eligible = datasetsFor(m);
  try { return findTable(spec, eligible); }
  catch (e) {
    // explain eligibility only when the named dataset exists solely among excluded sources; a sheet, ambiguity or other
    // error about an eligible dataset keeps its own message (v0.6.4, independent review)
    const want = String(spec.dataset ?? '').trim().toLowerCase(), stem = n => n.toLowerCase().replace(/\.\w+$/, '');
    const named = n => want && (n.toLowerCase() === want || stem(n) === want);
    if (!want || eligible.some(d => named(d.name))) throw e;
    const off = S.sources.find(s => tablesOf(s) && named(s.name));
    if (off) throw new Error(`Dataset "${off.name}" is ${!off.enabled || !inActiveTab(off) ? 'not ticked, or only in a source tab that is not ticked' : 'not one of the sources this answer used'}, so it is not used. Tick it (and its tab) and ask again to analyse it.`);
    throw e;
  }
}
function tpCard(m, k) {
  const parsed = parseSpecs(m.content)[k];
  const card = h('div', { class: 'tp-card' });
  if (!parsed) return card;
  if (!parsed.ok) { card.append(h('div', { class: 'err-box' }, parsed.error), h('pre', {}, parsed.raw)); return card; }
  const spec = parsed.spec, res = m.meta?.tp?.[k];
  const testName = TP_TESTS[spec.test]?.[0] || spec.test;
  let built = null, buildErr = null;
  try { const { table } = findEligible(spec, m); built = buildG({ ...spec }, table); } catch (e) { buildErr = e.message; }
  card.append(h('div', { class: 'tp-title' }, '📊 ', spec.title || testName,
    res ? h('span', { class: 'status ' + (res.status === 'ok' ? 'ok' : 'err') }, res.status === 'ok' ? 'run in Thistle Plot' : 'failed') : h('span', { class: 'status' }, 'proposed')),
  h('div', { class: 'tp-meta' }, `${testName} · ${spec._dataset || spec.dataset || '?'}${spec.sheet ? ' [' + spec.sheet + ']' : ''} · ${describeSpec(spec)}`),
  spec.why ? h('div', {}, '💡 ', spec.why) : null);
  // A successful run keeps the table it used (res.G): its .tplot and 👁 show that table with that result, even if the source
  // was edited or removed since (v0.6.2: the download paired an old result with a freshly rebuilt table)
  const okRun = res?.status === 'ok' ? res : res?.lastOk || null, ranG = okRun?.G || null;
  if (buildErr && !ranG) card.append(h('div', { class: 'err-box' }, buildErr));
  if (buildErr && ranG) card.append(h('div', { class: 'hint' }, `The data for this analysis is not available now (${buildErr}). ⤓ .tplot and 👁 still give the table and result of the run below.`));
  if (ranG && built && JSON.stringify(ranG) !== JSON.stringify(built.G)) card.append(h('div', { class: 'warn-box' }, 'The source data changed since this run. ⤓ .tplot and 👁 give the table the result below came from; ↻ Run again to use the current data.'));
  if (built) {
    const G = built.G;
    card.append(h('div', { class: 'preview hint' }, `Table for Thistle Plot: ${G.groups.length} column group(s) × ${G.nRows} row(s)${G.nReps > 1 ? ` × ${G.nReps} replicates` : ''} — `,
      G.groups.map(g => `${g.name} (n=${g.data.flat().filter(v => v !== '' && v != null).length})`).join(', '), built.notes.length ? ' · ' + built.notes.join(' ') : ''));
  }
  const btns = h('div', { class: 'tp-btns' });
  const tableG = ranG || built?.G, withResult = okRun && (ranG || built) ? okRun : null;
  if (built) btns.append(h('button', { class: 'btn small primary', onclick: async e => { e.target.disabled = true; await runSpec(m, k); } }, res ? '↻ Run again' : '▶ Run in Thistle Plot'));
  const when = t => t ? new Date(t).toLocaleString() : 'an earlier run';
  if (tableG) {
    btns.append(h('button', { class: 'btn small', title: ranG ? 'Thistle Plot project with the table and result of this run' : 'Thistle Plot project with this table (not run yet)', onclick: () => saveText(tplotFile(tableG, withResult, withResult?.plot, withResult?.appVersion), `${safeName(spec.title || spec.test)}.tplot`, 'application/json') }, '⤓ .tplot'),
      h('button', { class: 'btn small', title: 'Show Thistle Plot with this table loaded', onclick: async () => { try { await S.tp.show(tableG); openDrawer('tp'); } catch (e) { toast(e.message, true); } } }, '👁 Open in Thistle Plot'));
    if (res?.status === 'ok' && !m.meta.interpreted) btns.append(h('button', { class: 'btn small', onclick: () => sendResults(m, 0, true) }, '💬 Interpret results'));
  }
  card.append(btns);
  if (res?.status === 'err') card.append(h('div', { class: 'err-box' }, `The latest run failed (${when(res.at)}): ${res.error}`));
  if (okRun) {
    const box = h('div', { class: 'tp-result' });
    if (res.status === 'err') box.append(h('div', { class: 'hint' }, `Previous successful run (${when(okRun.at)}), kept for reference; ⤓ .tplot and 👁 give this run.`));
    const body = h('div'); body.innerHTML = window.DOMPurify.sanitize(okRun.html, { FORBID_TAGS: ['button', 'input', 'select', 'style'], FORBID_ATTR: ['style', 'onclick'] }); box.append(body);
    if (okRun.plot) box.append(h('img', { src: okRun.plot.image, alt: okRun.plot.title }));
    if (okRun.unknown?.length) box.prepend(h('div', { class: 'warn-box' }, 'Options not found in Thistle Plot (defaults used): ' + okRun.unknown.join('; ')));
    if (okRun.alerts?.length) box.prepend(h('div', { class: 'warn-box' }, 'Thistle Plot says: ' + okRun.alerts.join(' ')));
    card.append(box);
  }
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
    const { table } = findEligible(spec, m);
    const sp = { ...spec }, built = buildG(sp, table);
    const r = await S.tp.run(sp, built.G);
    m.meta.tp[k] = { status: 'ok', ...r, notes: built.notes, G: built.G, at: Date.now() };
  } catch (e) {
    // a failed attempt keeps the last successful run beside it (v0.6.3: the error replaced it)
    console.error(e); const prev = m.meta.tp[k], lastOk = prev?.status === 'ok' ? prev : prev?.lastOk;
    m.meta.tp[k] = { status: 'err', error: e.message, at: Date.now(), ...(lastOk ? { lastOk } : {}) };
  }
  await db.put('messages', m); if (S.nb) await db.touch(S.nb); // a new result is an unsaved change (v0.6.2)
  const old = $(`.msg[data-id="${m.id}"]`); if (old) old.replaceWith(messageEl(m));
  return m.meta.tp[k];
}
async function runAllAndInterpret(m, depth) {
  const specs = parseSpecs(m.content);
  for (let k = 0; k < specs.length; k++) if (specs[k].ok) await runSpec(m, k);
  await sendResults(m, depth);
}
function resultsParts(m) {
  const specs = parseSpecs(m.content), parts = [];
  specs.forEach((p, k) => {
    const r = m.meta.tp?.[k]; if (!p.ok || !r) return;
    if (r.status !== 'ok') { parts.push(`## Analysis ${k + 1}: ${p.spec.title || p.spec.test}\nFAILED: ${r.error}`); return; }
    parts.push(`## Analysis ${k + 1}: ${p.spec.title || r.title} (Thistle Plot v${r.appVersion}, test "${p.spec.test}")\n` +
      (r.notes?.length ? `Data notes: ${r.notes.join(' ')}\n` : '') + (r.applied?.length ? `Options set: ${r.applied.join('; ')}\n` : '') +
      (r.unknown?.length ? `Options NOT found (defaults used): ${r.unknown.join('; ')}\n` : '') + (r.alerts?.length ? `Thistle Plot messages: ${r.alerts.join(' ')}\n` : '') +
      `\n${r.text.slice(0, 12000)}\n\nOptions available for this test: ${r.options.join('; ')}`);
  });
  return parts;
}
const resultsDigest = m => resultsParts(m).join('\n\n---\n\n');
async function sendResults(m, depth, manual = false) {
  const parts = resultsParts(m);
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
    note.meta.model = currentModel(); note.meta.tabNames = S.nb.tabs.filter(t => t.active).map(t => t.name);
  } catch (e) { note.content += `\n\n**Error:** ${e.message}`; }
  finally { delete note.meta.busy; delete note.meta.progress; setBusy(false); }
  await db.put('notes', note); await saveNb(); renderNotes(); refreshCosts(); viewNote(note);
}
async function complete(t, sources, tone, extraUser = '') {
  const model = currentModel();
  if (!allowed(model)) throw new Error('This notebook is on-campus only: choose a 🏛 model.');
  const query = t.prompt + ' ' + extraUser;
  // Marking: give the whole submission + rubric when possible
  const { context, cites, mode: ctxMode } = await prepare(query, sources, t.perSubmission ? 200000 : undefined);
  const datasets = sources.filter(tablesOf).map(s => ({ name: s.name, tables: tablesOf(s) }));
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
  S.notes.unshift(n); await db.put('notes', n); await saveNb(); renderNotes(); toast('Saved to Notes');
}
function viewNote(n) {
  const body = h('div', {});
  const doc = () => ({ title: n.title, content: n.content, cites: n.meta?.cites || {}, web: n.meta?.web });
  const show = () => { body.innerHTML = ''; body.append(renderMarkdown(n.content, { cites: n.meta?.cites || {}, web: n.meta?.web?.citations || [], onCite: (_, c, e) => showCite(c, e), tableTools: tableTools(doc()) })); };
  show();
  const edit = () => {
    const ta = h('textarea', { class: 'note-edit' }); ta.value = n.content;
    const title = h('input', { type: 'text', value: n.title, style: { width: '100%', marginBottom: '6px' } });
    body.innerHTML = ''; body.append(title, ta, h('div', { class: 'modal-foot' }, h('button', { class: 'btn primary', onclick: async () => { n.content = ta.value; n.title = title.value; await db.put('notes', n); await saveNb(); renderNotes(); show(); } }, 'Save')));
  };
    const name = safeName(n.title);
  modal(n.title, h('div', {}, h('div', { class: 'tp-btns', style: { marginBottom: '8px' } },
    h('button', { class: 'btn small', onclick: edit }, '✎ Edit'),
    h('button', { class: 'btn small primary export-btn', title: 'Word, Excel, CSV, Markdown, HTML or PDF', onclick: e => exportMenu(e.currentTarget, doc()) }, '⤓ Export ▾'),
    h('button', { class: 'btn small', onclick: () => saveBlob(markdownToDocx(withRefs(doc()), n.title), `${name}.docx`) }, '⤓ Word'),
    ...(extractTables(n.content).length ? [h('button', { class: 'btn small', title: 'Every table in this report as a sheet, plus the cited sources', onclick: () => exportXlsx(doc()) }, '⤓ Excel')] : []),
    h('button', { class: 'btn small', title: 'Use this note as a source for further questions', onclick: async () => { closeModal(); await addTextSource(n.title, n.content, 'note', 'draft'); } }, '→ Add as source'),
    h('button', { class: 'btn small danger', onclick: async () => { if (!confirm('Delete this note?')) return; await db.del('notes', n.id); S.notes = S.notes.filter(x => x !== n); await saveNb(); renderNotes(); closeModal(); } }, '🗑 Delete')), body));
}
// Exported reports keep their citations readable outside the app: [n] → list of sources + locations
const citedNumbers = content => [...new Set([...String(content).matchAll(/\[(\d+(?:\s*[,–-]\s*\d+)*)\]/g)].flatMap(m => m[1].match(/\d+/g).map(Number)))].sort((a, b) => a - b);
function withRefs(d) {
  const c = d.cites || {}, content = String(d.content).replace(/```thistle-plot[\s\S]*?```/g, '').replace(/<think>[\s\S]*?(<\/think>|$)/g, '');
  const refs = citedNumbers(content).filter(i => c[i]).map(i => `[${i}] ${c[i].source}, ${c[i].loc}`);
  const web = (d.web?.citations || []).map((w, i) => `[W${i + 1}] ${w.title} — ${w.url}`);
  return content + (refs.length || web.length ? `\n\n---\n**Sources cited**\n\n${[...refs, ...web].map(r => '- ' + r).join('\n')}\n` : '');
}
function sourcesSheet(d) {
  const c = d.cites || {}, rows = citedNumbers(d.content).filter(i => c[i]).map(i => [`[${i}]`, c[i].source, c[i].loc, c[i].text.replace(/\s+/g, ' ').slice(0, 500)]);
  (d.web?.citations || []).forEach((w, i) => rows.push([`[W${i + 1}]`, w.title, w.url, '']));
  return rows.length ? [{ title: 'Sources cited', header: ['Citation', 'Source', 'Location', 'Passage (start)'], rows }] : [];
}

// ---------------- exports ----------------
function exportXlsx(d, only = null) {
  const tables = extractTables(d.content), pick = only == null ? tables : [tables[only]];
  if (!pick.length) return toast('This report has no tables', true);
  saveBlob(tablesToXlsx(pick, sourcesSheet(d)), `${safeName(only == null ? d.title : pick[0].title)}.xlsx`);
}
function exportCsv(d, i) { const t = extractTables(d.content)[i]; saveText(tableToCsv(t), `${safeName(t.title)}.csv`, 'text/csv'); }
async function copyTable(d, i) {
  const t = extractTables(d.content)[i], tsv = tableToTsv(t);
  const html = `<table>${[t.header, ...t.rows].map((r, k) => `<tr>${r.map(c => `<${k ? 'td' : 'th'}>${esc(c)}</${k ? 'td' : 'th'}>`).join('')}</tr>`).join('')}</table>`;
  try { await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([tsv], { type: 'text/plain' }), 'text/html': new Blob([html], { type: 'text/html' }) })]); }
  catch { await navigator.clipboard.writeText(tsv); }
  toast('Table copied: paste into Excel or Word');
}
function htmlReport(d) { return reportHtml(d.title, markdownToHtml(withRefs(d))); }
function printReport(d) {
  const url = URL.createObjectURL(new Blob([htmlReport(d)], { type: 'text/html' })), w = window.open(url, '_blank');
  if (!w) { toast('Pop-up blocked: use ⤓ HTML and print from the browser', true); return; }
  w.addEventListener('load', () => { w.focus(); w.print(); }); setTimeout(() => URL.revokeObjectURL(url), 120000);
}
// Small bar under each table: Excel / CSV / Copy
const tableTools = d => i => h('div', { class: 'table-tools' },
  h('button', { class: 'btn small', title: 'This table as an Excel workbook (with the cited sources)', onclick: () => exportXlsx(d, i) }, '⤓ Excel'),
  h('button', { class: 'btn small', title: 'This table as CSV', onclick: () => exportCsv(d, i) }, '⤓ CSV'),
  h('button', { class: 'btn small', title: 'Copy as a table you can paste into Excel or Word', onclick: () => copyTable(d, i) }, '📋 Copy table'));
function exportMenu(anchor, d) {
  const tables = extractTables(d.content), name = safeName(d.title), p = $('#popover');
  const item = (label, hint, fn) => h('button', { class: 'menu-item', onclick: () => { p.hidden = true; fn(); } }, h('span', {}, label), h('small', {}, hint));
  p.innerHTML = '';
  p.append(h('div', { class: 'menu' },
    h('div', { class: 'menu-head' }, `Export “${d.title.slice(0, 50)}”`),
    item('📝 Word (.docx)', 'Formatted report; wide tables on landscape pages', () => saveBlob(markdownToDocx(withRefs(d), d.title), `${name}.docx`)),
    tables.length ? item(`📊 Excel (.xlsx)`, `${tables.length} table${tables.length > 1 ? 's' : ''} as sheets + cited sources`, () => exportXlsx(d)) : null,
    ...tables.map((t, i) => item(`🧾 CSV: ${t.title.slice(0, 40)}`, `${t.rows.length} rows × ${t.header.length} columns`, () => exportCsv(d, i))),
    item('⬇ Markdown (.md)', 'Plain text with headings and tables', () => saveText(withRefs(d), `${name}.md`, 'text/markdown')),
    item('🌐 HTML page (.html)', 'Opens in any browser; easy to share', () => saveText(htmlReport(d), `${name}.html`, 'text/html')),
    item('🖨 Print / save as PDF', 'Opens the print dialog (A4 landscape)', () => printReport(d)),
    item('📋 Copy as Markdown', 'For pasting into other tools', () => navigator.clipboard.writeText(withRefs(d)).then(() => toast('Copied'))),
  ));
  p.hidden = false;
  const r = anchor.getBoundingClientRect();
  p.style.left = Math.max(8, Math.min(r.left, innerWidth - p.offsetWidth - 10)) + 'px';
  p.style.top = (r.bottom + 6 + p.offsetHeight > innerHeight ? Math.max(8, r.top - p.offsetHeight - 6) : r.bottom + 6) + 'px';
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
    const G = await S.tp.exclusive(async () => JSON.parse(JSON.stringify((await S.tp.ready()).eval('G')))); // not mid-run
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
      h('button', { class: 'btn', title: 'Tries each way ELM might offer web search, with one short query (costs a few pence at most)', onclick: () => { apply(); testWebSearch(status); } }, '🌐 Test web search'),
      h('button', { class: 'btn', onclick: async () => { apply(); status.innerHTML = '<div class="hint">Testing…</div>'; try { const ms = await S.elm.models(true); status.innerHTML = `<div class="hint-box">✅ Connected: ${ms.length} models (${ms.filter(m => m.local).length} on-campus).</div>`; } catch (e) { status.innerHTML = `<div class="err-box">${esc(e.message)}</div>`; } } }, 'Test connection'),
      h('button', { class: 'btn primary', onclick: () => { apply(); closeModal(); loadModels(true); } }, 'Save'))));
  function apply() {
    for (const [k, e] of Object.entries(f)) s[k] = e.type === 'number' ? +e.value : e.value.trim();
    s.rememberKey = remember.checked; saveSettings(s); makeElm();
    S.tp = new ThistlePlot(s.tpUrl || defaultSuiteUrl('thistle-plot'), $('#tpHost')); S.tf = new ThistleFlow(s.tfUrl || defaultSuiteUrl('thistle-flow'), $('#tfHost'));
    $('#tpHost').innerHTML = ''; $('#tfHost').innerHTML = '';
  }
}

const ELM_INFO = 'https://information-services.ed.ac.uk/computing/comms-and-collab/elm';
async function testWebSearch(box) {
  box.innerHTML = '<div class="hint">Testing web search through ELM…</div>';
  try { await S.elm.models(true); S.models = S.elm._models; } catch (e) { box.innerHTML = `<div class="err-box">${esc(e.message)}</div>`; return; }
  const q = 'What is the most recent news item on the University of Edinburgh website (ed.ac.uk)? Give its date and cite the page.';
  const rows = [];
  for (const r of S.elm.webSearchRoutes(searchModel())) {
    try {
      const res = await S.elm._searchRoute(r, q);
      rows.push({ ...r, ok: res.searched, msg: res.searched ? `✅ works — ${res.citations.length} web source(s), e.g. ${res.citations[0]?.url || '—'}` : '⚠ ELM answered, but no web search took place (the search tool seems to be ignored).' });
    } catch (e) { rows.push({ ...r, ok: false, msg: e.status === -1 ? '❌ ELM refused this request (its reason is hidden from browsers; see below)' : `❌ ${e.status > 0 ? e.status + ': ' : ''}${e.message}` }); }
  }
  const ok = rows.find(r => r.ok);
  setWebStatus(ok ? 'ok' : 'unavailable', ok ? ok.name : rows.map(r => r.msg).join(' / '));
  box.innerHTML = '';
  box.append(h('div', { class: ok ? 'hint-box' : 'warn-box' },
    h('b', {}, ok ? `Web search works with your key (${ok.name}, ${ok.model}).` : 'Web search is not available through ELM with your key. The 🌐 Web search option is now switched off; everything else works as before.'),
    h('table', { class: 'diag' }, h('tr', {}, h('th', {}, 'Route'), h('th', {}, 'Model'), h('th', {}, 'Result')),
      rows.map(r => h('tr', {}, h('td', {}, r.name), h('td', {}, r.model), h('td', {}, r.msg)))),
    ok ? null : h('div', {}, rows.some(r => /refused this request/.test(r.msg))
      ? h('div', {}, '“ELM refused this request” means ELM answered with an error that browsers are not allowed to read (ELM\'s error replies have no CORS header). To see ELM\'s actual reason, run this in Terminal on your own computer. It works in Terminal on a Mac (zsh) and in bash, asks for your key without showing it, and the key stays on your computer:',
        h('pre', { class: 'cmd' }, `printf 'ELM key: '; read -rs ELM_API_KEY; echo
curl -s https://elm.edina.ac.uk/api/v1/responses -H "Authorization: Bearer $ELM_API_KEY" -H "Content-Type: application/json" -d '{"model":"${rows[0]?.model || 'gpt-4.1-mini'}","input":"test","tools":[{"type":"web_search_preview"}]}'; echo`),
        h('button', { class: 'btn small', onclick: e => navigator.clipboard.writeText(e.target.previousSibling.textContent).then(() => toast('Command copied')) }, '📋 Copy command'))
      : null,
      h('div', {}, 'If ELM adds web search later, run this test again. To ask whether it is planned: edina@ed.ac.uk.'))));
}

function helpDialog() {
  modal('Thistle Notebook — help', renderMarkdown(`
**Thistle Notebook v${APP_VERSION} (beta)** is a source-grounded research assistant in the Thistle suite. It runs entirely in your browser and talks only to **ELM** (University of Edinburgh). Check important outputs yourself: AI text can be wrong, and suggested marks are suggestions.

### Where your data goes
- Files are read **in this browser**. Notebooks are stored in this browser (IndexedDB); **💾 Save** writes a \`.tnote\` file you can keep or share.
- For each question, only the needed text is sent to ELM. 🏛 models run in University data centres; ☁ models are OpenAI under ELM's zero-data-retention terms.
- **On-campus only** notebooks (✎ Notebook) never use ☁ models or web search — use this for student work, personal or unpublished data.
- **🌐 Web search** only works if ELM allows it for your key (so far ELM has refused it). **⚙ Settings → 🌐 Test web search** checks this; if it is unavailable, the option is switched off and answers say so. Everything else works without it.
- **🔎 Suggest searches**: ELM writes PubMed / Europe PMC / Google Scholar / bioRxiv searches for your question, shown as links. The app does not contact those sites; a link sends only its search words when you click it. Add the papers you choose as sources.
- **"ELM refused this request"**: ELM answered with an error that browsers cannot read (its error replies lack a CORS header). Usually a model, tool or option is not available to API keys; the web-search test shows a Terminal command that reveals the reason.
- The page's security policy makes the browser block every connection except to ELM, so nothing can be sent elsewhere.

### Sources
PDF (scanned pages are read by a vision model), Word, PowerPoint, Excel/CSV, text/Markdown/LaTeX/code, images (handwriting is transcribed), audio (transcribed), Thistle Plot \`.tplot\` and Thistle Flow \`.tflow\`. Set each source's **role** — the assistant treats rubrics, questions, submissions, datasets and drafts differently. Small selections are sent in full; large ones are searched and the most relevant passages are sent.

### Modes and Studio
- **Research papers**: summaries, comparison tables, gaps and contradictions, **hypotheses**.
- **Marking**: rubric + question + submissions → per-criterion suggested marks with quoted evidence, consistency checks, feedback drafts. Studio marks each submission separately.
- **Data analysis**: design, quality problems, appropriate tests, next experiments.
- **Scientific writing**: abstracts, lay summaries, introductions, discussions, rewrites — choose the **Audience** (lay public, scientists, field experts).

### Working in a notebook
- **Source tabs**: keep several sets of sources in one notebook. Click a tab to show it; **tick** it to use its sources. Only sources in ticked tabs are used. 📁 under a source puts it in several tabs (e.g. one rubric for every group). Double-click a tab to rename it.
- The chat is shared across tabs. Each answer shows the tabs it used: click **📁** for the exact sources, and **Use the same tabs now** to restore that selection.
- **🗑** deletes an answer, or a question with its answers. **↻ Re-run** / **↻ Regenerate** ask again (the old answer stays). **✎ Copy to box**, **🕘 Earlier questions** or **↑ / ↓** in the empty box reuse a question without sending it.
- **📂 Find files**: point to moved or renamed originals again (choose the folder or the files) to open them, re-read edited files, or analyse very large tables. Links last until the page is closed.
- Drag the lines between the panes to resize them; double-click to reset. **✕ Close** removes the notebook from this browser after asking whether to save it.

### Exports
Reports, notes and answers export to Word, Excel, CSV, Markdown, HTML or PDF (⤓ Export); each table also has its own Excel/CSV/copy buttons.

### Statistics with Thistle Plot and Thistle Flow
The AI never calculates p-values. It writes an analysis request (test + which columns), the app builds Thistle Plot's table **from your original file**, Thistle Plot runs the test here in the browser, and the results go back to the AI for interpretation. Each card can **⤓ .tplot** (open in Thistle Plot) or **👁 Open in Thistle Plot**.
In **🔬 Thistle apps → Thistle Flow**, load FCS files and gate as usual, then **⬇ Add TF statistics as source** to analyse population statistics here.

### ELM policies and guidance (University of Edinburgh)
Using Thistle Notebook means using ELM: its policies and your School's rules on AI apply. Links open in a new tab.
- **Policies:** [Our AI principles](${ELM_INFO}/our-ai-principles) · [Responsible AI and safety](${ELM_INFO}/responsible-ai-and-safety) · [Use of Operational Data Policy (PDF)](https://edwebcontent.ed.ac.uk/sites/default/files/atoms/files/operational-data-policy.pdf) · [Legal and security perspective](${ELM_INFO}/generative-ai-guidance-for-staff/legal-and-security-perspective)
- **Data protection:** [Generative AI and data protection](https://data-protection.ed.ac.uk/guidance/generative-artificial-intelligence) · [AI and privacy](https://information-services.ed.ac.uk/ai-privacy)
- **Guidance:** [for staff](${ELM_INFO}/generative-ai-guidance-for-staff) · [for students](${ELM_INFO}/guidance-for-working-with-generative-ai) · [for postgraduate research students](${ELM_INFO}/generative-ai-guidelines-for-students/generative-ai) · [agentic AI](${ELM_INFO}/elm-competency-centre/university-of-edinburgh-specific-guidance-on-agentic-ai) · [acknowledging AI in academic work (Library)](https://edinburgh-uk.libguides.com/gen-AI/guidance)
- **ELM service:** [About ELM](${ELM_INFO}) · [FAQs](${ELM_INFO}/elm-frequently-asked-questions-faqs) · [Availability and entitlement](${ELM_INFO}/availability-and-entitlement) · [Help and support](${ELM_INFO}/help-and-support)
- **API:** [API keys](https://elm.edina.ac.uk/documentation/docs/13-keys/) · [Proxy API reference](https://elm.edina.ac.uk/elm/help/proxy-api) (sign in to ELM to view) · questions about keys: edina@ed.ac.uk

Marking with AI help: follow your School's assessment policy; the marker remains responsible for every mark and comment.
`), {});
}

// ---------------- save / open ----------------
async function saveTnote() {
  const t = Date.now(), json = await db.exportNotebook(S.nb.id); // marked saved only once the file content exists (v0.6.2)
  S.nb.savedAt = t; await db.put('notebooks', S.nb); // put, not touch: saving is not a change
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
  $('#srcAll').onchange = async e => { for (const s of S.sources.filter(x => (x.tabs || []).includes(S.nb.viewTab))) { s.enabled = e.target.checked; await db.put('sources', s); } await saveNb(); renderSources(); };
  $('#btnFindFiles').onclick = findFilesDialog;
  $('#btnCloseNb').onclick = closeNotebook;
  $('#btnHistory').onclick = e => historyMenu(e.currentTarget);
  setupSplitters();
  $('#btnSend').onclick = () => { const t = $('#prompt').value.trim(); if (!t) return; $('#prompt').value = ''; S.histPos = -1; send(t); };
  $('#prompt').onkeydown = e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#btnSend').click(); return; }
    // ↑ / ↓ in an empty box (or one showing a recalled question) step through earlier questions; nothing is sent
    const ta = e.target, qs = pastQuestions(), showing = S.histPos >= 0 && ta.value === qs[S.histPos];
    if (e.key === 'ArrowUp' && !e.shiftKey && (ta.value === '' || showing) && S.histPos < qs.length - 1) { e.preventDefault(); ta.value = qs[++S.histPos]; }
    else if (e.key === 'ArrowDown' && !e.shiftKey && showing) { e.preventDefault(); S.histPos--; ta.value = S.histPos >= 0 ? qs[S.histPos] : ''; }
  };
  $('#prompt').oninput = () => { S.histPos = -1; };
  $('#btnStop').onclick = () => S.abort?.abort();
  $('#btnSuggest').onclick = () => suggestSearches();
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
  document.addEventListener('click', e => { if (!e.target.closest('#popover,.cite,.export-btn,#btnHistory,.tabs-btn')) $('#popover').hidden = true; });
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
S._t = { tpCard, runSpec, rereadSource, citeSource, resultsDigest, linkFile, openNotebook }; // for tests/robust.e2e.cjs
