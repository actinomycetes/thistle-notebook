// Protocol folders (v0.9): a lab folder for public protocols (e.g. on a University-hosted shared drive) and a private
// folder per user. Uses the File System Access API (Chrome, Edge): the chosen folder's handle is kept in IndexedDB
// (store "handles"), so the folder stays connected; after a browser restart one click grants access again.
// Safari and Firefox cannot keep a folder: there the folder is read once per session and files are saved by download.
// Files are written on the user's own disk or drive, so nothing leaves the University (no network request is made).
//
// One file per protocol: "<title> [<id>].tnote" = {app, format, kind: "protocol", protocol}. Saving reads the file
// first and merges (append-only), so two people editing the same protocol both keep their versions. Files are never
// deleted by Thistle Notebook.
import { APP_TITLE, APP_VERSION } from './version.js';

export const canKeepFolders = () => typeof window.TN_PICK_DIR === 'function' || typeof window.showDirectoryPicker === 'function';
const keyFor = (which, userId) => (which === 'lab' ? 'folder:lab' : `folder:private:${userId}`);
export const protocolFileName = p => `${String(p.versions[p.versions.length - 1].title || 'protocol').replace(/[\\/:*?"<>|#%]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)} [${p.id}].tnote`;
export const protocolFile = p => JSON.stringify({ app: APP_TITLE, format: 3, appVersion: APP_VERSION, kind: 'protocol', savedAt: new Date().toISOString(), protocol: p }, null, 1);

/** Protocols in a parsed file: one ("protocol") or many ("protocols" library file). */
export function protocolsInFile(text) {
  let d; try { d = JSON.parse(text); } catch { return []; }
  if (String(d?.app || '').replace(/\s+/g, '').toLowerCase() !== 'thistlenotebook') return [];
  if (d.kind === 'protocol' && d.protocol) return [d.protocol];
  if (d.kind === 'protocols' && Array.isArray(d.protocols)) return d.protocols;
  return [];
}

export function createFolders({ db }) {
  const pick = async which => (window.TN_PICK_DIR ? window.TN_PICK_DIR(which) : window.showDirectoryPicker({ id: `tn-${which}`, mode: 'readwrite' }));
  async function handle(which, userId) { return (await db.get('handles', keyFor(which, userId)))?.handle || null; }
  /** {state: 'none' | 'ok' | 'prompt' | 'denied', name} */
  async function status(which, userId) {
    const h = await handle(which, userId);
    if (!h) return { state: 'none' };
    let perm = 'prompt';
    try { perm = await h.queryPermission({ mode: 'readwrite' }); } catch { }
    return { state: perm === 'granted' ? 'ok' : perm, name: h.name };
  }
  async function choose(which, userId) {
    const h = await pick(which);
    if (!h) return null;
    await db.put('handles', { id: keyFor(which, userId), handle: h, name: h.name, t: Date.now() });
    return h;
  }
  async function forget(which, userId) { await db.del('handles', keyFor(which, userId)); } // only the connection: no file is touched
  /** Ask again for access (needs a click: browsers only grant it after a user action). */
  async function reconnect(which, userId) {
    const h = await handle(which, userId); if (!h) return false;
    try { return (await h.requestPermission({ mode: 'readwrite' })) === 'granted'; } catch { return false; }
  }
  async function ready(which, userId) { const s = await status(which, userId); return s.state === 'ok' ? handle(which, userId) : null; }
  async function readAll(dir) {
    const out = [];
    for await (const [name, entry] of dir.entries()) {
      if (entry.kind !== 'file' || !/\.(tnote|json)$/i.test(name)) continue;
      try { out.push(...protocolsInFile(await (await entry.getFile()).text())); } catch { }
    }
    return out;
  }
  async function readFile(dir, name) {
    try { return protocolsInFile(await (await (await dir.getFileHandle(name)).getFile()).text())[0] || null; } catch { return null; }
  }
  async function findById(dir, id) {
    const out = [], suffix = `[${id}].tnote`;
    for await (const [name, entry] of dir.entries()) {
      if (entry.kind !== 'file' || !name.endsWith(suffix)) continue;
      try { const p = protocolsInFile(await (await entry.getFile()).text()).find(x => x.id === id); if (p) out.push({ name, protocol: p }); } catch { }
    }
    return out;
  }
  async function writeFile(dir, name, text) {
    const fh = await dir.getFileHandle(name, { create: true }), w = await fh.createWritable();
    await w.write(text); await w.close();
  }
  return { status, choose, forget, reconnect, ready, readAll, readFile, findById, writeFile };
}
