// Sanity harness: run the untouched ANALOGEXACT worklet through the engine with the page's own graph topology.
const fs = require('fs');
const { Context } = require('../engine/webaudio-engine.js');
const sr = 48000;
const ctx = new Context(sr);
ctx.addModule(fs.readFileSync(__dirname + '/analogexact.worklet.js', 'utf8'));

// graph exactly as buildGraph() in the page
const ops = [
  { op: 'create', id: 'aw', type: 'AudioWorklet', name: 'analogexact-dsp', options: { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2 } },
  { op: 'create', id: 'dryGain', type: 'Gain' }, { op: 'create', id: 'dryDelay', type: 'Delay', args: [0.25] },
  { op: 'create', id: 'wetGain', type: 'Gain' }, { op: 'create', id: 'sumGain', type: 'Gain' }, { op: 'create', id: 'postGain', type: 'Gain' },
  { op: 'create', id: 'mic', type: 'MediaStreamSource' }, { op: 'create', id: 'dest', type: 'Destination' },
  { op: 'connect', from: 'dryGain', to: 'dryDelay' }, { op: 'connect', from: 'dryDelay', to: 'sumGain' },
  { op: 'connect', from: 'aw', to: 'wetGain' }, { op: 'connect', from: 'wetGain', to: 'sumGain' },
  { op: 'connect', from: 'sumGain', to: 'postGain' }, { op: 'connect', from: 'postGain', to: 'dest' },
  { op: 'connect', from: 'mic', to: 'aw' },
];
ops.forEach(o => ctx.applyOp(o));
ctx.captureMessages();
const base = { inDb: 0, outDb: 0, biasDb: 0, headroomDb: 0, monitor: 1, headblock: 0, speed: 15, flux: 250, eqStd: 0, tapeType: 1, transformer: 1, tapeHiss: 0, wowFlutter: 0, vibe: 0, preserve: 0, xfTrim: 1 };
function setParams(p) { ctx.applyOp({ op: 'post', id: 'aw', data: { type: 'params', params: Object.assign({}, base, p) } }); }
function mix(dry, wet) { ctx.applyOp({ op: 'param', id: 'dryGain', name: 'gain', method: 'setTargetAtTime', args: [dry, 0, 0.01], now: 0, timeArgs: [1] }); ctx.applyOp({ op: 'param', id: 'wetGain', name: 'gain', method: 'setTargetAtTime', args: [wet, 0, 0.01], now: 0, timeArgs: [1] }); }

function run(f0, dbfs, secs) {
  const n = Math.round(sr * secs); const inL = new Float32Array(n), inR = new Float32Array(n), outL = new Float32Array(n), outR = new Float32Array(n);
  const a = Math.pow(10, dbfs / 20); for (let i = 0; i < n; i++) { inL[i] = inR[i] = a * Math.sin(2 * Math.PI * f0 * i / sr); }
  ctx.render(inL, inR, outL, outR, n); return outL;
}
const tail = (y, n) => y.subarray(y.length - n);
const rmsDb = y => { let s = 0; for (const v of y) s += v * v; return 20 * Math.log10(Math.sqrt(s / y.length) + 1e-30); };
function mag(y, f) { let re = 0, im = 0; const N = y.length; for (let n = 0; n < N; n++) { const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * n / (N - 1)); re += y[n] * w * Math.cos(2 * Math.PI * f * n / sr); im -= y[n] * w * Math.sin(2 * Math.PI * f * n / sr); } return Math.hypot(re, im); }
function thd(y, f0) { const fund = mag(y, f0); let h = 0; for (let k = 2; k <= 10; k++) if (f0 * k < sr / 2) { const m = mag(y, f0 * k); h += m * m; } return 100 * Math.sqrt(h) / fund; }

const t0 = Date.now();
mix(0, 1);
setParams({ monitor: 0 }); let y = tail(run(1000, -20, 0.5), 16384); console.log('INPUT monitor bypass: -20 dBFS sine ->', rmsDb(y).toFixed(2), 'dBFS rms (expect -23.01)');
setParams({ monitor: 1 });
for (const lvl of [-40, -20, -12, -6, 0]) { y = tail(run(1000, lvl, 1.0), 16384); console.log(`REPRO 456/15ips/250: in ${lvl} dBFS -> out ${rmsDb(y).toFixed(2)} dBFS, THD ${thd(y, 1000).toFixed(3)} %`); }
setParams({ monitor: 1, vibe: 1 }); y = tail(run(1000, -12, 1.5), 16384); console.log('VIBE (Jiles-Atherton 8x OS): -12 dBFS -> out', rmsDb(y).toFixed(2), 'THD', thd(y, 1000).toFixed(3), '%');
setParams({ monitor: 1, speed: 7.5 }); const a75 = rmsDb(tail(run(10000, -40, 0.6), 16384)); setParams({ monitor: 1, speed: 15 }); const a15 = rmsDb(tail(run(10000, -40, 0.6), 16384)); console.log('10 kHz small-signal: 7.5 ips', a75.toFixed(2), 'vs 15 ips', a15.toFixed(2), 'dBFS');
setParams({ monitor: 1, tapeHiss: 1 }); y = tail(run(1000, -200, 1.0), 32768); console.log('hiss floor:', rmsDb(y).toFixed(1), 'dBFS');
setParams({ monitor: 1, preserve: 0.8 }); y = tail(run(1000, -20, 1.5), 16384); console.log('preserve 0.8 (FFT match-EQ running):', rmsDb(y).toFixed(2), 'dBFS');
mix(0.5, 0.5); setParams({ monitor: 1 }); y = tail(run(1000, -20, 0.5), 16384); console.log('50/50 mix via page GainNodes:', rmsDb(y).toFixed(2), 'dBFS');
const msgs = ctx.drainOutbox(); console.log('messages from worklet:', msgs.length, 'first:', JSON.stringify(msgs[0] && msgs[0].data).slice(0, 80), 'errors:', ctx.errors);
const secs = (Date.now() - t0) / 1000; console.log(`rendered ~9.6 s of audio in ${secs.toFixed(2)} s on Node/V8 (JIT) => ${(secs / 9.6 * 100).toFixed(1)} % of one core realtime`);
