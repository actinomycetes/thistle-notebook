// Syntax-check every browser module as an ES module (plain `node --check file.js` parses .js as CommonJS and misses errors).
const { execFileSync } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const dir = path.join(__dirname, '..', 'js'), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-syntax-'));
let bad = 0;
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
  const m = path.join(tmp, f.replace(/\.js$/, '.mjs')); fs.copyFileSync(path.join(dir, f), m);
  try { execFileSync(process.execPath, ['--check', m], { stdio: 'pipe' }); }
  catch (e) { bad++; console.log(`FAIL js/${f}: ${String(e.stderr).split('\n').filter(l => /SyntaxError|\.mjs:\d+/.test(l)).join(' ')}`); }
}
fs.rmSync(tmp, { recursive: true });
// the favicon needs the title to be set from script (Orion 1.1); keep this line in js/app.js
if (!/document\.title = `Thistle Notebook v\$\{APP_VERSION\} \(Beta\)`/.test(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'))) { bad++; console.log('FAIL js/app.js no longer sets document.title (the favicon needs it in Orion)'); }
console.log(bad ? `${bad} module(s) with syntax errors` : 'PASS all modules parse as ES modules');
process.exit(bad ? 1 : 0);
