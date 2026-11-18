// Thistle suite bridge.
// - parseSpecs(): read ```thistle-plot JSON blocks written by the model
// - buildG(): deterministically turn a dataset + spec into Thistle Plot's table G = {nReps, nRows, rowNames, groups:[{name, reps, data[row][rep]}]}
// - ThistleApp: drive Thistle Plot / Thistle Flow in a same-origin iframe (suite hosted together on GitHub Pages), so the
//   statistics are computed by the suite's own code and nothing leaves the browser.
import { htmlToText } from './ingest.js';
import { sleep } from './util.js';

export function parseSpecs(text) {
  const out = [], re = /```thistle-plot\s*\n([\s\S]*?)```/g; let m;
  while ((m = re.exec(text))) {
    try { out.push({ ok: true, spec: JSON.parse(m[1]), raw: m[0] }); }
    catch (e) { out.push({ ok: false, error: 'Could not read the analysis request (invalid JSON): ' + e.message, raw: m[0] }); }
  }
  return out;
}

const norm = s => String(s ?? '').trim().toLowerCase();

export function findTable(spec, datasets) {
  const want = norm(spec.dataset);
  const ds = datasets.find(d => norm(d.name) === want) || datasets.find(d => want && norm(d.name).includes(want)) ||
    datasets.find(d => want && want.includes(norm(d.name).replace(/\.\w+$/, ''))) || (datasets.length === 1 ? datasets[0] : null);
  if (!ds) throw new Error(`Dataset "${spec.dataset}" not found. Available: ${datasets.map(d => d.name).join(', ') || 'none'}.`);
  if (!ds.tables) throw new Error(`"${ds.name}" is too large to keep as a table in the browser; split it or open it directly in Thistle Plot.`);
  const sheets = Object.keys(ds.tables);
  const sheet = spec.sheet ? sheets.find(s => norm(s) === norm(spec.sheet)) : sheets[0];
  if (!sheet) throw new Error(`Sheet "${spec.sheet}" not found in ${ds.name}. Sheets: ${sheets.join(', ')}.`);
  return { ds, sheet, table: ds.tables[sheet] };
}

export function buildG(spec, table) {
  const cols = table.columns;
  const ci = name => {
    if (name == null) return -1;
    const i = cols.findIndex(c => norm(c) === norm(name));
    if (i < 0) throw new Error(`Column "${name}" not found. Columns: ${cols.join(', ')}.`);
    return i;
  };
  let rows = table.rows;
  for (const [k, v] of Object.entries(spec.filter || {})) {
    const i = ci(k), allowed = [].concat(v).map(norm);
    rows = rows.filter(r => allowed.includes(norm(r[i])));
  }
  if (!rows.length) throw new Error('No rows left after the filter.');
  const num = v => typeof v === 'number' && isFinite(v) ? v : (v != null && v !== '' && isFinite(+v) ? +v : null);
  const cell = v => (num(v) ?? '');
  const levels = (i, order) => {
    const seen = []; rows.forEach(r => { const k = r[i] == null ? null : String(r[i]); if (k != null && !seen.includes(k)) seen.push(k); });
    if (order) { const o = order.map(String); return [...o.filter(x => seen.includes(x)), ...seen.filter(x => !o.includes(x))]; }
    return seen;
  };
  const putFirst = (names, ctrl) => { if (ctrl == null) return names; const i = names.findIndex(n => norm(n) === norm(ctrl)); if (i < 0) throw new Error(`Control group "${ctrl}" not found. Groups: ${names.join(', ')}.`); return [names[i], ...names.filter((_, k) => k !== i)]; };
  const layout = spec.layout || (spec.columns ? 'wide' : spec.x ? 'xy' : spec.time ? 'survival' : spec.groups ? 'matrix' : spec.rows ? 'counts' : 'long');
  const G = { nReps: 1, nRows: 0, rowNames: [], groups: [] };
  const notes = [];

  if (layout === 'long') {
    const gcols = [].concat(spec.group).map(ci), vi = ci(spec.value), si = spec.subject ? ci(spec.subject) : -1;
    if (!gcols.length || gcols[0] < 0) throw new Error('"group" column is required for the long layout.');
    const key = r => gcols.map(i => r[i] == null ? null : String(r[i]));
    let names;
    if (gcols.length === 2) { // two-way: A-major order, as Thistle Plot's two-way ANOVA expects
      const A = levels(gcols[0], spec.orderA), B = levels(gcols[1], spec.orderB);
      names = A.flatMap(a => B.map(b => `${a} · ${b}`));
      notes.push(`Two-way layout: factor A = ${cols[gcols[0]]} (${A.length} levels), factor B = ${cols[gcols[1]]} (${B.length} levels).`);
      spec._nA = A.length; spec._nB = B.length;
    } else names = putFirst(levels(gcols[0], spec.order), spec.control);
    const gname = r => { const k = key(r); return k.some(x => x == null) ? null : k.join(' · '); };
    const valid = rows.filter(r => gname(r) != null && num(r[vi]) != null);
    if (si >= 0) {
      const subjects = levels(si);
      const cellVals = new Map();
      valid.forEach(r => { const k = String(r[si]) + '\u0000' + gname(r); (cellVals.get(k) || cellVals.set(k, []).get(k)).push(num(r[vi])); });
      const nReps = Math.max(1, ...[...cellVals.values()].map(v => v.length));
      G.nReps = nReps; G.rowNames = subjects; G.nRows = subjects.length;
      G.groups = names.map(n => ({ name: n, reps: Array.from({ length: nReps }, (_, k) => nReps === 1 ? 'Value' : `Rep${k + 1}`),
        data: subjects.map(s => Array.from({ length: nReps }, (_, k) => cellVals.get(String(s) + '\u0000' + n)?.[k] ?? '')) }));
    } else {
      const byG = names.map(n => valid.filter(r => gname(r) === n).map(r => num(r[vi])));
      const n = Math.max(...byG.map(v => v.length));
      G.nRows = n; G.rowNames = Array.from({ length: n }, (_, i) => `Obs ${i + 1}`);
      G.groups = names.map((nm, k) => ({ name: nm, reps: ['Value'], data: Array.from({ length: n }, (_, i) => [byG[k][i] ?? '']) }));
    }
    const dropped = rows.length - valid.length; if (dropped) notes.push(`${dropped} row(s) without a group or numeric value were left out.`);
  } else if (layout === 'wide' || layout === 'single') {
    let cs = [].concat(spec.columns || []).map(ci);
    if (!cs.length) throw new Error('"columns" is required for the wide layout.');
    if (spec.control) { const k = cs.findIndex(i => norm(cols[i]) === norm(spec.control)); if (k > 0) cs = [cs[k], ...cs.filter((_, j) => j !== k)]; }
    const li = spec.label ? ci(spec.label) : -1;
    const keep = rows.filter(r => cs.some(i => num(r[i]) != null));
    G.nRows = keep.length; G.rowNames = keep.map((r, k) => li >= 0 ? String(r[li] ?? `Row ${k + 1}`) : `Row ${k + 1}`);
    G.groups = cs.map(i => ({ name: cols[i], reps: ['Value'], data: keep.map(r => [cell(r[i])]) }));
  } else if (layout === 'xy') {
    const xi = ci(spec.x), yi = ci(spec.y), li = spec.label ? ci(spec.label) : -1;
    const keep = rows.filter(r => num(r[xi]) != null && num(r[yi]) != null);
    if (keep.length < rows.length) notes.push(`${rows.length - keep.length} row(s) with a missing X or Y were left out.`);
    G.nRows = keep.length; G.rowNames = keep.map((r, k) => li >= 0 ? String(r[li]) : `Point ${k + 1}`);
    G.groups = [xi, yi].map(i => ({ name: cols[i], reps: ['Value'], data: keep.map(r => [num(r[i])]) }));
  } else if (layout === 'counts') {
    const ri = ci(spec.rows), cj = ci(spec.cols), ni = spec.count ? ci(spec.count) : -1;
    const R = levels(ri, spec.orderRows), C = putFirst(levels(cj, spec.order), spec.control);
    const tab = R.map(() => C.map(() => 0));
    rows.forEach(r => { const a = R.indexOf(String(r[ri])), b = C.indexOf(String(r[cj])); if (a >= 0 && b >= 0) tab[a][b] += ni >= 0 ? (num(r[ni]) || 0) : 1; });
    G.nRows = R.length; G.rowNames = R;
    G.groups = C.map((c, b) => ({ name: c, reps: ['Value'], data: R.map((_, a) => [tab[a][b]]) }));
  } else if (layout === 'survival') {
    const ti = ci(spec.time), ei = ci(spec.event), gi = ci(spec.group);
    const keep = rows.filter(r => num(r[ti]) != null && num(r[ei]) != null && r[gi] != null);
    const names = putFirst(levels(gi, spec.order), spec.control);
    G.nRows = keep.length; G.rowNames = keep.map((r, k) => `Subject ${k + 1}`);
    G.groups = [{ name: cols[ti], reps: ['Value'], data: keep.map(r => [num(r[ti])]) },
      ...names.map(n => ({ name: n, reps: ['Value'], data: keep.map(r => [String(r[gi]) === n ? (num(r[ei]) ? 1 : 0) : '']) }))];
  } else if (layout === 'matrix') {
    const li = ci(spec.label), entries = Object.entries(spec.groups || {});
    if (!entries.length) throw new Error('"groups" ({name: [replicate columns]}) is required for the matrix layout.');
    const nReps = Math.max(...entries.map(([, c]) => c.length));
    const idx = entries.map(([n, c]) => [n, c.map(ci)]);
    G.nRows = rows.length; G.rowNames = rows.map((r, k) => String(r[li] ?? `Feature ${k + 1}`));
    if (['pca', 'heatmap'].includes(spec.test)) { // Thistle Plot treats each column group as one sample here
      G.nReps = 1;
      G.groups = idx.flatMap(([n, is]) => is.map(i => ({ name: `${n} · ${cols[i]}`, reps: ['Value'], data: rows.map(r => [cell(r[i])]) })));
      notes.push('Each replicate column is a separate sample (named "group · column").');
    } else {
      G.nReps = nReps;
      G.groups = idx.map(([n, is]) => ({ name: n, reps: Array.from({ length: nReps }, (_, k) => `Rep${k + 1}`), data: rows.map(r => Array.from({ length: nReps }, (_, k) => is[k] != null ? cell(r[is[k]]) : '')) }));
    }
  } else throw new Error(`Unknown layout "${layout}".`);
  if (!G.nRows) throw new Error('The table for Thistle Plot is empty.');
  return { G, notes, layout };
}

// Thistle Plot project file (format 2, as written by TP's saveProject), so it opens in TP directly.
export function tplotFile(G, statTab = null, plot = null, appVersion = '') {
  return JSON.stringify({ app: 'Thistle Plot', format: 2, version: 2, appVersion, createdBy: 'Thistle Notebook',
    G, statTabs: statTab ? [{ id: 'st1', title: statTab.title, html: statTab.html }] : [],
    plotTabs: plot ? [{ id: 'pt1', title: plot.title, imageData: plot.image }] : [], activePT: plot ? 'pt1' : null, activeST: statTab ? 'st1' : null }, null, 2);
}

// ---------------- iframe bridge ----------------
export function defaultSuiteUrl(app) { // app = 'thistle-plot' | 'thistle-flow'
  if (location.hostname.endsWith('github.io')) return `${location.origin}/${app}/`;
  return new URL(`../${app}/index.html`, location.href).href;
}

export class ThistleApp {
  constructor(name, url, host) { this.name = name; this.url = url; this.host = host; this.frame = null; this.alerts = []; }

  get sameOrigin() { try { return new URL(this.url, location.href).origin === location.origin; } catch { return false; } }

  async ensure(readyTest, timeout = 30000) {
    if (!this.sameOrigin) throw new Error(`${this.name} must be served from the same site as Thistle Notebook to run inside it (e.g. both on actinomycetes.github.io). Use the downloaded file instead.`);
    if (!this.frame) {
      this.frame = document.createElement('iframe');
      this.frame.src = this.url; this.frame.title = this.name; this.frame.className = 'suite-frame';
      this.host.append(this.frame);
    }
    const t0 = Date.now();
    for (; ;) {
      try { const w = this.frame.contentWindow; if (w && w.document.readyState === 'complete' && readyTest(w)) break; } catch (e) { throw new Error(`${this.name} could not be opened (${e.message}).`); }
      if (Date.now() - t0 > timeout) throw new Error(`${this.name} did not load from ${this.url}. Check the address in ⚙ Settings.`);
      await sleep(150);
    }
    const w = this.frame.contentWindow;
    if (!w.__tnHooked) { w.__tnHooked = true; w.alert = msg => { this.alerts.push(String(msg)); }; }
    return w;
  }
}

export class ThistlePlot extends ThistleApp {
  constructor(url, host) { super('Thistle Plot', url, host); }
  ready() { return this.ensure(w => typeof w.applyG === 'function' && typeof w.runAnalysis === 'function' && w.document.getElementById('asel')); }

  // Read the options TP offers for the selected test, as [{label, id, type, choices}]
  static readOptions(doc) {
    const out = [];
    doc.querySelectorAll('#aopts select, #aopts input').forEach(el => {
      if (!el.id || el.type === 'hidden') return;
      const box = el.closest('div'); let label = box?.querySelector('.opt-lbl')?.textContent?.trim();
      if (el.type === 'checkbox') label = el.closest('label')?.textContent?.trim() || label;
      out.push({ id: el.id, label: label || el.id, type: el.type === 'checkbox' ? 'checkbox' : el.tagName === 'SELECT' ? 'select' : 'number',
        choices: el.tagName === 'SELECT' ? [...el.options].map(o => o.textContent.trim()) : undefined, value: el.type === 'checkbox' ? el.checked : el.value });
    });
    return out;
  }

  async run(spec, G) {
    const w = await this.ready(), doc = w.document;
    this.alerts = [];
    w.applyG(G);
    const asel = doc.getElementById('asel');
    if (![...asel.options].some(o => o.value === spec.test)) throw new Error(`Thistle Plot has no test "${spec.test}".`);
    asel.value = spec.test; asel.dispatchEvent(new Event('change')); await sleep(80);
    const applied = [], unknown = [];
    const setEl = (el, v) => {
      if (el.type === 'checkbox') el.checked = !!v && !/^(false|no|off|0)$/i.test(String(v));
      else if (el.tagName === 'SELECT') {
        const o = [...el.options].find(o => norm(o.value) === norm(v)) || [...el.options].find(o => norm(o.textContent).includes(norm(v)));
        if (!o) return false; el.value = o.value;
      } else el.value = v;
      el.dispatchEvent(new Event('change', { bubbles: true })); el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    };
    const opts = { ...(spec.options || {}) };
    if (spec.test === 'anova2' && spec._nA) {
      const el = doc.getElementById('opt-nA');
      if (el) { setEl(el, spec._nA); applied.push(`Factor A levels (nA) = ${spec._nA}`); await sleep(30); }
    }
    for (const [label, v] of Object.entries(opts)) {
      if (label.startsWith('__')) continue;
      const found = ThistlePlot.readOptions(doc).find(o => norm(o.label).includes(norm(label)) || norm(o.id) === norm(label));
      const el = found && doc.getElementById(found.id);
      if (el && setEl(el, v)) { applied.push(`${found.label} = ${v}`); await sleep(30); } else unknown.push(`${label} = ${v}`);
    }
    const nBefore = w.eval('statTabs.length'), pBefore = w.eval('plotTabs.length');
    w.runAnalysis();
    await sleep(400);
    const stats = w.eval('statTabs'), plots = w.eval('plotTabs');
    if (stats.length === nBefore) throw new Error('Thistle Plot did not produce a result' + (this.alerts.length ? ': ' + this.alerts.join(' ') : '.'));
    const tab = stats[stats.length - 1];
    let plot = null;
    if (plots.length > pBefore) {
      const p = plots[plots.length - 1];
      const c = doc.getElementById('c_' + p.id) || doc.querySelector('#' + p.id + ' canvas');
      if (c) {
        const o = doc.createElement('canvas'); o.width = c.width; o.height = c.height;
        const g = o.getContext('2d'); g.fillStyle = w.getComputedStyle(doc.body).backgroundColor || '#fff'; g.fillRect(0, 0, o.width, o.height); g.drawImage(c, 0, 0);
        plot = { title: p.title, image: o.toDataURL('image/png') };
      }
    }
    return {
      title: tab.title, html: tab.html, text: htmlToText(tab.html), plot, applied, unknown, alerts: [...this.alerts],
      options: ThistlePlot.readOptions(doc).map(o => `${o.label}${o.choices ? ' {' + o.choices.join(' | ') + '}' : ''} = ${o.value}`),
      appVersion: w.eval('typeof APP_VERSION!=="undefined"?APP_VERSION:""'),
    };
  }

  // Save TP's whole session with TP's own serializer (captures its download)
  async saveSession() {
    const w = await this.ready(); const orig = w._saveBlob; let blob;
    w._saveBlob = b => { blob = b; };
    try { w.saveProject(); } finally { w._saveBlob = orig; }
    return blob;
  }
}

export class ThistleFlow extends ThistleApp {
  constructor(url, host) { super('Thistle Flow', url, host); }
  ready() { return this.ensure(w => !!w.thistleFlow && w.document.querySelector('.tabs button[data-tab="stats"]')); }
  // Read Thistle Flow's Statistics table (the user loads FCS files and gates inside the Thistle Flow panel)
  async statistics() {
    const w = await this.ready(), doc = w.document;
    doc.querySelector('.tabs button[data-tab="stats"]').click(); await sleep(300);
    const t = doc.getElementById('statsTable');
    const rows = [...t.querySelectorAll('tr')].map(tr => [...tr.children].map(c => c.textContent.trim()));
    if (rows.length < 2) throw new Error('Thistle Flow has no statistics yet: load FCS files and draw gates in the Thistle Flow panel first.');
    const typed = v => v === '' ? null : isFinite(+v.replace(/,/g, '')) ? +v.replace(/,/g, '') : v;
    return { columns: rows[0].map((c, i) => c || (i ? `col${i + 1}` : 'Sample')), rows: rows.slice(1).map(r => r.map(typed)), workspace: w.thistleFlow.ws?.name || 'Thistle Flow' };
  }
}
