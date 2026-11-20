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

  await b.close(); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
