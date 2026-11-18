// Notebook workspace features: source tabs, chat housekeeping (delete / re-run / copy to box / ↑ recall),
// finding moved files, resizable panes, closing a notebook. Mock ELM; files served by tests/serve.cjs.
const { chromium } = require('playwright');
const serveSuite = require('./serve.cjs');
const fs = require('fs'), os = require('os'), path = require('path');
const FX = path.join(__dirname, 'fixtures'), CDN = process.env.CDN_DIR || '', OUT = path.join(__dirname, '..', 'test-output');
fs.mkdirSync(OUT, { recursive: true });
const BASE = process.env.TN_URL || 'http://localhost:8765/thistle-notebook/index.html';
const log = [], chats = [];
const ok = (c, m) => { log.push((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const sse = t => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\ndata: [DONE]\n\n`;

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
  if (!process.env.TN_URL) await serveSuite(ctx);
  if (CDN) await ctx.route('https://cdnjs.cloudflare.com/**', r => { const f = path.join(CDN, r.request().url().replace('https://cdnjs.cloudflare.com/ajax/libs/', '').replace(/\//g, '__')); fs.existsSync(f) ? r.fulfill({ body: fs.readFileSync(f), contentType: 'application/javascript' }) : r.continue(); });
  await ctx.route('https://elm.edina.ac.uk/api/v1/**', r => {
    const p = new URL(r.request().url()).pathname.replace('/api/v1', ''), body = r.request().postDataJSON?.() ?? null, cors = { 'Access-Control-Allow-Origin': 'http://localhost:8765' };
    if (p === '/models') return r.fulfill({ json: { data: ['Qwen/Qwen3.5-397B-A17B-FP8', 'gpt-4o-mini'].map(id => ({ id })) }, headers: cors });
    if (p === '/costs') return r.fulfill({ json: { usage: 0, limit: 50, currency: 'GBP' }, headers: cors });
    if (p === '/embeddings') return r.fulfill({ status: 404, json: {}, headers: cors });
    if (p === '/chat/completions') { chats.push(body); const last = body.messages.at(-1).content; return r.fulfill({ body: sse(`Answer ${chats.length} to: ${last.slice(0, 40)} [1]`), headers: { ...cors, 'Content-Type': 'text/event-stream' } }); }
    r.fulfill({ status: 404, json: {}, headers: cors });
  });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept(d.type() === 'prompt' ? (globalThis.__answer ?? d.defaultValue()) : undefined));
  await page.addInitScript(() => sessionStorage.setItem('tn.key', 'elm-test'));
  await page.goto(BASE);
  await page.waitForSelector('#modelSelect option[value^="Qwen"]', { state: 'attached' });
  // wait until n more messages exist and the app is idle (clicks start async work, so "idle" alone is not enough)
  const nMsgs = () => page.evaluate(() => window.thistleNotebook.messages.length);
  const grew = (before, by) => page.waitForFunction(([b, k]) => window.thistleNotebook.messages.length === b + k && !window.thistleNotebook.busy, [before, by]);
  const ask = async text => { const b = await nMsgs(); await page.fill('#prompt', text); await page.click('#btnSend'); await grew(b, 2); };
  const ready = n => page.waitForFunction(n => window.thistleNotebook.sources.filter(s => s.status === 'ready').length === n, n);

  // ---------- tabs ----------
  await page.setInputFiles('#fileInput', ['paper.pdf', 'mice.csv'].map(f => path.join(FX, f))); await ready(2);
  globalThis.__answer = 'Marking set';
  await page.click('#srcTabs .tab-add'); await page.waitForFunction(() => window.thistleNotebook.nb.tabs.length === 2);
  await page.setInputFiles('#fileInput', ['rubric.docx', 'essay_student1.txt'].map(f => path.join(FX, f))); await ready(4);
  ok(await page.$$eval('#srcList .src-item', e => e.length) === 2, 'new tab shows only its own sources');
  // untick the first tab: only "Marking set" sources are used
  await page.uncheck('#srcTabs .src-tab:first-child input');
  ok(await page.waitForFunction(() => document.querySelector('#srcCount').textContent.includes('2 of 4 used')).then(() => true, () => false), 'source count shows how many are used in chat');
  await ask('What does the rubric say?');
  const sys = chats.at(-1).messages[0].content;
  const sent = (sys.match(/SOURCE: "[^"]+"/g) || []).join();
  ok(sent === 'SOURCE: "rubric.docx",SOURCE: "essay_student1.txt"', 'only sources in ticked tabs are sent (' + sent + ')');
  ok((await page.textContent('.msg.assistant .who')).includes('📁 Marking set'), 'answer shows which tabs were used');
  // a source in two tabs
  await page.click('#srcList .src-item:first-child .tabs-btn');
  await page.check('#popover label:has-text("Sources") input');
  ok(await page.waitForFunction(() => window.thistleNotebook.sources.find(s => s.name === 'rubric.docx').tabs.length === 2).then(() => true, () => false), 'a source can be in several tabs');
  await page.mouse.click(700, 400);
  // trace: sources used + restore that tab selection
  await page.check('#srcTabs .src-tab:first-child input');
  await page.click('.msg.assistant .who .link-btn');
  const used = await page.$$eval('#modalBody .used-list li', l => l.map(x => x.textContent));
  ok(used.length === 2 && used.some(t => t.includes('rubric.docx')), 'answer lists the exact sources it used');
  await page.click('#modalBody button:has-text("Use the same tabs now")');
  ok(await page.waitForFunction(() => window.thistleNotebook.nb.tabs.map(t => t.active).join() === 'false,true').then(() => true, () => false), '“use the same tabs” restores the tab selection');

  // ---------- chat housekeeping ----------
  const nChats = chats.length;
  await page.click('.msg.user .msg-actions button:has-text("Copy to box")');
  ok(await page.inputValue('#prompt') === 'What does the rubric say?' && chats.length === nChats, 'copy to box fills the box without sending');
  await page.fill('#prompt', '');
  await ask('Second question');
  await page.focus('#prompt'); await page.keyboard.press('ArrowUp');
  ok(await page.inputValue('#prompt') === 'Second question', '↑ in the empty box recalls the last question');
  await page.keyboard.press('ArrowUp');
  ok(await page.inputValue('#prompt') === 'What does the rubric say?', '↑ again goes further back');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
  ok(await page.inputValue('#prompt') === '', '↓ returns to an empty box');
  await page.click('#btnHistory'); await page.click('#popover .menu-item:has-text("rubric")');
  ok(await page.inputValue('#prompt') === 'What does the rubric say?' && chats.length === nChats + 1, 'earlier-questions menu fills the box without sending');
  await page.fill('#prompt', '');
  const count = () => page.evaluate(() => window.thistleNotebook.messages.length);
  let n0 = await count();
  await page.click('.msg.user >> nth=0 >> button:has-text("Re-run")'); await grew(n0, 2);
  ok(await count() === n0 + 2 && chats.at(-1).messages.at(-1).content === 'What does the rubric say?', 're-run asks the same question again');
  n0 = await count();
  await page.click('.msg.assistant >> nth=0 >> button:has-text("Regenerate")'); await grew(n0, 2);
  ok(await count() === n0 + 2, 'regenerate adds a new answer and keeps the old one');
  n0 = await count();
  await page.click('.msg.assistant >> nth=0 >> .who button.icon'); await grew(n0, -1);
  ok(await count() === n0 - 1 && await page.evaluate(() => window.thistleNotebook.messages[0].role === 'user'), 'delete removes only that answer');
  n0 = await count();
  await page.click('.msg.user >> nth=1 >> .who button.icon'); await grew(n0, -2);
  ok(await count() === n0 - 2, 'deleting a question removes it with its answer');

  // ---------- resizable panes ----------
  const w0 = await page.$eval('#paneSources', e => e.offsetWidth);
  const b = await page.$eval('#splitL', e => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 200 }; });
  await page.mouse.move(b.x, b.y); await page.mouse.down(); await page.mouse.move(b.x + 120, b.y, { steps: 5 }); await page.mouse.up();
  const w1 = await page.$eval('#paneSources', e => e.offsetWidth);
  ok(w1 > w0 + 100, `left pane widens when dragged (${w0} → ${w1} px)`);
  const r0 = await page.$eval('#paneStudio', e => e.offsetWidth);
  const c = await page.$eval('#splitR', e => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 200 }; });
  await page.mouse.move(c.x, c.y); await page.mouse.down(); await page.mouse.move(c.x - 80, c.y, { steps: 5 }); await page.mouse.up();
  ok(await page.$eval('#paneStudio', e => e.offsetWidth) > r0 + 60, 'right pane widens when dragged');

  // ---------- reload: sizes remembered, file links gone (browser limitation), find files ----------
  await page.reload(); await page.waitForSelector('#modelSelect option[value^="Qwen"]', { state: 'attached' });
  ok(Math.abs(await page.$eval('#paneSources', e => e.offsetWidth) - w1) < 3, 'pane width remembered after reload');
  await page.dblclick('#splitL');
  ok(Math.abs(await page.$eval('#paneSources', e => e.offsetWidth) - w0) < 3, 'double-click resets the pane width');
  await page.click('#btnFindFiles');
  ok((await page.$$eval('#modalBody table.diag tr', r => r.map(x => x.textContent))).filter(t => t.includes('not linked')).length === 4, 'after reload the 4 originals are listed as not linked');
  const moved = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-moved-'));
  ['paper.pdf', 'mice.csv', 'rubric.docx'].forEach(f => fs.copyFileSync(path.join(FX, f), path.join(moved, f))); // copies get new dates, same content
  fs.writeFileSync(path.join(moved, 'essay_student1.txt'), 'Student 1 answer, REVISED. Mitochondria produce ATP; the revision adds the electron transport chain.\n');
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#modalBody button:has-text("Choose files")')]);
  await fc.setFiles(fs.readdirSync(moved).map(f => path.join(moved, f)));
  await page.waitForFunction(() => window.thistleNotebook.files.size === 4);
  const rows = await page.$$eval('#modalBody table.diag tr', r => r.map(x => x.textContent));
  ok(rows.filter(t => t.includes('🔗 linked')).length === 3 && rows.some(t => t.includes('essay') && t.includes('changed')), 'files matched by name; the edited file is flagged as changed');
  await page.screenshot({ path: path.join(OUT, '7-find-files.png') });
  await page.click('#modalBody tr:has-text("essay") button:has-text("Re-read")');
  await page.waitForFunction(() => window.thistleNotebook.sources.find(s => s.name === 'essay_student1.txt').segments?.[0]?.text.includes('REVISED'));
  ok(await page.evaluate(() => { const s = window.thistleNotebook.sources.find(x => x.name === 'essay_student1.txt'); return s.role === 'submission' && s.tabs.length === 1 && s.status === 'ready'; }), 're-read updates the text and keeps role and tab');
  await page.keyboard.press('Escape');
  await page.click('#srcList .src-item:has-text("essay") .name');
  ok(await page.isVisible('#modalBody button:has-text("Open original")'), 'source viewer offers “Open original” once linked');
  await page.keyboard.press('Escape');
  await page.screenshot({ path: path.join(OUT, '8-tabs.png') });

  // ---------- close notebook ----------
  await page.click('#btnCloseNb');
  ok((await page.textContent('#modalBody')).includes('not saved'), 'closing an unsaved notebook asks to save');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#modalBody button:has-text("Save and close")')]);
  const saved = path.join(OUT, 'closed.tnote'); fs.copyFileSync(await dl.path(), saved);
  await page.waitForFunction(() => window.thistleNotebook.sources.length === 0);
  const tn = JSON.parse(fs.readFileSync(saved, 'utf8'));
  ok(tn.notebook.tabs.length === 2 && tn.sources.every(s => s.tabs?.length), 'saved file keeps tabs and tab membership');
  ok(await page.$$eval('#nbSelect option', o => o.length) === 1, 'closed notebook removed; a fresh one opened');
  await page.setInputFiles('#openInput', saved);
  await page.waitForFunction(() => window.thistleNotebook.sources.length === 4);
  ok(await page.$$eval('#srcTabs .src-tab', t => t.length) === 2, 'reopened notebook has its tabs');
  await page.click('#btnCloseNb');
  ok((await page.textContent('#modalBody')).includes('has not changed since it was saved'), 'a just-opened notebook closes without nagging');
  await page.keyboard.press('Escape');

  ok(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  console.log(log.join('\n'));
  await browser.close();
})().catch(e => { console.error(e); console.log(log.join('\n')); process.exit(1); });
