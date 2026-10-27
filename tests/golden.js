// Golden master for a forged project: run the shipped engine + worklets + bootOps under Node/V8 exactly the way the plugin does,
process.on('unhandledRejection', e => console.warn('[page async noise] ' + String(e && e.message || e).slice(0, 120)));
// and write golden.json for HostTest (--golden). Usage: node tests/golden.js <projectDir> [outFile]
const fs = require('fs'); const path = require('path');
const dir = process.argv[2]; const out = process.argv[3] || path.join(dir, 'golden.json');
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'Assets', 'manifest.json'), 'utf8'));
const { Context, registry } = require(path.join(path.resolve(dir), 'Assets', 'engine.js'));
const sr = 48000, block = 512;
function fresh() {
  for (const k of Object.keys(registry)) delete registry[k];
  const e = new Context(sr); e.addModule(fs.readFileSync(path.join(dir, 'Assets', 'worklets.js'), 'utf8'));
  e.setHostParamNames(manifest.params.map(p => p.id)); e.applyJSON(JSON.stringify(manifest.bootOps));
  for (const p of manifest.params) e.hostParam(p.id, p.default);
  return e;
}
function run(e, f0, dbfs, secs) { const n = Math.ceil(sr * secs / block) * block; const i = new Float32Array(block), o = new Float32Array(block), o2 = new Float32Array(block); const out = new Float32Array(n); const a = Math.pow(10, dbfs / 20); let ph = 0;
  for (let p = 0; p < n; p += block) { for (let k = 0; k < block; k++) { i[k] = a * Math.sin(ph); ph += 2 * Math.PI * f0 / sr; } e.render(i, i, o, o2, block, true); out.set(o, p); } return out; }
const tail = (y, n) => y.subarray(y.length - n);
const rmsDb = y => { let s = 0; for (const v of y) s += v * v; return 20 * Math.log10(Math.sqrt(s / y.length) + 1e-30); };
function mag(y, f) { let re = 0, im = 0; const N = y.length; for (let n = 0; n < N; n++) { const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * n / (N - 1)); re += y[n] * w * Math.cos(2 * Math.PI * f * n / sr); im -= y[n] * w * Math.sin(2 * Math.PI * f * n / sr); } return Math.hypot(re, im); }
function thd(y, f0) { const fund = mag(y, f0); let h = 0; for (let k = 2; k <= 10; k++) if (f0 * k < sr / 2) { const m = mag(y, f0 * k); h += m * m; } return 100 * Math.sqrt(h) / fund; }
const e = fresh(); const t0 = Date.now(); const y = tail(run(e, 1000, -20, 1.0), 16384); const secs = (Date.now() - t0) / 1000;
const g = { sampleRate: sr, block, inputDbfs: -20, outputDbfs: +rmsDb(y).toFixed(3), thdPct: +thd(y, 1000).toFixed(4), nodeRealtimePercent: +(secs * 100).toFixed(1), sweep: [] };
// Sweep candidates. UI-state parameters (ui_*: knob positions / segmented switches that only rebuild the page's model) cannot be
// driven from the engine alone, so they are not level-swept here; HostTest covers them through the page. In resident-page
// projects the plugin drives *bound* parameters through the page as well, so those sweep points are flagged viaPage and the
// host pumps the message loop before measuring.
// viaPage points are measured the way the plugin produces them: the forged page itself (jsdom + shim + bridge) receives the
// value through the bridge, and whatever it posts (plain params or a rebuilt model/config) feeds a fresh engine. An
// engine-side value swap would be wrong for controls whose click rebuilds the model (1073: MASTERING changes the config).
const { JSDOM } = require('jsdom');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function throughPage(id, value) {
  const html = fs.readFileSync(path.join(dir, 'Assets', 'index.html'), 'utf8'); const ops = [];
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://plugin.local/', beforeParse(w) {
    w.__h2p_init = { sampleRate: sr }; w.__h2p_transport = { send: o => ops.push(...o), onReceive() { } }; w.__h2p_manifest = manifest;
    w.fetch = w.fetch || (() => Promise.reject(new Error('offline')));
    for (const k of ['WebAssembly', 'DecompressionStream', 'CompressionStream', 'Response', 'Request', 'Headers', 'TextDecoder', 'TextEncoder', 'ReadableStream', 'WritableStream', 'TransformStream', 'structuredClone', 'queueMicrotask', 'crypto']) if (typeof w[k] === 'undefined' && typeof globalThis[k] !== 'undefined') { try { w[k] = globalThis[k]; } catch (e) { } }
    const RB = w.Blob; w.Blob = class extends RB { constructor(p, o) { super(p, o); } }; w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => { };
    const noop = new Proxy(function () { }, { get: () => noop, apply: () => noop, set: () => true }); w.HTMLCanvasElement.prototype.getContext = () => noop;
    w.requestAnimationFrame = f => w.setTimeout(() => f(w.performance.now()), 16);
    w.eval(fs.readFileSync(path.join(dir, 'Assets', 'shim.js'), 'utf8'));
  } });
  const w = dom.window;
  const settle = async () => { let n = -1, quiet = 0; for (let t = 0; t < 40 && quiet < 4; t++) { await sleep(50); w.__h2p.flush(); if (ops.length === n) quiet++; else { quiet = 0; n = ops.length; } } };
  await sleep(1500); await settle();
  if (!ops.some(o => o.op === 'create' && o.type === 'AudioWorklet')) { w.close(); return null; }
  const nBoot = ops.length;
  const ok = w.__h2p.setFromHost(id, value); await sleep(60); await settle();
  const moved = ops.length > nBoot;
  for (const k of Object.keys(registry)) delete registry[k];
  const e = new Context(sr); e.addModule(fs.readFileSync(path.join(dir, 'Assets', 'worklets.js'), 'utf8'));
  e.setHostParamNames(manifest.params.map(p => p.id)); e.applyJSON(JSON.stringify(ops.filter(o => o.op !== 'log')));
  try { w.close(); } catch (e2) { }
  return { e, ok, moved };
}
const cands = manifest.params.filter(p => p.source !== 'ui-state').slice(0, 8);
(async () => {
for (const p of cands) { const e2 = fresh(); let v = p.default; if (p.type === 'float') v = p.max; else if (p.type === 'bool') v = p.default ? 0 : 1; else if (p.type === 'choice') { const other = p.choices.find(c => c.value !== p.default); v = other ? other.value : p.default; }
  // norm: the 0..1 value a host passes for this point (hosted VST3/AU parameters expose numeric IDs, so HostTest matches on name and sets the normalised value)
  let norm = 0; if (p.type === 'float') norm = (v - p.min) / ((p.max - p.min) || 1); else if (p.type === 'bool') norm = v >= 0.5 ? 1 : 0; else if (p.type === 'choice') { const i = p.choices.findIndex(c => c.value === v); norm = p.choices.length > 1 ? Math.max(0, i) / (p.choices.length - 1) : 0; }
  const viaPage = !!(manifest.residentPage && manifest.bindings && manifest.bindings[p.id]);
  let eng = e2, how = 'engine';
  if (viaPage) { const r = await throughPage(p.id, v); if (r && r.ok && r.moved) { eng = r.e; how = 'page'; } else { console.warn(`[golden] ${p.id}: page did not take the value (${r ? (r.ok ? 'no ops followed' : 'bridge refused') : 'page did not boot'}); engine-side value used`); } }
  else e2.hostParam(p.id, v);
  if (how === 'engine' && viaPage) e2.hostParam(p.id, v);
  const yy = tail(run(eng, 1000, -20, 0.8), 16384); g.sweep.push({ id: p.id, name: p.name || p.id, norm: +norm.toFixed(6), value: v, outputDbfs: +rmsDb(yy).toFixed(3), viaPage, measured: how }); }
fs.writeFileSync(out, JSON.stringify(g, null, 1)); console.log(JSON.stringify(g)); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
