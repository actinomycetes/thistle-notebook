// Turn files into text segments ({loc, text}) and, for tables, a parsed copy used by the Thistle Plot bridge.
// Everything is parsed in this browser. Only images/scanned pages (vision model) and audio (transcription) go to ELM.
import { unzip } from './zip.js';
import { blobToDataURL } from './util.js';

export const ACCEPT = '.pdf,.docx,.pptx,.xlsx,.xlsm,.csv,.tsv,.tab,.txt,.md,.markdown,.tex,.bib,.json,.html,.htm,.xml,.py,.r,.rmd,.qmd,.ipynb,.yaml,.yml,.log,.fasta,.fa,.vcf,.gff,.gtf,.srt,.vtt,.png,.jpg,.jpeg,.webp,.gif,.mp3,.m4a,.wav,.webm,.mp4,.ogg,.flac,.tplot,.tflow';
const IMAGE = /\.(png|jpe?g|webp|gif|bmp)$/i, AUDIO = /\.(mp3|m4a|wav|webm|mp4|mpeg|mpga|ogg|flac)$/i;

const ROLE_HINTS = [
  [/rubric|marking[ _-]?(scheme|criteria|grid|guide)|mark[ _-]?scheme|grade[ _-]?descriptor|assessment[ _-]?criteria/i, 'rubric'],
  [/question|exam[ _-]?paper|assignment[ _-]?brief|task[ _-]?sheet/i, 'question'],
  [/answer|submission|script|dissertation|thesis|essay|candidate|student|\bs\d{6,}/i, 'submission'],
  [/draft|manuscript/i, 'draft'],
];
export const ROLES = {
  paper: 'Paper / article', dataset: 'Dataset', rubric: 'Rubric / marking scheme', question: 'Question / brief',
  submission: 'Answer / submission', draft: 'My draft', reference: 'Other reference', web: 'Web finding',
};
export function guessRole(name, kind) {
  if (kind === 'dataset') return 'dataset';
  for (const [re, role] of ROLE_HINTS) if (re.test(name)) return role;
  return kind === 'pdf' ? 'paper' : 'reference';
}

// ---------------- vision (images, scanned pages) ----------------
const VISION_PROMPT = 'Transcribe ALL text in this image exactly (including handwriting; equations in LaTeX; tables as Markdown tables). ' +
  'Then, under a heading "Visual description", describe any figures, plots, diagrams or photos precisely: axes, units, trends, ' +
  'labels, legends and notable values. Do not interpret beyond what is visible. Write [illegible] where text cannot be read.';
async function visionRead(ctx, dataUri, hint = '') {
  if (!ctx.visionModel) return '[Image not read: no vision-capable model is available' + (ctx.onCampusOnly ? ' among on-campus models' : '') + '.]';
  return ctx.elm.chat(ctx.visionModel, [{ role: 'user', content: [
    { type: 'text', text: VISION_PROMPT + (hint ? `\nFile: ${hint}` : '') },
    { type: 'image_url', image_url: { url: dataUri, detail: 'high' } }] }], { maxTokens: 4000, temperature: 0 });
}
async function imageToJpeg(src, maxSide = 2000) {
  const img = await createImageBitmap(src);
  const s = Math.min(1, maxSide / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.88);
}

// ---------------- main entry ----------------
export async function parseFile(file, ctx) {
  const name = file.name, low = name.toLowerCase(), log = ctx.log || (() => { });
  if (low.endsWith('.pdf')) return pdf(file, ctx);
  if (low.endsWith('.docx')) return docx(file);
  if (low.endsWith('.pptx')) return pptx(file);
  if (/\.(xlsx|xlsm)$/.test(low)) return tablesResult(await readXlsx(file), name);
  if (/\.(csv|tsv|tab)$/.test(low)) return tablesResult({ [name.replace(/\.\w+$/, '')]: await readCsv(file) }, name);
  if (low.endsWith('.tplot')) return tplot(file);
  if (low.endsWith('.tflow')) return tflow(file);
  if (/\.html?$/.test(low)) return { kind: 'text', segments: splitLines(htmlToText(await file.text())) };
  if (low.endsWith('.ipynb')) {
    const nb = JSON.parse(await file.text());
    return { kind: 'text', segments: (nb.cells || []).map((c, i) => ({ loc: `cell ${i + 1}`, text: (c.cell_type === 'code' ? '```\n' : '') + [].concat(c.source || []).join('') + (c.cell_type === 'code' ? '\n```' : '') })).filter(s => s.text.trim()) };
  }
  if (IMAGE.test(low)) {
    log('Reading image with the vision model…');
    const txt = await visionRead(ctx, await imageToJpeg(file), name);
    return { kind: 'image', segments: [{ loc: 'image', text: txt }], meta: { visionModel: ctx.visionModel } };
  }
  if (AUDIO.test(low)) {
    if (!ctx.transcriptionModel || (ctx.onCampusOnly && !ctx.transcriptionModel.includes('/')))
      throw new Error('No on-campus transcription model on ELM; this notebook is on-campus only.');
    if (file.size > 9.5 * 1048576) throw new Error('Audio is over ELM\'s 10 MiB request limit; compress it (e.g. mono 64 kbps MP3) or split it.');
    log('Transcribing audio…');
    return { kind: 'audio', segments: splitLines(await ctx.elm.transcribe(file, ctx.transcriptionModel)), meta: { transcribed: true } };
  }
  const buf = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
  if (buf.includes(0)) throw new Error(`Unsupported file type: ${name}`);
  return { kind: 'text', segments: splitLines(await file.text()) };
}

// ---------------- PDF (pdf.js) ----------------
async function pdf(file, ctx) {
  const lib = window.pdfjsLib;
  if (!lib) throw new Error('PDF reader did not load (pdf.js from cdnjs).');
  const doc = await lib.getDocument({ data: await file.arrayBuffer(), isEvalSupported: false, disableFontFace: true, useSystemFonts: true }).promise;
  const segs = [], scanned = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p), tc = await page.getTextContent();
    let text = '', lastY = null;
    for (const it of tc.items) {
      const y = it.transform?.[5];
      if (lastY !== null && Math.abs(y - lastY) > 2) text += '\n'; else if (text && !text.endsWith(' ') && it.str && !it.str.startsWith(' ')) text += ' ';
      text += it.str; if (it.hasEOL) text += '\n'; lastY = y;
    }
    text = text.replace(/-\n(\w)/g, '$1').replace(/[ \t]+\n/g, '\n');
    if (text.replace(/\s/g, '').length < 40) scanned.push(p); else segs.push({ loc: `p. ${p}`, text });
  }
  const meta = { pages: doc.numPages };
  if (scanned.length && ctx.ocrScanned !== false) {
    const todo = scanned.slice(0, 60);
    for (const [i, p] of todo.entries()) {
      ctx.log?.(`Reading scanned page ${p} (${i + 1}/${todo.length}) with the vision model…`);
      const page = await doc.getPage(p), vp = page.getViewport({ scale: 1.6 });
      const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      segs.push({ loc: `p. ${p} (scanned)`, text: await visionRead(ctx, c.toDataURL('image/jpeg', 0.85)) });
    }
    segs.sort((a, b) => parseInt(a.loc.slice(3)) - parseInt(b.loc.slice(3)));
    meta.scannedPages = todo.length;
  }
  return { kind: 'pdf', segments: segs, meta };
}

// ---------------- Word (mammoth) ----------------
async function docx(file) {
  if (!window.mammoth) throw new Error('Word reader did not load (mammoth from cdnjs).');
  const { value: html } = await window.mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const segs = []; let cur = [], heading = 'start', nTab = 0;
  const flush = () => { if (cur.length) segs.push({ loc: `§ ${heading}`, text: cur.join('\n') }); cur = []; };
  for (const el of doc.body.children) {
    const tag = el.tagName;
    if (/^H[1-6]$/.test(tag)) { flush(); heading = el.textContent.trim().slice(0, 60); cur.push('#'.repeat(+tag[1] + 1) + ' ' + el.textContent.trim()); }
    else if (tag === 'TABLE') cur.push(`\n[Table ${++nTab}]\n` + tableToMd(el) + '\n');
    else if (tag === 'UL' || tag === 'OL') [...el.querySelectorAll('li')].forEach((li, i) => cur.push((tag === 'OL' ? `${i + 1}. ` : '- ') + li.textContent.trim()));
    else if (el.textContent.trim()) cur.push(el.textContent.trim());
  }
  flush();
  return { kind: 'docx', segments: segs };
}
function tableToMd(t) {
  const rows = [...t.querySelectorAll('tr')].map(tr => [...tr.children].map(c => c.textContent.trim().replace(/\s+/g, ' ').replace(/\|/g, '/')));
  if (!rows.length) return '';
  const n = rows.reduce((width, row) => Math.max(width, row.length), 0);
  return [rows[0], Array(n).fill('---'), ...rows.slice(1)].map(r => '| ' + r.join(' | ') + ' |').join('\n');
}

// ---------------- PowerPoint ----------------
async function pptx(file) {
  const z = await unzip(await file.arrayBuffer());
  const slides = z.names.filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/\d+/)) - parseInt(b.match(/\d+/)));
  const paras = xml => [...new DOMParser().parseFromString(xml, 'application/xml').getElementsByTagName('a:p')]
    .map(p => [...p.getElementsByTagName('a:t')].map(t => t.textContent).join('')).filter(s => s.trim());
  const segs = [];
  for (const s of slides) {
    const n = s.match(/slide(\d+)/)[1];
    const parts = paras(await z.text(s));
    const notes = await z.text(`ppt/notesSlides/notesSlide${n}.xml`);
    if (notes) { const np = paras(notes).filter(t => !/^\d+$/.test(t)); if (np.length) parts.push('[Speaker notes] ' + np.join(' ')); }
    segs.push({ loc: `slide ${n}`, text: parts.join('\n') });
  }
  return { kind: 'pptx', segments: segs, meta: { slides: slides.length } };
}

// ---------------- tables ----------------
const MISSING = /^(na|n\/a|#n\/a|nan|null|none|-)$/i;
const THOU_NUM = /^[-+]?[1-9]\d{0,2}(,\d{3})+(\.\d+)?$/;
const PLAIN_NUM = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;
function typed(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (s === '' || MISSING.test(s)) return null;
  if (/^[-+]?0\d+$/.test(s)) return s; // identifiers such as 001 keep their text (v0.6.0: 001 and 1 became one subject)
  if (THOU_NUM.test(s)) { const n = Number(s.replace(/,/g, '')); return Number.isFinite(n) ? n : s; }
  if (PLAIN_NUM.test(s)) { const n = Number(s); return Number.isFinite(n) ? n : s; }
  return s;
}
// Keeps the spelling of cells whose typed value would change it (1e3 → 1000), so category columns (subjects, groups)
// can use the original text (buildG). Missing-value markers (NA, n/a, #N/A, -) stay missing. In columns that look like
// measurements (most filled cells are decimals) only spellings that would otherwise collide are kept: two different
// texts that read as the same number (1.1 and 1.10) would merge two subjects or groups. Formatting that changes nothing
// (12.300 alone) is not stored, so large tables and saved notebooks do not grow (v0.6.1).
function importTable(columns, sourceRows) {
  const originalText = [];
  const decimalCol = columns.map((_, c) => {
    let filled = 0, dec = 0;
    for (const row of sourceRows) { const t = row[c] == null ? '' : String(row[c]).trim(); if (!t || MISSING.test(t)) continue; filled++; if (/^[-+]?\d*\.\d+(e[-+]?\d+)?%?$/i.test(t)) dec++; }
    return filled > 0 && dec / filled > 0.5;
  });
  const rows = sourceRows.map(row => columns.map((_, c) => typed(row[c])));
  columns.forEach((_, c) => {
    const differs = r => { const raw = sourceRows[r][c], v = rows[r][c]; return v !== null && typeof raw === 'string' && raw.trim() !== '' && raw.trim() !== String(v); };
    let keep = () => true;
    if (decimalCol[c]) { // keep only values written in more than one way in this column
      const spellings = new Map();
      rows.forEach((row, r) => { const v = row[c]; if (v === null) return; const t = String(sourceRows[r][c]).trim(); (spellings.get(v) || spellings.set(v, new Set()).get(v)).add(t); });
      keep = r => spellings.get(rows[r][c]).size > 1;
    }
    for (let r = 0; r < rows.length; r++) if (differs(r) && keep(r)) originalText.push([r, c, String(sourceRows[r][c]).trim()]);
  });
  originalText.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  return originalText.length ? { columns, rows, originalText } : { columns, rows };
}
async function readCsv(file) {
  if (!window.Papa) throw new Error('CSV reader did not load (PapaParse from cdnjs).');
  const opts = { skipEmptyLines: 'greedy' };
  if (/\.(tsv|tab)$/i.test(file.name || '')) opts.delimiter = '\t';
  const res = window.Papa.parse((await file.text()).replace(/^\uFEFF/, ''), opts);
  const data = (res.data || []).filter(r => Array.isArray(r) && r.some(c => String(c ?? '').trim() !== ''));
  if (!data.length) throw new Error('CSV file is empty.');
  const [head, ...rows] = data;
  const width = rows.reduce((width, row) => Math.max(width, row.length), head.length);
  return importTable(Array.from({ length: width }, (_, i) => String(head[i] ?? '').trim() || `col${i + 1}`), rows);
}
const BUILTIN_DATE_FMTS = new Set([14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
function isDateFormatCode(code) {
  if (!code) return false;
  const sec = String(code).split(';')[0]
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[_*]./g, '');
  return /[yd]/i.test(sec) || (/(?:^|[^a-z])m{1,5}(?:[^a-z]|$)/i.test(sec) && !/[hs]/i.test(sec));
}
function excelSerialToIso(serial, date1904) {
  if (!Number.isFinite(serial) || serial < 0) return serial;
  const day = Math.floor(serial);
  let secs = Math.round((serial - day) * 86400);
  let carry = 0;
  if (secs >= 86400) { secs = 0; carry = 1; }
  const baseMs = date1904 ? Date.UTC(1904, 0, 1) : (day >= 60 ? Date.UTC(1899, 11, 30) : Date.UTC(1899, 11, 31));
  const dt = new Date(baseMs + (day + carry) * 86400000);
  const p2 = n => String(n).padStart(2, '0');
  const datePart = `${dt.getUTCFullYear()}-${p2(dt.getUTCMonth() + 1)}-${p2(dt.getUTCDate())}`;
  if (!secs) return datePart;
  return `${datePart} ${p2(Math.floor(secs / 3600))}:${p2(Math.floor((secs % 3600) / 60))}:${p2(secs % 60)}`;
}
const resolveXlsxPath = target => {
  const raw = String(target || '').replace(/\\/g, '/').trim();
  if (!raw) return '';
  const base = raw.startsWith('/') ? raw.slice(1) : (/^xl\//i.test(raw) ? raw : 'xl/' + raw);
  const parts = [];
  for (const seg of base.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
};
const localTag = el => (el?.localName || el?.tagName || '').replace(/^.*:/, '');
const richText = el => {
  if (!el) return '';
  let out = '';
  for (const ch of el.childNodes || []) {
    if (ch.nodeType !== 1) continue;
    const tn = localTag(ch);
    if (tn === 't') out += ch.textContent;
    else if (tn === 'r') {
      for (const rc of ch.childNodes || []) if (rc.nodeType === 1 && localTag(rc) === 't') out += rc.textContent;
    }
  }
  return out;
};
async function readXlsx(file) {
  const z = await unzip(await file.arrayBuffer()), P = s => new DOMParser().parseFromString(s, 'application/xml');
  const wbXml = await z.text('xl/workbook.xml'), relsXml = await z.text('xl/_rels/workbook.xml.rels');
  if (!wbXml || !relsXml) throw new Error('Invalid Excel file: missing workbook structure.');
  const shared = [];
  const ss = await z.text('xl/sharedStrings.xml');
  if (ss) for (const si of P(ss).getElementsByTagName('si')) shared.push(richText(si));
  const dateStyleIdx = new Set();
  const stylesXml = await z.text('xl/styles.xml');
  if (stylesXml) {
    const sd = P(stylesXml), customDateFmts = new Set();
    for (const nf of sd.getElementsByTagName('numFmt')) {
      const id = +(nf.getAttribute('numFmtId') ?? -1);
      if (isDateFormatCode(nf.getAttribute('formatCode'))) customDateFmts.add(id);
    }
    const cellXfs = sd.getElementsByTagName('cellXfs')[0];
    if (cellXfs) {
      let idx = 0;
      for (const ch of cellXfs.childNodes || []) {
        if (ch.nodeType !== 1 || localTag(ch) !== 'xf') continue;
        const nfId = +(ch.getAttribute('numFmtId') ?? 0), apply = ch.getAttribute('applyNumberFormat');
        if (apply !== '0' && (BUILTIN_DATE_FMTS.has(nfId) || customDateFmts.has(nfId))) dateStyleIdx.add(idx);
        idx++;
      }
    }
  }
  const wb = P(wbXml), rels = P(relsXml);
  const wbPr = wb.getElementsByTagName('workbookPr')[0];
  const date1904 = wbPr ? /^(1|true)$/i.test(wbPr.getAttribute('date1904') || '') : false;
  const relMap = {}; for (const r of rels.getElementsByTagName('Relationship')) relMap[r.getAttribute('Id')] = r.getAttribute('Target');
  const out = {};
  for (const sh of wb.getElementsByTagName('sheet')) {
    const rid = sh.getAttribute('r:id') || sh.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    const target = resolveXlsxPath(relMap[rid] || '');
    const xml = target ? await z.text(target) : null; if (!xml) continue;
    const grid = [];
    let nextRow = 0;
    for (const row of P(xml).getElementsByTagName('row')) {
      const rAttr = row.getAttribute('r');
      const r = rAttr && /^\d+$/.test(rAttr) ? +rAttr - 1 : nextRow;
      nextRow = r + 1;
      const arr = grid[r] || (grid[r] = []);
      let nextCol = 0;
      for (const c of row.getElementsByTagName('c')) {
        const ref = c.getAttribute('r') || '', letters = ref.replace(/\d+/g, '');
        const col = letters ? letters.split('').reduce((s, ch) => s * 26 + ch.charCodeAt(0) - 64, 0) - 1 : nextCol;
        nextCol = col + 1;
        const t = c.getAttribute('t'), vEl = c.getElementsByTagName('v')[0];
        const vRaw = vEl ? vEl.textContent : null, v = vRaw != null && vRaw !== '' ? vRaw : null;
        if (t === 's') arr[col] = v != null ? (shared[+v] ?? null) : null;
        else if (t === 'inlineStr') {
          const isEl = [...(c.childNodes || [])].find(n => n.nodeType === 1 && localTag(n) === 'is');
          arr[col] = isEl ? richText(isEl) : null;
        } else if (t === 'b') arr[col] = v != null ? (v === '1') : null;
        else if (t === 'str' || t === 'e' || t === 'd') arr[col] = v;
        else if (v != null) {
          const numVal = Number(v);
          if (Number.isFinite(numVal)) {
            const sIdx = c.getAttribute('s');
            arr[col] = sIdx != null && dateStyleIdx.has(+sIdx) ? excelSerialToIso(numVal, date1904) : numVal;
          } else arr[col] = v;
        } else arr[col] = null;
      }
    }
    const rows = Array.from(grid, r => r || []).filter(r => r.some(v => v != null && v !== ''));
    if (!rows.length) continue;
    const head = rows[0], n = rows.reduce((width, row) => Math.max(width, row.length), 0);
    out[sh.getAttribute('name')] = importTable(Array.from({ length: n }, (_, i) => String(head[i] ?? '').trim() || `col${i + 1}`), rows.slice(1));
  }
  return out;
}
function tablesResult(tables, name) {
  const keys = Object.keys(tables);
  const segs = keys.map(k => ({ loc: `sheet ${k}`, text: profileTable(tables[k], keys.length > 1 ? `${name} [${k}]` : name) }));
  const cells = keys.reduce((s, k) => s + tables[k].rows.length * tables[k].columns.length, 0);
  // above 600,000 cells the table is not stored in the notebook, but it is returned for this session (sessionTables), so a
  // relinked original can still be analysed (v0.6.3)
  return { kind: 'dataset', segments: segs, tables: cells <= 600000 ? tables : null, sessionTables: tables,
    meta: { sheets: Object.fromEntries(keys.map(k => [k, [tables[k].rows.length, tables[k].columns.length]])) } };
}

// ---------------- data profile (gives the model accurate summaries instead of raw numbers) ----------------
const fmt = x => x == null || !isFinite(x) ? '' : Math.abs(x) >= 1e5 || (Math.abs(x) < 1e-3 && x !== 0) ? x.toExponential(3) : +x.toPrecision(5);
function stats(v) {
  const a = v.filter(x => typeof x === 'number' && isFinite(x)).sort((p, q) => p - q), n = a.length;
  if (!n) return null;
  const mean = a.reduce((s, x) => s + x, 0) / n, sd = n > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : NaN;
  const q = p => { const i = (n - 1) * p, lo = Math.floor(i); return a[lo] + (a[Math.min(lo + 1, n - 1)] - a[lo]) * (i - lo); };
  return { n, mean, sd, min: a[0], q1: q(0.25), median: q(0.5), q3: q(0.75), max: a[n - 1] };
}
export function profileTable(t, name) {
  const { columns, rows } = t, out = [`### Dataset: ${name}`, `Shape: ${rows.length} rows × ${columns.length} columns`, ''];
  // What the model sees uses the spellings the importer kept (1e3 and 1000 are two IDs); numeric summaries use the typed
  // cells (v0.6.1, wider review: the model saw one ID where the analysis had two)
  const drows = rows.map(r => r.slice());
  for (const [ri, ci, txt] of t.originalText || []) if (drows[ri]) drows[ri][ci] = txt;
  const col = i => rows.map(r => r[i]), dcol = i => drows.map(r => r[i]);
  const uniq = v => new Set(v.filter(x => x != null).map(String)).size;
  const isNum = i => { const v = col(i).filter(x => x != null); return v.length > 0 && v.filter(x => typeof x === 'number').length / v.length > 0.9 && uniq(dcol(i)) <= uniq(col(i)); };
  const numIdx = columns.map((_, i) => i).filter(isNum).slice(0, 40), catIdx = columns.map((_, i) => i).filter(i => !isNum(i));
  out.push('#### Columns', '| column | type | missing | unique |', '|---|---|---|---|');
  columns.forEach((c, i) => { const v = dcol(i); out.push(`| ${c} | ${isNum(i) ? 'numeric' : 'text'} | ${v.filter(x => x == null).length} | ${uniq(v)} |`); });
  if (numIdx.length) {
    out.push('', '#### Numeric summary', '| column | n | mean | SD | min | Q1 | median | Q3 | max | |z|>3 |', '|---|---|---|---|---|---|---|---|---|---|');
    for (const i of numIdx) {
      const s = stats(col(i)); if (!s) continue;
      const nOut = col(i).filter(x => typeof x === 'number' && s.sd > 0 && Math.abs((x - s.mean) / s.sd) > 3).length;
      out.push(`| ${columns[i]} | ${s.n} | ${fmt(s.mean)} | ${fmt(s.sd)} | ${fmt(s.min)} | ${fmt(s.q1)} | ${fmt(s.median)} | ${fmt(s.q3)} | ${fmt(s.max)} | ${nOut} |`);
    }
  }
  for (const i of catIdx.slice(0, 10)) {
    const counts = new Map(); dcol(i).forEach(x => counts.set(x ?? '(blank)', (counts.get(x ?? '(blank)') || 0) + 1));
    if (counts.size > 30 || counts.size === rows.length) continue;
    out.push('', `#### Levels of \`${columns[i]}\``, [...counts].map(([k, n]) => `${k}: ${n}`).join('; '));
    if (counts.size <= 12 && numIdx.length) {
      out.push(`Numeric columns by \`${columns[i]}\` (mean ± SD, n):`);
      for (const j of numIdx.slice(0, 8)) {
        const parts = [...counts.keys()].map(lv => { const s = stats(rows.filter((r, k) => (drows[k][i] ?? '(blank)') === lv).map(r => r[j])); return s ? `${lv}: ${fmt(s.mean)} ± ${fmt(s.sd)} (n=${s.n})` : null; }).filter(Boolean);
        out.push(`- ${columns[j]} — ${parts.join('; ')}`);
      }
    }
  }
  const csv = rs => [columns, ...rs].map(r => r.map(v => v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v).join(',')).join('\n');
  if (rows.length <= 400) out.push('', '#### Full data (CSV)', '```csv', csv(drows), '```');
  else out.push('', `#### First 40 of ${rows.length} rows (statistics should be run in Thistle Plot on the full table)`, '```csv', csv(drows.slice(0, 40)), '```');
  return out.join('\n');
}

// ---------------- Thistle suite files ----------------
async function tplot(file) {
  const d = JSON.parse(await file.text());
  if (!d.G?.groups) throw new Error('Not a Thistle Plot project.');
  const G = d.G, cols = ['row'], rows = [];
  G.groups.forEach(g => g.reps.forEach(r => cols.push(G.groups.length > 1 || g.reps.length > 1 ? `${g.name} | ${r}` : g.name)));
  for (let i = 0; i < G.nRows; i++) rows.push([G.rowNames?.[i] ?? `Row ${i + 1}`, ...G.groups.flatMap(g => g.reps.map((_, k) => typed(g.data?.[i]?.[k])))]);
  const table = { columns: cols, rows };
  const segs = [{ loc: 'data table', text: profileTable(table, file.name) }];
  (d.statTabs || []).forEach(t => segs.push({ loc: `result: ${t.title}`, text: `### Thistle Plot result: ${t.title}\n` + htmlToText(t.html) }));
  return { kind: 'dataset', segments: segs, tables: { 'Thistle Plot table': table }, meta: { from: 'Thistle Plot', appVersion: d.appVersion, tpG: G } };
}
async function tflow(file) {
  const buf = await file.arrayBuffer(), u8 = new Uint8Array(buf);
  let json;
  if (u8[0] === 0x50 && u8[1] === 0x4b) json = await (await unzip(buf)).text('workspace.json');
  else json = new TextDecoder().decode(u8);
  const d = JSON.parse(json || '{}');
  const lines = [`### Thistle Flow ${d.kind || 'workspace'}: ${d.name || file.name}`, `Saved by Thistle Flow v${d.appVersion || '?'} (format ${d.format ?? d.version ?? '?'})`];
  const samples = d.samples || d.workspace?.samples || [];
  if (samples.length) lines.push('', `#### Samples (${samples.length})`, ...samples.slice(0, 200).map(s => typeof s === 'string' ? `- ${s}` : `- ${s.name || s.fileName || s.key || '?'}${s.events ? ` (${s.events} events)` : ''}`));
  const gates = d.gates || d.workspace?.gates || [];
  if (gates.length) {
    const byId = Object.fromEntries(gates.map(g => [g.id, g]));
    const path = g => { const p = [], visited = new Set(); let c = g; while (c && !visited.has(c)) { visited.add(c); p.unshift(c.name); c = byId[c.parent]; } return p.join(' / '); };
    lines.push('', `#### Gating hierarchy (${gates.length} gates)`, ...gates.map(g => `- ${path(g)} — ${g.type} on ${[g.x, g.y].filter(Boolean).join(' vs ')}`));
  }
  lines.push('', 'Note: population statistics are computed in Thistle Flow from the FCS files. Use "Import from Thistle Flow" (🔬 Thistle panel) or add Thistle Flow\'s exported statistics CSV as a dataset.');
  return { kind: 'text', segments: [{ loc: 'workspace', text: lines.join('\n') }], meta: { from: 'Thistle Flow' } };
}

// ---------------- helpers ----------------
export function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,nav,footer,header,aside,form,noscript,svg,button').forEach(e => e.remove());
  doc.querySelectorAll('table').forEach(t => t.replaceWith(doc.createTextNode('\n' + tableToMd(t) + '\n')));
  doc.querySelectorAll('h1,h2,h3,h4,p,div,li,br,tr').forEach(e => e.append(doc.createTextNode('\n')));
  return (doc.body?.textContent || '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}
export function splitLines(text, per = 120) {
  const lines = String(text).split('\n');
  if (lines.length <= per) return [{ loc: 'text', text }];
  const out = [];
  for (let i = 0; i < lines.length; i += per) out.push({ loc: `lines ${i + 1}–${Math.min(i + per, lines.length)}`, text: lines.slice(i, i + per).join('\n') });
  return out;
}
export { blobToDataURL };
