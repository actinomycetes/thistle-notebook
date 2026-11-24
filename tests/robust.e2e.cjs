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
    // compare results without Thistle Plot's "Run <date> <time>" stamp, which changes when a minute passes between runs
    // (the date follows the browser locale: 11/23/2026 06:34 PM, 23/11/2026 18:34, 23.11.2026 18:34, 2026/11/23 18:34)
    const strip = t => t.replace(/Run [\d./\-, ]+?\d{1,2}:\d{2}(:\d{2})?(\s?[AP]M)?/gi, 'Run <time>');
    const run = ([sp, G]) => S.tp.run({ ...sp }, G).then(r => strip(r.text), e => 'ERR ' + e.message);
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

  // ================= v0.6.3: post-merge review =================
  // [P1] a failed rerun keeps the previous successful run (shown, downloadable) and reports only the failure to the model
  const rerun = await page.evaluate(async () => {
    const S = window.thistleNotebook, db = await import('./js/store.js');
    const src = S.sources.find(s => s.id === 'snapsrc');
    src.tables.snap.rows = [[1, 4], [2, 5], [3, 6], [4, 7]];
    await S._t.runSpec(window._snapMsg, 0);
    src.tables.snap.rows = [[1, 4]];                          // too few values: Thistle Plot refuses the t-test
    await S._t.runSpec(window._snapMsg, 0);
    const stored = (await db.get('messages', window._snapMsg.id)) || window._snapMsg;
    const r = window._snapMsg.meta.tp[0];
    return { status: r.status, hasPrev: !!r.lastOk?.G, prevVals: r.lastOk?.G?.groups[0].data.map(x => x[0]), digest: S._t.resultsDigest(window._snapMsg) };
  });
  ok(rerun.status === 'err' && rerun.hasPrev && JSON.stringify(rerun.prevVals) === '[1,2,3,4]', 'a failed rerun keeps the previous successful run and its table ' + JSON.stringify(rerun));
  ok(/FAILED/.test(rerun.digest) && !/t statistic/.test(rerun.digest), 'the AI is told about the failure, not given the previous statistics as new: ' + rerun.digest.slice(0, 200));
  let tpPrev = await dlFrom();
  ok(JSON.stringify(tpPrev.G.groups[0].data.map(x => x[0])) === '[1,2,3,4]' && tpPrev.statTabs?.length, 'the previous run can still be downloaded with its result');
  ok(await page.evaluate(() => /previous successful run/i.test(document.getElementById('snapcard').textContent) && /failed/i.test(document.getElementById('snapcard').textContent)), 'the card shows the failure and labels the previous result');
  await page.evaluate(async () => { const S = window.thistleNotebook; S.sources.find(s => s.id === 'snapsrc').tables.snap.rows = [[5, 1], [6, 2], [7, 3], [8, 4]]; await S._t.runSpec(window._snapMsg, 0); });
  ok(await page.evaluate(() => { const r = window._snapMsg.meta.tp[0]; return r.status === 'ok' && !r.lastOk && r.G.groups[0].data[0][0] === 5; }), 'a successful rerun replaces both');

  // [P1] only ticked datasets in active tabs, and those the answer used, can run; old results stay viewable
  const elig = await page.evaluate(async () => {
    const S = window.thistleNotebook, mk = (id, name, extra = {}) => ({ id, nb: S.nb.id, name, kind: 'dataset', role: 'dataset', enabled: true, status: 'ready', tabs: [S.nb.viewTab],
      tables: { t: { columns: ['A', 'B'], rows: [[1, 4], [3, 6], [2, 5], [4, 7]] } }, ...extra });
    const keepSources = S.sources; S.sources = [mk('on', 'on.csv'), mk('off', 'off.csv', { enabled: false }), mk('hid', 'hid.csv', { tabs: ['no-such-tab'] })];
    const spec = ds => ({ test: 'ttest_ind', layout: 'wide', columns: ['A', 'B'], ...(ds ? { dataset: ds } : {}) });
    const msg = (sp, meta = {}) => ({ id: 'e' + Math.random(), nb: S.nb.id, role: 'assistant', content: '```thistle-plot\n' + JSON.stringify(sp) + '\n```', t: Date.now(), meta });
    const run = async m => (await S._t.runSpec(m, 0));
    const off = await run(msg(spec('off.csv'))), hid = await run(msg(spec('hid.csv'))), on = await run(msg(spec('on.csv')));
    S.sources = [mk('off', 'off.csv', { enabled: false })]; const sole = await run(msg(spec(null)));
    S.sources = [mk('on', 'on.csv'), mk('two', 'two.csv')]; const notUsed = await run(msg(spec('two.csv'), { sourceIds: ['on'] }));
    S.sources = [mk('on', 'on.csv')]; const m = msg(spec('on.csv')); await run(m); S.sources[0].enabled = false;
    const card = S._t.tpCard(m, 0), stillThere = !!card.querySelector('.tp-result') && [...card.querySelectorAll('button')].some(b => /tplot/.test(b.textContent)) && ![...card.querySelectorAll('button')].some(b => /Run again/.test(b.textContent));
    S.sources = keepSources;
    return { off: off.status === 'err' && /off\.csv/.test(off.error) && /tick/i.test(off.error), hid: hid.status === 'err' && /tick/i.test(hid.error), on: on.status === 'ok', sole: sole.status === 'err', notUsed: notUsed.status === 'err', stillThere };
  });
  ok(elig.off && elig.hid, 'an unticked dataset, or one only in an unticked tab, is not run, and the message says to tick it ' + JSON.stringify(elig));
  ok(elig.on, 'a ticked dataset in an active tab runs');
  ok(elig.sole, 'the single-dataset fallback does not pick an unticked dataset');
  ok(elig.notUsed, 'an answer cannot run a dataset it did not use');
  ok(elig.stillThere, 'a run whose source is now off keeps its result and download, without Run again');

  // [P1] survival event codes must be 0 or 1; [P1] duplicate exact headers are ambiguous
  const inp = await page.evaluate(async () => {
    const { buildG } = await import('./js/thistle.js'), { parseFile } = await import('./js/ingest.js'), { tablesToXlsx } = await import('./js/export.js');
    const err = f => { try { return { ok: f() }; } catch (e) { return { err: e.message }; } };
    const surv = rows => err(() => buildG({ test: 'km', layout: 'survival', time: 'T', event: 'E', group: 'C' }, { columns: ['T', 'E', 'C'], rows }));
    const s2 = surv([[5, 2, 'A'], [6, 1, 'B'], [7, 0, 'B']]), sm = surv([[5, -1, 'A'], [6, 1, 'B'], [7, 0, 'B']]);
    const okS = surv([[5, 1, 'A'], [6, 0, 'A'], [7, null, 'B'], [8, 1, 'B'], [9, 0, 'B']]);
    const csv = (await parseFile(new File(['ID,Y,Y,y\nS,1,99,7\nT,2,98,8\n'], 'd.csv'), {})).tables.d;
    const xb = tablesToXlsx([{ title: 'D', header: ['ID', 'Y', 'Y', 'y'], rows: [['S', 1, 99, 7], ['T', 2, 98, 8]] }]);
    const xl = Object.values((await parseFile(new File([await xb.arrayBuffer()], 'd.xlsx'), {})).tables)[0];
    const wide = (t, c) => err(() => buildG({ layout: 'wide', columns: [c] }, t).G.groups[0].data.map(x => x[0]));
    return { s2: s2.err, sm: sm.err, okS: okS.ok && { notes: okS.ok.notes, ev: okS.ok.G.groups.slice(1).map(g => g.data.map(x => x[0])) },
      csvY: wide(csv, 'Y'), xlY: wide(xl, 'Y'), csvy: wide(csv, 'y') };
  });
  ok(/2/.test(inp.s2 || '') && /row 1/i.test(inp.s2 || '') && /-1/.test(inp.sm || ''), 'event codes other than 0 or 1 are refused, naming the row ' + JSON.stringify([inp.s2, inp.sm]));
  ok(inp.okS && inp.okS.notes.some(n => /1 row.*left out/.test(n)), '0/1 events run, and a row with a missing event is reported ' + JSON.stringify(inp.okS));
  ok(/Y/.test(inp.csvY.err || '') && /2 and 3/.test(inp.csvY.err || '') && /rename/i.test(inp.csvY.err || ''), 'two columns headed Y (CSV) are refused with their positions ' + JSON.stringify(inp.csvY));
  ok(/2 and 3/.test(inp.xlY.err || ''), 'two columns headed Y (Excel) are refused too ' + JSON.stringify(inp.xlY));
  ok(JSON.stringify(inp.csvy.ok) === '[7,8]', 'a column y next to them is still usable by its exact name ' + JSON.stringify(inp.csvy));

  // [P2] eligibility messages only for excluded sources: sheet and duplicate-name errors keep their own wording
  const em = await page.evaluate(async () => {
    const S = window.thistleNotebook, keep = S.sources;
    const mk = (id, extra = {}) => ({ id, nb: S.nb.id, name: 'eligible.csv', kind: 'dataset', role: 'dataset', enabled: true, status: 'ready', tabs: [S.nb.viewTab],
      tables: { available: { columns: ['A', 'B'], rows: [[1, 4], [3, 6], [2, 5], [4, 7]] } }, ...extra });
    const msg = (sp, ids) => ({ id: 'q' + Math.random(), nb: S.nb.id, role: 'assistant', content: '```thistle-plot\n' + JSON.stringify(sp) + '\n```', t: Date.now(), meta: { sourceIds: ids } });
    const sp = sheet => ({ test: 'ttest_ind', layout: 'wide', columns: ['A', 'B'], dataset: 'eligible.csv', sheet });
    S.sources = [mk('e1')];
    const bad = await S._t.runSpec(msg(sp('bad'), ['e1']), 0), good = await S._t.runSpec(msg(sp('available'), ['e1']), 0);
    S.sources = [mk('e1'), mk('e2')];
    const dup = await S._t.runSpec(msg(sp('available'), ['e1', 'e2']), 0);
    S.sources = keep;
    return { bad: bad.error, good: good.status, dup: dup.error };
  });
  ok(/Sheet "bad" not found/.test(em.bad || '') && !/did not use|not one of the sources|not ticked/.test(em.bad || ''), 'a wrong sheet in an eligible dataset says the sheet is missing ' + em.bad);
  ok(em.good === 'ok', 'the same dataset with the right sheet runs');
  ok(/could mean|Multiple loaded|more than one/i.test(em.dup || '') && !/not one of the sources|not ticked/.test(em.dup || ''), 'two eligible files with the same name give the duplicate-name error ' + em.dup);
  // [P2] a text event code is invalid, not missing
  const ev = await page.evaluate(async () => {
    const { buildG } = await import('./js/thistle.js');
    try { buildG({ test: 'km', layout: 'survival', time: 'T', event: 'E', group: 'C' }, { columns: ['T', 'E', 'C'], rows: [[5, 1, 'A'], [6, 0, 'A'], [7, 'event', 'B'], [8, 1, 'B'], [9, null, 'B']] }); return null; } catch (e) { return e.message; }
  });
  ok(/row 3/.test(ev || '') && /event/.test(ev || ''), 'a text event code ("event") is refused as invalid, naming the row ' + ev);

  // tab icon: the embedded Thistle Plot frame carries no icon links, Notebook keeps its own icon and title (Orion showed
  // Plot's icon on Notebook's tab), and Notebook sets its title again after an embedded app loads
  const icon = await page.evaluate(async () => {
    const S = window.thistleNotebook, w = await S.tp.ready(), q = d => d.querySelectorAll('link[rel="icon"],link[rel="apple-touch-icon"]').length;
    return { frame: q(w.document), top: q(document), title: document.title, retitles: S.tp._retitled > 0 };
  });
  ok(icon.frame === 0, 'the embedded Thistle Plot frame has no tab icon links (Thistle Plot ≥ 0.19.1) ' + JSON.stringify(icon));
  ok(icon.top >= 1 && /^Thistle Notebook v/.test(icon.title) && icon.retitles, 'Notebook keeps its own icon and sets its title again after the frame loads ' + JSON.stringify(icon));

  // opening two notebooks quickly: the one opened last wins, with its own sources and messages (a slower earlier load
  // used to finish last and leave notebook B selected with notebook A's sources; same race as Thistle Flow v0.23.2)
  const race = await page.evaluate(async () => {
    const S = window.thistleNotebook, db = await import('./js/store.js'), back = S.nb.id;
    const a = await db.createNotebook('Race A'), b = await db.createNotebook('Race B');
    await db.put('sources', { id: 'raceA', nb: a.id, name: 'a.txt', kind: 'text', status: 'ready', enabled: true, created: 1, tabs: [] });
    await db.put('sources', { id: 'raceB', nb: b.id, name: 'b.txt', kind: 'text', status: 'ready', enabled: true, created: 1, tabs: [] });
    window.TN_OPEN_DELAY = id => id === a.id ? 400 : 0;     // test hook: make notebook A's load slower
    await Promise.all([S._t.openNotebook(a.id), S._t.openNotebook(b.id)]);
    delete window.TN_OPEN_DELAY;
    const out = { nb: S.nb.name, sources: S.sources.map(x => x.id) };
    await S._t.openNotebook(back); await db.deleteNotebook(a.id); await db.deleteNotebook(b.id);
    return out;
  });
  ok(race.nb === 'Race B' && JSON.stringify(race.sources) === '["raceB"]', 'opening A then B quickly leaves B open with only its own sources ' + JSON.stringify(race));

  // [P2] a dataset too large to keep in the notebook becomes usable after relinking its original (this session only)
  const big = await page.evaluate(async () => {
    const S = window.thistleNotebook, db = await import('./js/store.js'), { parseFile } = await import('./js/ingest.js');
    const lines = ['G,A,B,C,D,E']; for (let i = 0; i < 100001; i++) lines.push(`${i % 2 ? 'x' : 'y'},${i},1,2,3,4`);
    const file = new File([lines.join('\n')], 'big.csv', { type: 'text/csv' });
    const r = await parseFile(file, {});
    const s = { id: 'bigsrc', nb: S.nb.id, name: 'big.csv', kind: 'dataset', role: 'dataset', enabled: true, status: 'ready', tabs: [S.nb.viewTab], tables: r.tables, segments: r.segments, meta: {} };
    S.sources.push(s); await db.put('sources', s);
    const saved = JSON.parse(await db.exportNotebook(S.nb.id)).sources.find(x => x.id === 'bigsrc');
    await S._t.linkFile(s, file);
    const m = { id: 'bigm', nb: S.nb.id, role: 'assistant', content: '```thistle-plot\n' + JSON.stringify({ test: 'ttest_ind', layout: 'long', group: 'G', value: 'A', dataset: 'big.csv' }) + '\n```', t: Date.now(), meta: {} };
    const res = await S._t.runSpec(m, 0);
    const saved2 = JSON.parse(await db.exportNotebook(S.nb.id)).sources.find(x => x.id === 'bigsrc');
    await S._t.rereadSource(s);
    const afterRead = S.tableCache.get(s.id);
    S.tableCache.delete(s.id); // simulate reopening the saved source
    const edited = new File([lines.join('\n').replace('y,0,', 'y,99,')], 'big.csv');
    await S._t.linkFile(s, edited);
    const usedBeforeRead = S.tableCache.has(s.id);
    await S._t.rereadSource(s);
    const updated = S.tableCache.get(s.id);
    const firstValue = updated && Object.values(updated)[0].rows[0][1];
    const accepted = edited._sha256 === s.file.sha256;
    S.sources = S.sources.filter(x => x.id !== 'bigsrc'); await db.del('sources', 'bigsrc');
    return { afterRead: !!afterRead, usedBeforeRead, firstValue, accepted, keptInFile: !!r.tables, saved: !!saved?.tables, status: res.status, err: res.error, saved2: !!saved2?.tables };
  });
  ok(!big.keptInFile && !big.saved, 'a dataset over 600,000 cells is not stored in the notebook');
  ok(big.status === 'ok', 'after relinking its original it can be analysed in this session ' + (big.err || ''));
  ok(big.afterRead && !big.usedBeforeRead && Number(big.firstValue) === 99 && big.accepted, 'large table changes only after a successful re-read ' + JSON.stringify(big));
  ok(!big.saved2, 'and it still stays out of the saved notebook');

  await b.close(); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
