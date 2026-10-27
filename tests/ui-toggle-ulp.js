// Discrete controls must be compared by nearest option, not float equality: the live page (JavaScriptCore libm) computes option
// values that differ from the forge's measurements (V8 libm) by ULPs. Build 32 double-clicked 1073's MASTERING button for that
// reason and silently undid the host's change. Here the measured options are perturbed by 1e-13 and the bridge must still click once.
process.on('unhandledRejection', e => { });
const fs = require('fs'); const path = require('path'); const { JSDOM } = require('jsdom'); const { forge } = require('../forge/index.js');
(async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'inbox', 'analogexact-1073.html'), 'utf8');
  const { manifest } = await forge(html, { slug: 'ae1073-ulp-test' });
  const b = manifest.bindings.inGain; if (!b || b.kind !== 'click-toggle') { console.error('expected inGain click-toggle binding, got', JSON.stringify(b)); process.exit(1); }
  b.values = b.values.map(v => v * (1 + 1e-13));
  const ops = [];
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://plugin.local/', beforeParse(w) {
    w.__h2p_init = { sampleRate: 48000 }; w.__h2p_transport = { send: o => ops.push(...o), onReceive() { } }; w.__h2p_manifest = manifest;
    w.fetch = w.fetch || (() => Promise.reject(new Error('offline')));
    for (const k of ['WebAssembly', 'DecompressionStream', 'CompressionStream', 'Response', 'Request', 'Headers', 'TextDecoder', 'TextEncoder', 'ReadableStream', 'WritableStream', 'TransformStream', 'structuredClone', 'queueMicrotask', 'crypto']) if (typeof w[k] === 'undefined' && typeof globalThis[k] !== 'undefined') { try { w[k] = globalThis[k]; } catch (e) { } }
    const RB = w.Blob; w.Blob = class extends RB { constructor(p, o) { super(p, o); } }; w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => { };
    const noop = new Proxy(function () { }, { get: () => noop, apply: () => noop, set: () => true }); w.HTMLCanvasElement.prototype.getContext = () => noop;
    w.requestAnimationFrame = f => w.setTimeout(() => f(w.performance.now()), 16);
    w.eval(fs.readFileSync(path.join(__dirname, '..', 'runtime', 'webaudio-shim.js'), 'utf8')); w.eval(fs.readFileSync(path.join(__dirname, '..', 'runtime', 'ui-bridge.js'), 'utf8'));
  } });
  const w = dom.window; const sleep = ms => new Promise(r => setTimeout(r, ms));
  await sleep(2500); w.__h2p.flush();
  const btn = w.document.getElementById('mastering-btn'); const text = () => btn.textContent.trim();
  if (text() !== 'OFF') { console.error('page did not boot with MASTERING OFF:', text()); process.exit(1); }
  const on = b.values.reduce((a, c) => Math.abs(c - 1) > Math.abs(a - 1) ? c : a), hostOn = Math.fround(on);   // the host hands back a float-rounded value
  w.__h2p.setFromHost('inGain', hostOn); await sleep(300); w.__h2p.flush();
  const t1 = text();
  for (let i = 0; i < 3; i++) { w.__h2p.applyHostParams({ inGain: hostOn, trim: 1, phase: 1, xtalk: 0, os: 1 }); await sleep(250); w.__h2p.flush(); }
  const t2 = text(); const cur = w.__h2p.current.inGain;
  console.log(`mastering after host ON: ${t1}; after 3 host re-syncs: ${t2}; page inGain ${cur}`);
  const ok = t1 === 'ON' && t2 === 'ON' && Math.abs(cur - on) < 1e-6;
  w.__h2p.setFromHost('inGain', 1); await sleep(300); w.__h2p.flush();
  console.log(`mastering after host OFF: ${text()}; page inGain ${w.__h2p.current.inGain}`);
  console.log(ok && text() === 'OFF' ? 'PASS discrete controls compared by nearest option' : 'FAIL discrete control double-clicked');
  w.close(); process.exit(ok && text() === 'OFF' ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
