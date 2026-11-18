// Local storage of notebooks in the browser's IndexedDB (stays on this device), plus .tnote save/load files.
import { fileHeader, APP_TITLE } from './version.js';
import { uid, f32ToB64, b64ToF32 } from './util.js';

const DB = 'thistle-notebook', VER = 1, STORES = ['notebooks', 'sources', 'chunks', 'messages', 'notes'];
let dbp;
function db() {
  return dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open(DB, VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const s of STORES) if (!d.objectStoreNames.contains(s)) {
        const os = d.createObjectStore(s, { keyPath: 'id' });
        if (s !== 'notebooks') os.createIndex('nb', 'nb');
        if (s === 'chunks') os.createIndex('src', 'src');
      }
    };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
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
  for (const s of ['sources', 'chunks', 'messages', 'notes']) await delWhere(s, 'nb', id);
  await del('notebooks', id);
}
export async function deleteSource(id) { await delWhere('chunks', 'src', id); await del('sources', id); }

// ---------- .tnote files (Thistle suite convention: header first, one extension per app) ----------
export async function exportNotebook(nbId) {
  const nb = await get('notebooks', nbId);
  const [sources, chunks, messages, notes] = await Promise.all(['sources', 'chunks', 'messages', 'notes'].map(s => byNb(s, nbId)));
  return JSON.stringify({
    ...fileHeader('notebook'), savedAt: new Date().toISOString(), notebook: nb, sources, notes,
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
  const nb = { ...d.notebook, id: newNb, updated: Date.now() };
  const re = id => { if (!map.has(id)) map.set(id, uid()); return map.get(id); };
  await put('notebooks', nb);
  await putMany('sources', (d.sources || []).map(s => ({ ...s, id: re(s.id), nb: newNb })));
  await putMany('chunks', (d.chunks || []).map(c => ({ ...c, id: uid(), src: re(c.src), nb: newNb, emb: c.emb ? b64ToF32(c.emb) : null })));
  await putMany('messages', (d.messages || []).map(m => ({ ...m, id: uid(), nb: newNb })));
  await putMany('notes', (d.notes || []).map(n => ({ ...n, id: uid(), nb: newNb })));
  return nb;
}
