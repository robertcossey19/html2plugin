#!/usr/bin/env node
/* html2plugin forge: paste-in HTML (Web Audio / AudioWorklet plugin page)  ->  buildable JUCE 8 VST3 + AU project.
 * Usage: node forge/index.js <input.html> --out <dir> [--name "Plugin Name"] [--vendor "Vendor"] [--slug my-plugin] [--sr 48000]
 * The page runs untouched. We only (1) capture its worklet module(s) and boot-time Web Audio graph, (2) learn its controls empirically,
 * (3) emit a manifest the generic native runtime consumes. No DSP is rewritten. */
const fs = require('fs'); const path = require('path');
const acorn = require('acorn'); const crypto = require('crypto');
const { bootPage, flattenParams } = require('./boot.js');
const { extractWorkletModulesStatic } = require('./extract.js');

function arg(name, def) { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : def; }
const slugify = s => (s || 'plugin').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'plugin';
/* Pages pasted from a wrongly decoded file arrive as mojibake ("â€”" for "—"). Undo UTF-8-read-as-cp1252 when, and only when, it removes those sequences. */
const CP1252 = { '\u20AC': 0x80, '\u201A': 0x82, '\u0192': 0x83, '\u201E': 0x84, '\u2026': 0x85, '\u2020': 0x86, '\u2021': 0x87, '\u02C6': 0x88, '\u2030': 0x89, '\u0160': 0x8A, '\u2039': 0x8B, '\u0152': 0x8C, '\u017D': 0x8E, '\u2018': 0x91, '\u2019': 0x92, '\u201C': 0x93, '\u201D': 0x94, '\u2022': 0x95, '\u2013': 0x96, '\u2014': 0x97, '\u02DC': 0x98, '\u2122': 0x99, '\u0161': 0x9A, '\u203A': 0x9B, '\u0153': 0x9C, '\u017E': 0x9E, '\u0178': 0x9F };
function repairMojibake(text, log) {
  const rx = /[\u00C2\u00C3][\u0080-\u00BF\u20AC\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u017E\u0178]|\u00E2[\u0080-\u00BF\u20AC\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u017E\u0178]/g;
  const before = (text.match(rx) || []).length; if (!before) return text;
  const bytes = []; for (const ch of text) { const c = ch.codePointAt(0); if (c < 0x100) bytes.push(c); else if (CP1252[ch] != null) bytes.push(CP1252[ch]); else { const b = Buffer.from(ch, 'utf8'); for (const x of b) bytes.push(x); } }
  const fixed = Buffer.from(bytes).toString('utf8');
  const after = (fixed.match(rx) || []).length, bad = (fixed.match(/\uFFFD/g) || []).length - (text.match(/\uFFFD/g) || []).length;
  if (after < before && bad <= 0) { log.push(`repaired mojibake (${before} sequences, e.g. "\u00E2\u20AC\u201D" -> "\u2014")`); return fixed; }
  return text;
}
/* Product names reach Xcode build scripts, bundle paths and AU/VST3 metadata: keep them printable ASCII, no commas, no quotes, 48 chars. */
function safeProductName(t) {
  const ascii = String(t || '').normalize('NFKD').replace(/[\u2014\u2013\u2012\u2010\u2011]/g, '-').replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '').replace(/[^\x20-\x7E]/g, '').replace(/[,"\\/:*?<>|;$`]/g, ' ').replace(/\s+/g, ' ').trim();
  return ascii.replace(/^[\s.-]+|[\s.-]+$/g, '').slice(0, 48).trim() || 'HTML Plugin';
}
function titleHead(t) { // "Fairchild Model 670 — Feedback Topology, Diode-Coupled" -> "Fairchild Model 670"; hyphens inside words survive ("Fuzz-Box")
  return String(t || '').split(/\s+[\u2014\u2013|]\s+|[\u2014\u2013|]|\s+-\s+/)[0].trim();
}
const humanize = k => k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/\bdb\b/i, 'dB').replace(/^./, c => c.toUpperCase());
function codes(slug) {
  const h = crypto.createHash('sha1').update(slug).digest(); const L = 'abcdefghijklmnopqrstuvwxyz', U = L.toUpperCase();
  return { manufacturerCode: 'H' + L[h[0] % 26] + L[h[1] % 26] + L[h[2] % 26], pluginCode: U[h[3] % 26] + L[h[4] % 26] + L[h[5] % 26] + L[h[6] % 26] };  // at least one upper-case char each (AU/JUCE rule)
}
async function inlineExternalAssets(html, log) {
  const fetchText = async (url) => { try { const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }); if (!r.ok) throw new Error(r.status); return await r.text(); } catch (e) { log.push(`could not inline ${url}: ${e.message} (left as remote reference; needs network at runtime)`); return null; } };
  const scripts = [...html.matchAll(/<script\b([^>]*?)\bsrc=["'](https?:\/\/[^"']+)["']([^>]*)>\s*<\/script>/gi)];
  for (const m of scripts) { const t = await fetchText(m[2]); if (t != null) { const rep = `<script data-inlined-from="${m[2]}">\n${t.replace(/<\/script/gi, '<\\/script')}\n</script>`; html = html.replace(m[0], () => rep); /* function replacer: asset text may contain $' / $& patterns (Tailwind does) */ log.push(`inlined script ${m[2]} (${t.length} bytes)`); } }
  const links = [...html.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>/gi), ...html.matchAll(/<link\b[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*rel=["']stylesheet["'][^>]*>/gi)];
  for (const m of links) { const t = await fetchText(m[1]); if (t != null) { const rep = `<style data-inlined-from="${m[1]}">\n${t.replace(/<\/style/gi, '<\\/style')}\n</style>`; html = html.replace(m[0], () => rep); log.push(`inlined stylesheet ${m[1]} (${t.length} bytes)`); } }
  return html;
}

function stripHostingScripts(html, log) {
  // CodePen / JSFiddle / Glitch preview helpers are not part of the plugin
  const rx = /<script\b[^>]*\bsrc=["']https?:\/\/(?:public\.codepenassets\.com|cpwebassets\.codepen\.io|static\.codepen\.io|assets\.codepen\.io\/assets\/editor|jsfiddle\.net\/js|cdn\.glitch\.(?:com|global)\/pen)[^"']*["'][^>]*>\s*<\/script>/gi;
  return html.replace(rx, m => { log.push('removed hosting helper script: ' + (m.match(/src=["']([^"']+)/) || [])[1]); return ''; });
}

async function forge(inputHtml, options = {}) {
  const log = []; const warnings = [];
  inputHtml = repairMojibake(stripHostingScripts(inputHtml, log), log);
  const sampleRate = +(options.sampleRate || 48000);
  // 1. boot the page headlessly against the shim
  const boot = await bootPage(inputHtml, { sampleRate });
  const title = safeProductName(options.name || titleHead(boot.title) || 'HTML Plugin'); if (title !== (options.name || boot.title)) log.push(`product name: "${title}" (from <title> "${boot.title}")`);
  const slug = slugify(options.slug || title);
  // 2. worklet modules: from Blob URLs seen at boot, else static extraction from the script text
  let modules = Object.values(boot.modules);
  if (!modules.length) { const st = extractWorkletModulesStatic(inputHtml); modules = st.modules; log.push(...st.log); if (!modules.length) throw new Error('No AudioWorklet module found. The page must call audioWorklet.addModule() with an inline (Blob/template-literal/<script type=worklet>) module; external .js module files must be pasted inline.'); }
  if (boot.unresolvedModules.length) warnings.push(`addModule() called with URLs whose code is not inline: ${boot.unresolvedModules.join(', ')}. Paste the module inline.`);
  // 3. validate modules in the engine: processor names, descriptors, and a smoke render
  const { Context, registry } = require('../engine/webaudio-engine.js');
  for (const k of Object.keys(registry)) delete registry[k];
  const eng = new Context(sampleRate); for (const m of modules) eng.addModule(m);
  const processors = {}; for (const name in registry) { const P = registry[name]; let desc = []; try { desc = (P.parameterDescriptors || []).map(d => ({ name: d.name, defaultValue: d.defaultValue == null ? 0 : d.defaultValue, minValue: d.minValue, maxValue: d.maxValue, automationRate: d.automationRate || 'a-rate' })); } catch (e) { } processors[name] = desc; }
  if (!Object.keys(processors).length) throw new Error('Module loaded but registerProcessor() was never called.');
  const ownIds = new Set(); let unsupported = [];
  for (const op of boot.bootOps) if (op.op === 'create' && op.type === 'AudioWorklet' && !processors[op.name]) unsupported.push(`AudioWorkletNode "${op.name}" has no registered processor`);
  eng.applyJSON(JSON.stringify(boot.bootOps)); eng.setHostParamNames([]);
  const n = sampleRate; const inL = new Float32Array(n), inR = new Float32Array(n), oL = new Float32Array(n), oR = new Float32Array(n);
  for (let i = 0; i < n; i++) inL[i] = inR[i] = 0.1 * Math.sin(2 * Math.PI * 1000 * i / sampleRate);
  const t0 = Date.now(); eng.render(inL, inR, oL, oR, n); const renderMs = Date.now() - t0;
  let rms = 0; for (let i = n - 8192; i < n; i++) rms += oL[i] * oL[i]; rms = Math.sqrt(rms / 8192);
  const outDb = 20 * Math.log10(rms + 1e-30);
  if (eng.errors.length) warnings.push('engine errors during smoke render: ' + eng.errors.slice(0, 3).join(' | '));
  if (!isFinite(outDb) || rms === 0) warnings.push('smoke render produced silence for a -20 dBFS 1 kHz tone (check that the page routes input -> worklet -> destination without a user action we could not detect)');
  const msgs = eng.drainOutbox();
  const smoke = { inputDbfs: -20, outputDbfs: +outDb.toFixed(2), realtimeFactor: +(renderMs / 1000).toFixed(3), messagesFromWorklet: msgs.length, messageTypes: [...new Set(msgs.map(m => m.data && m.data.type).filter(Boolean))] };
  // 4. parameter table: descriptors ∪ keys of boot messages; types from bindings
  const names = new Set(); for (const d of Object.values(processors)) for (const p of d) names.add(p.name); for (const k of Object.keys(boot.bootParams)) names.add(k);
  const params = [];
  for (const id of names) {
    const desc = Object.values(processors).flat().find(d => d.name === id); const b = boot.bindings[id] || null; const bootV = boot.bootParams[id];
    let p = { id, name: humanize(id), type: 'float', min: desc ? desc.minValue : undefined, max: desc ? desc.maxValue : undefined, default: bootV != null ? bootV : (desc ? desc.defaultValue : 0), source: desc ? (bootV != null ? 'descriptor+message' : 'descriptor') : 'message', binding: b };
    if (b && (b.kind === 'choice' || b.kind === 'select')) { p.type = 'choice'; p.choices = b.options.map(o => ({ label: o.label, value: o.param !== undefined ? o.param : o.value })); }
    else if (b && (b.kind === 'click-toggle' || b.kind === 'checkbox')) { const vals = b.kind === 'checkbox' ? [b.offValue, b.onValue] : b.values.slice().sort((x, y) => x - y); if (vals.length === 2 && vals[0] === 0 && vals[1] === 1) p.type = 'bool'; else { p.type = 'choice'; p.choices = vals.map(v => ({ label: String(v), value: v })); } }
    else { if (b && b.min != null && (p.min == null || !isFinite(p.min))) p.min = b.min; if (b && b.max != null && (p.max == null || !isFinite(p.max))) p.max = b.max; if (b && b.kind === 'range') { p.step = b.step || 0; } }
    if (p.type === 'float' && (p.min == null || !isFinite(p.min) || p.max == null || !isFinite(p.max))) {
      // unbound channel twin (A/B, 1/2, L/R, left/right): borrow the range of the bound sibling instead of guessing
      const twins = [[/A$/, 'B'], [/B$/, 'A'], [/1$/, '2'], [/2$/, '1'], [/L$/, 'R'], [/R$/, 'L'], [/Left$/i, 'Right'], [/Right$/i, 'Left']];
      for (const [rx, rep] of twins) { if (!rx.test(id)) continue; const sib = id.replace(rx, rep); const sb = boot.bindings[sib]; if (sb && sb.min != null && sb.max != null && isFinite(sb.min) && isFinite(sb.max)) { p.min = sb.min; p.max = sb.max; p.rangeFrom = sib; log.push(`param ${id}: range [${sb.min}, ${sb.max}] mirrored from ${sib}`); break; } }
    }
    if (p.type === 'float') { if (p.min == null || !isFinite(p.min)) { p.min = Math.min(0, p.default); warnings.push(`param ${id}: no range known, guessed [${p.min}, ...]`); } if (p.max == null || !isFinite(p.max)) { p.max = Math.max(1, p.default); } if (desc && desc.minValue === 0 && desc.maxValue === 1 && !b && (bootV === 0 || bootV === 1)) { p.type = 'bool'; } }
    if (p.type === 'choice' && !p.choices.some(c => c.value === p.default)) p.choices.push({ label: String(p.default), value: p.default });
    params.push(p);
  }
  const bound = params.filter(p => p.binding).length;
  const manifest = {
    name: title, slug, vendor: options.vendor || 'html2plugin', version: options.version || '1.0.0', bundleId: `com.html2plugin.${slug.replace(/-/g, '')}`, ...codes(slug),
    ui: { width: Math.min(Math.max(boot.uiSize.width, 700), 1600), height: Math.min(Math.max(boot.uiSize.height, 500), 1100), startSelector: boot.startControl ? boot.startControl.selector : null },
    captureSampleRate: sampleRate, processors, params, bootOps: boot.bootOps, bindings: boot.bindings,
    report: { boundParams: bound, totalParams: params.length, unboundParams: params.filter(p => !p.binding).map(p => p.id), startControl: boot.startControl, smoke, pageErrors: boot.errors.slice(0, 10), pageConsole: boot.consoleLog.slice(0, 10), warnings, unsupported, log },
  };
  // 5. shipped page: original HTML with remote assets inlined (so the plugin works offline)
  const shippedHtml = await inlineExternalAssets(inputHtml, log);
  // 6. guard: every inline script in the shipped page must parse, and the shipped page must boot to the same graph as the original
  {
    const rx = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi; let m, idx = 0;
    while ((m = rx.exec(shippedHtml))) { idx++; if (!m[2].trim() || /\bsrc=/.test(m[1])) continue; const type = (m[1].match(/type=["']([^"']+)/) || [])[1]; if (type && !/javascript|module/.test(type)) continue;
      try { acorn.parse(m[2], { ecmaVersion: 'latest', sourceType: /module/.test(type || '') ? 'module' : 'script', allowAwaitOutsideFunction: true }); }
      catch (e) { throw new Error(`shipped page: inline script #${idx} does not parse (${e.message}) — asset inlining corrupted the page`); } }
    const sig = ops => ops.filter(o => o.op !== 'log' && o.op !== 'post' && o.op !== 'param').map(o => o.op + ':' + (o.type || o.name || '') + (o.from != null ? ':' + o.from + '>' + o.to : '')).join(' ');
    const reboot = await bootPage(shippedHtml, { sampleRate, offline: true });
    const a = sig(boot.bootOps), b = sig(reboot.bootOps);
    if (a !== b) throw new Error(`shipped page boots to a different graph than the original.\n  original: ${a}\n  shipped:  ${b}\n  page errors: ${JSON.stringify(reboot.errors.slice(0, 5))}`);
    log.push(`shipped page re-booted headless: same graph (${reboot.bootOps.length} ops)`);
  }
  return { manifest, modules, shippedHtml };
}

function writeProject(outDir, result) {
  const { manifest, modules, shippedHtml } = result; const root = path.join(__dirname, '..');
  const cp = (src, dst) => { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); };
  const cpDir = (s, d) => { for (const f of fs.readdirSync(s)) { const sp = path.join(s, f), dp = path.join(d, f); if (fs.statSync(sp).isDirectory()) cpDir(sp, dp); else cp(sp, dp); } };
  fs.mkdirSync(path.join(outDir, 'Assets'), { recursive: true });
  cpDir(path.join(root, 'runtime', 'native'), outDir);  // CMakeLists.txt, Source/, HostTest/
  fs.writeFileSync(path.join(outDir, 'Assets', 'index.html'), shippedHtml);
  fs.writeFileSync(path.join(outDir, 'Assets', 'engine.js'), fs.readFileSync(path.join(root, 'engine', 'webaudio-engine.js')));
  fs.writeFileSync(path.join(outDir, 'Assets', 'shim.js'), fs.readFileSync(path.join(root, 'runtime', 'webaudio-shim.js')) + '\n' + fs.readFileSync(path.join(root, 'runtime', 'ui-bridge.js')));
  fs.writeFileSync(path.join(outDir, 'Assets', 'worklets.js'), modules.join('\n;\n'));
  const slim = Object.assign({}, manifest); fs.writeFileSync(path.join(outDir, 'Assets', 'manifest.json'), JSON.stringify(slim));
  fs.writeFileSync(path.join(outDir, 'plugin.cmake'), [`set(H2P_NAME "${manifest.name.replace(/"/g, '')}")`, `set(H2P_SLUG "${manifest.slug}")`, `set(H2P_VENDOR "${manifest.vendor.replace(/"/g, '')}")`, `set(H2P_BUNDLE_ID "${manifest.bundleId}")`, `set(H2P_MANU_CODE "${manifest.manufacturerCode}")`, `set(H2P_PLUGIN_CODE "${manifest.pluginCode}")`, `set(H2P_VERSION "${manifest.version}")`, ''].join('\n'));
  fs.writeFileSync(path.join(outDir, 'REPORT.md'), report(manifest));
  return outDir;
}

function report(m) {
  const r = m.report; const lines = [`# ${m.name} — conversion report`, '', `- Slug: \`${m.slug}\`  Codes: manufacturer \`${m.manufacturerCode}\`, plugin \`${m.pluginCode}\`  Bundle: \`${m.bundleId}\``,
    `- AudioWorklet processors: ${Object.keys(m.processors).map(k => `\`${k}\` (${m.processors[k].length} descriptors)`).join(', ')}`,
    `- Boot graph ops recorded: ${m.bootOps.length}; start control: ${r.startControl ? `\`${r.startControl.selector}\` ("${r.startControl.text}") auto-pressed` : 'none needed'}`,
    `- Smoke render (−20 dBFS 1 kHz, boot state): output ${r.smoke.outputDbfs} dBFS, ${r.smoke.messagesFromWorklet} messages (${r.smoke.messageTypes.join(', ')}), Node/V8 render cost ${(r.smoke.realtimeFactor * 100).toFixed(1)} % of realtime`,
    `- Host parameters: ${r.totalParams}; two-way UI binding confirmed for ${r.boundParams}${r.unboundParams.length ? `; DSP-only (no UI control found): ${r.unboundParams.join(', ')}` : ''}`, '', '## Parameters', '', '| id | type | range / choices | default | UI control | binding |', '|---|---|---|---|---|---|'];
  for (const p of m.params) lines.push(`| ${p.id} | ${p.type} | ${p.type === 'choice' ? p.choices.map(c => c.label).join(' / ') : `${p.min} … ${p.max}`} | ${p.default} | ${p.binding ? p.binding.selector : '—'} | ${p.binding ? p.binding.kind : 'DSP only'} |`);
  if (r.warnings.length) lines.push('', '## Warnings', '', ...r.warnings.map(w => '- ' + w));
  if (r.unsupported.length) lines.push('', '## Unsupported', '', ...r.unsupported.map(w => '- ' + w));
  if (r.pageErrors.length) lines.push('', '## Page errors during headless boot (jsdom; canvas/network are stubbed, so some are expected)', '', ...r.pageErrors.map(w => '- ' + w));
  lines.push('', '## Log', '', ...r.log.map(w => '- ' + w), '');
  return lines.join('\n');
}

if (require.main === module) {
  // jsdom pages keep async work (MutationObservers, Tailwind JIT) alive past window.close(); their late rejections are page noise, not forge failures
  process.on('unhandledRejection', e => console.warn('[page async noise after boot] ' + String(e && e.message || e).slice(0, 200)));
  (async () => {
    const input = process.argv[2]; if (!input || input.startsWith('--')) { console.error('usage: node forge/index.js <input.html> --out <dir> [--name X] [--vendor Y] [--slug z]'); process.exit(2); }
    const html = fs.readFileSync(input, 'utf8'); const out = arg('out', path.join('build', 'plugin'));
    const res = await forge(html, { name: arg('name'), vendor: arg('vendor'), slug: arg('slug'), sampleRate: arg('sr') });
    writeProject(out, res); console.log(report(res.manifest)); console.log('project written to', out);
  })().catch(e => { console.error('forge failed:', e.message); process.exit(1); });
}
module.exports = { forge, writeProject, report };
