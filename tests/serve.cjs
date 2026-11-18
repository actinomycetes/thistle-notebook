// Serves the parent folder (thistle-notebook/, thistle-plot/, thistle-flow/ side by side) at http://localhost:8765
// through Playwright request interception, so the tests need no web server.
const fs = require('fs'), path = require('path');
const ROOT = process.env.SUITE_DIR || path.resolve(__dirname, '..', '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
module.exports = async function serveSuite(ctx) {
  await ctx.route('http://localhost:8765/**', r => {
    let p = decodeURIComponent(new URL(r.request().url()).pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(ROOT, path.normalize(p));
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return r.fulfill({ status: 404, body: 'not found' });
    r.fulfill({ body: fs.readFileSync(f), contentType: TYPES[path.extname(f)] || 'application/octet-stream' });
  });
};
