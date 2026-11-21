// Exports for reports, notes and chat answers: tables → Excel (.xlsx) / CSV / clipboard, whole report → HTML / print.
// Everything is generated in the browser (no upload). Word export lives in md.js (markdownToDocx).
import { zip } from './zip.js';
import { esc } from './util.js';

// ---------------- tables from Markdown ----------------
const decode = s => { const d = document.createElement('textarea'); d.innerHTML = s; return d.value; };
function inlineText(tokens) {
  let out = '';
  for (const t of tokens || []) {
    if (t.type === 'link') out += inlineText(t.tokens) + (t.href && !/^#/.test(t.href) ? ` (${t.href})` : '');
    else if (t.type === 'br') out += '\n';
    else if (t.tokens) out += inlineText(t.tokens);
    else out += decode(t.text ?? t.raw ?? '');
  }
  return out;
}
/** All Markdown tables in document order: [{title, header: [..], rows: [[..]]}]. Title = nearest heading above. */
export function extractTables(md) {
  const tokens = window.marked.lexer(String(md || '').replace(/```thistle-plot[\s\S]*?```/g, '').replace(/<think>[\s\S]*?(<\/think>|$)/g, ''));
  const out = []; let heading = '';
  const walk = list => list.forEach(t => {
    if (t.type === 'heading') heading = inlineText(t.tokens).trim();
    else if (t.type === 'table') out.push({ title: heading || `Table ${out.length + 1}`, header: t.header.map(c => inlineText(c.tokens).trim()), rows: t.rows.map(r => r.map(c => inlineText(c.tokens).trim())) });
    else if (t.type === 'blockquote' || t.type === 'list_item') walk(t.tokens || []);
    else if (t.type === 'list') walk(t.items || []);
  });
  walk(tokens);
  return out;
}

// ---------------- CSV / TSV ----------------
const csvCell = v => /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
// UTF-8 BOM so Excel on Windows/Mac reads accents, µ, ± and Greek letters correctly
export const tableToCsv = t => '﻿' + [t.header, ...t.rows].map(r => r.map(c => csvCell(String(c ?? ''))).join(',')).join('\r\n');
export const tableToTsv = t => [t.header, ...t.rows].map(r => r.map(c => String(c ?? '').replace(/[\t\n]+/g, ' ')).join('\t')).join('\n');

// ---------------- Excel (.xlsx, Office Open XML) ----------------
const xmlText = s => esc(String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')).replace(/&#39;/g, '&apos;');
const colName = i => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
const NUM = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;
// A cell becomes an Excel number only if Excel will show the same value: identifiers with leading zeros (001) and numbers
// with more than 15 significant digits (9007199254740993 would become ...992) stay text (v0.6.1, wider review).
const asNumber = s => NUM.test(s) && !/^[-+]?0\d/.test(s) && s.replace(/e.*$/i, '').replace(/[^\d]/g, '').replace(/^0+/, '').length <= 15;

function sheetXml(header, rows) {
  const ncol = Math.max(header.length, ...rows.map(r => r.length));
  const width = c => Math.min(60, Math.max(8, ...[header, ...rows].map(r => String(r[c] ?? '').split('\n').reduce((m, l) => Math.max(m, l.length), 0) * 1.1)));
  const cell = (v, r, c, style) => {
    const ref = colName(c) + (r + 1), s = String(v ?? '');
    if (style !== 1 && asNumber(s.trim())) return `<c r="${ref}" s="2"><v>${+s.trim()}</v></c>`;
    return `<c r="${ref}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${xmlText(s)}</t></is></c>`;
  };
  const rowXml = (r, i, style) => `<row r="${i + 1}">${Array.from({ length: ncol }, (_, c) => cell(r[c], i, c, style)).join('')}</row>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    + `<cols>${Array.from({ length: ncol }, (_, c) => `<col min="${c + 1}" max="${c + 1}" width="${width(c).toFixed(1)}" customWidth="1"/>`).join('')}</cols>`
    + `<sheetData>${rowXml(header, 0, 1)}${rows.map((r, i) => rowXml(r, i + 1, 2)).join('')}</sheetData></worksheet>`;
}
function sheetNames(titles) {
  const used = new Set();
  return titles.map((t, i) => {
    let n = String(t || `Table ${i + 1}`).replace(/[\[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 28) || `Table ${i + 1}`;
    let k = n, j = 2; while (used.has(k.toLowerCase())) k = `${n.slice(0, 26)} ${j++}`;
    used.add(k.toLowerCase()); return k;
  });
}
/** tables: [{title, header, rows}] → Blob (.xlsx). extraSheets are appended as-is (e.g. the cited sources). */
export function tablesToXlsx(tables, extraSheets = []) {
  const all = [...tables, ...extraSheets], names = sheetNames(all.map(t => t.title));
  const files = [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${all.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${xmlText(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${all.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${all.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    // styles: 0 default, 1 bold header (grey fill, wrapped), 2 wrapped + top-aligned body
    { name: 'xl/styles.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE2E8F0"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFBFBFBF"/></left><right style="thin"><color rgb="FFBFBFBF"/></right><top style="thin"><color rgb="FFBFBFBF"/></top><bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>' },
    ...all.map((t, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(t.header, t.rows) })),
  ];
  return zip(files);
}

// ---------------- standalone HTML (open, share, print to PDF) ----------------
export function reportHtml(title, bodyHtml) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>body{font:14px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;color:#0f172a;max-width:1100px;margin:24px auto;padding:0 20px}
h1{font-size:22px}h2{font-size:18px;margin-top:22px}h3{font-size:15px}table{border-collapse:collapse;margin:10px 0;font-size:12.5px;width:100%}
th,td{border:1px solid #cbd5e1;padding:4px 7px;text-align:left;vertical-align:top}th{background:#e2e8f0}code{background:#f1f5f9;padding:0 3px}
pre{background:#f1f5f9;padding:8px;overflow-x:auto}blockquote{border-left:3px solid #cbd5e1;margin:8px 0;padding-left:10px;color:#475569}
.foot{color:#64748b;font-size:11px;margin-top:30px;border-top:1px solid #e2e8f0;padding-top:6px}
@media print{body{margin:0;max-width:none}@page{size:A4 landscape;margin:14mm}tr{page-break-inside:avoid}}</style></head>
<body><h1>${esc(title)}</h1>${bodyHtml}<div class="foot">Generated with Thistle Notebook (ELM). AI-generated content: check it against the sources.</div></body></html>`;
}
export function markdownToHtml(md) {
  return window.DOMPurify.sanitize(window.marked.parse(String(md || '').replace(/```thistle-plot[\s\S]*?```/g, ''), { gfm: true }));
}
