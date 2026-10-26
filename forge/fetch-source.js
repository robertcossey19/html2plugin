#!/usr/bin/env node
// Resolve an inbox/<slug>.url file (one URL per line, first wins) to inbox/<slug>.html. Handles classic CodePen pens via cdpn.io.
const fs = require('fs');
async function fetchHtml(url) {
  const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
  let m = url.match(/codepen\.io\/([^\/]+)\/(?:pen|full|details|debug)\/([A-Za-z0-9]+)/);
  if (m) {
    if (m[2].length > 12) throw new Error('CodePen 2.0 (UUID) pens cannot be fetched without a browser session; paste the HTML instead');
    for (const u of [`https://cdpn.io/${m[1]}/fullpage/${m[2]}`, `https://cdpn.io/pen/debug/${m[2]}`]) {
      const r = await fetch(u, { headers: { 'User-Agent': ua, Referer: 'https://codepen.io/' } }); if (r.ok) { const t = await r.text(); if (/<html/i.test(t)) return t; }
    }
    throw new Error('could not fetch the pen from cdpn.io (private pen?)');
  }
  const r = await fetch(url, { headers: { 'User-Agent': ua } }); if (!r.ok) throw new Error(`${url} -> ${r.status}`); return await r.text();
}
if (require.main === module) {
  (async () => { const f = process.argv[2]; const url = fs.readFileSync(f, 'utf8').split(/\r?\n/).map(s => s.trim()).find(Boolean); const html = await fetchHtml(url); const out = f.replace(/\.url$/, '.html'); fs.writeFileSync(out, html); console.log(`fetched ${url} -> ${out} (${html.length} bytes)`); })().catch(e => { console.error(e.message); process.exit(1); });
}
module.exports = { fetchHtml };
