// Chunking, keyword (BM25) + embedding search, and building the cited source context for a request.
import { estTokens } from './util.js';

export function chunkSegments(segments, size = 1600, overlap = 200) {
  const out = [];
  for (const { loc, text: raw } of segments) {
    const text = (raw || '').trim();
    if (!text) continue;
    if (text.length <= size * 1.25) { out.push({ loc, text }); continue; }
    const paras = text.split(/\n\s*\n|(?<=[.!?])\s+(?=[A-Z(\[])/);
    let buf = '';
    for (const p of paras) {
      if (buf && buf.length + p.length > size) { out.push({ loc, text: buf.trim() }); buf = buf.slice(-overlap) + ' ' + p; }
      else buf += (buf ? '\n' : '') + p;
      while (buf.length > size * 2) { out.push({ loc, text: buf.slice(0, size) }); buf = buf.slice(size - overlap); }
    }
    if (buf.trim()) out.push({ loc, text: buf.trim() });
  }
  return out;
}

const STOP = new Set('the a an and or of to in on for with by is are was were be been being this that these those it its as at from which who whom what when where why how not no but if then than so such can could may might will would should do does did have has had i you he she they we our their your'.split(' '));
const toks = t => (t.toLowerCase().match(/[a-z0-9]+(?:[-'][a-z0-9]+)*/g) || []).filter(w => w.length > 1 && !STOP.has(w));

function bm25(query, docs, k1 = 1.4, b = 0.75) {
  const q = toks(query), T = docs.map(toks), N = docs.length, avg = T.reduce((s, t) => s + t.length, 0) / Math.max(N, 1);
  const df = new Map(); T.forEach(t => new Set(t).forEach(w => df.set(w, (df.get(w) || 0) + 1)));
  return T.map(t => {
    const tf = new Map(); t.forEach(w => tf.set(w, (tf.get(w) || 0) + 1));
    let s = 0;
    for (const w of q) if (tf.has(w)) {
      const d = df.get(w), f = tf.get(w);
      s += Math.log(1 + (N - d + 0.5) / (d + 0.5)) * f * (k1 + 1) / (f + k1 * (1 - b + b * t.length / Math.max(avg, 1)));
    }
    return s;
  });
}
const cos = (a, b) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / (Math.sqrt(na * nb) + 1e-9); };

// Reciprocal-rank fusion of BM25 and cosine similarity (when embeddings exist)
async function rank(query, chunks, embedQuery) {
  const order = s => s.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).map(x => x[1]);
  const lists = [order(bm25(query, chunks.map(c => c.text)))];
  const withEmb = chunks.filter(c => c.emb);
  if (withEmb.length && embedQuery) {
    const model = withEmb[0].embModel;
    try {
      const qv = await embedQuery(query, model);
      if (qv) lists.push(order(chunks.map(c => c.emb && c.embModel === model && c.emb.length === qv.length ? cos(c.emb, qv) : -1)));
    } catch { /* keyword search only */ }
  }
  const fused = new Float64Array(chunks.length);
  for (const l of lists) l.forEach((i, pos) => (fused[i] += 1 / (60 + pos)));
  return [...fused.keys()].sort((a, b) => fused[b] - fused[a]);
}

const ROLE_ORDER = { rubric: 0, question: 1, submission: 2, dataset: 3, paper: 4, draft: 5, reference: 6, web: 7 };

/** Returns {context, cites, mode}. Each included chunk is labelled [n]; cites[n] = {source, srcId, loc, text}.
 *  Everything is sent ("full") when it fits budgetTokens; otherwise rubric/question sources stay whole and the rest
 *  is retrieved by relevance ("retrieval"), with every selected source represented by at least its best chunk. */
export async function buildContext({ sources, chunksBySrc, query, budgetTokens, maxChunks, embedQuery, pinRoles = ['rubric', 'question'] }) {
  if (!sources.length) return { context: '', cites: {}, mode: 'none' };
  const srcs = [...sources].sort((a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9) || a.created - b.created);
  let rows = srcs.flatMap(s => (chunksBySrc.get(s.id) || []).sort((a, b) => a.idx - b.idx));
  const total = rows.reduce((s, r) => s + estTokens(r.text) + 12, 0);
  let mode = 'full';
  if (total > budgetTokens) {
    mode = 'retrieval';
    const role = r => srcs.find(s => s.id === r.src)?.role;
    let pinned = rows.filter(r => pinRoles.includes(role(r)));
    let used = pinned.reduce((s, r) => s + estTokens(r.text), 0);
    if (used > budgetTokens * 0.5) { pinned = []; used = 0; }
    const rest = rows.filter(r => !pinned.includes(r));
    const order = (await rank(query, rest, embedQuery)).map(i => rest[i]);
    const chosen = new Set(pinned), best = new Map();
    order.forEach(r => best.has(r.src) || best.set(r.src, r));
    for (const r of [...best.values(), ...order]) {
      if (chosen.size - pinned.length >= maxChunks || used > budgetTokens) break;
      if (!chosen.has(r)) { chosen.add(r); used += estTokens(r.text); }
    }
    rows = rows.filter(r => chosen.has(r));
  }
  const cites = {}, parts = []; let cur = null;
  rows.forEach((r, k) => {
    const n = k + 1, s = srcs.find(x => x.id === r.src);
    if (r.src !== cur) { cur = r.src; parts.push(`\n===== SOURCE: "${s.name}" (role: ${s.role}, type: ${s.kind}) =====`); }
    parts.push(`[${n}] (${r.loc})\n${r.text}`);
    cites[n] = { source: s.name, srcId: s.id, loc: r.loc, text: r.text.slice(0, 1500) };
  });
  return { context: parts.join('\n\n'), cites, mode };
}
