// Protocol library (v0.8): public / private protocols owned by users, versions (append-only), import from files,
// duplicate, delete / restore, insertion into a lab-note entry with a frozen copy, the wiki markup, the model context,
// and library files shared between browsers (merge without removing anything).
const { chromium } = require('playwright');
const serveSuite = require('./serve.cjs');
const fs = require('fs'), path = require('path');
const CDN = process.env.CDN_DIR || '', OUT = path.join(__dirname, '..', 'test-output');
fs.mkdirSync(OUT, { recursive: true });
const BASE = process.env.TN_URL || 'http://localhost:8765/thistle-notebook/index.html';
const log = [], chats = [];
const ok = (c, m) => { log.push((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const KB = 'Kirby-Bauer Disk Diffusion Susceptibility Test Protocol';
const KB_MD = `# ${KB}\n\n## Materials\n- Mueller-Hinton agar plates\n- 0.5 McFarland standard\n\n## Inoculation\n1. Dip a sterile swab into the inoculum.\n2. Streak the plate three times, rotating 60° each time.\n3. Let the surface dry for 3–15 min.\n`;
const AGAR = '1. Add 10 g tryptone, 5 g yeast extract and 10 g NaCl to 800 mL water.\n2. Adjust pH to 7.5 with NaOH.\n3. Add 15 g agar, make up to 1 L and autoclave.';

async function openApp(browser, names) {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://localhost:8765' });
  if (!process.env.TN_URL) await serveSuite(ctx);
  if (CDN) await ctx.route('https://cdnjs.cloudflare.com/**', r => { const f = path.join(CDN, r.request().url().replace('https://cdnjs.cloudflare.com/ajax/libs/', '').replace(/\//g, '__')); fs.existsSync(f) ? r.fulfill({ body: fs.readFileSync(f), contentType: 'application/javascript' }) : r.continue(); });
  await ctx.route('https://elm.edina.ac.uk/api/v1/**', r => {
    const p = new URL(r.request().url()).pathname.replace('/api/v1', ''), body = r.request().postDataJSON?.() ?? null, cors = { 'Access-Control-Allow-Origin': 'http://localhost:8765' };
    if (p === '/models') return r.fulfill({ json: { data: [{ id: 'Qwen/Qwen3.5-397B-A17B-FP8' }] }, headers: cors });
    if (p === '/costs') return r.fulfill({ json: { usage: 0, limit: 50, currency: 'GBP' }, headers: cors });
    if (p === '/chat/completions') { chats.push(body); return r.fulfill({ body: `data: ${JSON.stringify({ choices: [{ delta: { content: 'Noted.' } }] })}\n\ndata: [DONE]\n\n`, headers: { ...cors, 'Content-Type': 'text/event-stream' } }); }
    r.fulfill({ status: 404, json: {}, headers: cors });
  });
  const page = await ctx.newPage();
  page.errors = []; page.on('pageerror', e => page.errors.push(e.message));
  page.on('dialog', d => d.accept(d.type() === 'prompt' ? names.shift() || 'Someone' : undefined));
  await page.addInitScript(() => sessionStorage.setItem('tn.key', 'elm-test'));
  await page.goto(BASE);
  await page.waitForSelector('#modelSelect option[value^="Qwen"]', { state: 'attached' });
  return { ctx, page };
}

(async () => {
  const browser = await chromium.launch();
  const { page } = await openApp(browser, ['E. Grant', 'A. Second']);
  const protos = () => page.evaluate(() => JSON.parse(JSON.stringify(window.thistleNotebook.protocols._P.all)));
  const byTitle = async t => (await protos()).find(p => p.versions.at(-1).title === t);
  const entry = () => page.evaluate(() => { const n = window.thistleNotebook.lab._L.note; return JSON.parse(JSON.stringify(n.entries.find(e => e.id === n.activeEntry))); });

  // an assay entry to insert protocols into
  await page.click('#labPanel button:has-text("New assay")');
  await page.fill('#modalBody input[type=date]', '2017-09-10'); await page.fill('#modalBody input[type=text]', 'Antibiotics resistance');
  await page.click('#modalBody button:has-text("Create")'); await page.waitForSelector('#labEntry');

  // ---------- new private protocol ----------
  await page.click('#labPanel button:has-text("Protocols")');
  await page.waitForSelector('#modalBody .proto-lib');
  ok((await page.textContent('#modalBody')).includes('No protocols yet'), 'empty library explains how to add protocols');
  await page.click('#modalBody button:has-text("New protocol")');
  await page.fill('#modalBody .form-grid input >> nth=0', 'Agar recipe');
  await page.fill('#modalBody textarea', AGAR);
  await page.click('#modalBody button:has-text("Save")');
  await page.waitForFunction(() => window.thistleNotebook.protocols._P.all.length === 1);
  let agar = await byTitle('Agar recipe');
  ok(agar.visibility === 'private' && agar.ownerName === 'E. Grant' && agar.versions.length === 1, 'new protocol: private, owned and signed by the user');

  // ---------- import from a file, then versions ----------
  const kbFile = path.join(OUT, 'kirby-bauer.md'); fs.writeFileSync(kbFile, KB_MD);
  await page.click('#modalBody button:has-text("Library")').catch(() => {}); // back to the list from the protocol view
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#modalBody button:has-text("From files")')]);
  await fc.setFiles(kbFile);
  await page.waitForFunction(() => window.thistleNotebook.protocols._P.all.length === 2);
  let kb = await byTitle(KB);
  ok(kb && kb.versions[0].body.includes('Streak the plate') && /imported from kirby-bauer\.md/.test(kb.versions[0].note), 'imported from a file: title from its heading, steps kept, source noted');
  await page.click(`#modalBody tr.proto-row:has-text("${KB}")`);
  await page.click('#modalBody button:has-text("Edit")');
  await page.fill('#modalBody textarea', KB_MD.replace('three times', 'three times firmly'));
  await page.fill('#modalBody .form-grid input >> nth=3', 'firmer streaking');
  await page.click('#modalBody button:has-text("Save new version")');
  await page.click('#modalBody button:has-text("Versions")');
  await page.click('#modalBody .lab-rev:has-text("Version 1") button:has-text("Restore")');
  kb = await byTitle(KB);
  ok(kb.versions.length === 3 && kb.versions[2].body === kb.versions[0].body && kb.versions[1].body.includes('firmly') && /restored version 1/.test(kb.versions[2].note), 'edit adds a version; restore adds another; nothing removed');
  await page.click('#modalBody button:has-text("Back")');
  await page.click('#modalBody button:has-text("Edit")');
  await page.fill('#modalBody .form-grid input >> nth=1', KB);
  await page.click('#modalBody button:has-text("Save new version")');
  await page.click('#modalBody button:has-text("Make public")');
  await page.waitForSelector('#modalBody button:has-text("Make private")');
  kb = await byTitle(KB);
  ok(kb.versions.length === 4 && kb.versions[3].wiki === KB && kb.visibility === 'public' && kb.events.some(e => e.what === 'visibility'), 'wiki page set (version 4) and made public (recorded as an event)');
  await page.keyboard.press('Escape');

  // ---------- second user: sees public only, cannot edit, can duplicate ----------
  await page.click('#btnSettings'); await page.click('#modalBody button:has-text("New user")'); await page.click('#modalBody button:has-text("Save")');
  await page.waitForFunction(() => document.querySelector('#btnUser').textContent.includes('A. Second'));
  await page.click('#labPanel button:has-text("Protocols")');
  await page.waitForSelector('#modalBody .proto-lib');
  const rowsB = await page.$$eval('#modalBody tr.proto-row', r => r.map(x => x.textContent));
  ok(rowsB.length === 1 && rowsB[0].includes(KB), 'another user sees public protocols, not private ones');
  await page.click('#modalBody tr.proto-row');
  ok(!(await page.$('#modalBody button:has-text("Edit")')) && !(await page.$('#modalBody button:has-text("Delete")')), 'only the owner can edit or delete');
  await page.click('#modalBody button:has-text("Duplicate")');
  await page.waitForFunction(() => window.thistleNotebook.protocols._P.all.length === 3);
  const copy = (await protos()).find(p => p.ownerName === 'A. Second');
  ok(copy && copy.visibility === 'private' && /copied from .* version 4 by E\. Grant/.test(copy.versions[0].note), 'duplicate makes a private copy that records where it came from');
  await page.keyboard.press('Escape');
  await page.click('#btnUser'); await page.click('#popover .menu-item:has-text("E. Grant")');
  await page.waitForFunction(() => document.querySelector('#btnUser').textContent.includes('E. Grant'));

  // ---------- insert into the entry (from the Protocol section) ----------
  await page.click('#labPanel .lab-proto-add');
  await page.click(`#modalBody .menu-item:has-text("${KB}")`);
  ok(!(await page.isChecked('#modalBody input[type=checkbox]')), 'a protocol with a wiki page is linked, not copied, by default');
  await page.fill('#modalBody textarea', 'Used the lab agar recipe instead of Mueller-Hinton agar.');
  await page.click('#modalBody button:has-text("Add to the Protocol section")');
  await page.waitForFunction(() => window.thistleNotebook.lab._L.note.entries[0].protocolsUsed?.length === 1);
  let e = await entry();
  const ptext = e.fields.protocol.revs.at(-1).text;
  ok(ptext.includes(`Followed [${KB}](wiki:${KB}) (protocol version 4).`) && ptext.includes('Deviations from the protocol: Used the lab agar recipe'), 'reference and deviations added to the Protocol section');
  ok(e.protocolsUsed[0].v === 4 && e.protocolsUsed[0].body === kb.versions[3].body && e.fields.protocol.revs.at(-1).via === 'protocol', 'the entry keeps a frozen copy of the version used');
  // a later edit of the protocol does not change the record
  await page.evaluate(async t => { const P = window.thistleNotebook.protocols._P, p = P.all.find(x => x.versions.at(-1).title === t), m = await import('./js/protocols.js'); m.saveVersion(p, { ...p.versions.at(-1), body: p.versions.at(-1).body + '\n4. New step.' }, 'E. Grant', 'later'); await (await import('./js/store.js')).put('protocols', p); }, KB);
  e = await entry();
  ok(!e.protocolsUsed[0].body.includes('New step'), 'later protocol edits do not change the copy in the entry');
  await page.screenshot({ path: path.join(OUT, '12-protocol-in-entry.png') });
  await page.click('#labPanel .lab-protos button');
  ok((await page.textContent('#modalBody')).includes('does not change when the protocol is edited later'), 'the recorded copy can be viewed from the entry');
  await page.keyboard.press('Escape');

  // ---------- insert while editing (private protocol without a wiki page: steps copied) ----------
  await page.click('#labPanel .lab-sec[data-key="protocol"] button[title="Edit this section"]');
  await page.click('#labPanel .lab-edit-tools button:has-text("Protocol")');
  await page.click('#modalBody .menu-item:has-text("Agar recipe")');
  ok(await page.isChecked('#modalBody input[type=checkbox]'), 'a protocol without a wiki page is copied by default');
  await page.click('#modalBody button:has-text("Insert into the text")');
  await page.click('#labPanel .lab-sec[data-key="protocol"] button:has-text("Save")');
  await page.waitForFunction(() => window.thistleNotebook.lab._L.note.entries[0].protocolsUsed?.length === 2);
  e = await entry();
  ok(e.fields.protocol.revs.at(-1).text.includes('Followed **Agar recipe** (protocol version 1).') && e.fields.protocol.revs.at(-1).text.includes('Adjust pH to 7.5'), 'inserted while editing: reference plus a copy of the steps, recorded on save');

  // ---------- wiki markup and the model ----------
  await page.click('#labPanel button:has-text("Copy for wiki")');
  const markup = await page.textContent('#modalBody pre.wiki-pre');
  ok(markup.includes(`[${KB}|${KB}]`) && markup.includes('*Agar recipe*') && markup.includes('# Adjust pH to 7.5 with NaOH.') && !markup.includes('{attachments}'), 'wiki markup: protocol page link, bold title, copied steps, no attachments macro');
  await page.keyboard.press('Escape');
  await page.selectOption('#modeSelect', 'labnote');
  await page.fill('#prompt', 'followed kirby bauer as usual'); await page.click('#btnSend');
  await page.waitForFunction(n => window.thistleNotebook.messages.length === 2 && !window.thistleNotebook.busy);
  const sys = chats.at(-1).messages[0].content;
  ok(sys.includes('Protocols recorded in this entry') && sys.includes(`### ${KB} (version 4, wiki page "${KB}")`) && sys.includes('Agar recipe v1'), 'Lab notebook mode tells the model the recorded protocols and the library');

  // ---------- insert protocol at caret between two existing sentences in Word style ----------
  await page.evaluate(() => localStorage.removeItem('tn.labEditorMode'));
  await page.click('#labPanel .lab-sec[data-key="procedure"] button[title="Edit this section"]');
  await page.waitForSelector('#labPanel .lab-sec[data-key="procedure"] .lab-rich:not([hidden])');
  await page.click('#labPanel .lab-sec[data-key="procedure"] .lab-rich');
  await page.keyboard.type('First sentence. Second sentence.');
  await page.click('#labPanel .lab-sec[data-key="procedure"] button:has-text("Save")');
  await page.waitForSelector('#labPanel .lab-sec[data-key="procedure"] .lab-md');
  await page.click('#labPanel .lab-sec[data-key="procedure"] button[title="Edit this section"]');
  await page.waitForSelector('#labPanel .lab-sec[data-key="procedure"] .lab-rich:not([hidden])');
  // Place caret explicitly between "First sentence. " and "Second sentence."
  await page.evaluate(() => {
    const rich = document.querySelector('#labPanel .lab-sec[data-key="procedure"] .lab-rich');
    rich.focus();
    const walk = document.createTreeWalker(rich, NodeFilter.SHOW_TEXT);
    const tn = walk.nextNode();
    const pos = tn.nodeValue.indexOf('Second sentence.');
    const r = document.createRange();
    r.setStart(tn, pos); r.collapse(true);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
  });
  await page.click('#labPanel .lab-edit-tools button:has-text("Protocol")');
  await page.click('#modalBody .menu-item:has-text("Agar recipe")');
  await page.click('#modalBody button:has-text("Insert into the text")');
  await page.click('#labPanel .lab-sec[data-key="procedure"] button:has-text("Save")');
  await page.waitForFunction(() => window.thistleNotebook.lab._L.note.entries[0].protocolsUsed?.length === 3);
  // Reopen in Word style and verify both mid-sentence insertion order and recorded protocol ID/version
  await page.click('#labPanel .lab-sec[data-key="procedure"] button[title="Edit this section"]');
  await page.waitForSelector('#labPanel .lab-sec[data-key="procedure"] .lab-rich:not([hidden])');
  const midCheck = await page.evaluate(async () => {
    const L = await import('./js/labnote.js'), e = window.thistleNotebook.lab._L.note.entries[0];
    const agar = window.thistleNotebook.protocols._P.all.find(p => p.versions.at(-1).title === 'Agar recipe');
    const r = document.querySelector('#labPanel .lab-sec[data-key="procedure"] .lab-rich');
    return { md: L.cur(e.fields.procedure), dom: r.textContent, lastProto: e.protocolsUsed.at(-1), agarId: agar?.id };
  });
  const checkOrder = s => {
    const a = s.indexOf('First sentence.'), b = s.indexOf('Agar recipe'), c = s.indexOf('Adjust pH to 7.5'), d = s.indexOf('Second sentence.');
    return a >= 0 && b > a && c > b && d > c;
  };
  ok(checkOrder(midCheck.md) && checkOrder(midCheck.dom), 'inserting a protocol with the caret between two sentences preserves mid-sentence position across save and reopen');
  ok(midCheck.lastProto?.pid === midCheck.agarId && midCheck.lastProto?.v === 1, 'mid-sentence rich-editor protocol insertion records the exact protocol ID and version');
  await page.click('#labPanel .lab-sec[data-key="procedure"] button:has-text("Cancel")');

  // ---------- delete and restore ----------
  await page.click('#labPanel button:has-text("Protocols")');
  await page.click('#modalBody tr.proto-row:has-text("Agar recipe")'); await page.click('#modalBody button:has-text("Delete")');
  await page.waitForSelector('#modalBody tr.proto-row');
  ok(!(await page.$$eval('#modalBody tr.proto-row', r => r.map(x => x.textContent))).some(t => t.includes('Agar recipe')) && (await protos()).length === 3, 'a deleted protocol is hidden but kept');
  await page.selectOption('#modalBody select', 'deleted');
  await page.click('#modalBody tr.proto-row:has-text("Agar recipe")'); await page.click('#modalBody button:has-text("Restore")');
  ok(!(await byTitle('Agar recipe')).events.at(-1).what.includes('deleted'), 'restored from “My deleted”');
  ok(await page.waitForFunction(() => [...document.querySelectorAll('#modalBody tr.proto-row')].some(r => r.textContent.includes('Agar recipe'))).then(() => true, () => false), 'after restoring, the library shows the normal list again');

  // ---------- copy a protocol for the wiki ----------
  await page.click(`#modalBody tr.proto-row:has-text("${KB}")`);
  await page.click('#modalBody button:has-text("Copy for wiki")');
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Protocol wiki markup copied'));
  const pm = await page.evaluate(() => navigator.clipboard.readText());
  ok(pm.startsWith(`h1. ${KB}`) && pm.includes('h2. Materials') && pm.includes('# Dip a sterile swab'), 'protocol copied as wiki markup for its own page (headings keep their level)');

  // ---------- library file: public only unless chosen ----------
  await page.click('#modalBody button:has-text("Library")');
  await page.click('#modalBody button:has-text("Save library")');
  const [d1] = await Promise.all([page.waitForEvent('download'), page.click('#modalBody button:has-text("Save library file")')]);
  const lib1 = JSON.parse(fs.readFileSync(await d1.path(), 'utf8'));
  ok(lib1.kind === 'protocols' && lib1.protocols.length === 1 && lib1.protocols[0].versions.length === 5, 'library file holds public protocols with all versions');
  await page.click('#labPanel button:has-text("Protocols")'); await page.click('#modalBody button:has-text("Save library")');
  await page.check('#modalBody input[type=checkbox]');
  const [d2] = await Promise.all([page.waitForEvent('download'), page.click('#modalBody button:has-text("Save library file")')]);
  const libPath = path.join(OUT, 'protocols.tnote'); fs.copyFileSync(await d2.path(), libPath);
  ok(JSON.parse(fs.readFileSync(libPath, 'utf8')).protocols.length === 2, 'private protocols are included only when chosen');

  // the library belongs to the browser, not to one notebook
  await page.click('#btnNewNb'); await page.click('#modalBody button:has-text("Create")');
  await page.waitForFunction(() => document.querySelectorAll('#nbSelect option').length === 2);
  await page.click('#labPanel button:has-text("Protocols")');
  await page.waitForSelector('#modalBody .proto-lib');
  ok((await page.$$eval('#modalBody tr.proto-row', r => r.length)) === 2, 'the library is shared by all notebooks');
  await page.screenshot({ path: path.join(OUT, '11-protocol-library.png') });
  await page.keyboard.press('Escape');

  // ---------- another browser opens the library file ----------
  const { page: p2 } = await openApp(browser, ['C. Colleague']);
  await p2.click('#labPanel button:has-text("Protocols")');
  await p2.waitForSelector('#modalBody .proto-lib');
  await p2.setInputFiles('#modalBody input[type=file]', libPath);
  await p2.waitForFunction(() => window.thistleNotebook.protocols._P.all.length === 2);
  const rows2 = await p2.$$eval('#modalBody tr.proto-row', r => r.map(x => x.textContent));
  ok(rows2.length === 1 && rows2[0].includes(KB), 'a colleague sees the public protocol; the private one stays private to its owner');
  await p2.setInputFiles('#modalBody input[type=file]', libPath);
  await p2.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('already up to date'));
  ok((await p2.evaluate(() => window.thistleNotebook.protocols._P.all.length)) === 2, 'opening the same library again adds nothing twice');

  ok(!page.errors.length && !p2.errors.length, 'no page errors' + ([...page.errors, ...p2.errors].length ? ': ' + [...page.errors, ...p2.errors].join(' | ') : ''));
  console.log(log.join('\n'));
  await browser.close();
})().catch(e => { console.error(e); console.log(log.join('\n')); process.exit(1); });
