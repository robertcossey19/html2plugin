/* Boot the pasted page headlessly (jsdom) against the WebView shim, record the Web Audio ops the page issues,
 * capture worklet module text from Blob URLs, auto-press the start/power control, then empirically probe every UI control
 * to learn which DSP parameter it drives and how (range/select/checkbox/click/wheel/pointer-drag). */
const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('fs'); const path = require('path');
const SHIM = fs.readFileSync(path.join(__dirname, '..', 'runtime', 'webaudio-shim.js'), 'utf8');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const START_RX = /^(power|start|on|run|init|enable|engage|activate|go|begin|arm|audio|mic|input|connect|boot|play|bypass)\b|power|start|engage|enable/i;

/* Pages built as file players (Load -> decode -> build graph -> Play) never touch Web Audio until a file arrives. Inside the
 * plugin the DAW track is that file, so the boot hands them one: a short 16-bit stereo WAV (1 kHz, -20 dBFS). The same bytes
 * are produced by runtime/ui-bridge.js inside the WebView; keep the two in sync. */
function syntheticWavBytes(sampleRate) {
  const sr = sampleRate || 48000, frames = Math.round(sr * 0.5), ch = 2, bps = 2;
  const ab = new ArrayBuffer(44 + frames * ch * bps), dv = new DataView(ab);
  const str = (o, t) => { for (let i = 0; i < t.length; i++) dv.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + frames * ch * bps, true); str(8, 'WAVE'); str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, ch, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * ch * bps, true); dv.setUint16(32, ch * bps, true); dv.setUint16(34, 16, true); str(36, 'data'); dv.setUint32(40, frames * ch * bps, true);
  for (let i = 0; i < frames; i++) { const v = Math.round(Math.sin(2 * Math.PI * 1000 * i / sr) * 0.1 * 32767); dv.setInt16(44 + i * 4, v, true); dv.setInt16(46 + i * 4, v, true); }
  return ab;
}
/* Hand the synthetic file to the page the way a user would: every <input type=file> gets it via a change event, then a drop
 * event (bubbling, so any drop zone up the tree sees it) on each element with an id. Returns a replayable description or null. */
async function feedFile(w, d, sampleRate, graphBuilt, flush, timeoutMs) {
  const ab = syntheticWavBytes(sampleRate);
  const file = new w.File([new w.Uint8Array(ab)], 'h2p-input.wav', { type: 'audio/wav' }); file.__arrayBuffer = ab;
  try { file.arrayBuffer = () => Promise.resolve(ab.slice(0)); } catch (e) { }
  const list = { 0: file, length: 1, item: i => (i === 0 ? file : null), [Symbol.iterator]: function* () { yield file; } };
  const waitBuilt = async (ms) => { const dl = Date.now() + ms; while (Date.now() < dl && !graphBuilt()) { await sleep(100); flush(); } return graphBuilt(); };
  const inputs = [...d.querySelectorAll('input[type=file]')];
  for (const inp of inputs) {
    try { Object.defineProperty(inp, 'files', { configurable: true, get: () => list }); } catch (e) { continue; }
    inp.dispatchEvent(new w.Event('input', { bubbles: true })); inp.dispatchEvent(new w.Event('change', { bubbles: true })); flush();
    if (await waitBuilt(timeoutMs)) return { kind: 'file', selector: inp.id ? '#' + inp.id : `input[type=file]:nth-of-type(${inputs.indexOf(inp) + 1})`, name: file.name, text: 'file input ' + (inp.id || '') };
  }
  const dt = { files: list, items: [{ kind: 'file', type: 'audio/wav', getAsFile: () => file }], types: ['Files'], dropEffect: 'copy', effectAllowed: 'all', getData: () => '', setData() { } };
  const targets = [...d.querySelectorAll('[id]')].slice(0, 80);
  for (const el of targets) {
    for (const type of ['dragenter', 'dragover', 'drop']) { const ev = new w.Event(type, { bubbles: true, cancelable: true }); try { Object.defineProperty(ev, 'dataTransfer', { value: dt }); } catch (e) { } el.dispatchEvent(ev); }
    flush();
    if (await waitBuilt(Math.min(timeoutMs, 1200))) return { kind: 'drop', selector: '#' + el.id, name: file.name, text: 'file dropped on #' + el.id };
  }
  return null;
}

/* Name of the host parameter for slot i of a numeric array value; 2-slot arrays are stereo pairs (L/R). Mirrored in the engine. */
const arraySlotName = (k, i, len) => len === 2 ? k + (i === 0 ? '_L' : '_R') : k + '_' + (i + 1);
function flattenParams(data, into) {
  // numeric/boolean leaves of a message, keyed by leaf name; also {name|key|id|param, value|val|v} shapes
  into = into || {};
  if (!data || typeof data !== 'object' || Array.isArray(data)) return into;
  const kf = ['name', 'key', 'id', 'param', 'parameter'].find(k => typeof data[k] === 'string');
  const vf = ['value', 'val', 'v'].find(k => typeof data[k] === 'number' || typeof data[k] === 'boolean');
  if (kf && vf) { into[data[kf]] = +data[vf]; return into; }
  for (const k in data) {
    const v = data[k]; if (k === 'type') continue;
    if (typeof v === 'number' || typeof v === 'boolean') into[k] = +v;
    else if (Array.isArray(v)) { // short numeric arrays are per-channel values ({input:[L,R]}): one parameter per slot
      if (v.length >= 1 && v.length <= 8 && v.every(x => typeof x === 'number' || typeof x === 'boolean')) v.forEach((x, i) => { into[arraySlotName(k, i, v.length)] = +x; });
    }
    else if (v && typeof v === 'object') flattenParams(v, into);
  }
  return into;
}

async function bootPage(html, opts = {}) {
  const sampleRate = opts.sampleRate || 48000; const timeoutMs = opts.timeoutMs || 2500;
  const vc = new VirtualConsole(); const consoleLog = []; vc.on('error', m => consoleLog.push('error: ' + m)); vc.on('warn', () => { }); vc.on('log', m => { if (!String(m).startsWith('[h2p]')) consoleLog.push(String(m).slice(0, 200)); }); vc.on('jsdomError', e => consoleLog.push('jsdom: ' + (e && e.message || e).toString().slice(0, 200)));
  // Every probe runs against a page in its boot state: controls that rebuild the model can leave residue even after switching
  // back, so the page is re-created (fresh jsdom) before each control that follows a state-changing probe.
  let ops, recv, blobs, bn, addModuleUrls, dom, w, d, errors = [], startControl = null, reboots = 0;
  const flush = () => { try { w.__h2p.flush(); } catch (e) { } };
  const clickEl = x => { if (typeof x.click === 'function') x.click(); else x.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, view: w })); };   // SVG elements have no click()
  const graphBuilt = () => ops.some(o => o.op === 'create' && o.type === 'AudioWorklet') || ops.some(o => o.op === 'connect');
  async function freshPage() {
  // (previous probe pages are left to the GC: closing them while their MutationObservers still have records makes jsdom throw out of the microtask queue)
  if (w) { // retire the previous page: stop its timers and its op stream so a dozen probe pages cannot starve the live one
    w.__h2p_dead = true; for (const id of (w.__h2p_timers || [])) { try { w.clearTimeout(id); } catch (e) { } } for (const id of (w.__h2p_intervals || [])) { try { w.clearInterval(id); } catch (e) { } } w.__h2p_timers = []; w.__h2p_intervals = [];
    try { w.document.dispatchEvent(new w.Event('visibilitychange')); } catch (e) { }
  }
  ops = []; recv = null; blobs = {}; bn = 0; addModuleUrls = [];
  dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, url: 'https://plugin.local/index.html',
    beforeParse(w) {
      w.__h2p_init = { sampleRate }; w.__h2p_transport = { send: o => { if (!w.__h2p_dead) ops.push(...o); }, onReceive: f => { if (!w.__h2p_dead) recv = f; } };
      w.__h2p_timers = []; const st = w.setTimeout.bind(w), si = w.setInterval.bind(w);
      w.setTimeout = function (f, ms, ...a) { if (w.__h2p_dead) return 0; const id = st(f, ms, ...a); w.__h2p_timers.push(id); if (w.__h2p_timers.length > 4000) w.__h2p_timers.splice(0, 2000); return id; };
      w.__h2p_intervals = []; w.setInterval = function (f, ms, ...a) { if (w.__h2p_dead) return 0; const id = si(f, ms, ...a); w.__h2p_intervals.push(id); return id; };
      const RealBlob = w.Blob; w.Blob = class extends RealBlob { constructor(parts, o) { super(parts, o); this.__text = (parts || []).map(p => typeof p === 'string' ? p : (p && p.__text) || '').join(''); } };
      w.URL.createObjectURL = b => { const u = 'blob:h2p/' + (++bn); blobs[u] = (b && b.__text) || ''; return u; }; w.URL.revokeObjectURL = () => { };
      const noop = new Proxy(function () { }, { get: (t, k) => k === 'canvas' ? {} : noop, apply: () => noop, set: () => true });
      w.HTMLCanvasElement.prototype.getContext = () => noop; w.HTMLCanvasElement.prototype.toDataURL = () => 'data:,';
      w.requestAnimationFrame = f => w.setTimeout(() => f(w.performance.now()), 16); w.cancelAnimationFrame = w.clearTimeout;
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() { }, removeListener() { }, addEventListener() { }, removeEventListener() { } }));
      w.ResizeObserver = w.ResizeObserver || class { observe() { } unobserve() { } disconnect() { } };
      // pointer capture is what every drag-knob handler calls first; jsdom has no implementation
      const EP = w.Element.prototype; EP.setPointerCapture = EP.setPointerCapture || function () { }; EP.releasePointerCapture = EP.releasePointerCapture || function () { }; EP.hasPointerCapture = EP.hasPointerCapture || (() => false);
      w.fetch = w.fetch || (() => Promise.reject(new Error('offline')));
      // platform APIs jsdom lacks but pages use to unpack themselves (gzip+base64 bundles, wasm engines): lend Node's implementations
      for (const k of ['WebAssembly', 'DecompressionStream', 'CompressionStream', 'Response', 'Request', 'Headers', 'TextDecoder', 'TextEncoder', 'ReadableStream', 'WritableStream', 'TransformStream', 'structuredClone', 'queueMicrotask', 'crypto'])
        if (typeof w[k] === 'undefined' && typeof globalThis[k] !== 'undefined') { try { w[k] = globalThis[k]; } catch (e) { } }
      w.eval(SHIM);
      // remember which URLs went to addModule so blob text can be matched to modules
      const P = w.AudioContext.prototype; const orig = P._addModule; P._addModule = function (url) { addModuleUrls.push(String(url)); return orig.call(this, url); };
    },
  });
  w = dom.window; d = w.document;
  w.addEventListener('error', e => errors.push(String(e.message || e.error)));
  await sleep(250); flush();
  if (startControl && startControl.selector && !graphBuilt()) { // replay the start control found on the first boot
    if (startControl.kind === 'file' || startControl.kind === 'drop') await feedFile(w, d, sampleRate, graphBuilt, flush, timeoutMs);
    else { const el = d.querySelector(startControl.selector); if (el) for (let i = 0; i < (startControl.clicks || 1); i++) { clickEl(el); await sleep(300); flush(); } }
    const deadline = Date.now() + timeoutMs; while (Date.now() < deadline && !graphBuilt()) { await sleep(100); flush(); } await sleep(300); flush();
  }
  reboots++;
  if (process.env.H2P_DEBUG) console.error(`[boot] page #${reboots}: graphBuilt=${graphBuilt()} ops=${ops.length} worklets=${ops.filter(o => o.op === 'create' && o.type === 'AudioWorklet').map(o => o.id)} posts=${ops.filter(o => o.op === 'post').length} startControl=${JSON.stringify(startControl)}`);
  }
  let dirty = false;   // did the last probe post anything (i.e. may the page have left its boot state)?
  const ensureClean = async () => { if (!dirty) return; await freshPage(); dirty = false; };
  await freshPage();
  const probeLog0 = [];
  // auto-start: click the most plausible start control if the graph has not been built by the page itself
  if (!graphBuilt()) {
    const cands = [...d.querySelectorAll('button, [role=button], .btn, .toggle, .switch, .power, [id], input[type=checkbox]')].filter(el => (el.id || el.textContent));
    const score = el => { const t = ((el.id || '') + ' ' + (el.className || '') + ' ' + (el.textContent || '').trim().slice(0, 40)).toLowerCase(); let s = 0; if (/power/.test(t)) s += 10; if (/\bstart\b|engage|enable|init/.test(t)) s += 6; if (/\bon\b|run|activate|arm|connect|mic|input/.test(t)) s += 2; if (/export|download|save|stop|close|legend|learn|help|tech|reset|cal/.test(t)) s -= 8; if (el.tagName === 'BUTTON') s += 1; return s; };
    cands.sort((a, b) => score(b) - score(a));
    // A start control must leave the page in its default state. Controls that build the graph but also toggle themselves
    // (an HQ/ECO switch whose handler happens to resume the AudioContext) are clicked a second time to restore the state,
    // and the bridge inside the plugin repeats the same two clicks.
    const snap = el => [el.className, el.checked, el.getAttribute && el.getAttribute('aria-pressed'), el.getAttribute && el.getAttribute('aria-checked'), (el.textContent || '').trim().slice(0, 40)].join('|');
    const tryList = [...cands.filter(el => score(el) > 0).slice(0, 6), ...cands.filter(el => score(el) === 0 && (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || /btn|button|toggle|switch/i.test(String(el.className)))).slice(0, 12)];
    for (const el of tryList) {
      const s0 = snap(el); clickEl(el); await sleep(400); flush();
      if (!graphBuilt()) { if (snap(el) !== s0) { clickEl(el); await sleep(100); flush(); } continue; }
      let clicks = 1;
      if (snap(el) !== s0) {
        const n0 = ops.length; clickEl(el); await sleep(400); flush();
        if (process.env.H2P_DEBUG) console.error('[boot] second start click ops: ' + JSON.stringify(ops.slice(n0)).slice(0, 600));
        // a power switch disconnects/suspends on its second press (topology change) -> it is a one-shot start control; an HQ/ECO
        // style toggle only posts a parameter back -> press twice so the page ends in its boot state
        const lost = !graphBuilt() || ops.slice(n0).some(o => /^(close|reset|suspend|disconnect|connect|create)$/.test(o.op));
        if (lost) { clickEl(el); await sleep(400); flush(); probeLog0.push(`start control ${el.id || el.textContent} changes its own state and cannot be toggled back without losing the graph`); }
        else clicks = 2;
      }
      startControl = { id: el.id || null, text: (el.textContent || '').trim().slice(0, 40), selector: el.id ? '#' + el.id : null, clicks }; break;
    }
    // Still nothing: a file-player page (Load/drop -> decode -> graph -> Play). Hand it a file; the DAW track takes its place in the plugin.
    if (!graphBuilt()) {
      const fed = await feedFile(w, d, sampleRate, graphBuilt, flush, timeoutMs);
      if (fed) { startControl = Object.assign({ clicks: 1 }, fed); probeLog0.push(`graph is built when a file arrives (${fed.text}); the plugin feeds a synthetic WAV at boot and the DAW input replaces the file`); }
      else probeLog0.push('no button, file input or drop zone made the page build its graph');
    }
  }
  const deadline = Date.now() + timeoutMs; while (Date.now() < deadline && !graphBuilt()) { await sleep(100); flush(); }
  await sleep(300); flush();
  const bootOps = ops.filter(o => o.op !== 'log');   // page console forwarding is not part of the graph
  // which blob urls were worklet modules
  const modules = {}; for (const u of addModuleUrls) if (blobs[u]) modules[u] = blobs[u];
  const unresolvedModules = addModuleUrls.filter(u => !blobs[u]);
  // boot params = last message state per worklet node
  const lastParams = {}; for (const o of bootOps) if (o.op === 'post') flattenParams(o.data, lastParams);
  // Leaves of *structural* messages (netlists, filter matrices, wavetables: anything carrying binary payloads) describe the
  // model, not user parameters. They only become host parameters if the UI probe below ties a control to them.
  const isStructural = d => { const j = JSON.stringify(d) || ''; return j.length > 4096 || /"__(ta|ab|wasm|audiobuffer)"/.test(j); };
  const structuralOnly = {}; { const plain = {}; for (const o of bootOps) if (o.op === 'post' && !isStructural(o.data)) flattenParams(o.data, plain); for (const k in lastParams) if (!(k in plain)) structuralOnly[k] = true; }
  const workletIds = bootOps.filter(o => o.op === 'create' && o.type === 'AudioWorklet').map(o => o.id);

  /* ---------------- probe UI controls ---------------- */
  const bindings = {}; const probeLog = probeLog0;
  // worklet ids are read from the *current* page's ops: a re-created page may number its nodes differently from the first boot (start-control search clicks can create nodes)
  const paramsNow = () => { const p = {}; const wids = new Set(ops.filter(o => o.op === 'create' && o.type === 'AudioWorklet').map(o => o.id)); for (const o of ops) if (o.op === 'post' && wids.has(o.id)) flattenParams(o.data, p); return p; };
  const settle = async () => { let n = -1, quiet = 0; for (let t = 0; t < 12 && quiet < 2; t++) { await sleep(25); flush(); if (ops.length === n) quiet++; else { quiet = 0; n = ops.length; } } }; // wait until the page stops posting (debounced / rAF handlers)
  let structuralSeen = bootOps.filter(o => o.op === 'post' && isStructural(o.data)).length;
  const valuesSeen = {};   // every value each plain key took during probing (a segmented group's key takes exactly as many values as it has buttons)
  const diffAfter = async (action) => { await settle(); const before = paramsNow(); const n0 = ops.length; try { action(); } catch (e) { return { changed: {}, err: String(e) }; } await settle(); const after = paramsNow(); const changed = {}; for (const k in after) if (before[k] !== after[k] && ops.slice(n0).some(o => o.op === 'post')) { changed[k] = { from: before[k], to: after[k] }; (valuesSeen[k] = valuesSeen[k] || new Set()).add(after[k]); } const posts = ops.slice(n0).filter(o => o.op === 'post').map(o => o.data); for (const pd of posts) if (isStructural(pd)) structuralSeen++; return { changed, after, posts }; };
  const norm = x => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const single = (ch, hint, hint2) => { // one control usually moves one parameter; when several move (linked channels, derived values) prefer the one named like the control (or its group)
    const ks = Object.keys(ch).filter(k => !structuralOnly[k]); if (ks.length <= 1) return ks[0] || null;   // model-derived leaves (netlist gains etc.) are never parameters; the control's visual state is used instead
    for (const hh of [hint, hint2]) { const h = norm(hh); if (h && h.length >= 3) { const hit = ks.find(k => norm(k) === h) || ks.find(k => h.includes(norm(k)) || norm(k).includes(h)); if (hit) return hit; } }
    return ks.find(k => !bindings[k]) || ks[0];   // linked channels: the second knob of a stereo-linked pair moves both keys; take the one no control owns yet
  };
  // A control that moves several unrelated leaves at once (a "threshold" macro that sets input and output of both channels, a
  // lookup-table slider) cannot be replayed as one leaf. Stereo twins (x_L/x_R, inA/inB) of one base name still count as one.
  const baseOf = k => k.replace(/(_L|_R|_\d+|[AB]|[12]|L|R|Left|Right)$/, '');
  const isMacro = ch => { const ks = Object.keys(ch).filter(k => !structuralOnly[k]); return new Set(ks.map(baseOf)).size > 1; };
  const groupHint = el => { const p = el.parentElement; return p ? (p.id || (p.dataset && (p.dataset.param || p.dataset.name)) || '') : ''; };
  const fire = (el, type, init) => { const Ev = type.startsWith('pointer') ? w.PointerEvent || w.MouseEvent : type === 'wheel' ? w.WheelEvent : type.startsWith('mouse') ? w.MouseEvent : w.Event; el.dispatchEvent(new Ev(type, Object.assign({ bubbles: true, cancelable: true, composed: true }, init || {}))); };
  const consider = (name, b) => { if (!bindings[name] || (b.quality || 0) > (bindings[name].quality || 0)) bindings[name] = b; };

  if (opts.probeHook) await opts.probeHook({ d, w, diffAfter, fire, paramsNow, flush });
  const CSS_escape = s => String(s).replace(/([^a-zA-Z0-9_-])/g, '\\$1');
  const cssPath = (el) => { if (el.id) return '#' + CSS_escape(el.id); const parts = []; let cur = el; while (cur && cur.nodeType === 1 && cur !== d.body && cur !== d.documentElement) { if (cur.id) { parts.unshift('#' + CSS_escape(cur.id)); break; } const parent = cur.parentElement; const idx = parent ? [...parent.children].indexOf(cur) + 1 : 1; parts.unshift(cur.tagName.toLowerCase() + `:nth-child(${idx})`); cur = parent; } return parts.join(' > '); };
  const clickResults = []; // {selector, label, key, value}
  /* Controls that only rebuild the model (netlists, matrices) expose no plain value we could follow in a message. Their
     *visual* state is still observable: aria-valuenow, an indicator's rotate() transform, a numeric readout, a class on a
     segmented button. Those become "ui_" host parameters (0..1 position / choice index) driven through the page's own code. */
  const rotOf = x => { const m = /rotate\(\s*(-?[\d.]+)deg\s*\)/.exec((x.style && x.style.transform) || ''); return m ? parseFloat(m[1]) : null; };
  const numOf = x => { if (x.children && x.children.length) return null; const m = /-?\d+(?:\.\d+)?/.exec(x.textContent || ''); return m ? parseFloat(m[0]) : null; };
  const ariaOf = x => { const a = x.getAttribute && x.getAttribute('aria-valuenow'); return a == null || a === '' || isNaN(+a) ? null : +a; };
  const indicatorsOf = el => { const set = new Set([el, ...el.querySelectorAll('*')]); const pre = el.id ? el.id.split(/[-_]/)[0] : ''; if (pre.length >= 3) for (const x of d.querySelectorAll(`[id^="${pre}"]`)) set.add(x); return [...set]; };
  const readVisual = (x, how) => how === 'aria' ? ariaOf(x) : how === 'rotate' ? rotOf(x) : numOf(x);
  const findIndicator = (el, before) => { // which indicator moved between the snapshots?
    for (const how of ['aria', 'rotate', 'text']) for (const x of indicatorsOf(el)) { const v0 = before.get(x) && before.get(x)[how], v1 = readVisual(x, how); if (typeof v0 === 'number' && typeof v1 === 'number' && v0 !== v1) return { x, how }; }
    return null;
  };
  const snapshotVisual = el => { const m = new Map(); for (const x of indicatorsOf(el)) m.set(x, { aria: ariaOf(x), rotate: rotOf(x), text: numOf(x) }); return m; };
  const labelFor = el => { const own = (el.id || '').replace(/[-_]?(knob|container|ctl|control|dial|slider|wrap|wrapper)$/gi, ''); let lab = null; let cur = el; for (let i = 0; i < 3 && cur && !lab; i++, cur = cur.parentElement) { const c = cur.querySelector && cur.querySelector('[class*=label], label, h1, h2, h3, h4, span'); if (c && c.textContent.trim() && c.textContent.trim().length <= 24) lab = c.textContent.trim(); } return lab || own.replace(/[-_]+/g, ' ') || 'control'; };
  const junkControl = el => /\b(mic|microphone|file|load|open|record|rec|export|download|save|help|legend|tech|info|about|reset|cal|preset|share|copy|fullscreen|close)\b/i.test(((el.id || '') + ' ' + (el.textContent || '').trim().slice(0, 30)).replace(/[-_]/g, ' '));
  const uiId = el => 'ui_' + String(el.id || cssPath(el)).replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  const stateClicks = []; // {el, sel, added:[class]} for clicks that reached the DSP (posted) but carried no plain parameter
  const classAtBoot = new Map(); for (const x of d.querySelectorAll('[class]')) classAtBoot.set(cssPath(x), String(x.className)); const bootClass = x => classAtBoot.get(cssPath(x));
  const inputSelectors = [...d.querySelectorAll('input, textarea'), ...d.querySelectorAll('select')].map(el => el.id ? '#' + el.id : (el.name ? `${el.tagName.toLowerCase()}[name="${el.name}"]` : null)).filter(Boolean);
  for (const sel of inputSelectors) {
    await ensureClean(); const el = d.querySelector(sel); if (!el) continue;
    if (el.tagName === 'SELECT') {
      const map = []; let key = null; const bootIdx = el.selectedIndex;
      for (let i = 0; i < el.options.length; i++) { if (el.selectedIndex === i && el.options.length > 1) { await diffAfter(() => { el.selectedIndex = (i + 1) % el.options.length; fire(el, 'input'); fire(el, 'change'); }); } // leave it first so selecting it is a change the page reports
        const r = await diffAfter(() => { el.selectedIndex = i; fire(el, 'input'); fire(el, 'change'); }); const k = single(r.changed); if (k) { key = key || k; map.push({ index: i, value: el.options[i].value, label: el.options[i].text.trim(), param: r.after[k] }); } }
      dirty = true;
      if (key) consider(key, { selector: sel, kind: 'select', options: map, quality: 9 });
      else if (el.options.length > 1) { // the select rebuilds the model: expose it by option index
        const r = await diffAfter(() => { el.selectedIndex = (bootIdx + 1) % el.options.length; fire(el, 'input'); fire(el, 'change'); }); await diffAfter(() => { el.selectedIndex = bootIdx; fire(el, 'input'); fire(el, 'change'); });
        if (r.posts && r.posts.length) { const options = [...el.options].map((o, i) => ({ index: i, value: o.value, label: o.text.trim(), param: i })); const name = uiId(el);
          consider(name, { selector: sel, kind: 'select', options, quality: 7, uiParam: { type: 'choice', default: bootIdx, name: labelFor(el), choices: options.map(o => ({ label: o.label, value: o.param })) } });
          probeLog.push(`${sel}: select -> no plain parameter; model rebuild per option -> ${name}`); }
      }
      continue;
    }
    const type = (el.type || 'text').toLowerCase();
    if (type === 'checkbox' || type === 'radio') { // jsdom re-toggles a checkbox nested in its <label> on click(); set the state directly like a real toggle would, click() only as fallback
      const toggle = () => { el.checked = !el.checked; fire(el, 'input'); fire(el, 'change'); };
      let r1 = await diffAfter(toggle); let k = single(r1.changed, el.id || el.name); if (k) await diffAfter(toggle); else { r1 = await diffAfter(() => clickEl(el)); k = single(r1.changed, el.id || el.name); await diffAfter(() => clickEl(el)); }
      probeLog.push(`${sel}: checkbox -> ${k} ${JSON.stringify(r1.changed)}`); if (k) consider(k, { selector: sel, kind: 'checkbox', onValue: el.checked ? r1.changed[k].from : r1.changed[k].to, offValue: el.checked ? r1.changed[k].to : r1.changed[k].from, quality: 9 }); continue; }
    if (type === 'range' || type === 'number') {
      const min = parseFloat(el.min), max = parseFloat(el.max); if (!isFinite(min) || !isFinite(max)) continue; const orig = el.value;
      const r1 = await diffAfter(() => { el.value = String(min); fire(el, 'input'); fire(el, 'change'); }); const r2 = await diffAfter(() => { el.value = String(max); fire(el, 'input'); fire(el, 'change'); });
      const union = Object.assign({}, r1.changed, r2.changed); const macro = isMacro(union);
      let k = macro ? null : (single(r2.changed, el.id || el.name) || single(r1.changed, el.id || el.name));
      let nonlinear = false;
      if (k) { // the replay maps slider -> leaf linearly; a lookup-table slider (dB steps, tapers) is not linear: check the midpoint
        const pMin = r1.after ? r1.after[k] : undefined, pMax = r2.after[k];
        if (typeof pMin === 'number' && typeof pMax === 'number' && pMax !== pMin) for (const f of [0.25, 0.5, 0.75]) { // three interior points against the straight line
          const r3 = await diffAfter(() => { el.value = String(min + (max - min) * f); fire(el, 'input'); fire(el, 'change'); }); const pv = r3.after ? r3.after[k] : undefined;
          if (typeof pv !== 'number') continue; const lin = pMin + (pMax - pMin) * ((+el.value - min) / (max - min)); if (Math.abs(pv - lin) > 0.01 * Math.abs(pMax - pMin)) { nonlinear = true; break; }
        }
        if (!nonlinear) { const a = (pMax - pMin) / (max - min); consider(k, { selector: sel, kind: 'range', min, max, step: parseFloat(el.step) || 0, paramAtMin: pMin, paramAtMax: pMax, scale: a, offset: pMin - a * min, quality: 10 }); }
      }
      if ((macro || nonlinear) && !junkControl(el) && (r1.posts && r1.posts.length || r2.posts && r2.posts.length)) {
        const name = uiId(el); const keys = Object.keys(union).filter(x => !structuralOnly[x]);
        consider(name, { selector: sel, kind: 'range-ui', min, max, step: parseFloat(el.step) || 0, drives: keys, quality: 9, uiParam: { type: 'float', min, max, step: parseFloat(el.step) || 0, default: parseFloat(orig), name: labelFor(el) } });
        probeLog.push(`${sel}: range -> ${macro ? 'moves several parameters (' + keys.join(', ') + ')' : 'non-linear mapping to ' + k}; exposed as its own control ${name} [${min}, ${max}] driven through the page`);
      }
      el.value = orig; fire(el, 'input'); fire(el, 'change'); await sleep(20); flush();
      continue;
    }
  }
  // buttons / divs: click toggles & cycles, wheel knobs, pointer-drag knobs
  const others = [...new Set([...d.querySelectorAll('[id]'), ...d.querySelectorAll('button, [role=button]'), ...d.querySelectorAll('*')].filter(el => el.dataset && Object.keys(el.dataset).length || el.id || el.tagName === 'BUTTON' || /knob|dial|slider|fader|hit|handle|thumb|toggle|switch|lever|btn|button|pad|key|control|rotary|encoder/i.test(String(el.className))))].filter(el => !['INPUT', 'SELECT', 'TEXTAREA', 'SCRIPT', 'STYLE', 'CANVAS', 'SVG', 'BODY', 'HTML', 'HEAD', 'META', 'LINK', 'TITLE'].includes(el.tagName) && !(startControl && startControl.clicks !== 2 && el.id && el.id === startControl.id));   // a toggle-type start control keeps the graph: probe it like any control
  // Segmented "model" switches (style/mode/type groups where one sibling carries a state class) can leave the page in a state
  // that is not the boot state even after switching back (the page may re-derive knob mappings). Probe them last so the plain
  // controls are measured in the boot state, and move the <select>s to the end of the input pass for the same reason.
  const deferScore = el => { let sc = 0; const txt = ((el.id || '') + ' ' + (el.textContent || '').trim().slice(0, 30)).toLowerCase(); if (/mode|style|type|model|topology|circuit|variant|version/.test(txt)) sc += 2;
    const p = el.parentElement; if (p) { const sibs = [...p.children].filter(c => c !== el && c.nodeType === 1 && c.tagName === el.tagName); const mine = String(el.className).split(/\s+/); if (sibs.some(c => String(c.className).split(/\s+/).some(k => k && !mine.includes(k)) || mine.some(k => k && !String(c.className).split(/\s+/).includes(k)))) sc += 1; } return sc; };
  others.sort((a, b) => deferScore(a) - deferScore(b));
  const otherSelectors = others.map(el => el.id ? '#' + el.id : cssPath(el));
  for (const sel of otherSelectors) {
    await ensureClean(); const el = d.querySelector(sel); if (!el) continue;
    const idText = (el.id + ' ' + el.className + ' ' + (el.textContent || '').trim().slice(0, 30)).toLowerCase(); if (/export|download|legend|learn|help|close|modal|reset|cal now|cal-now/.test(idText)) continue;
    // wheel
    const vis0 = snapshotVisual(el);
    const rw = await diffAfter(() => { fire(el, 'wheel', { deltaY: -100 }); }); let kw = isMacro(rw.changed) ? null : single(rw.changed);
    if (!kw && rw.posts && rw.posts.length) {   // the wheel reached the DSP but carries no plain value: follow the control's visual state
      const ind = findIndicator(el, vis0);
      if (ind && !junkControl(el)) {
        const read = () => readVisual(ind.x, ind.how); const v0 = read(); let hi = v0, lo = v0, up = 0, down = 0;
        for (let i = 0; i < 400; i++) { const b = read(); fire(el, 'wheel', { deltaY: -100 }); const a = read(); if (a === b) break; hi = a; up++; }   // visual state updates synchronously: no settle needed
        for (let i = 0; i < 800; i++) { const b = read(); fire(el, 'wheel', { deltaY: 100 }); const a = read(); if (a === b) break; lo = a; down++; }
        dirty = true;
        const inverted = lo > hi; if (inverted) { const t = lo; lo = hi; hi = t; }
        const ticks = down; const bootValue = vis0.get(ind.x)[ind.how]; const pos = v => (v - lo) / (hi - lo || 1);
        const indicator = cssPath(ind.x); const dup = Object.values(bindings).some(b => b.indicator === indicator);   // the same knob seen through a child element
        if (ticks >= 2 && hi !== lo && !dup) {
          const name = uiId(el);
          consider(name, { selector: sel, kind: 'wheel-visual', indicator, read: ind.how, vmin: lo, vmax: hi, inverted, ticks, quality: 6, uiParam: { type: 'float', min: 0, max: 1, default: Math.min(1, Math.max(0, inverted ? 1 - pos(bootValue) : pos(bootValue))), name: labelFor(el) } });
          probeLog.push(`${sel}: wheel -> no plain parameter; visual ${ind.how} on ${indicator} spans [${lo}, ${hi}] over ${ticks} ticks -> ${name}`);
        }
        // restore the boot position
        { const target = inverted ? 1 - pos(bootValue) : pos(bootValue); const n = Math.round(target * ticks); for (let i = 0; i < n; i++) fire(el, 'wheel', { deltaY: -100 }); await sleep(20); flush(); }
        if (ticks >= 2 && hi !== lo) continue;   // (duplicates fall through to the regular probes, which will find nothing new)
      }
    }
    if (kw) {
      const step = rw.changed[kw].to - rw.changed[kw].from; let lo = rw.after[kw], hi = rw.after[kw];
      const up = [rw.changed[kw].from, rw.after[kw]], down = [];   // every value the key takes, in wheel-up order (a lookup-table knob is not evenly spaced)
      for (let i = 0; i < 400; i++) { const r = await diffAfter(() => fire(el, 'wheel', { deltaY: -100 })); if (!r.changed[kw]) break; hi = r.changed[kw].to; up.push(hi); }
      for (let i = 0; i < 800; i++) { const r = await diffAfter(() => fire(el, 'wheel', { deltaY: 100 })); if (!r.changed[kw]) break; lo = r.changed[kw].to; down.push(lo); }
      const near = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)); const idxOf = (arr, v) => arr.findIndex(x => near(x, v));   // float noise between the up and down sweeps
      const seq = [...down.slice().reverse(), ...up.filter(v => idxOf(down, v) < 0)].filter((v, i, a) => idxOf(a, v) === i);
      const diffs = seq.slice(1).map((v, i) => v - seq[i]); const even = diffs.length > 0 && diffs.every(d => Math.abs(Math.abs(d) - Math.abs(diffs[0])) <= 1e-6 * Math.max(1, Math.abs(diffs[0])) && Math.sign(d) === Math.sign(diffs[0]));
      const vmin = Math.min(...seq), vmax = Math.max(...seq);
      consider(kw, Object.assign({ selector: sel, kind: 'wheel', step: Math.abs(step), min: vmin, max: vmax, quality: 7 }, even ? {} : { seq }));
      probeLog.push(`${sel}: wheel -> ${kw} ${even ? `step ${step} range [${vmin}, ${vmax}]` : `${seq.length} stepped values ${JSON.stringify(seq)} (not evenly spaced: exposed as a choice)`}`);
      // restore towards boot value
      // restore towards the boot value one awaited tick at a time: knobs with wheel acceleration treat a burst of events as one big move
      // Walk back to the boot value one awaited tick at a time, re-reading the value each time and reversing when the page's
      // wheel acceleration overshoots. If it cannot be reached exactly the page is re-created before the next probe.
      const target = lastParams[kw];
      if (typeof target === 'number') {
        let cur = paramsNow()[kw], guard = 0, reached = false;
        while (guard++ < seq.length * 3 + 8) {
          const ci = idxOf(seq, cur), ti = idxOf(seq, target); let dir;
          if (ci >= 0 && ti >= 0) { if (ci === ti) { reached = true; break; } dir = ci < ti ? -100 : 100; }
          else { if (Math.abs(cur - target) <= Math.abs(step) / 2) { reached = true; break; } dir = (cur < target) === (seq[seq.length - 1] > seq[0]) ? -100 : 100; }
          const r = await diffAfter(() => fire(el, 'wheel', { deltaY: dir })); if (!r.changed[kw]) break; cur = r.changed[kw].to;
        }
        if (!reached && !near(paramsNow()[kw], target)) { dirty = true; probeLog.push(`${sel}: could not wheel ${kw} back to its boot value ${target} (at ${paramsNow()[kw]}); page re-created`); }
      }
    }
    // pointer drag (vertical): small drag to detect, then slam to both ends to learn the page's clamps, then restore the boot value
    let dragEvents = 'pointer';
    const pd = (dy) => { // a real drag is many move events; pages that sync linked controls one event late need the extra moves
      const mouse = dragEvents === 'mouse';
      const P = (type, y, extra) => fire(el, mouse ? type.replace('pointer', 'mouse') : type, Object.assign({ clientX: 50, clientY: y, screenX: 50, screenY: y }, mouse ? {} : { pointerId: 1, isPrimary: true, pointerType: 'mouse' }, extra));
      P('pointerdown', 400, { button: 0, buttons: 1 }); for (const f of [0.25, 0.5, 0.75, 1, 1]) P('pointermove', 400 - dy * f, { buttons: 1 }); P('pointerup', 400 - dy, { button: 0, buttons: 0 });
    };
    const hint = el.id || (el.parentElement && el.parentElement.querySelector && (el.parentElement.querySelector('input[id]') || {}).id) || el.className;
    let dragPx = 20, rp = await diffAfter(() => pd(dragPx));
    if (!Object.keys(rp.changed).length) { dragPx = 200; rp = await diffAfter(() => pd(dragPx)); } // coarse-stepped knobs need more travel before they tick
    if (!Object.keys(rp.changed).length) { dragEvents = 'mouse'; dragPx = 20; rp = await diffAfter(() => pd(dragPx)); if (!Object.keys(rp.changed).length) { dragPx = 200; rp = await diffAfter(() => pd(dragPx)); } } // pages on mousedown/mousemove instead of pointer events
    const kp = single(rp.changed, hint);
    if (!kp && /hit|knob/i.test(String(el.className))) probeLog.push(`${sel} (${hint}): drag -> nothing ${JSON.stringify(rp.changed)}${rp.err ? ' error: ' + rp.err : ''}${process.env.H2P_DEBUG ? ' state ' + JSON.stringify(paramsNow()) : ''}`);
    if (kp) {
      const perPx = (rp.changed[kp].to - rp.changed[kp].from) / dragPx;
      await diffAfter(() => pd(4000)); let hi = paramsNow()[kp]; await diffAfter(() => pd(-8000)); let lo = paramsNow()[kp];
      if (typeof lo === 'number' && typeof hi === 'number' && lo > hi) { const t = lo; lo = hi; hi = t; }
      const span = Math.abs(hi - lo), bounded = typeof lo === 'number' && typeof hi === 'number' && isFinite(span) && span < 0.6 * 12000 * Math.abs(perPx); // a page without clamps would have travelled the full 12000 px
      // response curve: knobs are rarely linear in the posted unit (dB knobs post linear gain, log frequency knobs post Hz).
      // From the end stop we are at now, walk the whole travel in 20 px steps and record (px, value); the plugin inverts it.
      let curve = null;
      if (bounded) {
        curve = []; let cum = 0, cur = paramsNow()[kp], flat = 0; curve.push([0, cur]);
        for (let i = 0; i < 400 && flat < 3; i++) { await diffAfter(() => pd(10)); cum += 10; const v = paramsNow()[kp]; if (typeof v !== 'number') break; if (v === cur) flat++; else flat = 0; cur = v; curve.push([cum, v]); }
        while (curve.length > 1 && curve[curve.length - 1][1] === curve[curve.length - 2][1]) curve.pop();
        if (curve.length < 3) curve = null;
      }
      // interpolation domain: a dB/log knob has (nearly) constant ratios between steps, a linear one constant differences
      let curveLog = false;
      if (curve && curve.every(([, v]) => v > 0)) {
        const cv = xs => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length) / (Math.abs(m) || 1); };
        const dl = [], dg = []; for (let i = 1; i < curve.length; i++) { dl.push(curve[i][1] - curve[i - 1][1]); dg.push(Math.log(curve[i][1]) - Math.log(curve[i - 1][1])); }
        curveLog = cv(dg) < cv(dl);
      }
      const b = { selector: sel, kind: 'drag', events: dragEvents, unitsPerPixelUp: perPx, min: bounded ? lo : (bindings[kp] && bindings[kp].min), max: bounded ? hi : (bindings[kp] && bindings[kp].max), wheelStep: bindings[kp] && bindings[kp].step, curve, curveLog, quality: bounded ? 9 : 8 }; consider(kp, b);
      probeLog.push(`${sel} (${hint}): ${dragEvents}-drag -> ${kp} ${perPx}/px${bounded ? ` clamps [${lo}, ${hi}]` : ''}${curve ? `, curve ${curve.length} points over ${curve[curve.length - 1][0]} px (${curveLog ? 'log' : 'linear'} interpolation)` : ''}`);
      // restore towards boot value (we are at the low end now if bounded, else 20 px below where we started)
      const target = lastParams[kp];
      if (bounded && typeof target === 'number' && perPx) {
        const cur = paramsNow()[kp];
        if (curve) { const f = curveLog ? Math.log : (x => x); const pxOf = v => { const c = curve, inc = c[c.length - 1][1] >= c[0][1]; let i = 0; while (i < c.length - 2 && (inc ? c[i + 1][1] < v : c[i + 1][1] > v)) i++; const [p0, v0] = c[i], [p1, v1] = c[i + 1]; return v1 === v0 ? p0 : p0 + (f(v) - f(v0)) * (p1 - p0) / (f(v1) - f(v0)); }; pd(pxOf(target) - pxOf(cur)); }
        else pd((target - cur) / perPx);
      } else pd(-20 + 4000 - 8000 > 0 ? 0 : 4000); 
      await sleep(20); flush();
    }
    if (kw || kp) continue;
    // click: toggle or cycle
    const seq = []; let key = null; let sawStructural = false, anyPosts = false;
    for (let i = 0; i < 8; i++) { const r = await diffAfter(() => clickEl(el)); if (r.posts && r.posts.length) anyPosts = true; if (r.posts && r.posts.some(isStructural)) sawStructural = true; const k = single(r.changed, el.id || el.textContent.trim().slice(0, 24), groupHint(el)); if (!k || (key && k !== key)) break; key = k; seq.push(r.after[k]); if (seq.length >= 2 && r.after[k] === seq[0] && i >= 1) break; }
    const c0 = bootClass(el);
    const restoreState = async () => { // re-click the sibling that lost its boot class, else the element itself, so later probes run in the boot state
      if (c0 == null || String(el.className) === c0) return; let fixed = false;
      if (el.parentElement) for (const sib of el.parentElement.children) { if (sib === el) continue; const b0 = (bootClass(sib) || '').split(/\s+/), bn = String(sib.className).split(/\s+/); if (b0.some(c => c && !bn.includes(c))) { clickEl(sib); await sleep(50); flush(); fixed = true; } }
      if (!fixed || String(el.className) !== c0) { clickEl(el); await sleep(50); flush(); }
    };
    const noteStateClick = () => { const c1 = String(el.className); if (c0 == null || c1 === c0) return; const added = c1.split(/\s+/).filter(c => c && !c0.split(/\s+/).includes(c)); if (added.length) stateClicks.push({ el, sel, added }); };
    if (!key) { const r = await diffAfter(() => clickEl(el)); if (r.posts && r.posts.length) anyPosts = true; if (r.posts && r.posts.length && !junkControl(el)) noteStateClick(); await restoreState(); }
    if (anyPosts || (c0 != null && String(el.className) !== c0)) dirty = true;   // the click reached the DSP or changed UI state: next control gets a fresh page (inert elements cost no reboot)
    if (key && seq.length) { const uniq = [...new Set(seq)]; const label = (el.textContent || '').trim().slice(0, 30) || el.id;
      if (uniq.length === 1 && sawStructural) { noteStateClick(); await restoreState(); probeLog.push(`${sel}: click rebuilds the model (structural message); ${key}=${uniq[0]} is a side effect -> treated as a UI-state switch`); }   // model switch: exposed through its own state, not the incidental key
      else if (uniq.length === 1) { clickResults.push({ selector: sel, label, key, value: uniq[0] }); noteStateClick(); await restoreState(); }   // one button = one value (segmented group member)
      else if (uniq.length === 2 && seq.length <= 3) consider(key, { selector: sel, kind: 'click-toggle', values: uniq, quality: 8 }); else consider(key, { selector: sel, kind: 'click-cycle', values: uniq, quality: 5 });
      probeLog.push(`${sel}: click -> ${key} ${JSON.stringify(uniq)}`); }
  }
  // segmented groups: several single-value buttons driving the same key => choice binding
  const byKey = {}; for (const r of clickResults) (byKey[r.key] = byKey[r.key] || []).push(r);
  // second pass: group members that were already 'active' at boot produced no change when clicked. Click a known member first (fresh
  // page), then each sibling the first pass did not resolve, so every button of the group gets its value.
  for (const key in byKey) {
    await ensureClean(); const el = d.querySelector(byKey[key][0].selector); const parent = el && el.parentElement; if (!parent) continue;
    const known = new Set(byKey[key].map(r => r.selector));
    const missing = [...parent.children].filter(c => c.nodeType === 1 && c.tagName === el.tagName && !known.has(cssPath(c)) && !junkControl(c));
    if (!missing.length) continue;
    for (const sib of missing) {
      const other = byKey[key].find(r => r.selector !== cssPath(sib)); const oel = other && d.querySelector(other.selector); if (oel) await diffAfter(() => clickEl(oel));   // leave the sibling's state so selecting it is a change
      const r = await diffAfter(() => clickEl(sib)); const k = single(r.changed, sib.id || sib.textContent.trim().slice(0, 24), groupHint(sib));
      if (process.env.H2P_DEBUG) probeLog.push(`  second pass ${key} ${cssPath(sib)} -> ${JSON.stringify(r.changed)} k=${k}`);
      if (k === key) byKey[key].push({ selector: cssPath(sib), label: (sib.textContent || '').trim().slice(0, 30), key, value: r.after[k] });
    }
    dirty = true;   // the group was left in a non-boot state: next group gets a fresh page
  }
  for (const key in byKey) { const opts = []; for (const r of byKey[key]) if (!opts.some(o => o.value === r.value)) opts.push({ selector: r.selector, label: r.label, value: r.value });
    if (valuesSeen[key] && valuesSeen[key].size > opts.length + 1 && byKey[key].some(r => stateClicks.some(sc => sc.sel === r.selector))) { probeLog.push(`${key}: changed by ${byKey[key].map(r => r.selector).join(', ')} but took ${valuesSeen[key].size} distinct values during probing -> derived side effect, not the buttons' value`); continue; } if (typeof lastParams[key] === 'number' && !opts.some(o => o.value === lastParams[key])) { /* boot value not reachable by a probed button: still fine, host default maps to nearest */ } if (opts.length >= 2) consider(key, { selector: opts[0].selector, kind: 'choice', options: opts.sort((a, b) => { const A = d.querySelector(a.selector), B = d.querySelector(b.selector); return A && B && A !== B ? ((A.compareDocumentPosition(B) & 4) ? -1 : 1) : a.value - b.value; }), quality: 9 }); else if (opts.length === 1) consider(key, { selector: opts[0].selector, kind: 'click-set', value: opts[0].value, quality: 3 }); }
  // state-only clicks: siblings that each add the same class (segmented style/mode switches) => ui_ choice; lone toggles => ui_ bool
  { const groups = new Map();
    await ensureClean(); for (const sc of stateClicks) sc.el = d.querySelector(sc.sel);   // fresh page: re-resolve the elements
    for (const sc of stateClicks.filter(sc => sc.el)) { const parent = sc.el.parentElement; const k = parent ? cssPath(parent) + '|' + sc.added[0] : sc.sel; (groups.get(k) || groups.set(k, []).get(k)).push(sc); }
    for (const [k, members] of groups) {
      const cls = members[0].added[0];
      const taken = members.every(m => Object.values(bindings).some(b => b.selector === m.sel || (b.options || []).some(o => o.selector === m.sel)));
      if (taken) continue;   // already a proper parameter control (e.g. STEREO/MONO buttons -> mono)
      if (members.length === 1 && members[0].el.parentElement) { // the partner button already carried the class at boot, so its own click changed nothing: pull it in
        const m0 = members[0]; for (const c of m0.el.parentElement.children) if (c !== m0.el && c.tagName === m0.el.tagName && (bootClass(c) || '').split(/\s+/).includes(cls) && !junkControl(c)) members.push({ el: c, sel: cssPath(c), added: [cls] });
        members.sort((a, b) => (a.el.compareDocumentPosition(b.el) & 4) ? -1 : 1);
      }
      if (members.length >= 2) {
        const parent = members[0].el.parentElement; const options = members.map((m, i) => ({ selector: m.sel, label: (m.el.textContent || '').trim().slice(0, 30) || m.el.id, value: i }));
        const bootIdx = Math.max(0, members.findIndex(m => (bootClass(m.el) || '').split(/\s+/).includes(cls)));
        const name = 'ui_' + String(parent && parent.id ? parent.id : members[0].el.id || k).replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
        consider(name, { selector: members[0].sel, kind: 'state-choice', className: cls, options, quality: 6, uiParam: { type: 'choice', default: bootIdx, name: labelFor(parent || members[0].el), choices: options.map(o => ({ label: o.label, value: o.value })) } });
        probeLog.push(`${k}: ${members.length} buttons toggle .${cls} and post to the DSP -> ${name} (choice)`);
      } else {
        const m = members[0]; const name = uiId(m.el); const bootOn = (bootClass(m.el) || '').split(/\s+/).includes(cls);
        consider(name, { selector: m.sel, kind: 'state-toggle', className: cls, quality: 5, uiParam: { type: 'bool', default: bootOn ? 1 : 0, name: labelFor(m.el) } });
        probeLog.push(`${m.sel}: click toggles .${cls} and posts to the DSP -> ${name} (bool)`);
      }
    }
  }
  // put the page back to its boot state as far as the probes changed it (DSP-side: we never ship this DOM, so it only matters for consistency of lastParams)
  const uiSize = { width: Math.max(d.documentElement.scrollWidth || 0, 900), height: Math.max(d.documentElement.scrollHeight || 0, 600) };
  const title = (d.title || '').trim();
  w.close();
  const structuralPosts = structuralSeen;
  probeLog.push(`page re-created ${reboots - 1} time(s) so every control was probed from the boot state`);
  return { bootOps, modules, unresolvedModules, addModuleUrls, workletIds, bootParams: lastParams, structuralOnly, structuralPosts, bindings, probeLog, startControl, errors, consoleLog, title, uiSize };
}

module.exports = { bootPage, flattenParams, syntheticWavBytes };
