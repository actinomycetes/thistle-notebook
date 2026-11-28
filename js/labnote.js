// Lab note (electronic lab notebook) model and exports. One TN notebook = one Study (Wikibench / ISA model);
// each entry = one Assay page. Every field keeps ALL its versions (append-only): a change adds a revision with time,
// author and how it was made; deleting adds an event. Nothing is ever removed from the record.

export const SECTIONS = {
  aim: { label: 'Aim', hint: 'What this experiment is for, in one or two sentences.', noHeading: true },
  materials: { label: 'Materials and samples', hint: 'Strains, cell lines, reagents (supplier, catalogue and lot numbers), equipment.' },
  protocol: { label: 'Protocol', hint: 'Protocol followed (a link to its wiki page) and every deviation from it.' },
  data: { label: 'Data inputs', hint: 'Datasets used, where they are stored, versions or accession numbers.' },
  software: { label: 'Software, code and parameters', hint: 'Software and versions, code repository and commit, parameters, compute used.' },
  procedure: { label: 'Procedure log', hint: 'What was done and observed, with times (one line each).' },
  results: { label: 'Results', hint: 'Tables, figures (attachments) and key numbers.' },
  analysis: { label: 'Analysis', hint: 'Statistics and interpretation (Thistle Plot results can be added from the chat).' },
  conclusions: { label: 'Conclusions and next steps', hint: 'What this shows, problems, and what to do next.' },
};
export const TYPES = { wet: 'Wet lab', dry: 'Dry lab (computational)', hybrid: 'Hybrid (wet + dry)' };
export const TEMPLATES = {
  wet: ['aim', 'materials', 'protocol', 'procedure', 'results', 'analysis', 'conclusions'],
  dry: ['aim', 'data', 'software', 'procedure', 'results', 'analysis', 'conclusions'],
  hybrid: ['aim', 'materials', 'protocol', 'data', 'software', 'procedure', 'results', 'analysis', 'conclusions'],
};
export const STUDY_FIELDS = {
  title: { label: 'Study title', hint: 'e.g. Temperature effects' },
  investigation: { label: 'Investigation', hint: 'The wider investigation this study belongs to (optional).' },
  purpose: { label: 'Purpose', hint: 'Why this series of experiments is done.' },
  description: { label: 'Description', hint: 'Design, materials and approach shared by the assays.' },
};

// ---------- append-only fields ----------
export const newField = (text = '', author = '', via = 'created') => ({ revs: text ? [{ t: Date.now(), author, text, via }] : [] });
export const cur = f => (f?.revs?.length ? f.revs[f.revs.length - 1].text : '');
/** Add a revision if the text changed. Returns the revision (or null when unchanged). Never removes anything. */
export function revise(field, text, author, via = 'edit', note = '') {
  text = String(text ?? '');
  if (text === cur(field)) return null;
  const rev = { t: Date.now(), author: author || 'unknown', text, via };
  if (note) rev.note = note;
  field.revs.push(rev);
  return rev;
}
export const appendText = (before, add) => (before.trim() ? before.replace(/\s+$/, '') + '\n' + add.replace(/^\s+/, '') : add);

export function newLabNote(nbId, studyTitle, author) {
  return { id: nbId, nb: nbId, created: Date.now(), study: { fields: Object.fromEntries(Object.keys(STUDY_FIELDS).map(k => [k, newField(k === 'title' ? studyTitle : '', author)])) }, entries: [], activeEntry: null };
}
export function newEntry({ id, date, title, type = 'wet', author }) {
  const fields = { title: newField(title, author), date: newField(date, author) };
  for (const k of Object.keys(SECTIONS)) fields[k] = newField();
  return { id, created: Date.now(), author, type, fields, events: [{ t: Date.now(), author, what: 'created', type }] };
}
export const isDeleted = e => { const ev = (e.events || []).filter(x => x.what === 'deleted' || x.what === 'restored'); return ev.length > 0 && ev[ev.length - 1].what === 'deleted'; };
export const entrySections = e => { const base = TEMPLATES[e.type] || TEMPLATES.wet; return Object.keys(SECTIONS).filter(k => base.includes(k) || cur(e.fields[k]).trim()); };
export const pageTitle = e => `${cur(e.fields.date)} Assay ${cur(e.fields.title)}`.trim();

// ---------- finalising (v0.9): a seal over the content, witnesses, and amendments afterwards ----------
// Finalising records an event with a SHA-256 seal of the entry's current content (sections, protocols recorded,
// attachment fingerprints). The entry is then locked: changes are added as dated amendments with a reason.
// A second person can witness (countersign) it. "Check seal" recomputes the seal and compares.
export const finalEvent = e => [...(e.events || [])].reverse().find(x => x.what === 'finalised') || null;
export const isFinal = e => !!finalEvent(e);
export const witnesses = e => (e.events || []).filter(x => x.what === 'witnessed');
export function sealPayload(e, files = []) {
  const sections = {};
  for (const k of Object.keys(e.fields || {}).sort()) sections[k] = cur(e.fields[k]);
  const cmp = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return JSON.stringify({ type: e.type, sections, protocols: (e.protocolsUsed || []).map(p => ({ pid: p.pid, v: p.v, title: p.title, body: p.body })),
    files: [...files].sort(cmp).map(f => [f.name, f.sha256]) });
}
/** Legacy v0.9.0 seal payload (localeCompare + raw field key order) kept only to verify entries sealed before deterministic sorting. */
export function legacySealPayload(e, files = []) {
  const sections = {};
  for (const k of Object.keys(e.fields || {})) sections[k] = cur(e.fields[k]);
  return JSON.stringify({ type: e.type, sections, protocols: (e.protocolsUsed || []).map(p => ({ pid: p.pid, v: p.v, title: p.title, body: p.body })),
    files: [...files].sort((a, b) => a.name.localeCompare(b.name)).map(f => [f.name, f.sha256]) });
}
export async function sha256Hex(data) {
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map(b => b.toString(16).padStart(2, '0')).join('');
}
const SEAL_SHOW = 16;
export const sealShort = s => (s ? s.slice(0, SEAL_SHOW) : '');
function finalLine(e) {
  const f = finalEvent(e); if (!f) return '';
  const w = witnesses(e).map(x => `${x.author} (${fmtTime(x.t)})`).join(', ');
  return `Finalised by ${f.author} on ${fmtTime(f.t)} (seal SHA-256 ${sealShort(f.seal)}…)${w ? `; witnessed by ${w}` : ''}.`;
}
const amendLines = e => (e.amendments || []).map(a => ({ head: `${fmtTime(a.t)} — ${a.author}${a.section ? ` (${SECTIONS[a.section]?.label || a.section})` : ''}`, reason: a.reason, text: a.text }));

/** All changes to an entry (or the study) as one time-ordered log: [{t, author, what, field, via, text}] */
export function changeLog(obj, labels = {}) {
  const out = [];
  for (const [k, f] of Object.entries(obj.fields || {})) (f.revs || []).forEach((r, i) => out.push({ t: r.t, author: r.author, field: k, label: labels[k] || SECTIONS[k]?.label || STUDY_FIELDS[k]?.label || k, what: i === 0 ? 'wrote' : 'changed', via: r.via, note: r.note || '', text: r.text }));
  for (const ev of obj.events || []) out.push({ t: ev.t, author: ev.author, field: '', label: '', what: ev.what + (ev.type ? ` (${TYPES[ev.type] || ev.type})` : '') + (ev.name ? `: ${ev.name}` : '') + (ev.seal ? ` (seal ${sealShort(ev.seal)}…)` : ''), via: '', note: ev.note || '', text: '' });
  for (const a of obj.amendments || []) out.push({ t: a.t, author: a.author, field: a.section || '', label: SECTIONS[a.section]?.label || '', what: 'amendment', via: '', note: a.reason, text: a.text });
  return out.sort((a, b) => a.t - b.t);
}
export function contributors(e) {
  const n = new Map();
  for (const f of Object.values(e.fields || {})) for (const r of f.revs || []) n.set(r.author, (n.get(r.author) || 0) + 1);
  for (const a of e.amendments || []) if (a.author) n.set(a.author, (n.get(a.author) || 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1]);
}
export const lastChange = e => Math.max(e.created || 0, ...Object.values(e.fields || {}).flatMap(f => (f.revs || []).map(r => r.t)), ...(e.events || []).map(x => x.t), ...(e.amendments || []).map(a => a.t || 0));

// ---------- updates written by the model in the chat ----------
// ```lab-note {"section": "procedure", "op": "append" | "replace", "text": "...", "target": "entry" | "study"} ```
export function parseLabUpdates(text) {
  const out = [], re = /```lab-note\s*\n([\s\S]*?)```/g; let m;
  while ((m = re.exec(String(text || '')))) {
    try {
      const u = JSON.parse(m[1]);
      const target = u.target === 'study' ? 'study' : 'entry', valid = target === 'study' ? STUDY_FIELDS : { ...SECTIONS, title: 1, date: 1 };
      if (!valid[u.section]) throw new Error(`unknown section "${u.section}"`);
      if (typeof u.text !== 'string' || !u.text.trim()) throw new Error('no text');
      out.push({ ok: true, u: { target, section: u.section, op: u.op === 'replace' ? 'replace' : 'append', text: u.text } });
    } catch (e) { out.push({ ok: false, error: 'Could not read this lab note update: ' + e.message }); }
  }
  return out;
}

// ---------- references inside note Markdown ----------
// ![caption](attachment:plate.png)  [raw data](attachment:zones.csv)  [Kirby-Bauer protocol](wiki:Kirby-Bauer Disk Diffusion Susceptibility Test Protocol)
// wiki:SPACE:Title links to a page in another wiki space. Spaces and balanced parentheses (e.g. plate (2).png) in link targets are supported.
const encodeTarget = t => encodeURIComponent(t.trim().replace(/^<|>$/g, '')).replace(/\(/g, '%28').replace(/\)/g, '%29');
export function fixTargets(md, prefix = '') {
  const s = String(md || ''); let out = '', i = 0;
  while (i < s.length) {
    const m = /\]\((attachment|wiki):/.exec(s.slice(i));
    if (!m) { out += s.slice(i); break; }
    const start = i + m.index, bodyStart = start + m[0].length;
    out += s.slice(i, start);
    let j = bodyStart, depth = 0, closed = false;
    while (j < s.length && s[j] !== '\n') {
      if (s[j] === '(') depth++;
      else if (s[j] === ')') { if (depth === 0) { closed = true; break; } depth--; }
      j++;
    }
    if (!closed) { out += s.slice(start, bodyStart); i = bodyStart; continue; }
    const target = s.slice(bodyStart, j);
    out += `](${prefix}${m[1]}:${encodeTarget(target)})`;
    i = j + 1;
  }
  return out;
}
const decodeTarget = href => decodeURIComponent(href.replace(/^(attachment|wiki):/, ''));

// ---------- Confluence wiki markup (Confluence: Insert → Markup → "Confluence wiki") ----------
// Escape only what Confluence could read as markup: brackets, braces, pipes and ! always; the paired markers
// * _ - + ^ ~ only at word edges (Kirby-Bauer, snake_case and 10-15 stay as they are); # only at a line start.
const wikiEsc = s => String(s)
  .replace(/[\\[\]{}|!]/g, '\\$&')
  .replace(/[*_+^~-]/g, (c, i, str) => (/[\p{L}\p{N}]/u.test(str[i - 1] || '') && /[\p{L}\p{N}]/u.test(str[i + 1] || '') ? c : '\\' + c))
  .replace(/^#/gm, '\\#');
function wikiInline(tokens, ctx) {
  let out = '';
  for (const t of tokens || []) {
    switch (t.type) {
      case 'strong': out += `*${wikiInline(t.tokens, ctx)}*`; break;
      case 'em': out += `_${wikiInline(t.tokens, ctx)}_`; break;
      case 'del': out += `-${wikiInline(t.tokens, ctx)}-`; break;
      case 'codespan': {
        let code = decodeEntities(t.text).replace(/[{}]/g, '\\$&');
        if (ctx.inTable) code = code.replace(/\|/g, '\\|');
        out += `{{${code}}}`;
        break;
      }
      case 'br': out += '\n'; break;
      case 'link': {
        const label = wikiInline(t.tokens, ctx), href = t.href || '';
        if (href.startsWith('attachment:')) { const f = decodeTarget(href); ctx.files.add(f); out += `[${label}|^${f}]`; }
        else if (href.startsWith('wiki:')) out += `[${label}|${decodeTarget(href)}]`;
        else out += `[${label}|${href}]`;
        break;
      }
      case 'image': {
        const href = t.href || '';
        if (href.startsWith('attachment:')) { const f = decodeTarget(href); ctx.files.add(f); out += `!${f}|width=${ctx.imageWidth}!`; }
        else out += `!${href}!`;
        break;
      }
      case 'escape': out += wikiEsc(t.text); break;
      case 'html': out += wikiEsc(t.raw.replace(/<[^>]+>/g, '')); break;
      default: out += t.tokens ? wikiInline(t.tokens, ctx) : wikiEsc(decodeEntities(t.text ?? t.raw ?? ''));
    }
  }
  return out;
}
function wikiBlocks(tokens, ctx, depth = 0) {
  const out = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'heading': out.push(`h${Math.min((ctx.headingBase ?? 3) + t.depth, 6)}. ${wikiInline(t.tokens, ctx)}`); break;
      case 'paragraph': out.push(wikiInline(t.tokens, ctx)); break;
      case 'text': out.push(t.tokens ? wikiInline(t.tokens, ctx) : wikiEsc(decodeEntities(t.text))); break;
      case 'list': out.push(wikiList(t, ctx, '')); break;
      case 'table': {
        const tctx = { ...ctx, inTable: true };
        const cell = c => wikiInline(c.tokens, tctx).replace(/\n/g, ' ') || ' ';
        out.push([`||${t.header.map(cell).join('||')}||`, ...t.rows.map(r => `|${r.map(cell).join('|')}|`)].join('\n'));
        break;
      }
      case 'code': out.push(`{code${t.lang ? ':language=' + t.lang.replace(/[^\w+-]/g, '') : ''}}\n${t.text}\n{code}`); break;
      case 'blockquote': out.push(`{quote}\n${wikiBlocks(t.tokens, ctx, depth + 1)}\n{quote}`); break;
      case 'hr': out.push('----'); break;
      case 'space': break;
      case 'html': out.push(wikiEsc(t.raw.replace(/<[^>]+>/g, '').trim())); break;
      default: if (t.raw?.trim()) out.push(wikiEsc(t.raw.trim()));
    }
  }
  return out.filter(x => x !== '').join('\n\n');
}
function wikiList(list, ctx, prefix) {
  const mark = prefix + (list.ordered ? '#' : '*');
  return list.items.map(it => {
    const parts = [], subs = [];
    for (const t of it.tokens) (t.type === 'list' ? subs : parts).push(t);
    const head = parts.map(p => (p.tokens ? wikiInline(p.tokens, ctx) : wikiEsc(decodeEntities(p.text || '')))).join(' ').replace(/\n+/g, ' ');
    const task = it.task ? (it.checked ? '(/) ' : '(x) ') : '';
    return [`${mark} ${task}${head}`, ...subs.map(s => wikiList(s, ctx, mark))].join('\n');
  }).join('\n');
}
const decodeEntities = s => String(s)
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
  .replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[e]));
const lex = md => window.marked.lexer(fixTargets(md), { gfm: true, breaks: true });
// headingBase 3: inside an assay page (sections are h3, so ## becomes h5); 0: a page of its own (## stays h2)
export function mdToWiki(md, ctx = { files: new Set(), imageWidth: 450 }) { return wikiBlocks(lex(md), { files: new Set(), imageWidth: 450, ...ctx }); }

/** One Assay page body in Confluence wiki markup: sections as h3 (aim without heading, as in Wikibench) and a provenance
 *  line; the attachments macro only if asked (v0.8: off by default, Wikibench page templates add it). Returns {title, markup, files}. */
export function entryToWiki(e, { footer = true, imageWidth = 450, attachmentsMacro = false } = {}) {
  const ctx = { files: new Set(), imageWidth }, parts = [];
  for (const k of entrySections(e)) {
    const md = cur(e.fields[k]).trim(); if (!md) continue;
    parts.push((SECTIONS[k].noHeading ? '' : `h3. ${SECTIONS[k].label}\n\n`) + mdToWiki(md, ctx));
  }
  const am = amendLines(e);
  if (am.length) parts.push('h3. Amendments\n\n' + am.map(a => `*${wikiEsc(a.head)}* — reason: ${wikiEsc(a.reason)}\n${mdToWiki(a.text, ctx)}`).join('\n\n'));
  if (attachmentsMacro) parts.push('h3. Attachments\n\n{attachments}');
  if (footer) parts.push(provenance(e, s => `_${wikiEsc(s)}_`));
  return { title: pageTitle(e), markup: parts.join('\n\n') + '\n', files: [...ctx.files] };
}
export function studyToWiki(note, { footer = true } = {}) {
  const f = note.study.fields, ctx = { files: new Set(), imageWidth: 450 }, parts = [];
  if (cur(f.purpose).trim()) parts.push(`*Purpose:* ${mdToWiki(cur(f.purpose), ctx)}`);
  if (cur(f.description).trim()) parts.push(`*Description:* ${mdToWiki(cur(f.description), ctx)}`);
  if (footer) parts.push(provenance(note.study, s => `_${wikiEsc(s)}_`));
  return { title: cur(f.title), markup: parts.join('\n\n') + '\n' };
}
function provenance(e, wrap) {
  const who = contributors(e).map(([a]) => a).join(', '), last = lastChange(e), fin = finalLine(e);
  return wrap(`Written with Thistle Notebook${who ? ' by ' + who : ''}; last change ${fmtTime(last)}.${fin ? ' ' + fin : ''} The full change history is kept in the notebook file (.tnote).`);
}
export const fmtTime = t => { const d = new Date(t), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };

// ---------- HTML for rich-text paste into the Confluence editor ----------
/** opts.wikiUrl(title) → URL of a wiki page (or null). Attachments become plain labels: links to attachments
 *  only work through the wiki-markup route. */
export function entryToHtml(e, { wikiUrl = () => null, footer = true } = {}) {
  const parts = [];
  for (const k of entrySections(e)) {
    const md = cur(e.fields[k]).trim(); if (!md) continue;
    parts.push((SECTIONS[k].noHeading ? '' : `<h3>${escH(SECTIONS[k].label)}</h3>`) + mdToHtml(md, wikiUrl));
  }
  const am = amendLines(e);
  if (am.length) parts.push('<h3>Amendments</h3>' + am.map(a => `<p><strong>${escH(a.head)}</strong> — reason: ${escH(a.reason)}</p>${mdToHtml(a.text, wikiUrl)}`).join(''));
  if (footer) parts.push(provenance(e, s => `<p><em>${escH(s)}</em></p>`));
  return parts.join('\n');
}
const mdEsc = s => String(s).replace(/[\\*_`~[\]]/g, '\\$&');
export function mdToHtml(md, wikiUrl = () => null) {
  const src = fixTargets(md)
    .replace(/!\[([^\]]*)\]\(attachment:([^)]+)\)/g, (_, c, f) => `*[Figure: ${mdEsc(decodeURIComponent(f))}${c ? ' — ' + mdEsc(c) : ''}]*`)
    .replace(/\[([^\]]+)\]\(attachment:([^)]+)\)/g, (_, c, f) => `${c} (attachment ${mdEsc(decodeURIComponent(f))})`)
    .replace(/\[([^\]]+)\]\(wiki:([^)]+)\)/g, (_, c, t) => { const u = wikiUrl(decodeURIComponent(t)); return u ? `[${c}](${u})` : c; });
  return window.DOMPurify.sanitize(window.marked.parse(src, { gfm: true, breaks: true }));
}
const escH = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Plain Markdown of an entry (export / model context). */
export function entryToMarkdown(e) {
  const out = [`# ${pageTitle(e)}`, `_${TYPES[e.type] || e.type}_`];
  for (const k of entrySections(e)) { const md = cur(e.fields[k]).trim(); if (md) out.push(`## ${SECTIONS[k].label}\n\n${md}`); }
  const am = amendLines(e);
  if (am.length) out.push('## Amendments\n\n' + am.map(a => `**${a.head}** — reason: ${a.reason}\n\n${a.text}`).join('\n\n'));
  out.push(provenance(e, s => `_${s}_`));
  return out.join('\n\n') + '\n';
}
