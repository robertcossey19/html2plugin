// Validate shim -> ops -> engine contract without a browser: fake window, run page-style graph code against the shim, replay in engine.
process.on('unhandledRejection', e => console.warn('[page async noise] ' + String(e && e.message || e).slice(0, 120)));
const fs = require('fs'); const vm = require('vm');
const { Context } = require('../engine/webaudio-engine.js');
const sr = 48000; const engine = new Context(sr); const worklet = fs.readFileSync(__dirname + '/analogexact.worklet.js', 'utf8'); engine.addModule(worklet);
const sent = []; const inbound = [];
const win = { __h2p_init: { sampleRate: sr }, __h2p_transport: { send: ops => sent.push(...ops), onReceive: fn => inbound.push(fn) }, __h2p_registry: { 'blob:x': { processors: { 'analogexact-dsp': [{ name: 'inDb', defaultValue: 0, minValue: -12, maxValue: 12 }] } } },
  performance, EventTarget, console, Promise, JSON, ArrayBuffer, Float32Array, Uint8Array, Map, DataView, String, Math, Object, Array, TypeError, Error, Number, isFinite, navigator: {} };
win.window = win; vm.createContext(win); vm.runInContext(fs.readFileSync(__dirname + '/../runtime/webaudio-shim.js', 'utf8'), win);
vm.runInContext(`
  const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  (async () => {
    await ctx.audioWorklet.addModule('blob:x');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false } });
    const src = ctx.createMediaStreamSource(stream);
    const aw = new AudioWorkletNode(ctx, 'analogexact-dsp', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2 });
    const dryGain = ctx.createGain(), dryDelay = ctx.createDelay(0.25), wetGain = ctx.createGain(), sumGain = ctx.createGain(), postGain = ctx.createGain();
    src.connect(aw); src.connect(dryGain); dryGain.connect(dryDelay).connect(sumGain); aw.connect(wetGain).connect(sumGain); sumGain.connect(postGain).connect(ctx.destination);
    dryGain.gain.setTargetAtTime(0, ctx.currentTime, 0.01); wetGain.gain.setTargetAtTime(1, ctx.currentTime, 0.01); postGain.gain.value = 1;
    aw.port.onmessage = e => { window.lastMsg = e.data; };
    aw.port.postMessage({ type: 'params', params: { inDb: 0, outDb: 0, biasDb: 0, headroomDb: 0, monitor: 1, headblock: 0, speed: 15, flux: 250, eqStd: 0, tapeType: 1, transformer: 1, tapeHiss: 0, wowFlutter: 0, vibe: 0, preserve: 0, xfTrim: 1 } });
    window.aw = aw;
  })();
`, win);
setTimeout(() => {
  win.__h2p.flush();
  console.log('ops recorded:', sent.length, sent.map(o => o.op + ':' + (o.type || o.method || '')).join(' '));
  engine.applyJSON(JSON.stringify(sent));
  const n = sr; const inL = new Float32Array(n), inR = new Float32Array(n), oL = new Float32Array(n), oR = new Float32Array(n);
  for (let i = 0; i < n; i++) inL[i] = inR[i] = 0.1 * Math.sin(2 * Math.PI * 1000 * i / sr);
  engine.render(inL, inR, oL, oR, n);
  let s = 0; for (let i = n - 16384; i < n; i++) s += oL[i] * oL[i]; console.log('out rms dBFS:', (20 * Math.log10(Math.sqrt(s / 16384))).toFixed(2), '(harness got -22.07)');
  const json = engine.drainOutboxJSON(true); for (const f of inbound) f(json);
  console.log('page received last message:', JSON.stringify(win.lastMsg).slice(0, 90), 'errors:', engine.errors);
}, 50);
