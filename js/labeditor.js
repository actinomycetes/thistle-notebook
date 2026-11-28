// Word-style rich editor for the Lab note pane (v0.9+): visual sentence formatting, direct picture/file insertion
// (upload, existing attachment, clipboard screenshot paste, drag-and-drop), interactive table generator with
// row/column editing, and lossless bidirectional conversion to canonical GFM Markdown (so Confluence wiki markup,
// direct Confluence HTML copy/paste, Word .docx export, SHA-256 sealing, and version history all work seamlessly).

const encodeTarget = t => encodeURIComponent(t.trim().replace(/^<|>$/g, '')).replace(/\(/g, '%28').replace(/\)/g, '%29');
function fixTargets(md, prefix = '') {
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
    out += `](${prefix}${m[1]}:${encodeTarget(s.slice(bodyStart, j))})`;
    i = j + 1;
  }
  return out;
}

const escAttr = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Build an inline attachment figure chip for the rich editor. */
export function makeFigureNode(doc, { name, caption, url }) {
  const wrap = doc.createElement('span');
  wrap.className = 'lab-ed-fig';
  wrap.setAttribute('contenteditable', 'false');
  wrap.dataset.tnAtt = name;
  wrap.dataset.tnCaption = caption || '';
  if (url) {
    const img = doc.createElement('img');
    img.src = url; img.alt = caption || name; img.title = `${name} — double-click to edit caption`;
    wrap.append(img);
  } else {
    const miss = doc.createElement('span');
    miss.className = 'missing-att';
    miss.textContent = `🖼 ${name} (not attached)`;
    wrap.append(miss);
  }
  const cap = doc.createElement('span');
  cap.className = 'lab-ed-cap';
  cap.textContent = caption || name;
  wrap.append(cap);
  return wrap;
}

/** Build an inline attachment file link chip for the rich editor. */
export function makeFileChip(doc, { name, label, url }) {
  const a = doc.createElement('a');
  a.className = 'lab-ed-att';
  a.setAttribute('contenteditable', 'false');
  a.dataset.tnAtt = name;
  a.dataset.tnLabel = label || name;
  if (url) { a.href = url; a.download = name; }
  a.title = `Attachment: ${name}`;
  a.textContent = `📎 ${label || name}`;
  return a;
}

/** Build an inline wiki page link chip for the rich editor. */
export function makeWikiChip(doc, { target, label, url }) {
  const a = doc.createElement('a');
  a.className = 'lab-ed-wiki';
  a.setAttribute('contenteditable', 'false');
  a.dataset.tnWiki = target;
  a.dataset.tnLabel = label || target;
  if (url) { a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  a.title = `Wiki page: ${target}`;
  a.textContent = `📘 ${label || target}`;
  return a;
}

/** Render canonical Markdown into editable rich HTML inside `root`. */
export function mdToEditorDom(md, root, { findFile = () => null, fileUrl = () => '', wikiUrl = () => null } = {}) {
  const doc = root.ownerDocument || document;
  const trimmed = String(md || '').trim();
  if (!trimmed) { root.innerHTML = '<p><br></p>'; return; }
  const src = fixTargets(trimmed, '#tn-');
  const html = window.DOMPurify.sanitize(window.marked.parse(src, { gfm: true, breaks: true }), {
    ADD_ATTR: ['checked', 'disabled', 'type'],
  });
  root.innerHTML = html;
  root.querySelectorAll('img').forEach(img => {
    const m = /^#tn-attachment:(.+)$/.exec(img.getAttribute('src') || '');
    if (!m) return;
    const name = decodeURIComponent(m[1]), f = findFile(name);
    const fig = makeFigureNode(doc, { name, caption: img.getAttribute('alt') || '', url: f ? fileUrl(f) : '' });
    img.replaceWith(fig);
  });
  root.querySelectorAll('a[href]').forEach(a => {
    const m = /^#tn-(attachment|wiki):(.+)$/.exec(a.getAttribute('href') || '');
    if (!m) { a.target = '_blank'; a.rel = 'noopener noreferrer'; return; }
    const target = decodeURIComponent(m[2]), label = a.textContent.trim();
    if (m[1] === 'attachment') {
      const f = findFile(target);
      a.replaceWith(makeFileChip(doc, { name: target, label, url: f ? fileUrl(f) : '' }));
    } else {
      a.replaceWith(makeWikiChip(doc, { target, label, url: wikiUrl(target) }));
    }
  });
  root.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.removeAttribute('disabled');
    cb.classList.add('lab-ed-chk');
  });
  root.querySelectorAll('table').forEach(t => t.classList.add('lab-ed-table'));
  ensureTrailingParagraph(root);
}

function ensureTrailingParagraph(root) {
  const doc = root.ownerDocument || document;
  const last = root.lastElementChild;
  if (!last || /^(TABLE|PRE|BLOCKQUOTE|HR)$/i.test(last.tagName) || last.querySelector?.('.lab-ed-fig')) {
    const p = doc.createElement('p'); p.append(doc.createElement('br')); root.append(p);
  }
}

// ---------- Rich DOM → canonical GFM Markdown ----------
const INLINE_WRAP = (open, close, inner) => {
  if (!inner.trim()) return inner;
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
  return `${m[1]}${open}${m[2]}${close}${m[3]}`;
};

function codeSpanMd(text) {
  const s = String(text || '');
  if (!s) return '';
  if (!s.includes('`')) return '`' + s + '`';
  const pad = s.startsWith('`') || s.endsWith('`') ? ' ' : '';
  return '``' + pad + s + pad + '``';
}

function escapeInlineMd(text) {
  const s = String(text || '').replace(/\u00a0/g, ' ').replace(/([\\*`~[\]<])/g, '\\$1');
  // Escape '_' unless both neighbours are alphanumeric (keeps snake_case_filenames clean while preserving literal _emphasis_ / __bold__)
  return s.replace(/_/g, (ch, idx, str) => {
    const prev = str[idx - 1] || '', next = str[idx + 1] || '';
    return /[A-Za-z0-9]/.test(prev) && /[A-Za-z0-9]/.test(next) ? ch : '\\_';
  });
}

function escapeBlockStart(text) {
  return String(text || '')
    .replace(/^([ \t]*)(#{1,6})([ \t])/gm, '$1\\$2$3')
    .replace(/^([ \t]*)>([ \t]|$)/gm, '$1\\>$2')
    .replace(/^([ \t]*)([+-])([ \t])/gm, '$1\\$2$3')
    .replace(/^([ \t]*)(\d+)\.([ \t])/gm, '$1$2\\.$3');
}

function inlineMd(node) {
  if (!node) return '';
  if (node.nodeType === 3) return escapeInlineMd(node.nodeValue || '');
  if (node.nodeType !== 1) return '';
  const tag = node.tagName.toUpperCase();
  if (tag === 'BR') return '\n';
  if (tag === 'INPUT' && (node.getAttribute?.('type') || node.type) === 'checkbox') return '';
  if (node.dataset?.tnAtt && (node.classList?.contains('lab-ed-fig') || tag === 'IMG')) {
    const name = node.dataset.tnAtt;
    const cap = (node.dataset.tnCaption ?? node.getAttribute?.('alt') ?? '').replace(/\]/g, '\\]');
    return `![${cap}](attachment:${name})`;
  }
  if (node.dataset?.tnAtt) {
    const name = node.dataset.tnAtt;
    const label = (node.dataset.tnLabel || node.textContent || name).replace(/^📎\s*/, '').trim() || name;
    return `[${label.replace(/\]/g, '\\]')}](attachment:${name})`;
  }
  if (node.dataset?.tnWiki) {
    const target = node.dataset.tnWiki;
    const label = (node.dataset.tnLabel || node.textContent || target).replace(/^📘\s*/, '').trim() || target;
    return `[${label.replace(/\]/g, '\\]')}](wiki:${target})`;
  }
  if (tag === 'IMG') {
    const src = node.getAttribute?.('src') || '', alt = (node.getAttribute?.('alt') || '').replace(/\]/g, '\\]');
    return src ? `![${alt}](${src})` : '';
  }
  if (tag === 'CODE') return codeSpanMd(node.textContent || '');
  const inner = [...node.childNodes].map(inlineMd).join('');
  if (tag === 'STRONG' || tag === 'B') return INLINE_WRAP('**', '**', inner);
  if (tag === 'EM' || tag === 'I') return INLINE_WRAP('*', '*', inner);
  if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') return INLINE_WRAP('~~', '~~', inner);
  if (tag === 'A') {
    const href = node.getAttribute?.('href') || '';
    if (!href || href.startsWith('#tn-')) return inner;
    const lbl = inner.trim() || href;
    return `[${lbl}](${href})`;
  }
  return inner;
}

function tableCellMd(cell) {
  const parts = [];
  for (const ch of cell.childNodes) {
    if (ch.nodeType === 1 && /^(P|DIV)$/i.test(ch.tagName)) parts.push([...ch.childNodes].map(inlineMd).join(''));
    else parts.push(inlineMd(ch));
  }
  return parts.join(' ').replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim();
}

function tableMd(tbl) {
  const rows = [...tbl.querySelectorAll('tr')].map(tr => [...tr.children].filter(c => /^(TH|TD)$/i.test(c.tagName)).map(tableCellMd)).filter(r => r.length);
  if (!rows.length) return '';
  const cols = Math.max(...rows.map(r => r.length));
  const pad = r => Array.from({ length: cols }, (_, i) => r[i] ?? '');
  const head = pad(rows[0]), body = rows.slice(1).map(pad);
  const line = r => `| ${r.join(' | ')} |`;
  const sep = `| ${Array.from({ length: cols }, () => '---').join(' | ')} |`;
  return [line(head), sep, ...body.map(line)].join('\n');
}

function listMd(list, indent = '') {
  const ordered = list.tagName.toUpperCase() === 'OL';
  const items = [...list.children].filter(c => c.tagName?.toUpperCase() === 'LI');
  return items.map((li, idx) => {
    const cb = [...li.children].find(c => c.tagName?.toUpperCase() === 'INPUT' && (c.getAttribute?.('type') || c.type) === 'checkbox')
      || (li.firstElementChild?.tagName?.toUpperCase() === 'P' ? [...li.firstElementChild.children].find(c => c.tagName?.toUpperCase() === 'INPUT' && (c.getAttribute?.('type') || c.type) === 'checkbox') : null);
    const prefix = cb ? `- [${cb.checked ? 'x' : ' '}] ` : (ordered ? `${idx + 1}. ` : '- ');
    const textParts = [], subLists = [];
    for (const ch of li.childNodes) {
      if (ch.nodeType === 1 && /^(UL|OL)$/i.test(ch.tagName)) subLists.push(listMd(ch, indent + '  '));
      else if (ch.nodeType === 1 && /^(P|DIV)$/i.test(ch.tagName)) textParts.push([...ch.childNodes].map(inlineMd).join('').trim());
      else textParts.push(inlineMd(ch));
    }
    const line = textParts.join('').replace(/\n+/g, ' ').trim();
    return [indent + prefix + line, ...subLists].filter(Boolean).join('\n');
  }).join('\n');
}

function blockMd(node) {
  if (!node) return '';
  if (node.nodeType === 3) { const t = escapeBlockStart(escapeInlineMd(node.nodeValue || '').trim()); return t; }
  if (node.nodeType !== 1) return '';
  const tag = node.tagName.toUpperCase();
  if (/^H[1-6]$/.test(tag)) {
    const level = Math.min(4, +tag[1]);
    const txt = [...node.childNodes].map(inlineMd).join('').replace(/\n+/g, ' ').trim();
    return txt ? `${'#'.repeat(level)} ${txt}` : '';
  }
  if (tag === 'HR') return '---';
  if (tag === 'PRE') {
    const code = (node.querySelector?.('code')?.textContent ?? node.textContent ?? '').replace(/\n$/, '');
    return '```\n' + code + '\n```';
  }
  if (tag === 'TABLE') return tableMd(node);
  if (tag === 'UL' || tag === 'OL') return listMd(node);
  if (tag === 'BLOCKQUOTE') {
    const inner = blocksMd(node);
    return inner ? inner.split('\n').map(l => (l ? '> ' + l : '>')).join('\n') : '';
  }
  if (tag === 'P' || tag === 'DIV') {
    // If a div wraps block children (browser paste/edit quirk), walk blocks instead
    if (tag === 'DIV' && [...node.children].some(c => /^(P|DIV|UL|OL|TABLE|PRE|BLOCKQUOTE|H[1-6]|HR)$/i.test(c.tagName))) {
      return blocksMd(node);
    }
    const txt = [...node.childNodes].map(inlineMd).join('').replace(/[ \t]+\n/g, '\n').replace(/^\n+|\n+$/g, '').trim();
    return escapeBlockStart(txt);
  }
  return inlineMd(node).trim();
}

function blocksMd(root) {
  const out = [];
  let inlineBuf = '';
  const flush = () => { if (inlineBuf.trim()) out.push(inlineBuf.trim()); inlineBuf = ''; };
  for (const ch of root.childNodes) {
    if (ch.nodeType === 1 && /^(P|DIV|H[1-6]|UL|OL|TABLE|PRE|BLOCKQUOTE|HR)$/i.test(ch.tagName)) {
      flush();
      const b = blockMd(ch);
      if (b) out.push(b);
    } else {
      inlineBuf += inlineMd(ch);
    }
  }
  flush();
  return out.join('\n\n');
}

/** Serialize the rich contenteditable DOM back to clean canonical GFM Markdown. */
export function editorHtmlToMd(root) {
  return blocksMd(root).replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- Table DOM helpers ----------
export function buildEditableTable(doc, rows, cols, { header = true } = {}) {
  rows = Math.max(1, Math.min(30, rows | 0));
  cols = Math.max(1, Math.min(15, cols | 0));
  const tbl = doc.createElement('table');
  tbl.className = 'lab-ed-table';
  const thead = doc.createElement('thead');
  const htr = doc.createElement('tr');
  for (let c = 0; c < cols; c++) {
    const th = doc.createElement('th');
    th.textContent = header ? `Column ${c + 1}` : '';
    if (!header) th.append(doc.createElement('br'));
    htr.append(th);
  }
  thead.append(htr); tbl.append(thead);
  const tbody = doc.createElement('tbody');
  const bodyRows = Math.max(1, header ? rows - 1 : rows);
  for (let r = 0; r < bodyRows; r++) {
    const tr = doc.createElement('tr');
    for (let c = 0; c < cols; c++) { const td = doc.createElement('td'); td.append(doc.createElement('br')); tr.append(td); }
    tbody.append(tr);
  }
  tbl.append(tbody);
  return tbl;
}

function cellCoords(cell) {
  const tr = cell?.closest('tr'), tbl = cell?.closest('table');
  if (!tr || !tbl) return null;
  const rows = [...tbl.querySelectorAll('tr')];
  const rIdx = rows.indexOf(tr), cIdx = [...tr.children].indexOf(cell);
  return { tbl, tr, rows, rIdx, cIdx };
}

export function modifyTable(cell, action) {
  const info = cellCoords(cell); if (!info) return null;
  const { tbl, tr, rows, rIdx, cIdx } = info;
  const doc = tbl.ownerDocument || document;
  const nCols = Math.max(...rows.map(r => r.children.length));
  const blankRow = (tag = 'td') => {
    const nr = doc.createElement('tr');
    for (let i = 0; i < nCols; i++) { const c = doc.createElement(tag); c.append(doc.createElement('br')); nr.append(c); }
    return nr;
  };
  if (action === 'row-above') {
    const isHead = tr.parentElement?.tagName === 'THEAD';
    const nr = blankRow('td');
    if (isHead) {
      const tb = tbl.querySelector('tbody') || tbl.appendChild(doc.createElement('tbody'));
      tb.prepend(nr);
    } else tr.before(nr);
    return nr.children[cIdx] || nr.firstElementChild;
  }
  if (action === 'row-below') {
    const isHead = tr.parentElement?.tagName === 'THEAD';
    const nr = blankRow('td');
    if (isHead) {
      const tb = tbl.querySelector('tbody') || tbl.appendChild(doc.createElement('tbody'));
      tb.prepend(nr);
    } else tr.after(nr);
    return nr.children[cIdx] || nr.firstElementChild;
  }
  if (action === 'col-left' || action === 'col-right') {
    const at = action === 'col-left' ? cIdx : cIdx + 1;
    let focusCell = null;
    rows.forEach((r, ri) => {
      const isHead = r.parentElement?.tagName === 'THEAD' || ri === 0 && r.children[0]?.tagName === 'TH';
      const nc = doc.createElement(isHead ? 'th' : 'td');
      if (isHead) nc.textContent = `Column ${at + 1}`; else nc.append(doc.createElement('br'));
      const ref = r.children[at] || null;
      r.insertBefore(nc, ref);
      if (r === tr) focusCell = nc;
    });
    return focusCell;
  }
  if (action === 'del-row') {
    if (rows.length <= 1) { tbl.remove(); return null; }
    const next = rows[rIdx + 1] || rows[rIdx - 1];
    tr.remove();
    return next?.children[Math.min(cIdx, next.children.length - 1)] || null;
  }
  if (action === 'del-col') {
    if (nCols <= 1) { tbl.remove(); return null; }
    rows.forEach(r => r.children[cIdx]?.remove());
    return tr.children[Math.min(cIdx, tr.children.length - 1)] || null;
  }
  if (action === 'del-table') { tbl.remove(); return null; }
  return null;
}

// ---------- Interactive Word-style Rich Editor component ----------
const MODE_KEY = 'tn.labEditorMode';
function savedMode() { try { return localStorage.getItem(MODE_KEY) === 'md' ? 'md' : 'rich'; } catch { return 'rich'; } }
function saveMode(m) { try { localStorage.setItem(MODE_KEY, m); } catch { } }

/**
 * Create a Word-style Lab Note section editor with Markdown mode toggle.
 * Exposes `{ el, getMarkdown, focus, setMode }`.
 */
export function createRichEditor(opts) {
  const {
    h, $, initialMd = '', placeholder = '', entry = null,
    findFile = () => null, fileUrl = () => '', wikiUrl = () => null, filesOf = () => [],
    pickFiles, isIOS = false, addAttachments, toast = () => {},
    openProtocolPicker = null, onSave = null, onCancel = null, compact = false,
  } = opts;
  let mode = compact ? 'rich' : savedMode();
  const pending = []; // protocols inserted in this edit
  let savedRange = null;

  const rich = h('div', {
    class: 'lab-rich md lab-md',
    contenteditable: 'true',
    role: 'textbox',
    'aria-multiline': 'true',
    'data-placeholder': placeholder || 'Write sentences as in Word, paste screenshots, or use the toolbar for headings, lists, tables, pictures and files…',
  });
  const ta = h('textarea', {
    class: 'lab-ta',
    rows: Math.min(18, Math.max(compact ? 5 : 6, String(initialMd).split('\n').length + 2)),
    placeholder: 'Markdown: **bold**, - lists, | tables |, [protocol](wiki:Page title), ![figure](attachment:file.png)',
  });
  ta.value = initialMd;

  const renderRichFromMd = md => {
    mdToEditorDom(md, rich, { findFile: n => findFile(entry?.id, n), fileUrl, wikiUrl });
  };
  renderRichFromMd(initialMd);

  const getMarkdown = () => (mode === 'rich' ? editorHtmlToMd(rich) : ta.value);

  const rememberRange = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && rich.contains(sel.anchorNode)) savedRange = sel.getRangeAt(0).cloneRange();
  };
  const restoreRange = () => {
    rich.focus();
    if (savedRange && rich.contains(savedRange.commonAncestorContainer)) {
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(savedRange);
    }
  };
  const focusCell = cell => {
    if (!cell) return;
    rich.focus();
    const sel = window.getSelection(), range = document.createRange();
    range.selectNodeContents(cell); range.collapse(false);
    sel.removeAllRanges(); sel.addRange(range);
    rememberRange(); updateTableBar();
  };

  const insertNodeAtCursor = node => {
    restoreRange();
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !rich.contains(sel.anchorNode)) {
      rich.append(node);
    } else {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(node);
      range.setStartAfter(node); range.collapse(true);
      sel.removeAllRanges(); sel.addRange(range);
    }
    ensureTrailingParagraph(rich);
    rememberRange();
  };

  const insertBlocksAtCursor = nodes => {
    if (!nodes.length) return;
    restoreRange();
    const sel = window.getSelection();
    const range = sel?.rangeCount && rich.contains(sel.anchorNode) ? sel.getRangeAt(0) : null;
    let anchor = range ? range.startContainer : null;
    if (anchor && anchor.nodeType === 3) anchor = anchor.parentElement;
    let block = anchor?.closest?.('p,div,h1,h2,h3,h4,li,blockquote,pre,table');
    if (block && block !== rich && rich.contains(block)) {
      if (block.tagName === 'P' && !block.textContent.trim() && !block.querySelector('img,.lab-ed-fig,.lab-ed-att,.lab-ed-wiki')) {
        let prev = block;
        for (const n of nodes) { prev.after(n); prev = n; }
        block.remove();
      } else if (range && /^(P|DIV)$/i.test(block.tagName)) {
        // Split the active paragraph at the caret so multi-block insertions (protocols, tables) land between before- and after-text
        range.deleteContents();
        const tailRange = document.createRange();
        tailRange.setStart(range.endContainer, range.endOffset);
        tailRange.setEnd(block, block.childNodes.length);
        const tailFrag = tailRange.extractContents();
        const hasBefore = !!(block.textContent.trim() || block.querySelector('img,.lab-ed-fig,.lab-ed-att,.lab-ed-wiki'));
        const hasAfter = !!(tailFrag.textContent.trim() || tailFrag.querySelector?.('img,.lab-ed-fig,.lab-ed-att,.lab-ed-wiki'));
        let prev = block;
        for (const n of nodes) { prev.after(n); prev = n; }
        if (hasAfter) {
          const afterP = document.createElement('p');
          afterP.append(tailFrag);
          prev.after(afterP);
        }
        if (!hasBefore) block.remove();
      } else {
        let prev = block;
        for (const n of nodes) { prev.after(n); prev = n; }
      }
    } else {
      for (const n of nodes) rich.append(n);
    }
    const last = nodes[nodes.length - 1];
    if (last && rich.contains(last)) {
      const r = document.createRange();
      r.selectNodeContents(last); r.collapse(false);
      const s = window.getSelection();
      if (s) { s.removeAllRanges(); s.addRange(r); }
    }
    ensureTrailingParagraph(rich);
    rememberRange();
  };
  const insertBlockAtCursor = node => insertBlocksAtCursor([node]);

  const insertMd = mdStr => {
    if (mode === 'md') {
      const a = ta.selectionStart, b = ta.selectionEnd;
      ta.value = ta.value.slice(0, a) + mdStr + ta.value.slice(b);
      ta.focus(); ta.selectionStart = ta.selectionEnd = a + mdStr.length;
      return;
    }
    const tmp = document.createElement('div');
    mdToEditorDom(mdStr, tmp, { findFile: n => findFile(entry?.id, n), fileUrl, wikiUrl });
    const nodes = [...tmp.childNodes].filter(n => !(n.nodeType === 1 && n.tagName === 'P' && !n.textContent.trim() && !n.querySelector('img,.lab-ed-fig,.lab-ed-att,.lab-ed-wiki')));
    if (nodes.length === 1 && nodes[0].tagName === 'P') {
      const frag = document.createDocumentFragment();
      while (nodes[0].firstChild) frag.append(nodes[0].firstChild);
      insertNodeAtCursor(frag);
    } else {
      insertBlocksAtCursor(nodes);
    }
  };

  // ---------- formatting actions ----------
  const exec = (cmd, val = null) => { restoreRange(); document.execCommand(cmd, false, val); rememberRange(); };
  const toggleInlineCode = () => {
    restoreRange();
    const sel = window.getSelection(); if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const existing = (range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement)?.closest('code');
    if (existing && rich.contains(existing)) {
      const txt = document.createTextNode(existing.textContent);
      existing.replaceWith(txt);
      const r = document.createRange(); r.selectNodeContents(txt); sel.removeAllRanges(); sel.addRange(r);
      return;
    }
    const code = document.createElement('code');
    code.textContent = range.toString() || 'code';
    range.deleteContents(); range.insertNode(code);
    const sp = document.createTextNode(' '); code.after(sp);
    const r = document.createRange(); r.setStartAfter(sp); r.collapse(true); sel.removeAllRanges(); sel.addRange(r);
  };
  const insertChecklist = () => {
    const ul = document.createElement('ul');
    const li = document.createElement('li');
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'lab-ed-chk';
    li.append(cb, document.createTextNode(' '));
    ul.append(li);
    insertBlockAtCursor(ul);
    const sel = window.getSelection(), r = document.createRange();
    r.selectNodeContents(li); r.collapse(false); sel.removeAllRanges(); sel.addRange(r);
  };

  // ---------- table generator popover & contextual table bar ----------
  const activeTableCell = () => {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !rich.contains(sel.anchorNode)) return null;
    const el = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
    return el?.closest?.('td,th') || null;
  };
  const tblBar = h('div', { class: 'lab-tbl-bar', hidden: true },
    h('span', { class: 'hint' }, 'Table:'),
    ...[
      ['+ Row ↑', 'row-above', 'Insert a row above'],
      ['+ Row ↓', 'row-below', 'Insert a row below'],
      ['+ Col ←', 'col-left', 'Insert a column left'],
      ['+ Col →', 'col-right', 'Insert a column right'],
      ['✕ Row', 'del-row', 'Delete this row'],
      ['✕ Col', 'del-col', 'Delete this column'],
      ['✕ Table', 'del-table', 'Delete the whole table'],
    ].map(([lbl, act, title]) => h('button', {
      class: 'btn small' + (act.startsWith('del-') ? ' danger' : ''), type: 'button', title,
      onmousedown: ev => ev.preventDefault(),
      onclick: () => { const c = activeTableCell(); if (!c) return; const next = modifyTable(c, act); if (next) focusCell(next); updateTableBar(); },
    }, lbl)));
  const updateTableBar = () => { tblBar.hidden = mode !== 'rich' || !activeTableCell(); };

  function openTablePicker(anchor) {
    rememberRange();
    const pop = $('#popover'); pop.innerHTML = '';
    const MAX = 8;
    const label = h('div', { class: 'menu-head' }, 'Insert table (3 × 3)');
    const grid = h('div', { class: 'lab-tbl-grid' });
    const cells = [];
    const doInsert = (r, c, header) => {
      pop.hidden = true;
      if (mode === 'md') {
        const hdr = `| ${Array.from({ length: c }, (_, i) => `Column ${i + 1}`).join(' | ')} |`;
        const sep = `| ${Array.from({ length: c }, () => '---').join(' | ')} |`;
        const body = Array.from({ length: Math.max(1, header ? r - 1 : r) }, () => `| ${Array.from({ length: c }, () => '').join(' | ')} |`).join('\n');
        insertMd(`\n${hdr}\n${sep}\n${body}\n`);
        return;
      }
      const tbl = buildEditableTable(document, r, c, { header });
      insertBlockAtCursor(tbl);
      focusCell(tbl.querySelector('th,td'));
    };
    const highlight = (R, C) => {
      label.textContent = `Insert ${R} × ${C} table`;
      cells.forEach(({ el, r, c }) => el.classList.toggle('on', r <= R && c <= C));
    };
    for (let r = 1; r <= MAX; r++) {
      for (let c = 1; c <= MAX; c++) {
        const cell = h('button', {
          type: 'button', class: 'lab-tbl-cell', 'aria-label': `${r} by ${c} table`,
          onmouseenter: () => highlight(r, c),
          onfocus: () => highlight(r, c),
          onclick: () => doInsert(r, c, hdrCb.checked),
        });
        cells.push({ el: cell, r, c }); grid.append(cell);
      }
    }
    const rIn = h('input', { type: 'number', min: 2, max: 30, value: 3, style: 'width:52px', 'aria-label': 'Rows' });
    const cIn = h('input', { type: 'number', min: 1, max: 15, value: 3, style: 'width:52px', 'aria-label': 'Columns' });
    const hdrCb = h('input', { type: 'checkbox', checked: true });
    highlight(3, 3);
    pop.append(h('div', { class: 'menu lab-tbl-pop' }, label, grid,
      h('div', { class: 'lab-tbl-custom' },
        h('label', {}, 'Rows', rIn), h('label', {}, 'Cols', cIn),
        h('button', { type: 'button', class: 'btn small primary', onclick: () => doInsert(+rIn.value || 3, +cIn.value || 3, hdrCb.checked) }, 'Insert')),
      h('label', { class: 'check-row lab-tbl-hdr' }, hdrCb, 'First row is header')));
    pop.hidden = false;
    const rect = anchor.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(rect.left, innerWidth - pop.offsetWidth - 10)) + 'px';
    pop.style.top = (rect.bottom + 4) + 'px';
  }

  // ---------- direct picture & file insertion ----------
  async function attachAndInsert(files, { asImage = null } = {}) {
    if (!entry || !addAttachments || !files?.length) return;
    const names = await addAttachments(entry, files, { quiet: false, skipRender: true });
    if (!names.length) return;
    for (const name of names) {
      const f = findFile(entry.id, name);
      const isImg = asImage ?? /^image\//.test(f?.type || '');
      const cap = name.replace(/\.[^.]+$/, '');
      if (mode === 'md') {
        insertMd(isImg ? `![${cap}](attachment:${name})` : `[${name}](attachment:${name})`);
      } else if (isImg) {
        insertNodeAtCursor(makeFigureNode(document, { name, caption: cap, url: f ? fileUrl(f) : '' }));
      } else {
        insertNodeAtCursor(makeFileChip(document, { name, label: name, url: f ? fileUrl(f) : '' }));
        insertNodeAtCursor(document.createTextNode(' '));
      }
    }
  }

  function openMediaPicker(anchor, kind) {
    rememberRange();
    const pop = $('#popover'); pop.innerHTML = '';
    const fs = entry ? filesOf(entry.id) : [];
    const existing = kind === 'image' ? fs.filter(f => /^image\//.test(f.type)) : fs;
    const isImg = kind === 'image';
    pop.append(h('div', { class: 'menu' },
      h('div', { class: 'menu-head' }, isImg ? 'Insert a picture' : 'Insert a file link'),
      entry && pickFiles ? h('button', {
        type: 'button', class: 'menu-item',
        onclick: async () => {
          pop.hidden = true;
          const picked = await pickFiles({ multiple: true, accept: isImg && !isIOS ? 'image/*' : undefined });
          if (picked.length) await attachAndInsert(picked, { asImage: isImg ? true : null });
        },
      }, h('span', {}, isImg ? '＋ Upload picture from computer…' : '＋ Attach file from computer…')) : null,
      existing.length ? h('div', { class: 'menu-head' }, isImg ? 'Already attached to this entry' : 'Attached files') : null,
      ...existing.map(f => h('button', {
        type: 'button', class: 'menu-item',
        onclick: () => {
          pop.hidden = true;
          const cap = f.name.replace(/\.[^.]+$/, '');
          if (mode === 'md') insertMd(isImg ? `![${cap}](attachment:${f.name})` : `[${f.name}](attachment:${f.name})`);
          else if (isImg) insertNodeAtCursor(makeFigureNode(document, { name: f.name, caption: cap, url: fileUrl(f) }));
          else { insertNodeAtCursor(makeFileChip(document, { name: f.name, label: f.name, url: fileUrl(f) })); insertNodeAtCursor(document.createTextNode(' ')); }
        },
      }, h('span', {}, `${isImg ? '🖼' : '📎'} ${f.name}`))),
      !existing.length && !entry ? h('div', { class: 'menu-head' }, 'Attach files on an assay entry to insert them.') : null));
    pop.hidden = false;
    const rect = anchor.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(rect.left, innerWidth - pop.offsetWidth - 10)) + 'px';
    pop.style.top = (rect.bottom + 4) + 'px';
  }

  // ---------- mode switching (Rich ↔ Markdown) ----------
  const richBtn = h('button', { type: 'button', class: 'btn small', 'data-ed-mode': 'rich', title: 'Word-style visual editor', onclick: () => setMode('rich') }, 'Word style');
  const mdBtn = h('button', { type: 'button', class: 'btn small', 'data-ed-mode': 'md', title: 'Edit raw Markdown directly', onclick: () => setMode('md') }, 'Markdown');

  const styleSel = h('select', {
    class: 'lab-ed-sel', 'aria-label': 'Paragraph style', title: 'Paragraph or heading style',
    onchange: () => {
      const v = styleSel.value;
      exec('formatBlock', v === 'p' ? 'P' : v.toUpperCase());
      styleSel.value = 'p';
    },
  },
    h('option', { value: 'p' }, 'Normal text'),
    h('option', { value: 'h1' }, 'Heading 1'),
    h('option', { value: 'h2' }, 'Heading 2'),
    h('option', { value: 'h3' }, 'Heading 3'));

  const fmtBtn = (label, title, fn, cls = '') => h('button', {
    type: 'button', class: 'btn small lab-fmt-btn ' + cls, title,
    onmousedown: ev => ev.preventDefault(),
    onclick: fn,
  }, label);

  const richOnlyControls = [
    styleSel,
    fmtBtn(h('b', {}, 'B'), 'Bold (Ctrl/⌘+B)', () => exec('bold')),
    fmtBtn(h('i', {}, 'I'), 'Italic (Ctrl/⌘+I)', () => exec('italic')),
    fmtBtn(h('s', {}, 'S'), 'Strikethrough', () => exec('strikeThrough')),
    fmtBtn('</>', 'Inline code', toggleInlineCode),
    fmtBtn('• List', 'Bulleted list', () => exec('insertUnorderedList')),
    fmtBtn('1. List', 'Numbered list', () => exec('insertOrderedList')),
    fmtBtn('☑', 'Checklist item', insertChecklist),
    fmtBtn('❝', 'Quote block', () => exec('formatBlock', 'BLOCKQUOTE')),
  ];

  const toolbar = h('div', { class: 'lab-toolbar lab-edit-tools' },
    ...richOnlyControls,
    h('button', { type: 'button', class: 'btn small', title: 'Insert a table (pick rows and columns)', onmousedown: ev => { rememberRange(); ev.preventDefault(); }, onclick: ev => openTablePicker(ev.currentTarget) }, '▦ Table ▾'),
    entry ? h('button', { type: 'button', class: 'btn small', title: 'Upload or insert a picture at the cursor', onmousedown: ev => { rememberRange(); ev.preventDefault(); }, onclick: ev => openMediaPicker(ev.currentTarget, 'image') }, '🖼 Picture ▾') : null,
    entry ? h('button', { type: 'button', class: 'btn small', title: 'Attach or insert a file link at the cursor', onmousedown: ev => { rememberRange(); ev.preventDefault(); }, onclick: ev => openMediaPicker(ev.currentTarget, 'file') }, '📎 File ▾') : null,
    entry && openProtocolPicker ? h('button', {
      type: 'button', class: 'btn small', title: 'Insert a protocol from the library (keeps a frozen copy of the version used)',
      onmousedown: ev => { rememberRange(); ev.preventDefault(); },
      onclick: () => { rememberRange(); openProtocolPicker((text, snap) => { insertMd(text); pending.push(snap); }); },
    }, '📚 Protocol…') : null,
    h('button', {
      type: 'button', class: 'btn small', title: 'Link to a wiki page by its exact title',
      onmousedown: ev => { rememberRange(); ev.preventDefault(); },
      onclick: () => {
        rememberRange();
        const t = prompt('Exact title of the wiki page (e.g. Kirby-Bauer Disk Diffusion Susceptibility Test Protocol). For another space: SPACEKEY:Title');
        if (!t || !t.trim()) return;
        const target = t.trim(), label = target.replace(/^[A-Z0-9]+:/, '');
        if (mode === 'md') insertMd(`[${label}](wiki:${target})`);
        else { insertNodeAtCursor(makeWikiChip(document, { target, label, url: wikiUrl(target) })); insertNodeAtCursor(document.createTextNode(' ')); }
      },
    }, '📘 Wiki link'),
    h('span', { class: 'grow' }),
    h('span', { class: 'lab-mode-sw' }, richBtn, mdBtn));

  function setMode(next, { persist = true } = {}) {
    if (next === mode && !rich.hidden === (mode === 'rich')) return;
    if (mode === 'rich' && next === 'md') ta.value = editorHtmlToMd(rich);
    else if (mode === 'md' && next === 'rich') renderRichFromMd(ta.value);
    mode = next;
    if (persist && !compact) saveMode(mode);
    rich.hidden = mode !== 'rich';
    ta.hidden = mode !== 'md';
    richOnlyControls.forEach(c => (c.hidden = mode !== 'rich'));
    richBtn.classList.toggle('active', mode === 'rich');
    mdBtn.classList.toggle('active', mode === 'md');
    updateTableBar();
    setTimeout(() => (mode === 'rich' ? rich : ta).focus(), 10);
  }

  // ---------- rich editor interactions (keyboard, paste, drag-drop, caption edit) ----------
  rich.addEventListener('keyup', () => { rememberRange(); updateTableBar(); });
  rich.addEventListener('mouseup', () => { rememberRange(); updateTableBar(); });
  rich.addEventListener('dblclick', ev => {
    const fig = ev.target.closest?.('.lab-ed-fig');
    if (!fig) return;
    const curCap = fig.dataset.tnCaption || '';
    const next = prompt(`Caption for ${fig.dataset.tnAtt}:`, curCap);
    if (next === null) return;
    fig.dataset.tnCaption = next.trim();
    const capEl = fig.querySelector('.lab-ed-cap'); if (capEl) capEl.textContent = next.trim() || fig.dataset.tnAtt;
    const imgEl = fig.querySelector('img'); if (imgEl) imgEl.alt = next.trim() || fig.dataset.tnAtt;
  });
  rich.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); onSave?.(getMarkdown(), pending); return; }
    if (ev.key === 'Escape') { ev.stopPropagation(); onCancel?.(); return; }
    if (ev.key === 'Tab') {
      const cell = activeTableCell();
      if (cell) {
        ev.preventDefault();
        const tbl = cell.closest('table');
        const all = [...tbl.querySelectorAll('th,td')];
        const i = all.indexOf(cell);
        if (ev.shiftKey) { if (i > 0) focusCell(all[i - 1]); }
        else if (i + 1 < all.length) focusCell(all[i + 1]);
        else { const added = modifyTable(cell, 'row-below'); if (added) focusCell(added); }
      }
    }
  });
  rich.addEventListener('paste', async ev => {
    const dt = ev.clipboardData; if (!dt) return;
    const imgItems = [...(dt.items || [])].filter(it => it.kind === 'file' && /^image\//.test(it.type));
    if (imgItems.length && entry && addAttachments) {
      ev.preventDefault();
      rememberRange();
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const files = imgItems.map((it, idx) => {
        const blob = it.getAsFile();
        const ext = (blob.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
        return { blob, name: blob.name && blob.name !== 'image.png' ? blob.name : `pasted-${stamp}${idx ? '-' + (idx + 1) : ''}.${ext}`, type: blob.type || 'image/png' };
      });
      await attachAndInsert(files, { asImage: true });
      return;
    }
    const html = dt.getData('text/html');
    if (html) {
      ev.preventDefault();
      const clean = window.DOMPurify.sanitize(html, {
        ALLOWED_TAGS: ['p', 'br', 'strong', 'b', 'em', 'i', 'del', 's', 'code', 'pre', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'blockquote', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a'],
        ALLOWED_ATTR: ['href'],
      });
      const tmp = document.createElement('div'); tmp.innerHTML = clean;
      tmp.querySelectorAll('table').forEach(t => t.classList.add('lab-ed-table'));
      const md = editorHtmlToMd(tmp);
      if (md) insertMd(md);
    }
  });
  rich.addEventListener('dragover', ev => { if (ev.dataTransfer?.types?.includes('Files')) { ev.preventDefault(); ev.stopPropagation(); rich.classList.add('drop'); } });
  rich.addEventListener('dragleave', () => rich.classList.remove('drop'));
  rich.addEventListener('drop', async ev => {
    rich.classList.remove('drop');
    if (!ev.dataTransfer?.files?.length) return;
    ev.preventDefault(); ev.stopPropagation(); document.body.classList.remove('dragging');
    if (!entry || !addAttachments) return toast('Attach files inside an assay entry', true);
    rememberRange();
    await attachAndInsert([...ev.dataTransfer.files]);
  });

  ta.onkeydown = ev => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); onSave?.(getMarkdown(), pending); }
    if (ev.key === 'Escape') { ev.stopPropagation(); onCancel?.(); }
  };

  // Initialize visibility state
  rich.hidden = mode !== 'rich';
  ta.hidden = mode !== 'md';
  richOnlyControls.forEach(c => (c.hidden = mode !== 'rich'));
  richBtn.classList.toggle('active', mode === 'rich');
  mdBtn.classList.toggle('active', mode === 'md');

  const foot = onSave ? h('div', { class: 'lab-edit-tools' },
    h('span', { class: 'hint' }, entry ? 'Ctrl/⌘+Enter saves · paste screenshots or drop pictures/files here' : 'Ctrl/⌘+Enter saves'),
    h('span', { class: 'grow' }),
    onCancel ? h('button', { type: 'button', class: 'btn small', onclick: () => onCancel() }, 'Cancel') : null,
    h('button', { type: 'button', class: 'btn small primary', onclick: () => onSave(getMarkdown(), pending) }, 'Save')) : null;

  const el = h('div', { class: 'lab-edit' }, toolbar, tblBar, rich, ta, foot);
  return {
    el, getMarkdown, setMode,
    focus: () => (mode === 'rich' ? rich : ta).focus(),
  };
}
