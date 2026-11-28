// Protocol library (v0.8): protocols stored in this browser, shared by all notebooks.
// - Owned by a user (js/users.js). Public = visible to every user of this browser and included in shared library files;
//   private = visible only to its owner here, and exported only when the owner asks. (A browser cannot enforce this
//   against someone with access to the device: it organises sharing, it does not protect secrets.)
// - Append-only like the lab note: each save adds a version {v, t, author, title, body, wiki, tags, note}; restoring
//   adds a version; deleting, restoring and visibility changes are events. Nothing is removed.
// - Inserting a protocol into a lab-note entry stores a frozen copy of the version used in the entry.
import { uid } from './util.js';
import { APP_TITLE, APP_VERSION } from './version.js';

export const isDeleted = p => { const ev = (p.events || []).filter(x => x.what === 'deleted' || x.what === 'restored'); return ev.length > 0 && ev[ev.length - 1].what === 'deleted'; };
export const curV = p => p.versions[p.versions.length - 1];
export const visibleTo = (p, userId) => p.visibility === 'public' || p.owner === userId;
export const canEdit = (p, userId) => p.owner === userId;

export function newProtocol({ title, body = '', wiki = '', tags = '', visibility = 'private', owner, ownerName, note = 'created' }) {
  const t = Date.now();
  return {
    id: uid(), owner, ownerName, visibility, created: t,
    versions: [{ v: 1, t, author: ownerName, title: title.trim(), body, wiki: wiki.trim(), tags: tags.trim(), note }],
    events: [{ t, author: ownerName, what: 'created', visibility }],
  };
}
/** Adds a version if anything changed; returns it (or null). */
export function saveVersion(p, { title, body, wiki = '', tags = '' }, author, note = '') {
  const c = curV(p), next = { title: title.trim(), body, wiki: wiki.trim(), tags: tags.trim() };
  if (['title', 'body', 'wiki', 'tags'].every(k => (c[k] || '') === next[k])) return null;
  const v = { v: c.v + 1, t: Date.now(), author, ...next, note: note || 'edited' };
  p.versions.push(v);
  return v;
}
export function setVisibility(p, visibility, author) {
  if (p.visibility === visibility) return false;
  p.visibility = visibility; p.events.push({ t: Date.now(), author, what: 'visibility', visibility });
  return true;
}
export function duplicate(p, owner, ownerName) {
  const c = curV(p);
  return newProtocol({ title: `${c.title} (copy)`, body: c.body, wiki: '', tags: c.tags, visibility: 'private', owner, ownerName, note: `copied from “${c.title}” version ${c.v} by ${p.ownerName}` });
}
/** Frozen copy of the version used, kept in the lab-note entry. */
export const snapshot = (p, author) => { const c = curV(p); return { pid: p.id, v: c.v, title: c.title, wiki: c.wiki, body: c.body, owner: p.ownerName, t: Date.now(), author }; };

/** Markdown inserted into an entry section. */
export function referenceMd(snap, { deviations = '', copySteps = false } = {}) {
  const safeTitle = String(snap.title || '').replace(/[\[\]]/g, '\\$&');
  const ref = snap.wiki ? `[${safeTitle}](wiki:${snap.wiki})` : `**${snap.title}**`;
  const out = [`Followed ${ref} (protocol version ${snap.v}).`];
  if (deviations.trim()) out.push(`Deviations from the protocol: ${deviations.trim()}`);
  if (copySteps && snap.body.trim()) out.push(`**Protocol as followed (copy of version ${snap.v}):**\n\n${snap.body.trim()}`);
  return out.join('\n\n');
}
export const searchText = p => { const c = curV(p); return `${c.title} ${c.tags} ${c.wiki} ${p.ownerName}`.toLowerCase(); };

// ---------- library files: same extension as notebooks (.tnote), told apart by "kind" (Thistle suite rule) ----------
export function libraryFile(protocols) {
  return JSON.stringify({ app: APP_TITLE, format: 3, appVersion: APP_VERSION, kind: 'protocols', savedAt: new Date().toISOString(), protocols });
}
const versionKey = v => `${v.t}|${v.author || ''}|${v.title || ''}|${v.body || ''}|${v.wiki || ''}|${v.tags || ''}`;
/** Merge protocols from a library file. Known protocols gain the versions and events they lack; nothing is
 *  removed or overwritten. Returns {added, updated, merged:[protocol records to store]}. */
export function mergeLibrary(existing, incoming) {
  const byId = new Map(existing.map(p => [p.id, p])), out = []; let added = 0, updated = 0;
  for (const q of incoming || []) {
    if (!q?.id || !Array.isArray(q.versions) || !q.versions.length) continue;
    const p = byId.get(q.id);
    if (!p) { out.push(q); added++; continue; }
    const seen = new Set(p.versions.map(versionKey)), extra = q.versions.filter(v => !seen.has(versionKey(v)));
    const seenE = new Set((p.events || []).map(e => `${e.t}|${e.what}|${e.author || ''}|${e.visibility || ''}`)), extraE = (q.events || []).filter(e => !seenE.has(`${e.t}|${e.what}|${e.author || ''}|${e.visibility || ''}`));
    if (!extra.length && !extraE.length) continue;
    // existing version numbers never change (entries quote them); versions from the file are appended after them
    let n = Math.max(...p.versions.map(v => v.v));
    const versions = [...p.versions, ...extra.sort((a, b) => a.t - b.t).map(v => ({ ...v, v: ++n, note: `${v.note || 'edited'} (version ${v.v} in the imported library file)` }))];
    const events = [...(p.events || []), ...extraE].sort((a, b) => a.t - b.t);
    const vis = [...events].reverse().find(e => e.what === 'visibility' || e.what === 'created')?.visibility || p.visibility;
    out.push({ ...p, versions, events, visibility: vis }); updated++;
  }
  return { added, updated, merged: out };
}
