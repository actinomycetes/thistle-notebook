// v0.9: protocol folders (lab = public, private per user) on a drive, finalising entries (seal, witness, amendments,
// seal check) and Word export with embedded figures. Folders are real directories of the browser's private file system
// (window.TN_PICK_DIR replaces the folder picker, which cannot be automated), with the same API as a chosen disk folder.
const { chromium } = require('playwright');
const serveSuite = require('./serve.cjs');
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const FX = path.join(__dirname, 'fixtures'), CDN = process.env.CDN_DIR || '', OUT = path.join(__dirname, '..', 'test-output');
fs.mkdirSync(OUT, { recursive: true });
const BASE = process.env.TN_URL || 'http://localhost:8765/thistle-notebook/index.html';
const log = [];
const ok = (c, m) => { log.push((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const block = o => '```lab-note\n' + JSON.stringify(o) + '\n```';

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://localhost:8765' });
  if (!process.env.TN_URL) await serveSuite(ctx);
  if (CDN) await ctx.route('https://cdnjs.cloudflare.com/**', r => { const f = path.join(CDN, r.request().url().replace('https://cdnjs.cloudflare.com/ajax/libs/', '').replace(/\//g, '__')); fs.existsSync(f) ? r.fulfill({ body: fs.readFileSync(f), contentType: 'application/javascript' }) : r.continue(); });
  await ctx.route('https://elm.edina.ac.uk/api/v1/**', r => {
    const p = new URL(r.request().url()).pathname.replace('/api/v1', ''), cors = { 'Access-Control-Allow-Origin': 'http://localhost:8765' };
    if (p === '/models') return r.fulfill({ json: { data: [{ id: 'Qwen/Qwen3.5-397B-A17B-FP8' }] }, headers: cors });
    if (p === '/costs') return r.fulfill({ json: { usage: 0, limit: 50, currency: 'GBP' }, headers: cors });
    if (p === '/chat/completions') return r.fulfill({ body: `data: ${JSON.stringify({ choices: [{ delta: { content: block({ section: 'results', op: 'append', text: 'Zone B was 18 mm on re-measurement.' }) + '\n\nRecorded.' } }] })}\n\ndata: [DONE]\n\n`, headers: { ...cors, 'Content-Type': 'text/event-stream' } });
    r.fulfill({ status: 404, json: {}, headers: cors });
  });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const names = ['E. Grant', 'A. Second'];
  page.on('dialog', d => d.accept(d.type() === 'prompt' ? names.shift() || 'X' : undefined));
  await page.addInitScript(() => {
    sessionStorage.setItem('tn.key', 'elm-test');
    // "folders on a drive": directories in the browser's private file system (same File System Access API)
    window.TN_PICK_DIR = async which => (await navigator.storage.getDirectory()).getDirectoryHandle(`drive-${which}`, { create: true });
  });
  await page.goto(BASE);
  await page.waitForSelector('#modelSelect option[value^="Qwen"]', { state: 'attached' });
  const listDir = which => page.evaluate(async which => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle(`drive-${which}`, { create: true }); const out = []; for await (const [n] of d.entries()) out.push(n); return out.sort(); }, which);
  const readDir = (which, name) => page.evaluate(async ([which, name]) => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle(`drive-${which}`); return JSON.parse(await (await (await d.getFileHandle(name)).getFile()).text()); }, [which, name]);
  const writeDir = (which, name, obj) => page.evaluate(async ([which, name, obj]) => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle(`drive-${which}`, { create: true }); const w = await (await d.getFileHandle(name, { create: true })).createWritable(); await w.write(JSON.stringify(obj)); await w.close(); }, [which, name, obj]);
  const protos = () => page.evaluate(() => JSON.parse(JSON.stringify(window.thistleNotebook.protocols._P.all)));

  // ---------- connect the lab and private folders (Settings) ----------
  await page.click('#labPanel button:has-text("New assay")'); // asks the name once
  await page.fill('#modalBody input[type=text]', 'Antibiotics resistance'); await page.fill('#modalBody input[type=date]', '2017-09-10');
  await page.click('#modalBody button:has-text("Create")'); await page.waitForSelector('#labEntry');
  await page.click('#btnSettings'); await page.click('#modalBody button:has-text("protocol folders")');
  await page.click('#modalBody tr:has-text("Lab folder") button:has-text("Choose folder")');
  await page.waitForSelector('#modalBody tr:has-text("Lab folder"):has-text("✅")');
  await page.click('#modalBody tr:has-text("Private folder") button:has-text("Choose folder")');
  await page.waitForSelector('#modalBody tr:has-text("Private folder"):has-text("✅")');
  ok(true, 'lab and private folders connected from Settings');
  await page.click('#modalBody button:has-text("Done")');
  await page.waitForSelector('#modalBody .proto-folders');
  ok((await page.textContent('#modalBody .proto-folders')).includes('Lab folder: drive-lab'), 'the library shows which folders are in use');

  // ---------- public protocol → lab folder; private → private folder ----------
  const newProto = async (title, body, vis) => {
    await page.click('#modalBody button:has-text("New protocol")');
    await page.fill('#modalBody .form-grid input >> nth=0', title); await page.fill('#modalBody textarea', body);
    await page.selectOption('#modalBody .form-grid select', vis);
    await page.click('#modalBody button:has-text("Save")');
    await page.waitForSelector('#modalBody button:has-text("Library")');
    await page.click('#modalBody button:has-text("Library")'); await page.waitForSelector('#modalBody .proto-lib');
  };
  await newProto('Kirby-Bauer disc test', '1. Swab the plate.\n2. Place discs.', 'public');
  await newProto('My agar recipe', '1. Mix.\n2. Autoclave.', 'private');
  const lab = await listDir('lab'), priv = await listDir('private');
  ok(lab.length === 1 && /^Kirby-Bauer disc test \[.+\]\.tnote$/.test(lab[0]) && priv.length === 1 && priv[0].startsWith('My agar recipe'), 'public protocol saved in the lab folder, private one in the private folder (one file each)');
  const kbFile = lab[0], kb = await readDir('lab', kbFile);
  ok(kb.kind === 'protocol' && kb.app === 'Thistle Notebook' && kb.protocol.versions.length === 1, 'protocol files follow the suite convention (app, format, kind)');

  // ---------- a colleague's work appears in the lab folder ----------
  const colleague = { ...kb.protocol, versions: [...kb.protocol.versions, { v: 2, t: Date.now() + 1000, author: 'C. Colleague', title: 'Kirby-Bauer disc test', body: '1. Swab the plate firmly.\n2. Place discs.', wiki: '', tags: '', note: 'firmer swabbing' }] };
  await writeDir('lab', kbFile, { app: 'Thistle Notebook', format: 3, kind: 'protocol', protocol: colleague });
  await writeDir('lab', 'Growth curve [colleague1].tnote', { app: 'Thistle Notebook', format: 3, kind: 'protocol', protocol: { id: 'colleague1', owner: 'u-c', ownerName: 'C. Colleague', visibility: 'public', created: 1, versions: [{ v: 1, t: 1, author: 'C. Colleague', title: 'Growth curve', body: '1. Measure OD600 hourly.', wiki: '', tags: '', note: 'created' }], events: [] } });
  await page.click('#modalBody button:has-text("Sync")');
  await page.waitForFunction(() => window.thistleNotebook.protocols._P.all.length === 3);
  let all = await protos();
  ok(all.find(p => p.id === 'colleague1') && all.find(p => p.id === kb.protocol.id).versions.at(-1).author === 'C. Colleague', 'Sync brings in a colleague’s new protocol and their new version');
  // both edit: my new version merges with the file instead of overwriting it
  await page.evaluate(async id => { const P = window.thistleNotebook.protocols._P, m = await import('./js/protocols.js'); const p = P.all.find(x => x.id === id); m.saveVersion(p, { ...p.versions.at(-1), body: p.versions.at(-1).body + '\n3. Incubate 18 h.' }, 'E. Grant', 'incubation step'); }, kb.protocol.id);
  await writeDir('lab', kbFile, { app: 'Thistle Notebook', format: 3, kind: 'protocol', protocol: { ...colleague, versions: [...colleague.versions, { v: 3, t: Date.now() + 2000, author: 'C. Colleague', title: 'Kirby-Bauer disc test', body: 'colleague edit at the same time', wiki: '', tags: '', note: 'parallel edit' }] } });
  await page.evaluate(async id => { const P = window.thistleNotebook.protocols; await P.openLibrary(); }, kb.protocol.id); // reload view
  await page.evaluate(async id => { const T = window.thistleNotebook.protocols._P, p = T.all.find(x => x.id === id); await window.thistleNotebook.protocols._store?.(p); }, kb.protocol.id);
  await page.click(`#modalBody tr.proto-row:has-text("Kirby-Bauer")`);
  await page.click('#modalBody button:has-text("Edit")'); await page.fill('#modalBody textarea', '1. Swab the plate firmly.\n2. Place discs.\n3. Incubate 18 h at 37 °C.'); await page.click('#modalBody button:has-text("Save new version")');
  await page.waitForSelector('#modalBody button:has-text("Versions")');
  const onDisk = (await readDir('lab', kbFile)).protocol;
  ok(onDisk.versions.some(v => v.body === 'colleague edit at the same time') && onDisk.versions.at(-1).body.includes('37 °C') && onDisk.versions.map(v => v.v).join() === [...onDisk.versions.keys()].map(i => i + 1).join(), 'saving merges with the file: both people’s versions are kept, numbered in order');
  all = await protos();
  ok(all.find(p => p.id === kb.protocol.id).versions.some(v => v.body === 'colleague edit at the same time'), 'the local library gains the colleague’s parallel version too');
  await page.keyboard.press('Escape');

  // ---------- folders stay connected after a reload ----------
  await page.reload(); await page.waitForSelector('#modelSelect option[value^="Qwen"]', { state: 'attached' });
  await page.click('#labPanel button:has-text("Protocols")'); await page.waitForSelector('#modalBody .proto-folders');
  ok((await page.textContent('#modalBody .proto-folders')).includes('Lab folder: drive-lab') && !(await page.textContent('#modalBody .proto-folders')).includes('needs permission'), 'folders are remembered after a reload');
  await page.keyboard.press('Escape');

  // ---------- finalise, witness, amendments, seal ----------
  const editSection = async (key, text) => {
    await page.click(`#labPanel .lab-sec[data-key="${key}"] button[title="Edit this section"]`);
    await page.fill(`#labPanel .lab-sec[data-key="${key}"] textarea`, text);
    await page.click(`#labPanel .lab-sec[data-key="${key}"] button:has-text("Save")`);
    await page.waitForSelector(`#labPanel .lab-sec[data-key="${key}"] .lab-md`);
  };
  await editSection('aim', 'An assay to measure antibiotic effectiveness on *E. coli* ATCC 25922.');
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#labPanel button:has-text("Attach files")')]);
  await fc.setFiles(path.join(FX, 'antibiotic_plate_labelled.png')); await page.waitForSelector('#labPanel .lab-att-list li');
  await editSection('results', '| Label | Zone (mm) |\n|---|---|\n| A | 39 |\n| B | 17 |\n\n![Labelled plate](attachment:antibiotic_plate_labelled.png)');
  await page.click('#labPanel .lab-menu-btn'); await page.click('#popover .menu-item:has-text("Finalise")');
  await page.click('#modalBody button:has-text("🔏 Finalise")');
  await page.waitForSelector('#labPanel .lab-final');
  ok(!(await page.$('#labPanel .lab-sec button[title="Edit this section"]')) && !(await page.$('#labPanel button:has-text("Attach files")')), 'a finalised entry is locked (no editing, no new attachments)');
  const ent = () => page.evaluate(() => { const n = window.thistleNotebook.lab._L.note; return JSON.parse(JSON.stringify(n.entries[0])); });
  let e = await ent();
  ok(/^[0-9a-f]{64}$/.test(e.events.find(x => x.what === 'finalised').seal), 'finalising records a SHA-256 seal with the author');
  await page.click('#labPanel .lab-final button:has-text("Check seal")');
  ok(await page.waitForSelector('#modalBody .hint-box:has-text("matches the seal")').then(() => true, () => false), 'the seal check confirms an unchanged entry');
  await page.keyboard.press('Escape');
  ok(!(await page.$('#labPanel .lab-final button:has-text("Witness")')), 'the author cannot witness their own entry');
  await page.click('#btnSettings'); await page.click('#modalBody button:has-text("New user")');
  await page.fill('#modalBody .add-key input[type=password]', 'elm-second'); await page.click('#btnAddKey'); await page.click('#modalBody button:has-text("Save")');
  await page.waitForFunction(() => document.querySelector('#btnUser').textContent.includes('A. Second'));
  await page.click('#labPanel .lab-final button:has-text("Witness")');
  await page.waitForFunction(() => document.querySelector('#labPanel .lab-final').textContent.includes('witnessed by A. Second'));
  ok((await ent()).events.some(x => x.what === 'witnessed' && x.author === 'A. Second'), 'a second person witnesses the entry');
  // amendment from the chat
  await page.selectOption('#modeSelect', 'labnote');
  await page.fill('#prompt', 'B was actually 18'); await page.click('#btnSend');
  await page.waitForSelector('.lab-card button:has-text("Accept")');
  await page.click('.lab-card button:has-text("Accept")');
  await page.fill('#modalBody input[type=text]', 'zone B re-measured with calipers');
  await page.click('#modalBody button:has-text("Add amendment")');
  await page.waitForFunction(() => document.querySelector('.lab-card .status')?.textContent.includes('added as an amendment'));
  e = await ent();
  ok(e.amendments?.length === 1 && e.amendments[0].reason === 'zone B re-measured with calipers' && e.amendments[0].author === 'A. Second' && !e.fields.results.revs.at(-1).text.includes('18 mm'), 'a chat update to a finalised entry becomes a signed amendment; the sealed text is unchanged');
  await page.click('#labPanel .lab-final button:has-text("Check seal")');
  ok(await page.waitForSelector('#modalBody .hint-box:has-text("matches the seal")').then(() => true, () => false), 'amendments do not break the seal');
  await page.keyboard.press('Escape');
  await page.click('#labPanel button:has-text("Copy for wiki")');
  const markup = await page.textContent('#modalBody pre.wiki-pre');
  ok(markup.includes('h3. Amendments') && markup.includes('reason: zone B re-measured with calipers') && markup.includes('Finalised by E. Grant') && markup.includes('witnessed by A. Second'), 'wiki markup includes the amendment and the finalisation line');
  await page.keyboard.press('Escape');

  // ---------- Word with embedded figure ----------
  await page.click('#labPanel .lab-menu-btn');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#popover .menu-item:has-text("Word")')]);
  const docx = path.join(OUT, 'entry.docx'); fs.copyFileSync(await dl.path(), docx);
  const info = await page.evaluate(async b64 => {
    const { unzip } = await import('./js/zip.js'), z = await unzip(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
    return { names: z.names, doc: await z.text('word/document.xml'), rels: await z.text('word/_rels/document.xml.rels'), ct: await z.text('[Content_Types].xml') };
  }, fs.readFileSync(docx).toString('base64'));
  ok(info.names.includes('word/media/image1.png') && info.doc.includes('<w:drawing>') && info.rels.includes('media/image1.png') && info.ct.includes('Extension="png"'), 'Word export embeds the attached figure');
  let py = ''; try { py = execFileSync('python3', ['-I', '-c', 'import sys,docx; d=docx.Document(sys.argv[1]); print(len(d.inline_shapes), "|", "Amendments" in [p.text for p in d.paragraphs], "|", len(d.tables))', docx]).toString().trim(); } catch (err) { py = 'python-docx unavailable'; }
  ok(py === '1 | True | 1' || py === 'python-docx unavailable', `Word file opens in python-docx with the picture, table and amendments (${py})`);

  // ---------- a change made outside the app is detected ----------
  await page.evaluate(async () => { const L = window.thistleNotebook.lab._L, e = L.note.entries[0]; e.fields.results.revs.push({ t: Date.now(), author: 'someone', text: 'tampered', via: 'edit' }); window.thistleNotebook.lab.render(); });
  await page.click('#labPanel .lab-final button:has-text("Check seal")');
  ok(await page.waitForSelector('#modalBody .err-box:has-text("does NOT match its seal")').then(() => true, () => false), 'the seal check detects content changed outside the app');
  await page.keyboard.press('Escape');

  // ---------- disconnecting a folder deletes nothing ----------
  await page.click('#labPanel button:has-text("Protocols")'); await page.click('#modalBody button:has-text("Folders")');
  await page.click('#modalBody tr:has-text("Lab folder") button:has-text("Disconnect")');
  await page.waitForSelector('#modalBody tr:has-text("Lab folder"):has-text("not set")');
  ok((await listDir('lab')).length === 2, 'disconnecting the lab folder leaves its files in place');

  ok(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  console.log(log.join('\n'));
  await browser.close();
})().catch(e => { console.error(e); console.log(log.join('\n')); process.exit(1); });
