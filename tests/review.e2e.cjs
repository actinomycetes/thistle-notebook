// Regression tests for the independent statistical review (Nov 2026), cases 04, 05, 13 and 14, through the real
// Thistle Plot (sibling checkout ../thistle-plot). References: SciPy 1.18.1 / statsmodels 0.15.0 (values in comments).
// Usage: node tests/review.e2e.cjs (files are served by tests/serve.cjs)
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const serveSuite = require('./serve.cjs');
const BASE = process.env.TN_URL || 'http://localhost:8765/thistle-notebook/index.html';
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const b = await chromium.launch(), bctx = await b.newContext();
  if (!process.env.TN_URL) await serveSuite(bctx);
  const page = await bctx.newPage();
  await page.route('https://elm.edina.ac.uk/**', r => r.fulfill({ status: 401, json: { error: { message: 'no key in test' } } }));
  await page.goto(BASE);
  await page.waitForFunction(() => window.thistleNotebook?.tp);
  // the same path as runSpec in js/app.js: findTable → buildG → ThistlePlot.run; errors come back as { error }
  const run = (spec, datasets) => page.evaluate(async ([spec, datasets]) => {
    const { findTable, buildG } = await import('./js/thistle.js');
    try {
      const { ds, table } = findTable(spec, datasets);
      const sp = { ...spec }, built = buildG(sp, table);
      const r = await window.thistleNotebook.tp.run(sp, built.G);
      return { dataset: ds.name, G: built.G, notes: built.notes, text: r.text, applied: r.applied, unknown: r.unknown };
    } catch (e) { return { error: e.message }; }
  }, [spec, datasets]);
  const ds = (name, columns, rows) => ({ name, tables: { [name.replace(/\.\w+$/, '')]: { columns, rows } } });

  // ---- 04: a 2×3 design sets both factor sizes (nB stayed at Thistle Plot's default 2, fitting 4 of 6 cells as 2×2)
  const f04 = []; ['WT', 'KO'].forEach((a, i) => ['Veh', 'Lo', 'Hi'].forEach((bb, j) => [-1, 0, 1].forEach(o => f04.push([a, bb, [1, 2, 4, 8, 16, 32][i * 3 + j] + o]))));
  let r = await run({ test: 'anova2', layout: 'long', group: ['Geno', 'Treat'], value: 'Y', dataset: 'f.csv' }, [ds('f.csv', ['Geno', 'Treat', 'Y'], f04)]);
  ok(!r.error && /2×3/.test(r.text), '04: two-way ANOVA fitted as 2×3 ' + (r.error || ''));
  ok(/1200\.500/.test(r.text) && /283\.500/.test(r.text) && /171\.500/.test(r.text), '04: F = 1200.5, 283.5, 171.5 (statsmodels ols Y ~ A*B, df_resid 12)');
  ok((r.applied || []).some(a => /nB.*3/.test(a)), '04: nB = 3 reported as applied');

  // ---- 05: paired tests need a subject column; technical repeats are averaged per subject
  const S = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'], before = [10.2, 11.5, 9.8, 12.1, 10.9, 11.0], delta = [1.3, 2.1, -0.4, 1.8, 0.9, 1.5];
  const after = before.map((v, i) => +(v + delta[i]).toFixed(2));
  const shuffled = [...S.map((s, i) => [s, 'Before', before[i]]), ...[3, 0, 5, 1, 4, 2].map(i => [S[i], 'After', after[i]])];
  for (const t of ['ttest_rel', 'wilcoxon']) {
    r = await run({ test: t, layout: 'long', group: 'Cond', value: 'Y', control: 'Before', dataset: 'p.csv' }, [ds('p.csv', ['Subj', 'Cond', 'Y'], shuffled)]);
    ok(r.error && /subject/i.test(r.error), `05: ${t} without a subject column is refused (rows were paired by file order)`);
  }
  r = await run({ test: 'ttest_rel', layout: 'long', group: 'Cond', value: 'Y', control: 'Before', subject: 'Subj', dataset: 'p.csv' }, [ds('p.csv', ['Subj', 'Cond', 'Y'], shuffled)]);
  ok(/t statistic \| -3\.320/.test(r.text || ''), '05: with subject IDs the order of rows does not matter (t = -3.320, SciPy ttest_rel -3.3197)');
  const dup = [];
  S.forEach((s, i) => [-0.2, 0.3].forEach(t => dup.push([s, 'Before', +(before[i] + t).toFixed(2)])));
  S.forEach((s, i) => [0.25, -0.1].forEach(t => dup.push([s, 'After', +(after[i] + t).toFixed(2)])));
  r = await run({ test: 'ttest_rel', layout: 'long', group: 'Cond', value: 'Y', control: 'Before', subject: 'Subj', dataset: 'd.csv' }, [ds('d.csv', ['Subj', 'Cond', 'Y'], dup)]);
  ok(/t statistic \| -3\.389/.test(r.text || '') && /df \| 5\.0/.test(r.text || ''), '05: repeats averaged per subject: t = -3.389, df 5 (SciPy on subject means -3.3889, p 0.01949); was df 11');
  ok((r.notes || []).some(n => /averag/i.test(n)), '05: averaging is stated in the data notes');

  // ---- 13a: a named dataset that is not loaded is an error, not the only loaded file
  r = await run({ test: 'anova', layout: 'long', group: 'G', value: 'Y', dataset: 'different.csv' }, [ds('actual.csv', ['G', 'Y'], [['a', 1], ['a', 2], ['b', 3], ['b', 4]])]);
  ok(r.error && /different\.csv/.test(r.error), '13a: "different.csv" is not resolved to actual.csv');
  r = await run({ test: 'anova', layout: 'long', group: 'G', value: 'Y', dataset: 'mice_v2.csv' }, [ds('mice.csv', ['G', 'Y'], [['a', 1], ['a', 2], ['b', 3], ['b', 4]]), ds('other.csv', ['G', 'Y'], [['a', 1]])]);
  ok(r.error, '13a: "mice_v2.csv" is not resolved to mice.csv');
  r = await run({ test: 'ttest_ind', layout: 'long', group: 'G', value: 'Y' }, [ds('actual.csv', ['G', 'Y'], [['a', 1], ['a', 2], ['a', 2.5], ['b', 3], ['b', 4], ['b', 4.5]])]);
  ok(!r.error && r.dataset === 'actual.csv' && (r.notes || []).some(n => /actual\.csv/.test(n)), '13a: with no dataset named, the only one is used and named in the notes');

  // ---- 13b/c: the shipped Dunnett example runs Dunnett vs the control (2 comparisons), not Holm–Šídák on all pairs
  const mice = fs.readFileSync(path.join(__dirname, 'fixtures/mice.csv'), 'utf8').trim().split('\n');
  const mcols = mice[0].split(','), mrows = mice.slice(1).map(l => l.split(',').map((v, i) => i === 3 ? +v : v));
  const M = [ds('mice.csv', mcols, mrows)];
  const example = { title: 'Body weight by treatment', test: 'anova', dataset: 'mice.csv', layout: 'long', group: 'Treatment', value: 'Weight_g', control: 'Vehicle', filter: { Sex: 'F' }, options: { 'Post-hoc correction': 'Dunnett' } };
  r = await run(example, M);
  ok(/Dunnett, vs Vehicle \(2 comparisons\)/.test(r.text || ''), '13b: example runs "Dunnett, vs Vehicle (2 comparisons)" ' + (r.error || ''));
  ok(/0\.0403/.test(r.text || '') && /0\.183/.test(r.text || ''), '13b: Dunnett p-adj 0.0403 / 0.183 (SciPy dunnett 0.04030, 0.18350)');
  const promptText = fs.readFileSync(path.join(__dirname, '../js/prompts.js'), 'utf8');
  ok(/"Comparisons":\s*"vs control"/.test(promptText), '13b: the protocol example names "Comparisons": "vs control"');
  r = await run({ ...example, options: { 'Comparisons': 'all pairs', 'Post-hoc correction': 'Dunnett' } }, M);
  ok(r.error && /Dunnett/.test(r.error), '13c: a choice Thistle Plot has disabled (Dunnett with all pairs) fails instead of being recorded as applied');
  r = await run({ ...example, options: { 'Post-hoc correction': 'Scheffe' } }, M);
  ok(r.error && /Scheffe/.test(r.error), '13c: a choice that does not exist for a known option fails');

  // ---- 13d: a Thistle Plot error tab is a failure, not a result
  r = await run({ test: 'anova2', layout: 'long', group: 'G', value: 'Y', dataset: 'g.csv' }, [ds('g.csv', ['G', 'Y'], [['a', 1], ['a', 2], ['b', 3], ['b', 4], ['c', 5], ['c', 6]])]);
  ok(r.error, '13d: two-way ANOVA on one factor fails ' + (r.error || ''));
  r = await run({ test: 'anova', layout: 'long', group: 'G', value: 'Y', dataset: 'g.csv' }, [ds('g.csv', ['G', 'Y'], [['a', 1], ['a', 2]])]);
  ok(r.error, '13d: ANOVA with one group fails');

  // ---- 14: Thistle Flow's statistics are read at full precision from data-v; blank stays missing
  const st = await page.evaluate(async () => {
    const { readStatsTable } = await import('./js/thistle.js');
    const t = document.createElement('table');
    t.innerHTML = '<thead><tr><th>Sample</th><th>CD3+ | % Total</th><th>CD3+ | Count</th></tr></thead><tbody>' +
      '<tr><td>rare.fcs</td><td data-v="0.003">0.003</td><td data-v="3">3</td></tr><tr><td>noCD3.fcs</td><td data-v=""></td><td data-v=""></td></tr>' +
      '<tr><td>old.fcs</td><td>12.50</td><td>1,250</td></tr></tbody>';
    return readStatsTable(t);
  });
  ok(st.rows[0][1] === 0.003 && st.rows[0][2] === 3, '14: rare frequency read as 0.003 from data-v (the text showed 0.00 before TF v0.21)');
  ok(st.rows[1][1] === null && st.rows[1][2] === null, '14: not-measured cells stay null, never 0');
  ok(st.rows[2][1] === 12.5 && st.rows[2][2] === 1250, '14: tables without data-v are still read from their text');

  // ================= statistical re-review (TN v0.6.0) =================
  // N1: pre-counted data: every source count must be a whole number >= 0; absent combinations count as 0 with a note
  const cnt = rows => [ds('c.csv', ['Treat', 'Outcome', 'N'], rows)];
  const cspec = { test: 'fisher', layout: 'counts', rows: 'Treat', cols: 'Outcome', count: 'N', dataset: 'c.csv' };
  r = await run(cspec, cnt([['A', 'yes', 10], ['A', 'no', ''], ['B', 'yes', 0], ['B', 'no', 10]]));
  ok(r.error && /blank/i.test(r.error), 'N1: a blank count is refused, not read as 0 ' + (r.error || ''));
  r = await run(cspec, cnt([['A', 'yes', 10], ['A', 'no', 0.5], ['A', 'no', 0.5], ['B', 'yes', 0], ['B', 'no', 10]]));
  ok(r.error && /0\.5/.test(r.error), 'N1: fractional counts are refused (two 0.5 became 1)');
  r = await run(cspec, cnt([['A', 'yes', 10], ['A', 'no', -2], ['B', 'yes', 0], ['B', 'no', 10]]));
  ok(r.error && /-2/.test(r.error), 'N1: negative counts are refused');
  r = await run(cspec, cnt([['A', 'yes', 10], ['A', 'no', 'many'], ['B', 'yes', 0], ['B', 'no', 10]]));
  ok(r.error && /many/.test(r.error), 'N1: text counts are refused');
  r = await run(cspec, cnt([['A', 'yes', 10], ['A', 'no', 0], ['B', 'yes', 0], ['B', 'no', 10]]));
  ok(!r.error && JSON.stringify(r.G.groups.map(g => g.data.map(x => x[0]))) === '[[10,0],[0,10]]', 'N1: a genuine 0 is kept ' + (r.error || ''));
  r = await run(cspec, cnt([['A', 'yes', 10], ['B', 'yes', 0], ['B', 'no', 10]]));
  ok(!r.error && (r.notes || []).some(n => /A × no/.test(n) && /counted as 0/.test(n)), 'N1: an absent combination counts as 0 and the notes say which ' + JSON.stringify(r.notes || r.error));

  // N2: an explicit file name must match exactly; a bare name only when it is unique
  const two = [ds('actual.csv', ['G', 'Y'], [['a', 1], ['a', 2], ['b', 3], ['b', 4]])];
  r = await run({ test: 'anova', layout: 'long', group: 'G', value: 'Y', dataset: 'actual.xlsx' }, two);
  ok(r.error && /actual\.xlsx/.test(r.error), 'N2: "actual.xlsx" does not run on actual.csv');
  r = await run({ test: 'anova', layout: 'long', group: 'G', value: 'Y', dataset: 'actual' }, two);
  ok(!r.error && r.dataset === 'actual.csv', 'N2: a bare name that is unique still works ' + (r.error || ''));
  r = await run({ test: 'anova', layout: 'long', group: 'G', value: 'Y', dataset: 'actual' }, [...two, ds('actual.xlsx', ['G', 'Y'], [['a', 9], ['b', 9]])]);
  ok(r.error && /actual\.csv/.test(r.error) && /actual\.xlsx/.test(r.error), 'N2: an ambiguous bare name is refused and lists both files');

  // N2: a wide control must be one of the columns (a misspelling ran Dunnett against the first column)
  const wide = [ds('w.csv', ['T1', 'T2', 'Vehicle'], [[5, 7, 3], [6, 8, 4], [5.5, 7.5, 3.2], [6.2, 8.1, 3.9]])];
  const wspec = { test: 'anova', layout: 'wide', columns: ['T1', 'T2', 'Vehicle'], dataset: 'w.csv', options: { 'Post-hoc correction': 'Dunnett' } };
  r = await run({ ...wspec, control: 'Vehcile' }, wide);
  ok(r.error && /Vehcile/.test(r.error), 'N2: a misspelt control is refused ' + (r.error || ''));
  r = await run({ ...wspec, control: 'Vehicle' }, wide);
  ok(/Dunnett, vs Vehicle \(2 comparisons\)/.test(r.text || ''), 'N2: control Vehicle gives Dunnett vs Vehicle, 2 comparisons ' + (r.error || ''));

  // N3: factor sizes come from the table; conflicting options are refused; a long two-way needs two factor columns
  r = await run({ test: 'anova2', layout: 'long', group: ['Geno', 'Treat'], value: 'Y', dataset: 'f.csv', options: { 'opt-nA': 3, 'opt-nB': 2 } }, [ds('f.csv', ['Geno', 'Treat', 'Y'], f04)]);
  ok(r.error && /2/.test(r.error) && /3/.test(r.error), 'N3: options nA = 3, nB = 2 on a 2×3 table are refused (it fitted 3×2) ' + (r.error || ''));
  r = await run({ test: 'anova2', layout: 'long', group: ['Geno', 'Treat'], value: 'Y', dataset: 'f.csv', options: { 'opt-nA': 2, 'opt-nB': 3 } }, [ds('f.csv', ['Geno', 'Treat', 'Y'], f04)]);
  ok(!r.error && /1200\.500/.test(r.text || ''), 'N3: options that agree with the table are fine');
  r = await run({ test: 'anova2', layout: 'long', group: 'Geno', value: 'Y', dataset: 'f.csv', options: { 'opt-nA': 2, 'opt-nB': 3 } }, [ds('f.csv', ['Geno', 'Treat', 'Y'], f04)]);
  ok(r.error && /two/i.test(r.error), 'N3: a long two-way ANOVA with one factor column is refused');

  // N4: subject IDs keep their text through import (001 and 1 are different subjects); rows without an ID are reported
  const imp = await page.evaluate(async () => {
    const { parseFile } = await import('./js/ingest.js');
    const f = new File(['ID,Cond,Y\n001,A,1\n1,A,2\n1,B,6\n001,B,4\n,A,5\n'], 'ids.csv', { type: 'text/csv' });
    const res = await parseFile(f, {}); return Object.values(res.tables || {})[0] || res.table || res;
  });
  ok(imp.rows && imp.rows[0][0] === '001' && String(imp.rows[1][0]) === '1', 'N4: "001" stays "001" after import ' + JSON.stringify(imp.rows && imp.rows.slice(0, 2)));
  r = await run({ test: 'ttest_rel', layout: 'long', group: 'Cond', value: 'Y', subject: 'ID', control: 'A', dataset: 'ids.csv' }, [{ name: 'ids.csv', tables: { ids: imp } }]);
  ok(!r.error && JSON.stringify(r.G.rowNames) === '["001","1"]', 'N4: two subjects, 001 and 1 ' + (r.error || JSON.stringify(r.G?.rowNames)));
  ok(/t statistic \| 7\.000/.test(r.text || '') || /t statistic \| -7\.000/.test(r.text || ''), 'N4: differences 3 and 4 give |t| = 7 (SciPy ttest_rel: t = 7.0, df 1)');
  ok((r.notes || []).some(n => /1 row.*no subject/i.test(n)), 'N4: the row without a subject ID is reported ' + JSON.stringify(r.notes));

  // unknown option names stop the run instead of using Thistle Plot's defaults
  r = await run({ ...example, options: { 'Post-hoc correction': 'Dunnett', 'Confidence band': '99%' } }, M);
  ok(r.error && /Confidence band/.test(r.error), 'options: an option Thistle Plot does not have is refused ' + (r.error || ''));

  const identity = await page.evaluate(async () => {
    const {parseFile} = await import('./js/ingest.js');
    const {buildG} = await import('./js/thistle.js');
    const file = new File(['ID,Group,Y\n1e3,A,1e3\n1000,A,2\nNA,A,3\n'], 'identity.csv');
    const parsed = await parseFile(file, {});
    const out = buildG({layout:'long',subject:'ID',group:'Group',value:'Y'},parsed.tables.identity);
    // measurement-like columns (mostly decimals) keep no original text, so large tables do not grow
    const big = await parseFile(new File(['G,Y\n' + Array.from({ length: 500 }, (_, i) => `g${i % 3},${(i / 7).toFixed(2)}0`).join('\n')], 'big.csv'), {});
    return { G: out.G, notes: out.notes, bigOrig: (big.tables.big.originalText || []).length };
  });
  ok(JSON.stringify(identity.G.rowNames) === '["1e3","1000"]' && identity.G.groups[0].data[0][0] === 1000,
    'categorical spellings survive while scientific-notation measurements stay numeric ' + JSON.stringify(identity.G.rowNames));
  ok(identity.notes.some(n => /1 row.*no subject/i.test(n)), 'NA in a subject column stays missing (not a subject called "NA") and is reported');
  ok(identity.bigOrig === 0, 'a column of decimals stores no original text (saved notebooks do not grow): ' + identity.bigOrig);
  // independent review of PR #1: decimal-looking subject IDs 1.1, 1.10 and 2.0 are three subjects, not two
  const dec = await page.evaluate(async () => {
    const { parseFile } = await import('./js/ingest.js');
    const { buildG } = await import('./js/thistle.js');
    const parsed = await parseFile(new File(['ID,Cond,Y\n1.1,A,1\n1.10,A,2\n2.0,A,3\n1.1,B,4\n1.10,B,6\n2.0,B,8\n'], 'dec.csv'), {});
    const spec = { test: 'ttest_rel', layout: 'long', subject: 'ID', group: 'Cond', value: 'Y', control: 'A' };
    const all = buildG(spec, parsed.tables.dec);
    const filtered = buildG({ ...spec, filter: { ID: ['1.1', '1.10', '2.0'] } }, parsed.tables.dec);
    let unmatched; try { buildG({ ...spec, filter: { ID: ['1.1', '3.0'] } }, parsed.tables.dec); } catch (e) { unmatched = e.message; }
    const one = id => buildG({ ...spec, filter: { ID: [id] } }, parsed.tables.dec).G.rowNames;
    let ambiguous; try { one('1.100'); } catch (e) { ambiguous = e.message; }
    return { ...all, filtered: filtered.G.rowNames, unmatched, only11: one('1.1'), only110: one('1.10'), only20: one('2.0'), ambiguous };
  });
  ok(dec.G.rowNames.length === 3 && dec.G.rowNames.includes('1.1') && dec.G.rowNames.includes('1.10'), 'decimal-looking subject IDs 1.1 and 1.10 stay separate: 3 pairs ' + JSON.stringify(dec.G.rowNames));
  ok(!dec.notes.some(n => /averag/i.test(n)), 'no subjects merged and averaged as technical repeats');
  ok(JSON.stringify(dec.filtered) === JSON.stringify(dec.G.rowNames), 'a filter listing the three original IDs keeps the same three pairs ' + JSON.stringify(dec.filtered));
  ok(/3\.0/.test(dec.unmatched || ''), 'a filter value that matches no row stops the run and names it: ' + dec.unmatched);
  ok(JSON.stringify(dec.only11) === '["1.1"]', 'filter 1.1 alone selects exactly subject 1.1 ' + JSON.stringify(dec.only11));
  ok(JSON.stringify(dec.only110) === '["1.10"]', 'filter 1.10 alone selects exactly subject 1.10 (not 1.1 as well) ' + JSON.stringify(dec.only110));
  ok(JSON.stringify(dec.only20) === '["2"]', 'filter 2.0 still finds the stored 2 ' + JSON.stringify(dec.only20));
  ok(/1\.100/.test(dec.ambiguous || '') && /1\.1\b/.test(dec.ambiguous || '') && /1\.10/.test(dec.ambiguous || ''), 'a value that matches two spellings only by number (1.100) is refused and names both: ' + dec.ambiguous);
  // independent review: case matters for IDs; S1 and s1 are two subjects, so a filter must not join them
  const cs = await page.evaluate(async () => {
    const { parseFile } = await import('./js/ingest.js');
    const { buildG } = await import('./js/thistle.js');
    const parsed = await parseFile(new File(['ID,Cond,Y\nS1,A,1\ns1,A,2\nS2,A,3\nS1,B,4\ns1,B,6\nS2,B,8\n'], 'case.csv'), {});
    const spec = { test: 'ttest_rel', layout: 'long', subject: 'ID', group: 'Cond', value: 'Y', control: 'A' };
    const one = id => { try { return buildG({ ...spec, filter: { ID: [id] } }, parsed.tables.case).G.rowNames; } catch (e) { return 'ERR ' + e.message; } };
    return { all: buildG(spec, parsed.tables.case).G.rowNames, S1: one('S1'), s1: one('s1'), s2: one('s2') };
  });
  ok(cs.all.length === 3, 'S1, s1 and S2 are three subjects ' + JSON.stringify(cs.all));
  ok(JSON.stringify(cs.S1) === '["S1"]', 'filter S1 selects only S1 ' + JSON.stringify(cs.S1));
  ok(JSON.stringify(cs.s1) === '["s1"]', 'filter s1 selects only s1 ' + JSON.stringify(cs.s1));
  ok(JSON.stringify(cs.s2) === '["S2"]', 'a different case still matches when only one spelling exists (s2 → S2) ' + JSON.stringify(cs.s2));
  // independent review: filters resolve against the whole column, not the rows left by an earlier filter
  const mf = await page.evaluate(async () => {
    const { parseFile } = await import('./js/ingest.js');
    const { buildG } = await import('./js/thistle.js');
    const t1 = (await parseFile(new File(['ID,Site,Cond,Y\nS1,North,A,1\nS1,North,B,2\ns1,South,A,3\ns1,South,B,5\n'], 'mf.csv'), {})).tables.mf;
    const t2 = (await parseFile(new File(['ID,Site,Cond,Y\n1.1,North,A,1\n1.1,North,B,2\n1.10,South,A,3\n1.10,South,B,5\n'], 'mf2.csv'), {})).tables.mf2;
    const spec = { test: 'ttest_rel', layout: 'long', subject: 'ID', group: 'Cond', value: 'Y', control: 'A' };
    const go = (t, filter) => { try { const b = buildG({ ...spec, filter }, t); return { names: b.G.rowNames, vals: b.G.groups.map(g => g.data.map(x => x[0])) }; } catch (e) { return { error: e.message }; } };
    return { a: go(t1, { ID: 'S1', Site: 'South' }), b: go(t1, { Site: 'South', ID: 'S1' }),
      c: go(t1, { ID: 's1', Site: 'South' }), d: go(t1, { Site: 'South', ID: 's1' }), e: go(t2, { Site: 'South', ID: '1.100' }) };
  });
  ok(mf.a.error && mf.b.error && /no rows/i.test(mf.a.error) && /no rows/i.test(mf.b.error), 'ID S1 + Site South selects nothing in either order (S1 was swapped for s1 when Site came first) ' + JSON.stringify([mf.a, mf.b]));
  ok(!mf.c.error && JSON.stringify(mf.c) === JSON.stringify(mf.d) && JSON.stringify(mf.c.names) === '["s1"]' && JSON.stringify(mf.c.vals) === '[[3],[5]]', 'ID s1 + Site South gives the same subject and values in either order ' + JSON.stringify([mf.c, mf.d]));
  ok(mf.e.error && /1\.100/.test(mf.e.error) && /could mean/.test(mf.e.error), 'a site filter cannot make an ambiguous 1.100 resolve to one subject ' + JSON.stringify(mf.e));
  // independent review: a measurement column used as a filter, or one whose name differs only in case from the subject
  // column, keeps its typed numbers ("1,000" is 1000), so no pair is lost
  const meas = await page.evaluate(async () => {
    const { parseFile } = await import('./js/ingest.js');
    const { buildG } = await import('./js/thistle.js');
    const t = (await parseFile(new File(['ID,Cond,Y\nP1,A,"1,000"\nP1,B,1100\nP2,A,900\nP2,B,1001\n'], 'm.csv'), {})).tables.m;
    const t2 = (await parseFile(new File(['id,Cond,ID\nP1,A,"1,000"\nP1,B,1100\nP2,A,900\nP2,B,1001\n'], 'm2.csv'), {})).tables.m2;
    const spec = { test: 'ttest_rel', layout: 'long', subject: 'ID', group: 'Cond', value: 'Y', control: 'A' };
    const pick = b => ({ names: b.G.rowNames, vals: b.G.groups.map(g => g.data.map(x => x[0])), notes: b.notes });
    return { plain: pick(buildG(spec, t)), filt: pick(buildG({ ...spec, filter: { Y: ['1,000', '1100', '900', '1001'] } }, t)),
      cased: pick(buildG({ ...spec, subject: 'id', value: 'ID' }, t2)) };
  });
  ok(JSON.stringify(meas.plain.vals) === '[[1000,900],[1100,1001]]', 'unfiltered: 1,000 is read as 1000 ' + JSON.stringify(meas.plain.vals));
  ok(JSON.stringify(meas.filt.vals) === JSON.stringify(meas.plain.vals) && JSON.stringify(meas.filt.names) === JSON.stringify(meas.plain.names) && !meas.filt.notes.some(n => /left out/.test(n)),
    'filtering a measurement column by all its values gives the same table, two complete pairs, no dropped rows ' + JSON.stringify(meas.filt));
  ok(JSON.stringify(meas.cased.vals) === '[[1000,900],[1100,1001]]' && !meas.cased.notes.some(n => /left out/.test(n)), 'subject "id" and value "ID" keep the measurement typed ' + JSON.stringify(meas.cased));
  // independent review: two-way cells are keyed by their levels, not by a joined display name
  const cells = await page.evaluate(async () => {
    const { buildG } = await import('./js/thistle.js');
    const t = { columns: ['A', 'B', 'Y', 'S'], rows: [['a', 'b · c', 10, 'p1'], ['a', 'c', 20, 'p1'], ['a · b', 'b · c', 30, 'p1'], ['a · b', 'c', 40, 'p1']] };
    const un = buildG({ test: 'anova2', layout: 'long', group: ['A', 'B'], value: 'Y' }, t);
    const pr = buildG({ test: 'anova2', layout: 'long', group: ['A', 'B'], value: 'Y', subject: 'S' }, t);
    const vals = b => b.G.groups.map(g => g.data.map(x => x[0]).filter(v => v !== ''));
    return { un: vals(un), pr: vals(pr), names: un.G.groups.map(g => g.name) };
  });
  ok(JSON.stringify(cells.un) === '[[10],[20],[30],[40]]', 'unpaired: each two-way cell gets only its own value (cells 1 and 4 both got [10,40]) ' + JSON.stringify(cells.un));
  ok(JSON.stringify(cells.pr) === '[[10],[20],[30],[40]]', 'subject-indexed: each two-way cell gets only its own value ' + JSON.stringify(cells.pr));
  ok(new Set(cells.names).size === 4, 'the four cells have four different names ' + JSON.stringify(cells.names));
  // independent review: a level repeated in an order list is refused instead of duplicating a group
  const ord = await page.evaluate(async () => {
    const { buildG } = await import('./js/thistle.js');
    const t = { columns: ['Cond', 'Y'], rows: [['A', 1000], ['A', 900], ['B', 1100], ['B', 1001]] };
    const t2 = { columns: ['F', 'G', 'Y'], rows: [['x', 'u', 1], ['x', 'v', 2], ['y', 'u', 3], ['y', 'v', 4]] };
    const err = f => { try { f(); return null; } catch (e) { return e.message; } };
    return {
      one: err(() => buildG({ test: 'anova', layout: 'long', group: 'Cond', value: 'Y', order: ['A', 'A', 'B'] }, t)),
      two: err(() => buildG({ test: 'anova2', layout: 'long', group: ['F', 'G'], value: 'Y', orderB: ['v', 'v'] }, t2)),
      partial: buildG({ test: 'anova', layout: 'long', group: 'Cond', value: 'Y', order: ['B'] }, t).G.groups.map(g => g.name) };
  });
  ok(/"order"/.test(ord.one || '') && /"A"/.test(ord.one || ''), 'a repeated level in "order" is refused, naming the field and level: ' + ord.one);
  ok(/"orderB"/.test(ord.two || '') && /"v"/.test(ord.two || ''), 'a repeated level in "orderB" is refused: ' + ord.two);
  ok(JSON.stringify(ord.partial) === '["B","A"]', 'a valid partial order puts B first and adds A once ' + JSON.stringify(ord.partial));
  // independent review: a column requested twice in the wide layout is refused; missing IDs do not count as repeats
  const wd = await page.evaluate(async () => {
    const { buildG } = await import('./js/thistle.js');
    const t = { columns: ['Control', 'Drug'], rows: [[1, 5], [2, 7], [3, 9]] };
    const t2 = { columns: ['Control', 'control', 'Drug'], rows: [[1, 10, 5], [2, 20, 7], [3, 30, 9]] };
    const err = f => { try { f(); return null; } catch (e) { return e.message; } };
    const ids = rows => buildG({ test: 'ttest_rel', layout: 'long', subject: 'ID', group: 'Cond', value: 'Y', control: 'A' }, { columns: ['ID', 'Cond', 'Y'], rows }).notes;
    return {
      exact: err(() => buildG({ layout: 'wide', columns: ['Control', 'Control', 'Drug'] }, t)),
      cased: err(() => buildG({ layout: 'wide', columns: ['Control', 'control', 'Drug'] }, t)),
      distinct: buildG({ layout: 'wide', columns: ['Control', 'control', 'Drug'] }, t2).G.groups.map(g => [g.name, g.data.map(x => x[0])]),
      noId: ids([['P', 'A', 1], ['P', 'B', 2], [null, 'A', 4], [null, 'A', 8]]),
      rep: ids([['P', 'A', 1], ['P', 'A', 3], ['P', 'B', 2], [null, 'A', 4]]) };
  });
  ok(/Control/.test(wd.exact || '') && /more than once/.test(wd.exact || ''), 'wide: an exactly repeated column is refused: ' + wd.exact);
  ok(/Control/.test(wd.cased || '') && /more than once/.test(wd.cased || ''), 'wide: "Control" and "control" naming the same column are refused: ' + wd.cased);
  ok(JSON.stringify(wd.distinct) === '[["Control",[1,2,3]],["control",[10,20,30]],["Drug",[5,7,9]]]', 'wide: two different columns Control and control are both used ' + JSON.stringify(wd.distinct));
  ok(wd.noId.some(n => /2 row.*no subject/.test(n)) && !wd.noId.some(n => /averag/.test(n)), 'rows without an ID give only the missing-ID note, no averaging note ' + JSON.stringify(wd.noId));
  ok(wd.rep.some(n => /1 subject × group cell.*averag/.test(n)), 'a real repeat for P still gives the averaging note ' + JSON.stringify(wd.rep));
  // wider review: identifiers keep their text across the suite (Flow table → Notebook, model summary, Excel export)
  const idx = await page.evaluate(async () => {
    const { readStatsTable, buildG } = await import('./js/thistle.js');
    const { parseFile, profileTable } = await import('./js/ingest.js');
    const { tablesToXlsx } = await import('./js/export.js');
    const { unzip } = await import('./js/zip.js');
    const t = document.createElement('table');
    t.innerHTML = '<thead><tr><th>Sample</th><th>CD3+ | Count</th></tr></thead><tbody><tr><td>001</td><td data-v="10">10</td></tr><tr><td>1</td><td data-v="20">20</td></tr></tbody>';
    const flow = readStatsTable(t);
    const fg = buildG({ layout: 'long', group: 'Sample', value: 'CD3+ | Count' }, flow).G.groups.map(g => [g.name, g.data.map(x => x[0]).filter(v => v !== '')]);
    const ds = (await parseFile(new File(['ID,Cond,Y\n1e3,A,1\n1000,B,2\n'], 'p.csv'), {})).tables.p;
    const prof = profileTable(ds, 'p.csv');
    const f = id => buildG({ layout: 'long', group: 'Cond', value: 'Y', filter: { ID: id } }, ds).G.groups.map(g => g.name);
    const blob = tablesToXlsx([{ title: 'T', header: ['ID', 'Y'], rows: [['001', '1.5'], ['9007199254740993', '2.25'], ['1e309', '1e-400'], ['-1e-310', '0e-400']] }]);
    const z = await unzip(new Uint8Array(await blob.arrayBuffer())), sh = await z.text('xl/worksheets/sheet1.xml');
    return { flowNames: flow.rows.map(r => r[0]), fg, prof, f1: f('1e3'), f2: f('1000'), sh };
  });
  ok(JSON.stringify(idx.flowNames) === '["001","1"]', 'Flow sample names 001 and 1 arrive as text ' + JSON.stringify(idx.flowNames));
  ok(JSON.stringify(idx.fg) === '[["001",[10]],["1",[20]]]', 'Flow samples 001 and 1 stay two groups with their own values ' + JSON.stringify(idx.fg));
  ok(/\| ID \| text \| 0 \| 2 \|/.test(idx.prof) && /1e3,A,1/.test(idx.prof), 'the summary sent to the model shows two IDs and the spelling 1e3 ' + (idx.prof.match(/\| ID \|[^\n]*/) || [''])[0]);
  ok(JSON.stringify(idx.f1) === '["A"]' && JSON.stringify(idx.f2) === '["B"]', 'an exact filter on 1e3 and on 1000 selects one row each ' + JSON.stringify([idx.f1, idx.f2]));
  ok(/t="inlineStr"[^>]*><is><t[^>]*>001</.test(idx.sh) && /t="inlineStr"[^>]*><is><t[^>]*>9007199254740993</.test(idx.sh), 'Excel keeps 001 and a 16-digit ID as text');
  ok(/<v>1\.5<\/v>/.test(idx.sh) && /<v>2\.25<\/v>/.test(idx.sh), 'Excel keeps ordinary measurements numeric');
  for (const [ref, value] of [['A4', '1e309'], ['B4', '1e-400'], ['A5', '-1e-310']]) {
    ok(idx.sh.includes(`<c r="${ref}" t="inlineStr" s="2"><is><t xml:space="preserve">${value}</t>`), `Excel preserves out-of-range ${value} as text`);
  }
  ok(idx.sh.includes('<c r="B5" s="2"><v>0</v></c>'), 'a genuine zero stays numeric');
  // the same rule for column names and control groups
  r = await run({ test: 'ttest_ind', layout: 'long', group: 'G', value: 'y', control: 'ctrl', dataset: 'cg.csv' }, [ds('cg.csv', ['G', 'Y', 'y'],
    [['Ctrl', 1, 10], ['Ctrl', 2, 11], ['ctrl', 5, 20], ['ctrl', 6, 21], ['Ctrl', 1.5, 12], ['ctrl', 5.5, 22]])]);
  ok(!r.error && r.G.groups[0].name === 'ctrl' && r.G.groups[0].data.map(x => x[0]).join() === '20,21,22', 'control "ctrl" and column "y" are taken exactly, not "Ctrl" / "Y" ' + (r.error || JSON.stringify(r.G?.groups?.map(g => g.name))));
  r = await run({ test: 'ttest_ind', layout: 'long', group: 'G', value: 'y', control: 'CTRL', dataset: 'cg.csv' }, [ds('cg.csv', ['G', 'Y', 'y'], [['Ctrl', 1, 10], ['ctrl', 5, 20]])]);
  ok(r.error && /Ctrl/.test(r.error) && /ctrl/.test(r.error), 'a control that matches two groups only by case is refused ' + (r.error || ''));

  const six = ['A1','A2','A3','B1','B2','B3'];
  const groups = ds('wide.csv', six, [-1,0,1].map(d => [1,2,4,8,16,32].map(v => v+d)));
  r = await run({ test:'anova2', layout:'wide', columns:six, options:{'opt-nA':2,'opt-nB':3} }, [groups]);
  ok(!r.error && /1200\.500/.test(r.text), 'wide two-way design preserves explicit 2 by 3 dimensions');
  r = await run({ ...wspec, dataset: 'wide.csv' }, [groups, groups]);
  ok(/Multiple loaded/.test(r.error || ''), 'duplicate filenames require unique selection');

  // ---- ingestion: European decimal commas, #N/A, OOXML readXlsx + serial dates, CSV/TSV, tflow ----
  const ing = await page.evaluate(async () => {
    const { parseFile } = await import('./js/ingest.js');
    const { zip } = await import('./js/zip.js');
    const eu = (await parseFile(new File(['V\n"0,125"\n"0,001"\n"-0,050"\n"1234,567"\n"1,000"\n#N/A\n'], 'eu.csv'), {})).tables.eu;
    let emptyCsvErr = '';
    try { await parseFile(new File(['\n   \n'], 'empty.csv'), {}); } catch (e) { emptyCsvErr = e.message; }
    const ragged = (await parseFile(new File(['A,B\n1,2,3\n'], 'rag.csv'), {})).tables.rag;
    const tsv = (await parseFile(new File(['A\tB\n1\t2\n'], 'tab.tsv'), {})).tables.tab;
    const xBlob = zip([
      { name: 'xl/workbook.xml', data: '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S1" sheetId="1" r:id="rId1"/></sheets></workbook>' },
      { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="xl/worksheets/sheet1.xml"/></Relationships>' },
      { name: 'xl/sharedStrings.xml', data: '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>田中</t><rPh sb="0" eb="2"><t>タナカ</t></rPh></si></sst>' },
      { name: 'xl/styles.xml', data: '<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>' },
      { name: 'xl/worksheets/sheet1.xml', data: '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row><c t="inlineStr"><is><t>Name</t></is></c><c t="inlineStr"><is><t>Blank</t></is></c><c t="inlineStr"><is><t>IsoDate</t></is></c><c t="inlineStr"><is><t>SerDate</t></is></c><c t="inlineStr"><is><t>Inline</t></is></c></row><row><c t="s"><v>0</v></c><c><v/></c><c t="d"><v>2026-01-15</v></c><c s="1"><v>46037</v></c><c t="inlineStr"><f>A1</f><is><t>ok</t></is></c></row></sheetData></worksheet>' },
    ]);
    const xl = (await parseFile(new File([await xBlob.arrayBuffer()], 'ooxml.xlsx'), {})).tables.S1;
    const tf = await parseFile(new File([JSON.stringify({ format: 1, name: 'Cy', samples: ['s1.fcs'], gates: [{ id: 'g1', name: 'A', parent: 'g2', type: 'rect', x: 'FSC', y: 'SSC' }, { id: 'g2', name: 'B', parent: 'g1', type: 'rect', x: 'FSC', y: 'SSC' }] })], 'cy.tflow'), {});
    return { eu: eu.rows.map(r => r[0]), emptyCsvErr, raggedCols: ragged.columns, raggedRow: ragged.rows[0], tsvCols: tsv.columns, xlRow: xl.rows[0], tfText: tf.segments[0].text };
  });
  ok(JSON.stringify(ing.eu) === '["0,125","0,001","-0,050","1234,567",1000,null]', 'typed(): European decimal commas stay text, English thousands parse, #N/A is null ' + JSON.stringify(ing.eu));
  ok(/empty/i.test(ing.emptyCsvErr), 'readCsv: empty CSV gives clear error');
  ok(ing.raggedCols.length === 3 && ing.raggedRow[2] === 3, 'readCsv: ragged extra columns are kept');
  ok(JSON.stringify(ing.tsvCols) === '["A","B"]', 'readCsv: .tsv uses tab delimiter');
  ok(JSON.stringify(ing.xlRow) === '["田中",null,"2026-01-15","2026-01-15","ok"]', 'readXlsx: relative xl/ path, omitted r attrs, empty <v/>, t="d", serial date, <rPh>/<f> exclusion ' + JSON.stringify(ing.xlRow));
  ok(ing.tfText.includes('- s1.fcs') && !ing.tfText.includes('undefined'), 'tflow(): handles format-1 string samples and gate cycles');

  await b.close(); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
