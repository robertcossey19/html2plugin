// Golden master for a forged project: run the shipped engine + worklets + bootOps under Node/V8 exactly the way the plugin does,
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
const cands = manifest.params.filter(p => p.type !== 'bool' || true).slice(0, 8);
for (const p of cands) { const e2 = fresh(); let v = p.default; if (p.type === 'float') v = p.max; else if (p.type === 'bool') v = p.default ? 0 : 1; else if (p.type === 'choice') { const other = p.choices.find(c => c.value !== p.default); v = other ? other.value : p.default; }
  e2.hostParam(p.id, v); const yy = tail(run(e2, 1000, -20, 0.8), 16384); g.sweep.push({ id: p.id, value: v, outputDbfs: +rmsDb(yy).toFixed(3) }); }
fs.writeFileSync(out, JSON.stringify(g, null, 1)); console.log(JSON.stringify(g));
