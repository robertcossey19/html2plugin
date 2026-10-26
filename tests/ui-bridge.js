// Host -> UI: forge the page, then boot it again with shim+bridge and drive the page's own controls from "the host".
process.on('unhandledRejection', e => console.warn('[page async noise] ' + String(e && e.message || e).slice(0, 120)));
const fs = require('fs'); const { JSDOM } = require('jsdom'); const { forge } = require('../forge/index.js');
(async () => {
  const html = fs.readFileSync(__dirname + '/analogexact.html', 'utf8');
  const { manifest } = await forge(html, { slug: 'analogexact-test' });
  const ops = [];
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://plugin.local/', beforeParse(w) {
    w.__h2p_init = { sampleRate: 48000 }; w.__h2p_transport = { send: o => ops.push(...o), onReceive() { } }; w.__h2p_manifest = manifest;
    const RB = w.Blob; w.Blob = class extends RB { constructor(p, o) { super(p, o); } }; w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => { };
    const noop = new Proxy(function () { }, { get: () => noop, apply: () => noop, set: () => true }); w.HTMLCanvasElement.prototype.getContext = () => noop;
    w.requestAnimationFrame = f => w.setTimeout(() => f(w.performance.now()), 16);
    w.eval(fs.readFileSync(__dirname + '/../runtime/webaudio-shim.js', 'utf8')); w.eval(fs.readFileSync(__dirname + '/../runtime/ui-bridge.js', 'utf8'));
  } });
  const w = dom.window; const sleep = ms => new Promise(r => setTimeout(r, ms));
  await sleep(1200); w.__h2p.flush();
  console.log('auto-start built graph:', ops.some(o => o.op === 'create' && o.type === 'AudioWorklet'), '| current inDb', w.__h2p.current.inDb, 'speed', w.__h2p.current.speed);
  const tests = [['inDb', -6], ['inDb', 4.5], ['outDb', -10], ['headroomDb', 3], ['speed', 7.5], ['tapeType', 3], ['flux', 500], ['vibe', 1], ['transformer', 0], ['monitor', 0], ['tapeHiss', 1], ['preserve', 0.5], ['biasDb', -2.3], ['eqStd', 1]];
  for (const [k, v] of tests) { const ok = w.__h2p.setFromHost(k, v); await sleep(10); w.__h2p.flush(); const got = w.__h2p.current[k]; console.log(`${ok ? 'ok ' : 'NO '} ${k}: want ${v} -> page now ${got} ${Math.abs(got - v) <= 0.13 ? '' : '  <-- MISMATCH'}`); }
  const knob = w.document.querySelector('#knob-in .knob-ind'); console.log('knob-in indicator transform:', knob && knob.style.transform, '| val-in text:', w.document.getElementById('val-in') && w.document.getElementById('val-in').textContent);
  w.close(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
