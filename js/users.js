// People using this browser, each with one or more ELM API keys (keys are renewed every year, so a person can have
// several: the active one is used). Names label every change in the lab note. This is not a login: anyone using
// this browser profile can switch users, so it records authorship, it does not protect anything.
// Storage: names and key labels in localStorage (preferences); a key's value only if "remember" is ticked,
// otherwise in sessionStorage (forgotten when the tab closes).
import { uid } from './util.js';

const KEY = 'tn.users', SESS = 'tn.sessionKeys';
const read = (store, k, d) => { try { return JSON.parse(store.getItem(k) || '') ?? d; } catch { return d; } };

export function loadUsers() {
  let st = read(localStorage, KEY, null);
  if (!st || !Array.isArray(st.users)) {
    // migrate the single key of v0.1–0.6 (tn.key in localStorage = remembered, in sessionStorage = this tab only)
    let legacy = '', remembered = false;
    try { legacy = localStorage.getItem('tn.key') || ''; remembered = !!legacy; if (!legacy) legacy = sessionStorage.getItem('tn.key') || ''; } catch { }
    const u = { id: uid(), name: '', keys: [], activeKey: null };
    st = { current: u.id, users: [u] };
    if (legacy) addKey(st, u.id, { label: 'ELM key', value: legacy, remember: remembered });
    saveUsers(st);
    try { localStorage.removeItem('tn.key'); } catch { }
  } else {
    // tests and older tabs may still put a key in sessionStorage tn.key: adopt it when the current user has none
    let legacy = ''; try { legacy = sessionStorage.getItem('tn.key') || ''; } catch { }
    const u = currentUser(st);
    if (legacy && u && !u.keys.length) { addKey(st, u.id, { label: 'ELM key', value: legacy, remember: false }); saveUsers(st); }
  }
  return st;
}
export function saveUsers(st) { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch { } }
export const currentUser = st => st.users.find(u => u.id === st.current) || st.users[0];
const sessionKeys = () => read(sessionStorage, SESS, {});
export function keyValue(k) { if (!k) return ''; return k.remember ? (k.value || '') : (sessionKeys()[k.id] || ''); }
export function activeKey(st) { const u = currentUser(st); return u?.keys.find(k => k.id === u.activeKey) || u?.keys[u.keys.length - 1] || null; }
export const activeKeyValue = st => keyValue(activeKey(st));

export function addKey(st, userId, { label, value, remember }) {
  const u = st.users.find(x => x.id === userId); if (!u) return null;
  const k = { id: uid(), label: (label || '').trim() || `ELM key ${new Date().getFullYear()}`, added: Date.now(), remember: !!remember, last4: String(value).slice(-4) };
  if (remember) k.value = value; else { const s = sessionKeys(); s[k.id] = value; try { sessionStorage.setItem(SESS, JSON.stringify(s)); } catch { } }
  u.keys.push(k); u.activeKey = k.id;
  return k;
}
export function setRemember(st, userId, keyId, remember) {
  const k = st.users.find(x => x.id === userId)?.keys.find(x => x.id === keyId); if (!k || k.remember === remember) return;
  const v = keyValue(k), s = sessionKeys();
  if (remember) { k.value = v; delete s[k.id]; } else { delete k.value; if (v) s[k.id] = v; }
  k.remember = remember;
  try { sessionStorage.setItem(SESS, JSON.stringify(s)); } catch { }
}
export function removeKey(st, userId, keyId) {
  const u = st.users.find(x => x.id === userId); if (!u) return;
  u.keys = u.keys.filter(k => k.id !== keyId);
  const s = sessionKeys(); delete s[keyId]; try { sessionStorage.setItem(SESS, JSON.stringify(s)); } catch { }
  if (u.activeKey === keyId) u.activeKey = u.keys[u.keys.length - 1]?.id || null;
}
export function addUser(st, name) { const u = { id: uid(), name: (name || '').trim(), keys: [], activeKey: null }; st.users.push(u); st.current = u.id; return u; }
export function removeUser(st, userId) {
  const u = st.users.find(x => x.id === userId); if (!u || st.users.length === 1) return false;
  u.keys.forEach(k => removeKey(st, userId, k.id));
  st.users = st.users.filter(x => x.id !== userId); if (st.current === userId) st.current = st.users[0].id;
  return true;
}
