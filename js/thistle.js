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
// Index of `want` in `names`: the exact (trimmed, case-sensitive) name first; otherwise a case-insensitive match only when
// it is the only one ("ctrl" never picks "Ctrl" while a "ctrl" also exists). -1 = none; throws when two names differ
// only in case and neither is exact (v0.6.1, independent review).
function pickName(names, want, what) {
  const w = String(want ?? '').trim(), hits = names.map((n, i) => String(n ?? '').trim() === w ? i : -1).filter(i => i >= 0);
  if (hits.length > 1) throw new Error(`${what} "${want}" appears ${hits.length} times (positions ${hits.map(i => i + 1).join(' and ')}); rename the duplicates in the file so each name is unique (v0.6.3).`);
  if (hits.length) return hits[0];
  const loose = names.map((n, i) => norm(n) === norm(w) ? i : -1).filter(i => i >= 0);
  if (loose.length > 1) throw new Error(`${what} "${want}" could mean ${loose.map(i => `"${names[i]}"`).join(' or ')}; write it exactly as in the file.`);
  return loose.length ? loose[0] : -1;
}
const PAIRED_TESTS = ['ttest_rel', 'wilcoxon'];

// The dataset a spec names: a name with an extension must match exactly ("actual.xlsx" never runs on "actual.csv",
// v0.6.0); a bare name ("mice") matches a file of that name with any extension only when exactly one does. Never a
// partial match, and never a different file just because it is the only one loaded (v0.5.0). With no dataset named and
// one loaded, that one is used and named in the notes (spec._datasetNote).
export function findTable(spec, datasets) {
  const want = norm(spec.dataset), stem = n => norm(n).replace(/\.\w+$/, '');
  let ds = null;
  if (want) {
    const exact = datasets.filter(d => norm(d.name) === want);
    if (exact.length > 1) throw new Error(`Multiple loaded datasets match "${spec.dataset}". Give them unique filenames before running this analysis.`);
    ds = exact[0] || null;
    if (!ds && !/\.\w+$/.test(want)) {
      const hits = datasets.filter(d => stem(d.name) === want);
      if (hits.length > 1) throw new Error(`"${spec.dataset}" could mean ${hits.map(d => d.name).join(' or ')}; name the file with its extension.`);
      ds = hits[0] || null;
    }
  }
  else if (datasets.length === 1) { ds = datasets[0]; spec._datasetNote = `Data: ${ds.name} (the only dataset loaded; no dataset was named).`; }
  if (!ds) throw new Error(want ? `Dataset "${spec.dataset}" is not loaded. Available: ${datasets.map(d => d.name).join(', ') || 'none'}.`
    : `Name the dataset to use ("dataset"). Available: ${datasets.map(d => d.name).join(', ') || 'none'}.`);
  spec._dataset = ds.name;
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
    const i = pickName(cols, name, 'Column');
    if (i < 0) throw new Error(`Column "${name}" not found. Columns: ${cols.join(', ')}.`);
    return i;
  };
  let rows = table.rows;
  // Category reads (subjects, groups, filters, labels, count rows/columns) use cat(row, col): the spelling from the file
  // where the importer kept one (1e3, 1.10), else the cell. Measurements always read the typed cell, so a value column
  // that is also filtered, or named like the subject column in another case (id / ID), keeps "1,000" as 1000
  // (v0.6.1, independent review: the spelling used to overwrite the cell and the pair was lost).
  const orig = new Map();
  for (const [r, c, value] of table.originalText || []) { const row = table.rows[r]; if (row) (orig.get(row) || orig.set(row, new Map()).get(row)).set(c, value); }
  const cat = (row, c) => { const m = orig.get(row); return m && m.has(c) ? m.get(c) : row[c]; };
  // Filter values (v0.6.1, independent review): a value selects the cells with exactly its text (trimmed, case-sensitive,
  // because S1 and s1 are different subjects). Only when no cell has that text may it match ignoring case ("female" →
  // "Female"), and then by number ("2.0" → the stored 2), each only if it finds a single spelling in the column; "1.10"
  // never pulls in "1.1", and "S1" never pulls in "s1". Every value is resolved against its WHOLE column (not the rows left
  // by another filter, which let {Site: South, ID: S1} pick s1); matches are combined within a column and intersected
  // across columns. A value that matches nothing or two spellings stops the run, and so does an empty intersection.
  const filters = Object.entries(spec.filter || {});
  if (filters.length) {
    const text = c => c == null ? null : String(c).trim(), problems = [], keep = [];
    for (const [k, v] of filters) {
      const i = ci(k), picks = new Set();
      for (const w of [].concat(v).map(x => String(x).trim())) {
        const exact = rows.filter(r => text(cat(r, i)) === w);
        if (exact.length) { exact.forEach(r => picks.add(r)); continue; }
        const n = w === '' ? NaN : Number(w);
        let found = false;
        for (const same of [r => text(cat(r, i)) != null && norm(cat(r, i)) === norm(w),               // ignoring case
          r => Number.isFinite(n) && typeof r[i] === 'number' && r[i] === n]) {                             // by number (typed cell)
          const hits = rows.filter(same), spellings = [...new Set(hits.map(r => text(cat(r, i))))];
          if (spellings.length === 1) { hits.forEach(r => picks.add(r)); found = true; break; }
          if (spellings.length > 1) { problems.push(`"${cols[i]}": "${w}" could mean ${spellings.map(x => `"${x}"`).join(' or ')}`); found = true; break; }
        }
        if (!found) problems.push(`"${cols[i]}": no rows with "${w}" (values present: ${[...new Set(rows.map(r => cat(r, i)).filter(x => x != null).map(String))].slice(0, 20).join(', ')})`);
      }
      keep.push(picks);
    }
    if (problems.length) throw new Error(`Filter: ${problems.join('; ')}. Use the values exactly as written in the file.`);
    rows = rows.filter(r => keep.every(p => p.has(r)));
    if (!rows.length) throw new Error(`Filter: no rows match all of ${filters.map(([k, v]) => `${k} = ${[].concat(v).join(' or ')}`).join(' and ')}.`);
  }
  if (!rows.length) throw new Error('No rows left after the filter.');
  const num = v => typeof v === 'number' && isFinite(v) ? v : (v != null && v !== '' && isFinite(+v) ? +v : null);
  const cell = v => (num(v) ?? '');
  // Levels of a category column in file order; `order` (field = its spec name) puts the listed levels first. A level
  // listed twice is refused (v0.6.1, independent review: it duplicated a group with the same observations).
  const levels = (i, order, field = 'order') => {
    const seen = []; rows.forEach(r => { const v = cat(r, i), k = v == null ? null : String(v); if (k != null && !seen.includes(k)) seen.push(k); });
    if (order) {
      const o = [].concat(order).map(String), dup = o.find((x, j) => o.indexOf(x) !== j);
      if (dup !== undefined) throw new Error(`"${field}" lists "${dup}" more than once; give each level once.`);
      return [...o.filter(x => seen.includes(x)), ...seen.filter(x => !o.includes(x))];
    }
    return seen;
  };
  const putFirst = (names, ctrl) => { if (ctrl == null) return names; const i = pickName(names, ctrl, 'Control group'); if (i < 0) throw new Error(`Control group "${ctrl}" not found. Groups: ${names.join(', ')}.`); return [names[i], ...names.filter((_, k) => k !== i)]; };
  const layout = spec.layout || (spec.columns ? 'wide' : spec.x ? 'xy' : spec.time ? 'survival' : spec.groups ? 'matrix' : spec.rows ? 'counts' : 'long');
  const G = { nReps: 1, nRows: 0, rowNames: [], groups: [] };
  const notes = spec._datasetNote ? [spec._datasetNote] : [];

  if (layout === 'long') {
    const gcols = [].concat(spec.group).map(ci), vi = ci(spec.value), si = spec.subject ? ci(spec.subject) : -1;
    if (!gcols.length || gcols[0] < 0) throw new Error('"group" column is required for the long layout.');
    if (spec.test === 'anova2' && gcols.length !== 2) throw new Error('A two-way ANOVA in the long layout needs two factor columns in "group" (for example ["Genotype", "Treatment"]), so that the design comes from the data.');
    if (PAIRED_TESTS.includes(spec.test) && si < 0) throw new Error('A paired test in the long layout needs a "subject" column that says which measurements belong to the same subject (animal, patient, experiment). Without it the rows would be paired by their order in the file.');
    const key = r => gcols.map(i => cat(r, i) == null ? null : String(cat(r, i)));
    // Observations are assigned by the tuple of levels (a cell index), never by the display name: "a" + "b · c" and
    // "a · b" + "c" both read "a · b · c" (v0.6.1, independent review: two cells received each other's values).
    let tuples, names;
    if (gcols.length === 2) { // two-way: A-major order, as Thistle Plot's two-way ANOVA expects
      const A = levels(gcols[0], spec.orderA, 'orderA'), B = levels(gcols[1], spec.orderB, 'orderB');
      tuples = A.flatMap(a => B.map(b => [a, b]));
      names = tuples.map(([a, b]) => `${a} · ${b}`);
      if (new Set(names).size < names.length) names = tuples.map(([a, b]) => `[${a}] · [${b}]`); // keep labels distinct
      if (new Set(names).size < names.length) names = names.map((n, k) => `${n} (cell ${k + 1})`);
      notes.push(`Two-way layout: factor A = ${cols[gcols[0]]} (${A.length} levels), factor B = ${cols[gcols[1]]} (${B.length} levels).`);
      spec._nA = A.length; spec._nB = B.length;
    } else { names = putFirst(levels(gcols[0], spec.order), spec.control); tuples = names.map(n => [n]); }
    const cellOf = new Map(tuples.map((t, k) => [JSON.stringify(t), k]));
    const gidx = r => { const k = key(r); return k.some(x => x == null) ? null : (cellOf.get(JSON.stringify(k)) ?? null); };
    const valid = rows.filter(r => gidx(r) != null && num(r[vi]) != null);
    if (si >= 0) {
      const subjects = levels(si);
      const hasId = r => cat(r, si) != null && String(cat(r, si)).trim() !== '';
      const noId = valid.filter(r => !hasId(r)).length;
      if (noId) notes.push(`${noId} row(s) with no subject ID were left out.`);
      const cellVals = new Map(); // rows without an ID are left out here, so they never count as repeated measurements
      valid.filter(hasId).forEach(r => { const k = JSON.stringify([String(cat(r, si)), gidx(r)]); (cellVals.get(k) || cellVals.set(k, []).get(k)).push(num(r[vi])); });
      // One value per subject and group: repeated (technical) measurements are averaged, so the subject stays the unit
      // of analysis (v0.5.0: repeats became extra pairs and inflated n and the degrees of freedom).
      const repeated = [...cellVals.values()].filter(v => v.length > 1).length;
      if (repeated) notes.push(`${repeated} subject × group cell(s) had repeated measurements; they were averaged, so each subject counts once.`);
      G.nReps = 1; G.rowNames = subjects; G.nRows = subjects.length;
      G.groups = names.map((n, g) => ({ name: n, reps: ['Value'],
        data: subjects.map(s => { const v = cellVals.get(JSON.stringify([String(s), g])); return [v?.length ? v.reduce((a, x) => a + x, 0) / v.length : '']; }) }));
    } else {
      const byG = names.map((_, g) => valid.filter(r => gidx(r) === g).map(r => num(r[vi])));
      const n = Math.max(...byG.map(v => v.length));
      G.nRows = n; G.rowNames = Array.from({ length: n }, (_, i) => `Obs ${i + 1}`);
      G.groups = names.map((nm, k) => ({ name: nm, reps: ['Value'], data: Array.from({ length: n }, (_, i) => [byG[k][i] ?? '']) }));
    }
    const dropped = rows.length - valid.length; if (dropped) notes.push(`${dropped} row(s) without a group or numeric value were left out.`);
  } else if (layout === 'wide' || layout === 'single') {
    let cs = [].concat(spec.columns || []).map(ci);
    if (!cs.length) throw new Error('"columns" is required for the wide layout.');
    // the same column twice (exactly, or Control / control resolving to one header) would be tested against itself
    { const d = cs.find((c, j) => cs.indexOf(c) !== j); if (d !== undefined) throw new Error(`Column "${cols[d]}" is listed more than once in "columns" (v0.6.1).`); }
    if (spec.control != null) { const k = pickName(cs.map(i => cols[i]), spec.control, 'Control');
      if (k < 0) throw new Error(`Control "${spec.control}" is not one of the columns: ${cs.map(i => cols[i]).join(', ')}.`); // v0.6.0: was ignored
      if (k > 0) cs = [cs[k], ...cs.filter((_, j) => j !== k)]; }
    const li = spec.label ? ci(spec.label) : -1;
    const keep = rows.filter(r => cs.some(i => num(r[i]) != null));
    G.nRows = keep.length; G.rowNames = keep.map((r, k) => li >= 0 ? String(cat(r, li) ?? `Row ${k + 1}`) : `Row ${k + 1}`);
    G.groups = cs.map(i => ({ name: cols[i], reps: ['Value'], data: keep.map(r => [cell(r[i])]) }));
  } else if (layout === 'xy') {
    const xi = ci(spec.x), yi = ci(spec.y), li = spec.label ? ci(spec.label) : -1;
    const keep = rows.filter(r => num(r[xi]) != null && num(r[yi]) != null);
    if (keep.length < rows.length) notes.push(`${rows.length - keep.length} row(s) with a missing X or Y were left out.`);
    G.nRows = keep.length; G.rowNames = keep.map((r, k) => li >= 0 ? String(cat(r, li)) : `Point ${k + 1}`);
    G.groups = [xi, yi].map(i => ({ name: cols[i], reps: ['Value'], data: keep.map(r => [num(r[i])]) }));
  } else if (layout === 'counts') {
    const ri = ci(spec.rows), cj = ci(spec.cols), ni = spec.count ? ci(spec.count) : -1;
    const R = levels(ri, spec.orderRows, 'orderRows'), C = putFirst(levels(cj, spec.order), spec.control);
    const tab = R.map(() => C.map(() => 0)), seen = R.map(() => C.map(() => false)), bad = [];
    // Pre-counted data: each count must be a whole number >= 0 (v0.6.0: a blank became 0 and two 0.5 became 1 before
    // Thistle Plot could check the table). A combination with no row at all counts as 0, and the notes say which.
    const count = (v, k) => {
      const x = typeof v === 'number' ? v : (v == null || String(v).trim() === '' ? NaN : Number(String(v).trim()));
      if (Number.isInteger(x) && x >= 0) return x;
      bad.push(`row ${k + 1} (${r_label(k)}): ${v == null || String(v).trim() === '' ? 'blank' : JSON.stringify(v)}`); return 0;
    };
    const r_label = k => `${cat(rows[k], ri)} × ${cat(rows[k], cj)}`;
    rows.forEach((r, k) => { const a = R.indexOf(String(cat(r, ri))), b = C.indexOf(String(cat(r, cj))); if (a < 0 || b < 0) return;
      seen[a][b] = true; tab[a][b] += ni >= 0 ? count(r[ni], k) : 1; });
    if (bad.length) throw new Error(`Counts in "${cols[ni]}" must be whole numbers of 0 or more: ${bad.slice(0, 5).join('; ')}${bad.length > 5 ? `; and ${bad.length - 5} more` : ''}. Fix the file or use the raw rows instead of counts.`);
    if (ni >= 0) { const absent = []; R.forEach((a, i) => C.forEach((c, j) => { if (!seen[i][j]) absent.push(`${a} × ${c}`); }));
      if (absent.length) notes.push(`No row for ${absent.join(', ')}: counted as 0.`); }
    G.nRows = R.length; G.rowNames = R;
    G.groups = C.map((c, b) => ({ name: c, reps: ['Value'], data: R.map((_, a) => [tab[a][b]]) }));
  } else if (layout === 'survival') {
    const ti = ci(spec.time), ei = ci(spec.event), gi = ci(spec.group);
    // events must be coded 0 (censored) or 1 (event): any other code is refused, never read as an event (v0.6.3)
    // missing = blank or a missing marker (typed as null); any other text ("event") is an invalid code, not missing
    const badEv = []; rows.forEach((r, k) => { const raw = cat(r, ei); if (raw == null || String(raw).trim() === '') return; const e = num(r[ei]); if (e !== 0 && e !== 1) badEv.push(`row ${k + 1}: ${raw}`); });
    if (badEv.length) throw new Error(`"${cols[ei]}" must be 1 (event) or 0 (censored); found ${badEv.slice(0, 5).join('; ')}${badEv.length > 5 ? ` and ${badEv.length - 5} more` : ''}. Recode the column first.`);
    const keep = rows.filter(r => num(r[ti]) != null && num(r[ei]) != null && cat(r, gi) != null);
    if (keep.length < rows.length) notes.push(`${rows.length - keep.length} row(s) with a missing time, event or group were left out.`);
    const names = putFirst(levels(gi, spec.order), spec.control);
    G.nRows = keep.length; G.rowNames = keep.map((r, k) => `Subject ${k + 1}`);
    G.groups = [{ name: cols[ti], reps: ['Value'], data: keep.map(r => [num(r[ti])]) },
      ...names.map(n => ({ name: n, reps: ['Value'], data: keep.map(r => [String(cat(r, gi)) === n ? (num(r[ei]) ? 1 : 0) : '']) }))];
  } else if (layout === 'matrix') {
    const li = ci(spec.label), entries = Object.entries(spec.groups || {});
    if (!entries.length) throw new Error('"groups" ({name: [replicate columns]}) is required for the matrix layout.');
    const nReps = Math.max(...entries.map(([, c]) => c.length));
    const idx = entries.map(([n, c]) => [n, c.map(ci)]);
    { const all = idx.flatMap(([, is]) => is), d = all.find((c, j) => all.indexOf(c) !== j);
      if (d !== undefined) throw new Error(`Column "${cols[d]}" is listed more than once in "groups" (v0.6.1).`); }
    G.nRows = rows.length; G.rowNames = rows.map((r, k) => String(cat(r, li) ?? `Feature ${k + 1}`));
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
  constructor(name, url, host) { this.name = name; this.url = url; this.host = host; this.frame = null; this.alerts = []; this._q = Promise.resolve(); }

  // One user of the shared app frame at a time: a run (apply table → options → collect result and image) or a drawer action
  // that changes the table waits for the previous one, even if that one failed (v0.6.2: two overlapping cards both got the
  // second card's result).
  exclusive(fn) { const p = this._q.then(() => fn()); this._q = p.catch(() => {}); return p; }

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
    if (!w.__tnHooked) {
      w.__tnHooked = true; w.alert = msg => { this.alerts.push(String(msg)); };
      // a freshly loaded app page: set Notebook's own title again so the tab keeps Notebook's icon (v0.6.5: Orion showed
      // the embedded Thistle Plot's icon on Notebook's tab; Plot ≥ 0.19.1 and Flow ≥ 0.23.1 also drop their icons inside a frame)
      document.title = document.title; this._retitled = (this._retitled || 0) + 1;
    }
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

  run(spec, G) { return this.exclusive(() => this._run(spec, G)); }
  // Load a table into the frame for the user to look at (👁), in turn with runs
  show(G) { return this.exclusive(async () => { const w = await this.ready(); w.applyG(G); return w; }); }
  async _run(spec, G) {
    const w = await this.ready(), doc = w.document;
    this.alerts = [];
    w.applyG(G);
    const asel = doc.getElementById('asel');
    if (![...asel.options].some(o => o.value === spec.test)) throw new Error(`Thistle Plot has no test "${spec.test}".`);
    asel.value = spec.test; asel.dispatchEvent(new Event('change')); await sleep(80);
    const applied = [], unknown = [];
    // true when set; otherwise why not ('missing' choice, or 'disabled' by Thistle Plot for this design)
    const setEl = (el, v) => {
      if (el.type === 'checkbox') el.checked = !!v && !/^(false|no|off|0)$/i.test(String(v));
      else if (el.tagName === 'SELECT') {
        const o = [...el.options].find(o => norm(o.value) === norm(v)) || [...el.options].find(o => norm(o.textContent).includes(norm(v)));
        if (!o) return 'missing'; if (o.disabled) return 'disabled'; el.value = o.value;
      } else el.value = v;
      el.dispatchEvent(new Event('change', { bubbles: true })); el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    };
    const opts = { ...(spec.options || {}) };
    if (spec.test === 'anova2') for (const [id, v, lab] of [['opt-nA', spec._nA, 'Factor A levels (nA)'], ['opt-nB', spec._nB, 'Factor B levels (nB)']]) {
      const el = v && doc.getElementById(id);
      if (el) { setEl(el, v); applied.push(`${lab} = ${v}`); await sleep(30); }
    }
    const isCmp = l => /comparison/i.test(l) && !/correction/i.test(l);
    // Dunnett compares each group with ONE control: with a control named and no Comparisons given, ask for "vs control"
    if (spec.test === 'anova' && spec.control != null && Object.values(opts).some(v => /dunnett/i.test(String(v))) && !Object.keys(opts).some(isCmp)) {
      const el = doc.getElementById('opt-cmp');
      if (el && setEl(el, 'ctrl') === true) { applied.push('Comparisons = vs control (Dunnett compares each group with one control)'); await sleep(30); }
    }
    const order = Object.entries(opts).filter(([l]) => !l.startsWith('__')).sort(([a], [b]) => (isCmp(b) ? 1 : 0) - (isCmp(a) ? 1 : 0));
    for (const [label, v] of order) {
      const menu = ThistlePlot.readOptions(doc);
      const query = norm(label);
      const exact = menu.filter(o => norm(o.label) === query || norm(o.id) === query);
      const matches = exact.length ? exact : menu.filter(o => query && norm(o.label).includes(query));
      if (matches.length > 1) throw new Error(`Ambiguous option "${label}": ${matches.map(o => o.label).join(', ')}.`);
      const found = matches[0];
      if (spec.test === 'anova2' && ['opt-nA', 'opt-nB'].includes(found?.id)) {
        const inferred = found.id === 'opt-nA' ? spec._nA : spec._nB;
        if (inferred != null && Number(v) !== inferred) throw new Error(`${found.label} has ${inferred} levels in the data but the option asks for ${v}.`);
        if (!Number.isInteger(Number(v)) || Number(v) < 2) throw new Error(`${found.label} requires a whole number of at least two.`);
      }
      const el = found && doc.getElementById(found.id);
      if (!el) throw new Error(`Thistle Plot has no option "${label}" for this test (v0.6.0: it used to run with the default). Options: ${ThistlePlot.readOptions(doc).map(o => o.label).filter(Boolean).join(' | ')}.`);
      const res = setEl(el, v);
      if (res === true) { applied.push(`${found.label} = ${v}`); await sleep(30); continue; }
      const choices = el.tagName === 'SELECT' ? [...el.options].filter(o => !o.disabled).map(o => o.textContent.trim()).join(' | ') : '';
      throw new Error(`Thistle Plot cannot use ${found.label} = ${v}: ${res === 'disabled' ? 'that choice is not available for this design' : 'there is no such choice'}${choices ? `. Available now: ${choices}` : ''}.`);
    }
    const nBefore = w.eval('statTabs.length'), pBefore = w.eval('plotTabs.length');
    w.runAnalysis();
    await sleep(400);
    const stats = w.eval('statTabs'), plots = w.eval('plotTabs');
    if (stats.length === nBefore) throw new Error('Thistle Plot did not produce a result' + (this.alerts.length ? ': ' + this.alerts.join(' ') : '.'));
    const tab = stats[stats.length - 1];
    // Thistle Plot reports a problem as a result tab with only an error box (or a tab titled "Error"): that is a failure
    if (tab.title === 'Error' || (!/class="scard"/.test(tab.html) && /class="ebox"/.test(tab.html)))
      throw new Error('Thistle Plot could not run this analysis: ' + htmlToText(tab.html).trim());
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
    const out = readStatsTable(doc.getElementById('statsTable'));
    if (!out.rows.length) throw new Error('Thistle Flow has no statistics yet: load FCS files and draw gates in the Thistle Flow panel first.');
    return { ...out, workspace: w.thistleFlow.ws?.name || 'Thistle Flow' };
  }
}

// Thistle Flow's Statistics table as typed rows. Since TF v0.21.0 every value cell carries its exact number in data-v
// (the text is rounded for reading, e.g. 0.003 % shown as 0.00 before); a blank means "not measured" and stays null.
export function readStatsTable(t) {
  const rows = t ? [...t.querySelectorAll('tr')].map(tr => [...tr.children]) : [];
  const typed = c => {
    const v = c.hasAttribute('data-v') ? c.getAttribute('data-v') : c.textContent.trim();
    if (v === '') return null;
    const n = +v.replace(/,/g, ''); return isFinite(n) ? n : v;
  };
  if (rows.length < 2) return { columns: rows[0]?.map(c => c.textContent.trim()) || [], rows: [] };
  // the first column holds sample names: text, never numbers (v0.6.1: 001 and 1 both became 1); statistics read data-v
  return { columns: rows[0].map((c, i) => c.textContent.trim() || (i ? `col${i + 1}` : 'Sample')), rows: rows.slice(1).map(r => r.map((c, i) => i ? typed(c) : (c.textContent.trim() || null))) };
}
