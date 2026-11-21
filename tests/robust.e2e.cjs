// App robustness (wider review of v0.6.1, Nov 2026): result provenance, re-read recovery, unsaved changes, citations
// after a round trip, and overlapping Thistle Plot runs. Usage: node tests/robust.e2e.cjs (TP checked out beside).
const { chromium } = require('playwright');
const serveSuite = require('./serve.cjs');
const BASE = process.env.TN_URL || 'http://localhost:8765/thistle-notebook/index.html';
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const b = await chromium.launch(), bctx = await b.newContext({ acceptDownloads: true });
  if (!process.env.TN_URL) await serveSuite(bctx);
  const page = await bctx.newPage();
  await page.route('https://elm.edina.ac.uk/**', r => r.fulfill({ status: 401, json: { error: { message: 'no key in test' } } }));
  await page.goto(BASE);
  await page.waitForFunction(() => window.thistleNotebook?.tp && window.thistleNotebook.nb && window.thistleNotebook._t);

  // ---- [P1] overlapping runs on the shared Thistle Plot frame return their own results
  const conc = await page.evaluate(async () => {
    const { buildG } = await import('./js/thistle.js');
    const S = window.thistleNotebook, mk = (a, b2) => { const sp = { test: 'ttest_ind', layout: 'wide', columns: ['A', 'B'] };
      return [sp, buildG(sp, { columns: ['A', 'B'], rows: a.map((v, i) => [v, b2[i]]) }).G]; };
    const one = mk([1, 3, 2, 4], [4, 6, 5, 7]), two = mk([1, 3, 2, 4], [54, 56, 55, 57]);
    const bad = [{ test: 'anova2', layout: 'wide', columns: ['A', 'B'] }, one[1]];
    const run = ([sp, G]) => S.tp.run({ ...sp }, G).then(r => r.text, e => 'ERR ' + e.message);
    const s1 = await run(one), s2 = await run(two);
    const [p1, p2] = await Promise.all([run(one), run(two)]), [q2, q1] = await Promise.all([run(two), run(one)]);
    const [e, g] = await Promise.all([run(bad), run(two)]);
    return { differ: s1 !== s2, ab: p1 === s1 && p2 === s2, ba: q1 === s1 && q2 === s2, err: /^ERR/.test(e), recover: g === s2 };
  });
  ok(conc.differ, 'serial runs of the two datasets give different results');
  ok(conc.ab && conc.ba, 'overlapping runs return their own serial result in both launch orders (both returned the second)');
  ok(conc.err && conc.recover, 'after a failing run, an overlapping run still returns its own result');

  // ---- [P1] a run's .tplot carries the table that run used; a source edited later does not leak in
  const spec = { title: 'Snap', test: 'ttest_ind', layout: 'wide', columns: ['A', 'B'], dataset: 'snap.csv' };
  const content = 'x\n```thistle-plot\n' + JSON.stringify(spec) + '\n```\n';
  await page.evaluate(([content]) => {
    const S = window.thistleNotebook;
    S.sources.push({ id: 'snapsrc', nb: S.nb.id, name: 'snap.csv', kind: 'dataset', role: 'dataset', enabled: true, status: 'ready', tabs: [S.nb.viewTab],
      tables: { snap: { columns: ['A', 'B'], rows: [[1, 4], [3, 6], [2, 5], [4, 7]] } } });
    window._snapMsg = { id: 'snapmsg', nb: S.nb.id, role: 'assistant', content, t: Date.now(), meta: {} };
  }, [content]);
  await page.evaluate(() => window.thistleNotebook._t.runSpec(window._snapMsg, 0));
  await page.evaluate(() => { window.thistleNotebook.sources.find(s => s.id === 'snapsrc').tables.snap.rows = [[10, 40], [30, 60], [20, 50], [40, 70]]; });
  const dlFrom = async () => {
    await page.evaluate(() => { const c = window.thistleNotebook._t.tpCard(window._snapMsg, 0); c.id = 'snapcard'; document.getElementById('snapcard')?.remove(); document.body.append(c); });
    const [d] = await Promise.all([page.waitForEvent('download'), page.click('#snapcard button:has-text(".tplot")')]);
    return JSON.parse(require('fs').readFileSync(await d.path(), 'utf8'));
  };
  let tp = await dlFrom();
  ok(JSON.stringify(tp.G.groups[0].data.map(x => x[0])) === '[1,3,2,4]', 'the .tplot of a run holds the observations that run used, not the edited source ' + JSON.stringify(tp.G.groups[0].data.map(x => x[0])));
  ok(await page.evaluate(() => /changed since this run/i.test(document.getElementById('snapcard').textContent)), 'the card says the source changed since the run');
  await page.evaluate(() => { const S = window.thistleNotebook; S.sources = S.sources.filter(s => s.id !== 'snapsrc'); });
  tp = await dlFrom();
  ok(JSON.stringify(tp.G.groups[0].data.map(x => x[0])) === '[1,3,2,4]', 'the historical run can still be downloaded after its source is removed');
  await page.evaluate(() => { const S = window.thistleNotebook; S.sources.push({ id: 'snapsrc', nb: S.nb.id, name: 'snap.csv', kind: 'dataset', role: 'dataset', enabled: true, status: 'ready', tabs: [S.nb.viewTab], tables: { snap: { columns: ['A', 'B'], rows: [[10, 40], [30, 60], [20, 50], [40, 70]] } } }); });
  await page.evaluate(() => window.thistleNotebook._t.runSpec(window._snapMsg, 0));
  tp = await dlFrom();
  ok(JSON.stringify(tp.G.groups[0].data.map(x => x[0])) === '[10,30,20,40]' && tp.statTabs?.length, 'a rerun updates both the table and the result in the .tplot');

  // ---- [P2] a manual analysis run marks the notebook as unsaved
  const dirty = await page.evaluate(async () => {
    const S = window.thistleNotebook; S.nb.updated = 1; S.nb.savedAt = 2;
    await S._t.runSpec(window._snapMsg, 0); return S.nb.updated > S.nb.savedAt;
  });
  ok(dirty, 'after a manual run the notebook counts as changed, so Close offers Save');

  // ---- [P1] a failed re-read keeps the source and its search passages; a successful retry replaces them
  const rr = await page.evaluate(async () => {
    const S = window.thistleNotebook, db = await import('./js/store.js');
    const s = { id: 'rrsrc', nb: S.nb.id, name: 'w.csv', kind: 'text', role: 'reference', enabled: true, status: 'ready', tabs: [S.nb.viewTab], segments: [{ loc: 'all', text: 'old passage' }], chars: 11, meta: {} };
    S.sources.push(s); await db.put('sources', s); await db.putMany('chunks', [{ id: 'rrc1', nb: S.nb.id, src: 'rrsrc', idx: 0, loc: 'all', text: 'old passage', emb: null }]);
    S.files.set('rrsrc', new File([new Uint8Array([1, 2, 3, 4])], 'w.xlsx'));
    await S._t.rereadSource(s);
    const afterFail = { chunks: (await db.bySrc('rrsrc')).map(c => c.text), status: s.status, stored: (await db.get('sources', 'rrsrc'))?.status };
    let writeErr = null; try { await db.replaceSource({ ...s }, [{ nb: S.nb.id, src: 'rrsrc', text: 'no id' }]); } catch (e) { writeErr = e?.name || String(e); }
    const afterWrite = (await db.bySrc('rrsrc')).map(c => c.text);
    S.files.set('rrsrc', new File(['Col\nnew passage text\n'], 'w.csv', { type: 'text/csv' }));
    await S._t.rereadSource(s);
    const afterOk = (await db.bySrc('rrsrc')).map(c => c.text).join(' ');
    return { afterFail, writeErr, afterWrite, afterOk };
  });
  ok(JSON.stringify(rr.afterFail.chunks) === '["old passage"]' && rr.afterFail.status === 'ready' && rr.afterFail.stored === 'ready', 'a broken replacement keeps the old source and its search passages ' + JSON.stringify(rr.afterFail));
  ok(rr.writeErr && JSON.stringify(rr.afterWrite) === '["old passage"]', 'a failed write leaves the old passages in place (one transaction) ' + JSON.stringify(rr));
  ok(/new passage/.test(rr.afterOk) && !/old passage/.test(rr.afterOk), 'a successful retry replaces the passages ' + rr.afterOk);

  // ---- [P2] citations open the cited source after a save / reopen round trip, even with two same-named sources
  const cite = await page.evaluate(async () => {
    const S = window.thistleNotebook, db = await import('./js/store.js'), nbId = S.nb.id;
    const d = { notebook: { ...S.nb, id: 'oldnb' }, sources: [
      { id: 'sa', nb: 'oldnb', name: 'a.pdf', kind: 'text', segments: [{ loc: 'p1', text: 'first' }] },
      { id: 'sb', nb: 'oldnb', name: 'a.pdf', kind: 'text', segments: [{ loc: 'p1', text: 'second' }] }],
      chunks: [], notes: [{ id: 'n1', nb: 'oldnb', content: '[1]', meta: { cites: { 1: { source: 'a.pdf', srcId: 'sb', loc: 'p1', text: 'second' } } } }],
      messages: [{ id: 'm1', nb: 'oldnb', role: 'assistant', content: '[1]', t: 1, meta: { cites: { 1: { source: 'a.pdf', srcId: 'sb', loc: 'p1', text: 'second' } }, sourceIds: ['sa', 'sb'] } }] };
    const nb = await db.importNotebook(d);
    const srcs = await db.byNb('sources', nb.id), msgs = await db.byNb('messages', nb.id), notes = await db.byNb('notes', nb.id);
    const second = srcs.find(s => s.segments[0].text === 'second');
    const pick = (c, list) => S._t.citeSource(c, list);
    return { msgCite: msgs[0].meta.cites[1].srcId === second.id, noteCite: notes[0].meta.cites[1].srcId === second.id,
      ids: JSON.stringify(msgs[0].meta.sourceIds) === JSON.stringify([srcs.find(s => s.segments[0].text === 'first').id, second.id]),
      resolved: pick(msgs[0].meta.cites[1], srcs)?.id === second.id,
      ambiguous: pick({ source: 'a.pdf', srcId: 'gone' }, srcs) === null,
      unique: pick({ source: 'b.pdf', srcId: 'gone' }, [{ id: 'x', name: 'b.pdf' }])?.id === 'x', back: nbId };
  });
  ok(cite.msgCite && cite.noteCite && cite.ids, 'import remaps the source ids inside message and note citations ' + JSON.stringify(cite));
  ok(cite.resolved, 'a citation of the second of two same-named sources opens that source after reopening');
  ok(cite.ambiguous && cite.unique, 'the file-name fallback is used only when the name is unique');

  await b.close(); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
