// End-to-end test (thistle-plot/ must be checked out beside this repo; files are served by tests/serve.cjs): mock ELM (route interception at the real ELM URL, so the CSP still applies), real Thistle Plot in the iframe.
const { chromium } = require('playwright');
const serveSuite = require('./serve.cjs');
const fs = require('fs'), path = require('path');
const SP = __dirname, FX = path.join(SP, 'fixtures'), CDN = process.env.CDN_DIR || '', OUT = path.join(SP, '..', 'test-output');
fs.mkdirSync(OUT, { recursive: true });
const BASE = process.env.TN_URL || 'http://localhost:8765/thistle-notebook/index.html';
const log = [], requests = [];
let webMode = 'ok'; // 'ok' | 'ignored' (proxy drops the tool) | 'refused' (400)
let rejectReasoning = false; // ELM refuses reasoning_effort for a model
// Like the real ELM, error replies carry NO CORS header, so the browser cannot read them
// (fulfilled mocks skip the browser's CORS check, so the refusal is simulated as the failed fetch the browser reports)
const refuse = (r, msg) => { void msg; return r.abort('failed'); };
const ok = (c, m) => { log.push((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };

const MODELS = ['Qwen/Qwen3.5-397B-A17B-FP8', 'mistralai/Mistral-Small-4-119B-2603', 'Snowflake/snowflake-arctic-embed-l-v2.0', 'gpt-4o-mini', 'gpt-5-mini', 'gpt-4o-mini-search-preview', 'whisper-1', 'text-embedding-3-small'];
const embed = t => { const v = new Array(16).fill(0); for (const w of t.toLowerCase().split(/\W+/)) if (w) v[[...w].reduce((s, c) => s + c.charCodeAt(0), 0) % 16] += 1; return v; };
function sse(text) {
  const parts = text.match(/[\s\S]{1,40}/g) || [''];
  return parts.map(p => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`).join('') + 'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":20}}\n\ndata: [DONE]\n\n';
}
function chatReply(body) {
  const sys = body.messages[0].content, last = body.messages[body.messages.length - 1].content;
  if (sys.startsWith('You help a scientist find literature')) return 'Here you go:\n[{"db":"pubmed","query":"\\"RNA, Circular\\"[Mesh] AND stability[tiab]","why":"Checks stability claims"},{"db":"Google Scholar","query":"circRNA half-life exonuclease","why":"Recent measurements"},{"db":"biorxiv","query":"circRNA decay","why":"Preprints"},{"db":"wikipedia","query":"x","why":"dropped"}]';
  if (sys.includes('# NOW')) return 'Interpretation: Thistle Plot reports a one-way ANOVA. DrugA differs from Vehicle; see the post-hoc table. [1]';
  if (/anova/i.test(last)) return 'I will run a one-way ANOVA in Thistle Plot.\n\n```thistle-plot\n' + JSON.stringify({ title: 'Weight by treatment', test: 'anova', dataset: 'mice.csv', layout: 'long', group: 'Treatment', value: 'Weight_g', control: 'Vehicle', options: { 'Post-hoc correction': 'Tukey', 'Bogus option': 'x' }, why: '3 independent groups' }) + '\n```\n';
  if (/comparison table/i.test(last)) return '## Comparison table\n\n| Citation | Research question | Design | Sample size | Key methods | Main findings | Limitations (authors) | Limitations (observed) |\n|---|---|---|---|---|---|---|---|\n| Ma et al., 2025 [1] | Roles of circRNA peptides | Review | N/A | **Synthesis** | Peptides exist [1, 2] | Detection limited | No primary data |\n| Sanger 1976 [3] | Viroid structure | EM, µ-scale | 12 | Electron microscopy | Circular RNA, ±5% | Old methods | Small n |\n\n## Patterns\n\n- Stability recurs [1].';
  if (/Mark THIS submission/.test(last)) return '**Suggested overall mark: 62 / 100**\n\n| criterion | mark |\n|---|---|\n| Understanding | 18/30 [1] |\n\nStrengths: clear [2].';
  return '## Summary\nThe paper reports DrugA increases weight [1, 2]. The rubric has bands [3]. Invalid cite [999].';
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
  if (!process.env.TN_URL) await serveSuite(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  if (CDN) await ctx.route('https://cdnjs.cloudflare.com/**', r => { // optional offline copies of the cdnjs libraries
    const f = path.join(CDN, r.request().url().replace('https://cdnjs.cloudflare.com/ajax/libs/', '').replace(/\//g, '__'));
    fs.existsSync(f) ? r.fulfill({ body: fs.readFileSync(f), contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' } }) : r.continue();
  });
  await ctx.route('https://elm.edina.ac.uk/api/v1/**', async r => {
    const u = new URL(r.request().url()), p = u.pathname.replace('/api/v1', ''), body = r.request().postDataJSON?.() ?? null;
    requests.push({ p, body, auth: r.request().headers().authorization });
    const cors = { 'Access-Control-Allow-Origin': 'http://localhost:8765' };
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 200, headers: { ...cors, 'Access-Control-Allow-Headers': 'authorization, content-type', 'Access-Control-Allow-Methods': 'GET,POST' } });
    if (p === '/models') return r.fulfill({ json: { data: MODELS.map(id => ({ id })) }, headers: cors });
    if (p === '/costs') return r.fulfill({ json: { usage: 1.2345, limit: 50, currency: 'GBP', asOf: '2026-11-18T10:00:00Z' }, headers: cors });
    if (p === '/embeddings') return r.fulfill({ json: { data: body.input.map((t, i) => ({ index: i, embedding: embed(t) })) }, headers: cors });
    if (p === '/chat/completions' && body.web_search_options) {
      if (webMode === 'refused') return refuse(r, 'Unrecognized request argument supplied: web_search_options');
      return r.fulfill({ json: { choices: [{ message: { content: 'Search says Y.', annotations: webMode === 'ok' ? [{ type: 'url_citation', url_citation: { url: 'https://www.ed.ac.uk/news/x', title: 'News' } }] : [] } }] }, headers: cors });
    }
    if (p === '/responses' && webMode === 'refused') return refuse(r, 'Tool type web_search_preview is not supported');
    if (p === '/chat/completions' && rejectReasoning && body.reasoning_effort) return refuse(r, 'reasoning_effort not supported');
    if (p === '/responses' && webMode === 'ignored') return r.fulfill({ json: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'From memory.', annotations: [] }] }] }, headers: cors });
    if (p === '/chat/completions') return body.stream
      ? r.fulfill({ body: sse(chatReply(body)), headers: { ...cors, 'Content-Type': 'text/event-stream' } })
      : r.fulfill({ json: { choices: [{ message: { content: chatReply(body) } }] }, headers: cors });
    if (p === '/responses') return r.fulfill({ json: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'Web says X.', annotations: [{ type: 'url_citation', url: 'https://doi.org/10.1/abc', title: 'A paper' }] }] }] }, headers: cors });
    r.fulfill({ status: 404, json: { error: { message: 'nope' } }, headers: cors });
  });
  await page.addInitScript(() => { sessionStorage.setItem('tn.key', 'elm-test-key'); });
  await page.goto(BASE);
  await page.waitForFunction(() => document.querySelector('#modelSelect option[value="Qwen/Qwen3.5-397B-A17B-FP8"]'));
  ok(await page.$eval('#modelSelect', s => s.value) === 'Qwen/Qwen3.5-397B-A17B-FP8', 'default model is on-campus Qwen');
  ok((await page.textContent('#costBadge')).includes('£1.23'), 'costs shown');
  ok(requests.every(r => r.auth === 'Bearer elm-test-key'), 'Bearer key sent');

  // CSP: any non-ELM connection is blocked by the browser
  const blocked = await page.evaluate(() => fetch('https://example.com/x').then(() => false, () => true));
  ok(blocked, 'CSP blocks connections to other hosts');

  // sources
  await page.setInputFiles('#fileInput', fs.readdirSync(FX).map(f => path.join(FX, f)));
  await page.waitForFunction(() => document.querySelectorAll('.src-item').length === 6 && !document.querySelector('.src-item.busy'), null, { timeout: 30000 });
  const srcs = await page.evaluate(() => window.thistleNotebook.sources.map(s => ({ name: s.name, role: s.role, kind: s.kind, status: s.status, error: s.error, chars: s.chars, emb: s.meta.embModel, tables: !!s.tables })));
  console.log(srcs);
  ok(srcs.every(s => s.status === 'ready'), 'all 6 sources parsed');
  const by = n => srcs.find(s => s.name === n);
  ok(by('mice.csv').role === 'dataset' && by('mice.csv').tables, 'csv → dataset with table');
  ok(by('paired.xlsx').tables && by('paired.xlsx').kind === 'dataset', 'xlsx parsed as table');
  ok(by('rubric.docx').role === 'rubric', 'rubric role guessed');
  ok(by('essay_student1.txt').role === 'submission', 'submission role guessed');
  ok(by('paper.pdf').chars > 50, 'pdf text extracted');
  ok(by('talk.pptx').chars > 10, 'pptx text extracted');
  ok(by('paper.pdf').emb === 'Snowflake/snowflake-arctic-embed-l-v2.0', 'on-campus embedding model used');
  const pptText = await page.evaluate(() => window.thistleNotebook.sources.find(s => s.name === 'talk.pptx').segments[0].text);
  ok(pptText.includes('Speaker notes'), 'pptx speaker notes read');
  const xlsxSheets = await page.evaluate(() => Object.keys(window.thistleNotebook.sources.find(s => s.name === 'paired.xlsx').tables));
  ok(xlsxSheets.includes('Paired'), 'xlsx sheet names read');

  // chat with citations + web search
  await page.check('#webToggle');
  await page.fill('#prompt', 'Summarise the sources');
  await page.click('#btnSend');
  await page.waitForSelector('.msg.assistant .cite', { timeout: 15000 });
  const chatReq = requests.filter(r => r.p === '/chat/completions').pop();
  ok(chatReq.body.messages[0].content.includes('SOURCE: "paper.pdf"'), 'source text sent in system prompt (full mode)');
  ok(chatReq.body.messages[0].content.includes('[W1] A paper'), 'web findings included');
  ok(chatReq.body.reasoning_effort === undefined, 'no reasoning param by default');
  ok(await page.$('.cite.missing') !== null, 'invalid citation flagged');
  await page.click('.msg.assistant .cite:not(.missing)');
  ok(await page.isVisible('#popover'), 'citation popover opens');
  await page.screenshot({ path: path.join(OUT, '1-chat.png') });
  await page.click('#popover button');
  await page.waitForSelector('.src-view');
  await page.keyboard.press('Escape');
  await page.uncheck('#webToggle');

  // web search that ELM silently ignores → visible warning in the answer, option switched off
  webMode = 'ignored';
  await page.check('#webToggle');
  await page.fill('#prompt', 'Any recent papers?'); await page.click('#btnSend');
  await page.waitForFunction(() => document.querySelectorAll('.msg.assistant').length === 2 && !window.thistleNotebook.busy);
  const lastWarn = await page.$eval('.msg.assistant:last-child .warn-box', e => e.textContent).catch(() => '');
  ok(lastWarn.includes('Web search did not run') && lastWarn.includes('no web search took place'), 'ignored search tool → warning in the answer (not fake results)');
  ok(await page.$eval('#webToggle', t => t.disabled && !t.checked), 'web search option switched off after ELM refused every route');
  // ⚙ Settings → Test web search: per-route diagnosis
  webMode = 'refused';
  await page.click('#btnSettings'); await page.click('#modalBody button:has-text("Test web search")');
  await page.waitForSelector('#modalBody table.diag');
  const diag = await page.$$eval('#modalBody table.diag tr', trs => trs.map(t => t.textContent));
  ok(diag.length === 4 && diag.slice(1).every(t => t.includes('ELM refused this request')), 'refused routes reported as refused, not "could not reach ELM"');
  const cmd = await page.textContent('#modalBody pre.cmd');
  ok(cmd.startsWith("printf 'ELM key: '; read -rs ELM_API_KEY; echo") && !cmd.includes('elm-test-key'), 'Terminal command works in zsh and bash; key not embedded');
  await page.screenshot({ path: path.join(OUT, '1b-websearch-test.png') });
  webMode = 'ok';
  await page.click('#modalBody button:has-text("Test web search")');
  await page.waitForFunction(() => document.querySelector('#modalBody .hint-box b')?.textContent.includes('works'));
  ok(await page.$eval('#webToggle', t => !t.disabled), 'web search option back on after a successful test');
  await page.keyboard.press('Escape');

  // asking for a web search in words without the 🌐 box → note in the answer, and the model is told
  await page.uncheck('#webToggle');
  const nBefore = await page.$$eval('.msg.assistant', e => e.length);
  await page.fill('#prompt', 'Do web search to see if the above information is still up-to-date'); await page.click('#btnSend');
  await page.waitForFunction(n => document.querySelectorAll('.msg.assistant').length === n + 1 && !window.thistleNotebook.busy, nBefore);
  const webNote = await page.$eval('.msg.assistant:last-child .warn-box', e => e.textContent).catch(() => '');
  ok(webNote.includes('No web search for this answer') && webNote.includes('box was not ticked'), 'web request in words → note explains why no search ran');
  ok(requests.filter(r => r.p === '/chat/completions').pop().body.messages[0].content.includes('Web search is NOT available'), 'model told that web search is not available');

  // 🔎 Suggest searches: ELM writes queries, the app only builds links (no request to the search sites)
  const outside = []; page.on('request', rq => { const u = new URL(rq.url()); if (!/^(localhost|elm\.edina\.ac\.uk|cdnjs\.cloudflare\.com)$/.test(u.hostname) && u.protocol.startsWith('http')) outside.push(u.hostname); });
  await page.click('.msg.assistant:last-child .warn-box button:has-text("Suggest searches")');
  await page.waitForSelector('.msg.searches .search-list li');
  const sug = await page.$$eval('.msg.searches .search-list li', lis => lis.map(li => ({ text: li.textContent, links: [...li.querySelectorAll('a')].map(a => ({ href: a.href, target: a.target, rel: a.rel })) })));
  ok(sug.length === 3 && sug[0].text.startsWith('PubMed') && sug[1].text.startsWith('Google Scholar') && sug[2].text.startsWith('bioRxiv'), 'suggested searches listed per database (unknown database dropped)');
  const pm = sug[0].links[0].href, pmSince = sug[0].links[1].href, yr = new Date().getFullYear();
  ok(pm.startsWith('https://pubmed.ncbi.nlm.nih.gov/?term=') && decodeURIComponent(pm.split('term=')[1].replace(/\+/g, ' ')) === '"RNA, Circular"[Mesh] AND stability[tiab]', 'PubMed link carries the exact query');
  ok(pmSince.includes(`filter=years.${yr - 3}-${yr}`) && sug[1].links[1].href.includes(`as_ylo=${yr - 3}`), '"since" links filter to the last 3 years');
  ok(sug.flatMap(x => x.links).every(l => l.target === '_blank' && l.rel.includes('noreferrer')), 'links open in a new tab without referrer');
  await page.screenshot({ path: path.join(OUT, '1c-searches.png') });
  ok(!outside.length, 'no request to any search site (only links)' + (outside.length ? ': ' + outside.join(',') : ''));
  ok(!requests.filter(r => r.p === '/chat/completions').pop().body.messages.some(x => x.content.includes('SOURCES')), 'search request sends the question and answer excerpt, not the sources');
  ok(!(await page.evaluate(() => window.thistleNotebook.messages.filter(m => m.role === 'searches').length === 0)), 'suggestions saved in the notebook');

  // ELM refuses an optional parameter (reason hidden) → retried once without optional parameters
  rejectReasoning = true;
  await page.selectOption('#reasonSelect', 'high');
  await page.fill('#prompt', 'Summarise again'); await page.click('#btnSend');
  await page.waitForFunction(n => document.querySelectorAll('.msg.assistant').length === n + 2 && !window.thistleNotebook.busy, nBefore);
  const lastTwo = requests.filter(r => r.p === '/chat/completions').slice(-2).map(r => r.body);
  ok(lastTwo[0].reasoning_effort === 'high' && !('reasoning_effort' in lastTwo[1]) && !('_stripped' in lastTwo[1]), 'hidden refusal → retried without optional parameters');
  ok(!(await page.$eval('.msg.assistant:last-child', e => e.querySelector('.err-box')?.textContent || '')), 'retried answer arrives without an error');
  rejectReasoning = false; await page.selectOption('#reasonSelect', 'default');

  // ANOVA → Thistle Plot (auto-run) → results → interpretation
  await page.fill('#prompt', 'Run an ANOVA on body weight');
  await page.click('#btnSend');
  await page.waitForFunction(() => [...document.querySelectorAll('.msg.assistant')].some(m => m.textContent.includes('Interpretation:')), null, { timeout: 60000 });
  const card = await page.evaluate(() => { const c = document.querySelector('.tp-card'); return { status: c.querySelector('.status')?.textContent, result: c.querySelector('.tp-result')?.textContent.slice(0, 400), img: !!c.querySelector('.tp-result img'), warn: c.querySelector('.warn-box')?.textContent }; });
  console.log(card);
  ok(card.status === 'run in Thistle Plot', 'analysis ran in Thistle Plot');
  ok(await page.$('.tp-card .table-tools') === null, 'Thistle Plot result tables get no Markdown table buttons');
  ok(/ANOVA/i.test(card.result || ''), 'TP ANOVA result shown in card');
  ok(card.img, 'TP auto-plot captured');
  ok((card.warn || '').includes('Bogus option'), 'unknown option reported');
  const resMsg = await page.evaluate(() => window.thistleNotebook.messages.find(m => m.role === 'results')?.content || '');
  ok(/Post-hoc|Tukey/i.test(resMsg) && /F|p/.test(resMsg), 'results text sent back to the model');
  const G = await page.evaluate(() => window.thistleNotebook.messages.find(m => m.meta?.tp)?.meta.tp[0].G);
  ok(G && G.groups[0].name === 'Vehicle' && G.groups.length === 3 && G.groups.every(g => g.data.filter(r => r[0] !== '').length === 8), 'G built deterministically (control first, n=8 each)');
  const csvVals = fs.readFileSync(path.join(FX, 'mice.csv'), 'utf8').trim().split('\n').slice(1).filter(l => l.includes('Vehicle')).map(l => +l.split(',')[3]);
  ok(JSON.stringify(G.groups[0].data.map(r => r[0])) === JSON.stringify(csvVals), 'TP table values identical to the CSV');
  await page.screenshot({ path: path.join(OUT, '2-anova.png') });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.tp-card button:has-text(".tplot")')]);
  const tplot = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
  ok(tplot.app === 'Thistle Plot' && tplot.format === 2 && tplot.G.groups.length === 3 && tplot.statTabs.length === 1, '.tplot file has suite header, table and result');
  fs.writeFileSync(path.join(OUT, 'anova.tplot'), JSON.stringify(tplot));

  // Studio: per-submission marking → note
  await page.click('#studio button:has-text("Mark each submission")');
  await page.waitForSelector('#modal:not([hidden]) .md table', { timeout: 20000 });
  const note = await page.textContent('#modalBody');
  ok(note.includes('62 / 100') && note.includes('essay_student1.txt'), 'marking note with summary table');
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#modalBody button:has-text("Word")')]);
  const docxPath = path.join(OUT, 'note.docx'); fs.copyFileSync(await dl2.path(), docxPath);
  await page.screenshot({ path: path.join(OUT, '3-note.png') });
  await page.keyboard.press('Escape');

  // Literature comparison table → Excel / CSV / Word (landscape)
  await page.click('#studio button:has-text("Literature comparison table")');
  await page.waitForSelector('#modal:not([hidden]) .table-tools', { timeout: 20000 });
  const [x1] = await Promise.all([page.waitForEvent('download'), page.click('#modalBody .tp-btns button:has-text("Excel")')]);
  const xlsxPath = path.join(OUT, 'lit.xlsx'); fs.copyFileSync(await x1.path(), xlsxPath);
  const { unzip } = await import(path.join(__dirname, '..', 'js', 'zip.js'));
  const xz = await unzip(fs.readFileSync(xlsxPath));
  const wb = await xz.text('xl/workbook.xml'), sh1 = await xz.text('xl/worksheets/sheet1.xml'), sh2 = await xz.text('xl/worksheets/sheet2.xml');
  ok(/name="Comparison table"/.test(wb) && /name="Sources cited"/.test(wb), 'xlsx: table sheet named from heading + Sources sheet');
  ok(sh1.includes('Limitations (observed)') && sh1.includes('Ma et al., 2025 [1]') && sh1.includes('Synthesis') && !sh1.includes('**'), 'xlsx: header + cells, Markdown stripped');
  ok(/<c r="D3" s="2"><v>12<\/v><\/c>/.test(sh1), 'xlsx: numeric cell stored as a number');
  ok(sh1.includes('µ-scale') && sh1.includes('±5%'), 'xlsx: special characters kept');
  ok(sh2.includes('paper.pdf') || sh2.includes('[1]'), 'xlsx: cited sources listed');
  const [c1] = await Promise.all([page.waitForEvent('download'), page.click('#modalBody .table-tools button:has-text("CSV")')]);
  const csv = fs.readFileSync(await c1.path(), 'utf8');
  ok(csv.startsWith('\uFEFFCitation,Research question') && csv.includes('"Peptides exist [1, 2]"'), 'CSV: BOM, header, quoted commas');
  const [w1] = await Promise.all([page.waitForEvent('download'), page.click('#modalBody .tp-btns button:has-text("Word")')]);
  const dz = await unzip(fs.readFileSync(await w1.path())), dx = await dz.text('word/document.xml');
  ok(dx.includes('<w:tblGrid>') && (dx.match(/<w:gridCol /g) || []).length === 8, 'docx: table has tblGrid with 8 columns');
  ok(dx.includes('w:orient="landscape"'), 'docx: wide table → landscape pages');
  fs.copyFileSync(await w1.path(), path.join(OUT, 'lit.docx'));
  await page.click('#modalBody .export-btn');
  const menu = await page.$$eval('#popover .menu-item span', els => els.map(e => e.textContent));
  ok(menu.some(t => t.startsWith('📊 Excel')) && menu.some(t => t.startsWith('🧾 CSV')) && menu.some(t => t.includes('HTML')) && menu.some(t => t.includes('PDF')), 'export menu lists Word/Excel/CSV/Markdown/HTML/PDF');
  const [h1] = await Promise.all([page.waitForEvent('download'), page.click('#popover .menu-item:has-text("HTML page")')]);
  const html = fs.readFileSync(await h1.path(), 'utf8');
  ok(html.includes('<table>') && html.includes('Sources cited') && !html.includes('<script'), 'HTML export: tables + sources, no scripts');
  await page.screenshot({ path: path.join(OUT, '3b-lit.png') });
  await page.keyboard.press('Escape');
  // chat answers have the same export menu
  await page.click('.msg.assistant .export-btn');
  ok(await page.isVisible('#popover .menu-item'), 'chat answer has export menu');
  await page.keyboard.press('Escape'); await page.mouse.click(5, 300);

  // save .tnote and reopen
  const [dl3] = await Promise.all([page.waitForEvent('download'), page.click('#btnSave')]);
  const tn = path.join(OUT, 'nb.tnote'); fs.copyFileSync(await dl3.path(), tn);
  const tnj = JSON.parse(fs.readFileSync(tn, 'utf8'));
  ok(tnj.app === 'Thistle Notebook' && tnj.format === 1 && tnj.kind === 'notebook' && tnj.sources.length === 6, '.tnote header + content');
  await page.setInputFiles('#openInput', tn);
  await page.waitForFunction(() => document.querySelectorAll('#nbSelect option').length === 2);
  ok(await page.evaluate(() => window.thistleNotebook.sources.length === 6 && window.thistleNotebook.messages.length > 3), '.tnote reopened as a new notebook');
  // TP project rejected politely
  await page.setInputFiles('#openInput', path.join(OUT, 'anova.tplot'));
  await page.waitForTimeout(300);
  ok((await page.textContent('#toast')).includes('Thistle Plot project'), '.tplot opened as notebook gives a plain message');

  // on-campus only
  await page.evaluate(async () => { const S = window.thistleNotebook; S.nb.onCampusOnly = true; });
  await page.click('#btnNbSettings'); await page.click('#modalBody button:has-text("Save")');
  await page.waitForTimeout(200);
  ok(await page.$eval('#modelSelect option[value="gpt-4o-mini"]', o => o.disabled), 'OpenAI models disabled in on-campus notebook');
  ok(await page.$eval('#webToggle', o => o.disabled), 'web search disabled in on-campus notebook');

  // Help links to the ELM policies (open in a new tab, no referrer)
  await page.click('#btnHelp');
  const links = await page.$$eval('#modalBody a', as => as.map(a => ({ href: a.href, target: a.target, rel: a.rel })));
  ok(links.filter(l => /information-services\.ed\.ac\.uk|data-protection\.ed\.ac\.uk|edwebcontent\.ed\.ac\.uk/.test(l.href)).length >= 12, 'help links to ELM policies and guidance');
  ok(links.some(l => l.href.includes('operational-data-policy.pdf')) && links.every(l => l.target === '_blank' && l.rel.includes('noopener')), 'policy links open safely in a new tab');
  await page.keyboard.press('Escape');

  // light theme screenshot + TP drawer
  await page.click('#btnTheme');
  await page.click('#btnThistle'); await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, '4-drawer.png') });
  await page.click('#btnCloseDrawer');
  await page.screenshot({ path: path.join(OUT, '5-light.png') });

  const realErr = errors.filter(e => !/example\.com|Content Security Policy|Failed to fetch|status of 400|CORS|Access-Control|ERR_FAILED/.test(e)); // deliberate refusals in the mock (no CORS header, like ELM)
  ok(!realErr.length, 'no page errors' + (realErr.length ? ': ' + realErr.join(' | ') : ''));
  console.log(log.join('\n'));
  await browser.close();
})().catch(e => { console.error(e); console.log(log.join('\n')); process.exit(1); });
