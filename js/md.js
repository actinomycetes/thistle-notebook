// Markdown rendering (marked + DOMPurify), citation chips, and Markdown → Word (.docx) export.
import { zip } from './zip.js';
import { esc } from './util.js';

export function renderMarkdown(text, { cites = {}, web = [], onCite, cardSlot, tableTools } = {}) {
  let src = String(text || '');
  // reasoning traces from some models
  src = src.replace(/<think>([\s\S]*?)(<\/think>|$)/g, (_, t) => `\n<details class="think"><summary>Model reasoning</summary>\n\n${t.trim()}\n\n</details>\n`);
  // analysis requests become cards
  let k = 0;
  src = src.replace(/```thistle-plot\s*\n[\s\S]*?(```|$)/g, () => `\n<div class="tp-slot" data-k="${k++}"></div>\n`);
  const html = window.DOMPurify.sanitize(window.marked.parse(src, { gfm: true, breaks: false }), { ADD_TAGS: ['details', 'summary'] });
  const el = document.createElement('div'); el.className = 'md'; el.innerHTML = html;
  el.querySelectorAll('a[href]').forEach(a => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
  // citation chips
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: n => n.parentElement.closest('code,pre,a') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
  const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
  const re = /\[((?:W?\d+)(?:\s*[,;–-]\s*W?\d+)*)\]/g;
  for (const node of nodes) {
    if (!re.test(node.nodeValue)) continue; re.lastIndex = 0;
    const frag = document.createDocumentFragment(); let last = 0, m;
    while ((m = re.exec(node.nodeValue))) {
      frag.append(node.nodeValue.slice(last, m.index));
      const ids = [];
      m[1].split(/\s*[,;]\s*/).forEach(part => {
        const r = part.match(/^(W?)(\d+)\s*[–-]\s*W?(\d+)$/);
        if (r) for (let i = +r[2]; i <= Math.min(+r[3], +r[2] + 30); i++) ids.push(r[1] + i); else ids.push(part.trim());
      });
      const wrap = document.createElement('span'); wrap.className = 'cites';
      ids.forEach(id => {
        const isW = id.startsWith('W'), n = +id.replace('W', ''), c = isW ? web[n - 1] : cites[n];
        const b = document.createElement(isW && c ? 'a' : 'button');
        b.className = 'cite' + (c ? '' : ' missing'); b.textContent = id;
        if (isW && c) { b.href = c.url; b.target = '_blank'; b.rel = 'noopener noreferrer'; b.title = c.title; }
        else if (c) { b.title = `${c.source} — ${c.loc}`; b.onclick = e => onCite?.(n, c, e); }
        else b.title = 'This citation number was not in the context sent to the model';
        wrap.append(b);
      });
      frag.append(wrap); last = re.lastIndex;
    }
    frag.append(node.nodeValue.slice(last));
    node.replaceWith(frag);
  }
  // Export buttons under each table (index matches extractTables(), which skips reasoning blocks too).
  // Must run before analysis cards are inserted: Thistle Plot result tables are not part of the Markdown
  if (tableTools) el.querySelectorAll('table').forEach((t, i) => { if (!t.closest('details.think')) t.after(tableTools(i)); });
  if (cardSlot) el.querySelectorAll('.tp-slot').forEach(s => cardSlot(+s.dataset.k, s));
  return el;
}

// ---------------- Markdown -> .docx ----------------
const X = s => esc(s).replace(/&#39;/g, '&apos;');
function runs(tokens, fmt = {}) {
  let out = '';
  for (const t of tokens || []) {
    if (t.type === 'strong') out += runs(t.tokens, { ...fmt, b: 1 });
    else if (t.type === 'em') out += runs(t.tokens, { ...fmt, i: 1 });
    else if (t.type === 'codespan') out += run(t.text, { ...fmt, code: 1 });
    else if (t.type === 'link') out += runs(t.tokens, { ...fmt, u: 1 }) + run(` (${t.href})`, fmt);
    else if (t.type === 'br') out += '<w:r><w:br/></w:r>';
    else if (t.tokens) out += runs(t.tokens, fmt);
    else out += run(decode(t.text ?? t.raw ?? ''), fmt);
  }
  return out;
}
const decode = s => { const d = document.createElement('textarea'); d.innerHTML = s; return d.value; };
function run(text, f) {
  const pr = (f.b ? '<w:b/>' : '') + (f.i ? '<w:i/>' : '') + (f.u ? '<w:u w:val="single"/>' : '') + (f.code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>' : '');
  return `<w:r>${pr ? `<w:rPr>${pr}</w:rPr>` : ''}<w:t xml:space="preserve">${X(text)}</w:t></w:r>`;
}
const para = (inner, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${inner}</w:p>`;

// Usable text width in twips (A4, 2 cm margins): portrait 9638, landscape 14570. Set per document in markdownToDocx.
let PAGE_W = 9638;
function blocks(tokens, depth = 0) {
  let out = '';
  for (const t of tokens) {
    if (t.type === 'heading') out += para(runs(t.tokens), `Heading${Math.min(t.depth, 4)}`);
    else if (t.type === 'paragraph' || t.type === 'text') out += para(runs(t.tokens || [{ type: 'text', text: t.text }]));
    else if (t.type === 'list') t.items.forEach((it, i) => {
      const bullet = (t.ordered ? `${(t.start || 1) + i}. ` : '• ');
      const [first, ...rest] = it.tokens;
      out += `<w:p><w:pPr><w:ind w:left="${360 * (depth + 1)}" w:hanging="260"/></w:pPr>${run(bullet, {})}${runs(first?.tokens || [{ type: 'text', text: first?.text || '' }])}</w:p>`;
      out += blocks(rest, depth + 1);
    });
    else if (t.type === 'code') t.text.split('\n').forEach(l => (out += para(run(l, { code: 1 }), 'Code')));
    else if (t.type === 'blockquote') out += blocks(t.tokens, depth + 1);
    else if (t.type === 'table') {
      // <w:tblGrid> is required by the Word format: without it Word may call the file damaged or squash the columns
      const ncol = Math.max(t.header.length, ...t.rows.map(r => r.length)), colW = Math.floor(PAGE_W / ncol);
      const cellX = (c, head) => `<w:tc><w:tcPr><w:tcW w:w="${colW}" w:type="dxa"/>${head ? '<w:shd w:val="clear" w:color="auto" w:fill="E2E8F0"/>' : ''}</w:tcPr>${para(runs(c.tokens, head ? { b: 1 } : {}), head ? null : 'TableText')}</w:tc>`;
      out += `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(b => `<w:${b} w:val="single" w:sz="4" w:space="0" w:color="999999"/>`).join('')}</w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr>`
        + `<w:tblGrid>${Array.from({ length: ncol }, () => `<w:gridCol w:w="${colW}"/>`).join('')}</w:tblGrid>`
        + `<w:tr><w:trPr><w:tblHeader/></w:trPr>${t.header.map(c => cellX(c, true)).join('')}</w:tr>` + t.rows.map(r => `<w:tr>${r.map(c => cellX(c)).join('')}</w:tr>`).join('') + '</w:tbl>' + para('');
    } else if (t.type === 'hr') out += para('');
    else if (t.type === 'html') out += para(run(t.text.replace(/<[^>]+>/g, ''), {}));
  }
  return out;
}

export function markdownToDocx(md, title = '') {
  const tokens = window.marked.lexer(String(md).replace(/```thistle-plot[\s\S]*?```/g, ''));
  // Wide tables (more than 5 columns) get landscape pages
  const wide = tokens.some(function f(t) { return (t.type === 'table' && t.header.length > 5) || (t.tokens || t.items || []).some(f); });
  PAGE_W = wide ? 14570 : 9638;
  const body = (title ? para(run(title, {}), 'Title') : '') + blocks(tokens);
  const pg = wide ? '<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>' : '<w:pgSz w:w="11906" w:h="16838"/>';
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr>${pg}<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const st = (id, name, sz, extra = '') => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:spacing w:before="240" w:after="80"/>${extra}</w:pPr><w:rPr><w:b/><w:sz w:val="${sz}"/></w:rPr></w:style>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>${st('Title', 'Title', 36)}${st('Heading1', 'heading 1', 32)}${st('Heading2', 'heading 2', 28)}${st('Heading3', 'heading 3', 24)}${st('Heading4', 'heading 4', 22)}<w:style w:type="paragraph" w:styleId="TableText"><w:name w:val="Table Text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="18"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:pPr><w:spacing w:after="0"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="18"/></w:rPr></w:style></w:styles>`;
  return zip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/_rels/document.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
    { name: 'word/document.xml', data: doc },
    { name: 'word/styles.xml', data: styles },
  ]);
}
