// Runs every table layout through the real Thistle Plot (sibling checkout ../thistle-plot) and checks the numbers.
// Usage: serve the PARENT folder (python3 -m http.server 8765) then: node tests/layouts.e2e.cjs
const { chromium } = require('playwright');
const BASE = process.env.TN_URL || 'http://localhost:8765/thistle-notebook/index.html';
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const b = await chromium.launch(), page = await (await b.newContext()).newPage();
  if (process.env.CDN_DIR) { const fs = require('fs'), path = require('path');
    await page.route('https://cdnjs.cloudflare.com/**', r => { const f = path.join(process.env.CDN_DIR, r.request().url().replace('https://cdnjs.cloudflare.com/ajax/libs/', '').replace(/\//g, '__')); fs.existsSync(f) ? r.fulfill({ body: fs.readFileSync(f), contentType: 'application/javascript' }) : r.abort(); }); }
  await page.route('https://elm.edina.ac.uk/**', r => r.fulfill({ status: 401, json: { error: { message: 'no key in test' } } }));
  await page.goto(BASE);
  await page.waitForFunction(() => window.thistleNotebook?.tp);
  const run = (spec, table) => page.evaluate(async ([spec, table]) => {
    const { buildG } = await import('./js/thistle.js');
    const built = buildG({ ...spec }, table);
    const S = window.thistleNotebook, sp = { ...spec }; buildG(sp, table);
    const r = await S.tp.run(sp, built.G);
    return { G: built.G, text: r.text, alerts: r.alerts, unknown: r.unknown };
  }, [spec, table]);
  // paired, long with subject
  const rows = []; [[1, 10, 12], [2, 11, 14], [3, 9, 9.5], [4, 12, 15], [5, 10, 13]].forEach(([s, a, c]) => { rows.push([`S${s}`, 'Before', a]); rows.push([`S${s}`, 'After', c]); });
  rows.splice(3, 1); // S2 After missing → S2 pair dropped, not shifted
  let r = await run({ test: 'ttest_rel', layout: 'long', group: 'Time', value: 'Y', subject: 'Subj', control: 'Before' }, { columns: ['Subj', 'Time', 'Y'], rows });
  ok(r.G.groups[0].name === 'Before' && r.G.groups[1].data[1][0] === '' && r.G.groups[1].data[2][0] === 9.5, 'paired: matched by subject, blank kept in place');
  ok(/t statistic \| -3\.597/.test(r.text) && /df \| 3\.0/.test(r.text), 'paired t = -3.597, df 3 (SciPy: -3.5973; incomplete pair dropped)');
  // two-way: A-major ordering + nA
  const tw = []; ['WT', 'KO'].forEach((g, i) => ['Veh', 'Drug'].forEach((t, j) => [0, 1, 2].forEach(k => tw.push([g, t, 10 + 5 * i * j + j + k * 0.5 + i]))));
  r = await run({ test: 'anova2', layout: 'long', group: ['Geno', 'Treat'], value: 'Y' }, { columns: ['Geno', 'Treat', 'Y'], rows: tw });
  ok(r.G.groups.map(g => g.name).join('|') === 'WT · Veh|WT · Drug|KO · Veh|KO · Drug', 'two-way: A-major group order');
  ok(/interaction/i.test(r.text) && !r.alerts.length, 'two-way ANOVA ran with interaction term');
  // counts from raw categorical
  const ct = []; for (let i = 0; i < 12; i++) ct.push(['Treated', 'Resp']); for (let i = 0; i < 5; i++) ct.push(['Treated', 'No']); for (let i = 0; i < 3; i++) ct.push(['Untreated', 'Resp']); for (let i = 0; i < 10; i++) ct.push(['Untreated', 'No']);
  r = await run({ test: 'fisher', layout: 'counts', rows: 'Out', cols: 'Grp' }, { columns: ['Grp', 'Out'], rows: ct });
  ok(r.G.groups[0].data.map(x => x[0]).join() === '12,5' && r.G.groups[1].data.map(x => x[0]).join() === '3,10', 'counts: cross-tabulated correctly');
  ok(/p-value \| 0\.02533/.test(r.text), 'Fisher p = 0.02533 (SciPy 0.025328)');
  // survival
  const sv = [[5, 1, 'A'], [8, 0, 'A'], [12, 1, 'A'], [3, 1, 'B'], [4, 1, 'B'], [9, 0, 'B']];
  r = await run({ test: 'km', layout: 'survival', time: 'T', event: 'E', group: 'G' }, { columns: ['T', 'E', 'G'], rows: sv });
  ok(r.G.groups.length === 3 && r.G.groups[1].data[3][0] === '' && r.G.groups[2].data[3][0] === 1, 'survival: time + per-group event columns');
  ok(/log-rank/i.test(r.text), 'Kaplan–Meier ran with log-rank');
  // xy correlation with a missing value
  r = await run({ test: 'pearson', layout: 'xy', x: 'X', y: 'Y' }, { columns: ['X', 'Y'], rows: [[1, 2], [2, 4.1], [3, null], [4, 8.2], [5, 9.9]] });
  ok(r.G.nRows === 4 && /\| 0\.9994 \| 0\.0006181/.test(r.text), 'xy: missing pair dropped, Pearson r = 0.9994 (SciPy 0.99938)');
  // matrix (genes × replicates)
  const mx = []; for (let i = 0; i < 6; i++) mx.push([`G${i}`, 5 + i, 5.2 + i, 4.9 + i, 7 + i, 7.1 + i, 6.8 + i]);
  r = await run({ test: 'pca', layout: 'matrix', label: 'gene', groups: { Ctrl: ['c1', 'c2', 'c3'], Trt: ['t1', 't2', 't3'] } }, { columns: ['gene', 'c1', 'c2', 'c3', 't1', 't2', 't3'], rows: mx });
  ok(r.G.groups.length === 6 && r.G.nRows === 6 && /PC1/i.test(r.text), 'matrix: PCA ran on 6 features × 6 samples');
  await b.close(); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
