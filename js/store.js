// Local storage of notebooks in the browser's IndexedDB (stays on this device), plus .tnote save/load files.
import { fileHeader, APP_TITLE } from './version.js';
import { uid, f32ToB64, b64ToF32 } from './util.js';

// v2 (TN v0.7): lab notes (one per notebook, id = notebook id) and lab-note attachment files (blobs)
// v3 (TN v0.8): protocol library (shared by all notebooks in this browser; not part of a notebook's .tnote)
// v4 (TN v0.9): folder handles (lab and private protocol folders; File System Access API)
const DB = 'thistle-notebook', VER = 4, STORES = ['notebooks', 'sources', 'chunks', 'messages', 'notes', 'labnotes', 'files', 'protocols', 'handles'];
let dbp;
function db() {
  return dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open(DB, VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const s of STORES) if (!d.objectStoreNames.contains(s)) {
        const os = d.createObjectStore(s, { keyPath: 'id' });
        if (!['notebooks', 'protocols', 'handles'].includes(s)) os.createIndex('nb', 'nb');
        if (s === 'chunks') os.createIndex('src', 'src');
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => { dbp = null; rej(r.error); };
  }).catch(e => { dbp = null; throw e; });
}
const wrap = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function tx(store, mode = 'readonly') { return (await db()).transaction(store, mode).objectStore(store); }

export const put = async (store, obj) => wrap((await tx(store, 'readwrite')).put(obj));
export const get = async (store, id) => wrap((await tx(store)).get(id));
export const del = async (store, id) => wrap((await tx(store, 'readwrite')).delete(id));
export const all = async store => wrap((await tx(store)).getAll());
export const byNb = async (store, nb) => wrap((await tx(store)).index('nb').getAll(nb));
export const bySrc = async src => wrap((await tx('chunks')).index('src').getAll(src));

export async function putMany(store, objs) {
  const t = (await db()).transaction(store, 'readwrite'), os = t.objectStore(store);
  objs.forEach(o => os.put(o));
  return new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
}
// Replace a source record and all its search passages in one transaction: if any write fails, nothing changes
// (v0.6.2: a re-read deleted the old passages before the new file was read)
export async function replaceSource(src, chunks) {
  const t = (await db()).transaction(['chunks', 'sources'], 'readwrite'), cs = t.objectStore('chunks');
  const done = new Promise((res, rej) => { t.oncomplete = res; t.onabort = () => rej(t.error || new Error('Saving the source was cancelled.')); t.onerror = e => e.preventDefault(); });
  const keys = await wrap(cs.index('src').getAllKeys(src.id));
  try { keys.forEach(k => cs.delete(k)); chunks.forEach(c => cs.put(c)); t.objectStore('sources').put(src); }
  catch (e) { t.abort(); await done.catch(() => {}); throw e; }
  return done;
}
export async function delWhere(store, index, key) {
  const t = (await db()).transaction(store, 'readwrite'), idx = t.objectStore(store).index(index);
  const keys = await wrap(idx.getAllKeys(key));
  keys.forEach(k => t.objectStore(store).delete(k));
  return new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
}

export async function listNotebooks() { return (await all('notebooks')).sort((a, b) => b.updated - a.updated); }
export async function createNotebook(name, onCampusOnly = false) {
  const nb = { id: uid(), name, created: Date.now(), updated: Date.now(), onCampusOnly, mode: 'general', tone: 'scientist' };
  await put('notebooks', nb); return nb;
}
export async function touch(nb) { nb.updated = Date.now(); await put('notebooks', nb); }
export async function deleteNotebook(id) {
  for (const s of ['sources', 'chunks', 'messages', 'notes', 'files', 'labnotes']) await delWhere(s, 'nb', id);
  await del('notebooks', id);
}
export async function deleteSource(id) { await delWhere('chunks', 'src', id); await del('sources', id); }

// ---------- .tnote files (Thistle suite convention: header first, one extension per app) ----------
export async function exportNotebook(nbId) {
  const nb = await get('notebooks', nbId);
  const [sources, chunks, messages, notes, files] = await Promise.all(['sources', 'chunks', 'messages', 'notes', 'files'].map(s => byNb(s, nbId)));
  const labnote = await get('labnotes', nbId);
  // attachments travel inside the file (base64), with every version and deleted attachment: nothing is dropped
  const filesOut = await Promise.all(files.map(async f => ({ ...f, blob: undefined, data: await blobToB64(f.blob) })));
  return JSON.stringify({
    ...fileHeader('notebook'), savedAt: new Date().toISOString(), notebook: nb, sources, notes, labnote: labnote || null, files: filesOut,
    messages: messages.sort((a, b) => a.t - b.t),
    chunks: chunks.map(c => ({ ...c, emb: c.emb ? f32ToB64(c.emb) : null })),
  });
}

export function identifyFile(name, text) {
  let d; try { d = JSON.parse(text); } catch { return { ok: false, msg: `“${name}” is not a Thistle Notebook file (.tnote).` }; }
  const key = String(d?.app || '').replace(/\s+/g, '').toLowerCase();
  if (key === 'thistleplot') return { ok: false, msg: `“${name}” is a Thistle Plot project. Open it in Thistle Plot, or add it as a source here (＋ Add sources).` };
  if (key === 'thistleflow' || key === 'flowlite') return { ok: false, msg: `“${name}” is a Thistle Flow file. Open it in Thistle Flow, or add it as a source here.` };
  if (key !== APP_TITLE.replace(/\s+/g, '').toLowerCase() || !d.notebook) return { ok: false, msg: `“${name}” is not a Thistle Notebook file (.tnote).` };
  return { ok: true, data: d };
}

export async function importNotebook(d) {
  const map = new Map(), newNb = uid();
  const now = Date.now(), nb = { ...d.notebook, id: newNb, updated: now, savedAt: now }; // just opened from a file = nothing unsaved
  const re = id => { if (!map.has(id)) map.set(id, uid()); return map.get(id); };
  const sources = (d.sources || []).map(s => ({ ...s, id: re(s.id), nb: newNb }));
  const chunks = (d.chunks || []).map(c => ({ ...c, id: uid(), src: re(c.src), nb: newNb, emb: c.emb ? b64ToF32(c.emb) : null }));
  // citations and answer metadata point at sources by id: give them the new ids too (v0.6.2)
  const remapMeta = meta => {
    if (!meta) return meta;
    const out = { ...meta };
    if (meta.cites) out.cites = Object.fromEntries(Object.entries(meta.cites).map(([n, c]) => [n, c?.srcId != null && map.has(c.srcId) ? { ...c, srcId: map.get(c.srcId) } : c]));
    if (Array.isArray(meta.sourceIds)) out.sourceIds = meta.sourceIds.map(id => map.get(id) || id);
    return out;
  };
  const messages = (d.messages || []).map(m => ({ ...m, id: uid(), nb: newNb, meta: remapMeta(m.meta) }));
  const notes = (d.notes || []).map(n => ({ ...n, id: uid(), nb: newNb, meta: remapMeta(n.meta) }));
  const labnote = d.labnote ? { ...d.labnote, id: newNb, nb: newNb } : null;
  const files = (d.files || []).map(f => { const { data, ...rest } = f; return { ...rest, id: uid(), nb: newNb, blob: b64ToBlob(data, f.type) }; });
  const t = (await db()).transaction(['notebooks', 'sources', 'chunks', 'messages', 'notes', 'labnotes', 'files'], 'readwrite');
  const done = new Promise((res, rej) => {
    t.oncomplete = res;
    t.onabort = () => rej(t.error || new Error('Importing the notebook was cancelled.'));
    t.onerror = () => rej(t.error || new Error('Could not save the imported notebook.'));
  });
  try {
    t.objectStore('notebooks').put(nb);
    const putAll = (store, list) => { const os = t.objectStore(store); list.forEach(o => os.put(o)); };
    putAll('sources', sources);
    putAll('chunks', chunks);
    putAll('messages', messages);
    putAll('notes', notes);
    if (labnote) t.objectStore('labnotes').put(labnote);
    putAll('files', files);
  } catch (e) { t.abort(); await done.catch(() => {}); throw e; }
  await done;
  return nb;
}

async function blobToB64(blob) {
  if (!blob) return '';
  const b = new Uint8Array(await blob.arrayBuffer()); let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64ToBlob(b64, type = 'application/octet-stream') {
  const s = atob(b64 || ''), b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return new Blob([b], { type });
}
