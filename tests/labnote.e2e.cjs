// Lab note (v0.7): assay entries, direct edits with full version history, chat updates (accept / edit / reject /
// automatic), attachments, users with several ELM keys, non-destructive delete and restore, .tnote round trip, and
// the Wikibench export. Rebuilds the Wikibench example assay "2017-09-10 Assay Antibiotics resistance".
// UPDATE_EXAMPLES=1 rewrites examples/wikibench/* from this run; otherwise the export is compared with them.
const { chromium } = require('playwright');
const serveSuite = require('./serve.cjs');
const fs = require('fs'), path = require('path');
const FX = path.join(__dirname, 'fixtures'), CDN = process.env.CDN_DIR || '', OUT = path.join(__dirname, '..', 'test-output');
const EX = path.join(__dirname, '..', 'examples', 'wikibench');
fs.mkdirSync(OUT, { recursive: true });
const BASE = process.env.TN_URL || 'http://localhost:8765/thistle-notebook/index.html';
const log = [], chats = [];
const ok = (c, m) => { log.push((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const sse = t => (t.match(/[\s\S]{1,60}/g) || ['']).map(p => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`).join('') + 'data: [DONE]\n\n';
const block = o => '```lab-note\n' + JSON.stringify(o) + '\n```';
function labReply(last) {
  if (/Kirby/i.test(last)) return [
    block({ section: 'protocol', op: 'append', text: 'Followed [Kirby-Bauer Disk Diffusion Susceptibility Test Protocol](wiki:Kirby-Bauer Disk Diffusion Susceptibility Test Protocol) with the exception that the lab [agar recipe](wiki:Agar recipe) was used.' }),
    block({ section: 'results', op: 'append', text: '| Label | Antibiotic | Zone size (mm) |\n|---|---|---|\n| A | Kanamycin | 39 |\n| B | Netilmicin | 17 |\n| C | Streptomycin | 40 |\n| D | nil (control) | 0 |\n| E | Meropenem | 0 |\n| F | Cefalexin | 13 |\n| G | Teicoplanin | 27 |' }),
    'I recorded the protocol and the zone sizes.'].join('\n\n');
  if (/contaminat/i.test(last)) return block({ section: 'procedure', op: 'append', text: '- 09:15 — Plate D showed possible contamination.' }) + '\n\nRecorded the observation.';
  if (/incubated/i.test(last)) return block({ section: 'procedure', op: 'append', text: '- 18:00 — Plates were incubated at 37 °C for 18 h.' }) + '\n\nRecorded.';
  return 'Noted.';
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://localhost:8765' });
  if (!process.env.TN_URL) await serveSuite(ctx);
  if (CDN) await ctx.route('https://cdnjs.cloudflare.com/**', r => { const f = path.join(CDN, r.request().url().replace('https://cdnjs.cloudflare.com/ajax/libs/', '').replace(/\//g, '__')); fs.existsSync(f) ? r.fulfill({ body: fs.readFileSync(f), contentType: 'application/javascript' }) : r.continue(); });
  await ctx.route('https://elm.edina.ac.uk/api/v1/**', r => {
    const p = new URL(r.request().url()).pathname.replace('/api/v1', ''), body = r.request().postDataJSON?.() ?? null, cors = { 'Access-Control-Allow-Origin': 'http://localhost:8765' };
    if (p === '/models') return r.fulfill({ json: { data: ['Qwen/Qwen3.5-397B-A17B-FP8'].map(id => ({ id })) }, headers: cors });
    if (p === '/costs') return r.fulfill({ json: { usage: 0, limit: 50, currency: 'GBP' }, headers: cors });
    if (p === '/chat/completions') {
      chats.push({ body, auth: r.request().headers().authorization });
      const sys = body.messages[0].content, last = body.messages.at(-1).content;
      return r.fulfill({ body: sse(sys.includes('## Lab note') ? labReply(last) : 'An answer about the sources.'), headers: { ...cors, 'Content-Type': 'text/event-stream' } });
    }
    r.fulfill({ status: 404, json: {}, headers: cors });
  });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  let promptAnswer = 'E. Grant';
  page.on('dialog', d => d.accept(d.type() === 'prompt' ? promptAnswer : undefined));
  await page.addInitScript(() => sessionStorage.setItem('tn.key', 'elm-test'));
  await page.goto(BASE);
  await page.waitForSelector('#modelSelect option[value^="Qwen"]', { state: 'attached' });
  const lab = () => page.evaluate(() => JSON.parse(JSON.stringify(window.thistleNotebook.lab._L.note)));
  const entry = async () => { const n = await lab(); return n.entries.find(e => e.id === n.activeEntry); };
  const nMsgs = () => page.evaluate(() => window.thistleNotebook.messages.length);
  const ask = async text => { const b = await nMsgs(); await page.fill('#prompt', text); await page.click('#btnSend'); await page.waitForFunction(b => window.thistleNotebook.messages.length === b + 2 && !window.thistleNotebook.busy, b); };

  ok(await page.isVisible('#labPanel') && (await page.textContent('#labPanel')).includes('Write your lab notebook here'), 'Lab note pane is shown by default, with a start hint');

  // ---------- new assay entry (the author's name is asked once) ----------
  await page.click('#labPanel button:has-text("New assay")');
  await page.fill('#modalBody input[type=date]', '2017-09-10');
  await page.fill('#modalBody input[type=text]', 'Antibiotics resistance');
  await page.click('#modalBody button:has-text("Create")');
  await page.waitForSelector('#labEntry');
  let e = await entry();
  ok(e && e.type === 'wet' && e.fields.title.revs[0].author === 'E. Grant' && (await page.textContent('#labPanel')).includes('2017-09-10 Assay Antibiotics resistance'), 'entry created with Wikibench title “date Assay title”, signed by the user');
  ok((await page.textContent('#btnUser')).includes('E. Grant'), 'the user name is shown in the header');

  // ---------- direct edit ----------
  const editSection = async (key, text) => {
    await page.click(`#labPanel .lab-sec[data-key="${key}"] button[title="Edit this section"]`);
    await page.fill(`#labPanel .lab-sec[data-key="${key}"] textarea`, text);
    await page.click(`#labPanel .lab-sec[data-key="${key}"] button:has-text("Save")`);
    await page.waitForSelector(`#labPanel .lab-sec[data-key="${key}"] .lab-md`);
  };
  const AIM = 'An assay to measure the effectiveness of several antibiotics on *Escherichia coli* ATCC 25922.';
  await editSection('aim', AIM);
  e = await entry();
  ok(e.fields.aim.revs.length === 1 && e.fields.aim.revs[0].author === 'E. Grant' && e.fields.aim.revs[0].via === 'edit', 'direct edit stored as a signed, timestamped version');

  // ---------- attachment ----------
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#labPanel button:has-text("Attach files")')]);
  await fc.setFiles(path.join(FX, 'antibiotic_plate_labelled.png'));
  await page.waitForSelector('#labPanel .lab-att-list li');
  ok((await page.textContent('#labPanel .lab-att')).includes('antibiotic_plate_labelled.png'), 'file attached to the entry');

  // ---------- chat → lab note: accept, edit ----------
  await page.selectOption('#modeSelect', 'labnote');
  await ask('Did the Kirby-Bauer disc test but with our agar. Zones: A kan 39, B netilmicin 17, C strep 40, D nothing 0, E meropenem 0, F cefalexin 13, G teicoplanin 27');
  const sys = chats.at(-1).body.messages[0].content;
  ok(sys.includes('## Lab note') && sys.includes('Current entry: 2017-09-10 Assay Antibiotics resistance (wet)') && sys.includes(AIM), 'Lab notebook mode sends the current entry to the model');
  ok(await page.$$eval('.lab-card', c => c.length) === 2 && (await page.textContent('.lab-card')).includes('proposed'), 'updates shown as cards, not yet in the note');
  ok((await entry()).fields.protocol.revs.length === 0, 'nothing enters the note before it is accepted');
  await page.click('.lab-card >> nth=0 >> button:has-text("Accept")');
  await page.waitForFunction(() => document.querySelector('.lab-card .status')?.textContent.includes('accepted by'));
  e = await entry();
  ok(e.fields.protocol.revs.length === 1 && e.fields.protocol.revs[0].via === 'chat' && /accepted from chat/.test(e.fields.protocol.revs[0].note), 'accepted update stored with author, time and “from chat”');
  await page.click('.lab-card >> nth=1 >> button:has-text("Edit")');
  const edited = (await page.inputValue('.lab-card >> nth=1 >> textarea')) + '\n\n![Labelled plate](attachment:antibiotic_plate_labelled.png)';
  await page.fill('.lab-card >> nth=1 >> textarea', edited);
  await page.click('.lab-card >> nth=1 >> button:has-text("Accept edited text")');
  await page.waitForFunction(() => [...document.querySelectorAll('.lab-card .status')].some(s => s.textContent.includes('edited and accepted')));
  e = await entry();
  ok(e.fields.results.revs.at(-1).text === edited, 'edited update stores the edited text');
  ok(await page.$eval('#labPanel .lab-sec[data-key="results"] img', i => i.src.startsWith('blob:') && i.naturalWidth > 0).catch(() => false), 'image reference shows the attached image');

  // ---------- reject, then automatic ----------
  await ask('possible contamination on plate D this morning');
  await page.click('.msg.assistant:last-child .lab-card button:has-text("Reject")');
  await page.waitForFunction(() => document.querySelector('.msg.assistant:last-child .lab-card .status')?.textContent.includes('rejected'));
  ok((await entry()).fields.procedure.revs.length === 0, 'rejected update leaves the section unchanged');
  ok(await page.evaluate(() => { const m = window.thistleNotebook.messages.at(-1); return m.meta.lab[0].status === 'rejected' && m.content.includes('contamination'); }), 'the rejected proposal stays visible in the chat (nothing deleted)');
  await page.selectOption('#labPanel .lab-foot select', 'auto');
  await ask('plates incubated overnight at 37');
  await page.waitForFunction(() => window.thistleNotebook.lab._L.note.entries[0].fields.procedure.revs.length === 1);
  ok((await page.textContent('.msg.assistant:last-child .lab-card .status')).includes('applied automatically'), 'automatic option applies updates and labels them');
  await page.selectOption('#labPanel .lab-foot select', 'ask');

  // ---------- versions: nothing is removed ----------
  await editSection('aim', 'A wrong aim, written by mistake.');
  await page.click('#labPanel .lab-sec[data-key="aim"] button[title="All versions of this section"]');
  ok(await page.$$eval('#modalBody .lab-rev', r => r.length) === 2, 'history lists every version');
  await page.click('#modalBody .lab-rev >> nth=1 >> button:has-text("Restore")');
  e = await entry();
  ok(e.fields.aim.revs.length === 3 && e.fields.aim.revs[2].text === AIM && e.fields.aim.revs[2].via === 'restore' && e.fields.aim.revs[1].text.includes('mistake'), 'restore adds a version; the mistaken version is still kept');

  // ---------- second user and a renewed key ----------
  await page.click('#btnSettings');
  await page.fill('#modalBody .add-key input[type=text]', 'ELM key 2027');
  await page.fill('#modalBody .add-key input[type=password]', 'elm-renewed-key');
  await page.click('#btnAddKey');
  ok(await page.$$eval('#modalBody .keys-table tr', r => r.length) === 3, 'a user can hold several ELM keys');
  promptAnswer = 'A. Second';
  await page.click('#modalBody button:has-text("New user")');
  await page.fill('#modalBody .add-key input[type=password]', 'elm-second-key');
  await page.click('#btnAddKey');
  await page.click('#modalBody button:has-text("Save")');
  await page.selectOption('#modeSelect', 'general');
  await ask('hello');
  ok(chats.at(-1).auth === 'Bearer elm-second-key', 'requests use the current user’s active key');
  await editSection('conclusions', 'Kanamycin and streptomycin were the most effective; meropenem showed no zone [check: repeat with fresh discs].');
  ok((await entry()).fields.conclusions.revs[0].author === 'A. Second', 'changes are signed by the user writing now');
  await page.click('#btnUser'); await page.click('#popover .menu-item:has-text("E. Grant")');
  await page.waitForFunction(() => document.querySelector('#btnUser').textContent.includes('E. Grant'));
  await ask('hello again');
  ok(chats.at(-1).auth === 'Bearer elm-renewed-key', 'switching back uses that user’s newest key');

  // ---------- add an answer to the lab note ----------
  await page.click('.msg.assistant:last-child .lab-add-btn');
  await page.click('#popover .menu-item:has-text("Analysis")');
  await page.waitForFunction(() => window.thistleNotebook.lab._L.note.entries[0].fields.analysis.revs.length === 1);
  ok((await entry()).fields.analysis.revs[0].via === 'add', 'a chat answer can be added to a section (recorded as such)');

  // ---------- delete and restore are events, not removals ----------
  await page.click('#labPanel .lab-menu-btn'); await page.click('#popover .menu-item:has-text("Delete this entry")');
  await page.waitForFunction(() => document.querySelector('#labPanel').textContent.includes('No assay entries yet') || !document.querySelector('#labEntry option'));
  ok((await lab()).entries.length === 1, 'a deleted entry is kept in the record');
  await page.click('#labPanel .lab-deleted-btn');
  ok((await page.textContent('#labPanel')).includes('was deleted by E. Grant') && !(await page.$('#labPanel .lab-sec button[title="Edit this section"]')), 'a deleted entry can be shown read-only');
  await page.click('#labPanel .warn-box button:has-text("Restore")');
  await page.waitForSelector('#labPanel .lab-sec button[title="Edit this section"]');
  ok(await page.evaluate(() => window.thistleNotebook.lab._L.note.entries[0].events.map(x => x.what).join()).then(w => /deleted,restored$/.test(w)), 'delete and restore recorded as events');
  await page.click('#labPanel .lab-menu-btn'); await page.click('#popover .menu-item:has-text("Change log")');
  const logRows = await page.$$eval('#modalBody table.diag tr', r => r.length);
  ok(logRows > 12, `change log lists every change (${logRows - 1})`);
  await page.keyboard.press('Escape');

  // ---------- export for the wiki ----------
  await page.click('#labPanel button:has-text("Copy for wiki")');
  const markup = await page.textContent('#modalBody pre.wiki-pre');
  await page.click('#modalBody button:has-text("Copy wiki markup")');
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Wiki markup copied'));
  ok(await page.evaluate(() => navigator.clipboard.readText()) === markup, 'wiki markup copied to the clipboard');
  for (const [frag, what] of [
    ['An assay to measure the effectiveness of several antibiotics on _Escherichia coli_ ATCC 25922.', 'aim as a paragraph (no heading), italics'],
    ['h3. Protocol', 'sections as h3 headings'],
    ['[Kirby-Bauer Disk Diffusion Susceptibility Test Protocol|Kirby-Bauer Disk Diffusion Susceptibility Test Protocol]', 'protocol linked to its wiki page by title (hyphen not escaped)'],
    ['||Label||Antibiotic||Zone size (mm)||', 'table header row'], ['|A|Kanamycin|39|', 'table rows'],
    ['!antibiotic_plate_labelled.png|width=450!', 'image of an attachment'],
    ['* 18:00 — Plates were incubated at 37 °C for 18 h.', 'procedure log line as a bullet'],
    ['\\[check: repeat with fresh discs\\]', 'square brackets escaped (not turned into links)'],
    ['_Written with Thistle Notebook by E. Grant, A. Second;', 'provenance line with authors']]) ok(markup.includes(frag), 'wiki markup: ' + what);
  ok(!/\{\{|\bnull\b|undefined/.test(markup), 'wiki markup has no stray artefacts');
  ok(!markup.includes('{attachments}'), 'no attachments macro by default (the Wikibench template adds it)');
  await page.click('#modalBody button:has-text("Copy as formatted text")');
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Formatted text copied'));
  const html = await page.evaluate(async () => { const it = (await navigator.clipboard.read())[0]; return await (await it.getType('text/html')).text(); });
  ok(html.includes('<h3>Results</h3>') && html.includes('<table>') && html.includes('Kanamycin') && html.includes('Figure: antibiotic_plate_labelled.png'), 'formatted-text copy has headings, the table and a figure note');
  await page.screenshot({ path: path.join(OUT, '9-wiki-dialog.png') });
  await page.keyboard.press('Escape');
  await page.screenshot({ path: path.join(OUT, '10-lab-note.png') });

  // ---------- the example files for the wiki paste test ----------
  const ex = await page.evaluate(async () => {
    const L = await import('./js/labnote.js'), e = window.thistleNotebook.lab._L.note.entries[0];
    // the example is the Wikibench assay itself: aim, protocol, results, figure (no log, conclusions or analysis)
    const ex = JSON.parse(JSON.stringify(e)); for (const k of ['procedure', 'analysis', 'conclusions']) ex.fields[k] = { revs: [] };
    const w = L.entryToWiki(ex, { footer: false });
    return { title: w.title, markup: w.markup, html: L.entryToHtml(ex, { footer: false, wikiUrl: t => `https://www.wiki.ed.ac.uk/display/WIKB/${encodeURIComponent(t).replace(/%20/g, '+')}` }) };
  });
  const files = {
    'assay.wiki.txt': ex.markup,
    'assay-formatted.html': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${ex.title}</title><style>body{font:14px/1.5 system-ui,sans-serif;max-width:860px;margin:24px auto;padding:0 16px}table{border-collapse:collapse}th,td{border:1px solid #ccc;padding:3px 8px}.how{background:#eef4ff;border:1px solid #b9cdf5;padding:8px 12px;border-radius:6px}</style></head><body>\n<div class="how"><b>Formatted-text test.</b> Select everything below the line (from “An assay…” to the end), copy, and paste into the body of a new Wikibench assay page titled <b>${ex.title}</b>.</div><hr>\n${ex.html}\n</body></html>\n`,
  };
  for (const [n, c] of Object.entries(files)) {
    const f = path.join(EX, n);
    if (process.env.UPDATE_EXAMPLES) fs.writeFileSync(f, c);
    ok(fs.existsSync(f) && fs.readFileSync(f, 'utf8') === c, `examples/wikibench/${n} matches what the app produces`);
  }

  // ---------- .tnote round trip keeps every version and the attachment ----------
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnSave')]);
  const tn = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
  ok(tn.format === 3 && tn.labnote?.entries?.[0]?.fields.aim.revs.length === 3 && tn.files?.[0]?.data?.length > 1000, '.tnote (format 3) holds the lab note with every version and the attachment');
  fs.writeFileSync(path.join(OUT, 'lab.tnote'), JSON.stringify(tn));
  await page.setInputFiles('#openInput', path.join(OUT, 'lab.tnote'));
  await page.waitForFunction(() => document.querySelectorAll('#nbSelect option').length === 2 && window.thistleNotebook.lab._L.note?.entries?.length === 1);
  const back = await page.evaluate(() => { const L = window.thistleNotebook.lab._L; return { revs: L.note.entries[0].fields.aim.revs.length, file: L.files[0]?.blob?.size, name: L.files[0]?.name }; });
  ok(back.revs === 3 && back.file === fs.statSync(path.join(FX, 'antibiotic_plate_labelled.png')).size && back.name === 'antibiotic_plate_labelled.png', 'reopened notebook has the versions and the identical attachment');

  ok(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  console.log(log.join('\n'));
  await browser.close();
})().catch(e => { console.error(e); console.log(log.join('\n')); process.exit(1); });
