/* Boot the pasted page headlessly (jsdom) against the WebView shim, record the Web Audio ops the page issues,
 * capture worklet module text from Blob URLs, auto-press the start/power control, then empirically probe every UI control
 * to learn which DSP parameter it drives and how (range/select/checkbox/click/wheel/pointer-drag). */
const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('fs'); const path = require('path');
const SHIM = fs.readFileSync(path.join(__dirname, '..', 'runtime', 'webaudio-shim.js'), 'utf8');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const START_RX = /^(power|start|on|run|init|enable|engage|activate|go|begin|arm|audio|mic|input|connect|boot|play|bypass)\b|power|start|engage|enable/i;

function flattenParams(data, into) {
  // numeric/boolean leaves of a message, keyed by leaf name; also {name|key|id|param, value|val|v} shapes
  into = into || {};
  if (!data || typeof data !== 'object' || Array.isArray(data)) return into;
  const kf = ['name', 'key', 'id', 'param', 'parameter'].find(k => typeof data[k] === 'string');
  const vf = ['value', 'val', 'v'].find(k => typeof data[k] === 'number' || typeof data[k] === 'boolean');
  if (kf && vf) { into[data[kf]] = +data[vf]; return into; }
  for (const k in data) { const v = data[k]; if (k === 'type') continue; if (typeof v === 'number' || typeof v === 'boolean') into[k] = +v; else if (v && typeof v === 'object' && !Array.isArray(v)) flattenParams(v, into); }
  return into;
}

async function bootPage(html, opts = {}) {
  const sampleRate = opts.sampleRate || 48000; const timeoutMs = opts.timeoutMs || 2500;
  const vc = new VirtualConsole(); const consoleLog = []; vc.on('error', m => consoleLog.push('error: ' + m)); vc.on('warn', () => { }); vc.on('log', m => { if (!String(m).startsWith('[h2p]')) consoleLog.push(String(m).slice(0, 200)); }); vc.on('jsdomError', e => consoleLog.push('jsdom: ' + (e && e.message || e).toString().slice(0, 200)));
  const ops = []; let recv = null; const blobs = {}; let bn = 0; const addModuleUrls = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, url: 'https://plugin.local/index.html',
    beforeParse(w) {
      w.__h2p_init = { sampleRate }; w.__h2p_transport = { send: o => ops.push(...o), onReceive: f => { recv = f; } };
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
      w.eval(SHIM);
      // remember which URLs went to addModule so blob text can be matched to modules
      const P = w.AudioContext.prototype; const orig = P._addModule; P._addModule = function (url) { addModuleUrls.push(String(url)); return orig.call(this, url); };
    },
  });
  const w = dom.window; const d = w.document;
  const errors = []; w.addEventListener('error', e => errors.push(String(e.message || e.error)));
  const flush = () => { try { w.__h2p.flush(); } catch (e) { } };
  await sleep(250); flush();
  const graphBuilt = () => ops.some(o => o.op === 'create' && o.type === 'AudioWorklet') || ops.some(o => o.op === 'connect');
  // auto-start: click the most plausible start control if the graph has not been built by the page itself
  let startControl = null;
  if (!graphBuilt()) {
    const cands = [...d.querySelectorAll('button, [role=button], .btn, .toggle, .switch, .power, [id], input[type=checkbox]')].filter(el => el.id || el.textContent);
    const score = el => { const t = ((el.id || '') + ' ' + (el.className || '') + ' ' + (el.textContent || '').trim().slice(0, 40)).toLowerCase(); let s = 0; if (/power/.test(t)) s += 10; if (/\bstart\b|engage|enable|init/.test(t)) s += 6; if (/\bon\b|run|activate|arm|connect|mic|input/.test(t)) s += 2; if (/export|download|save|stop|close|legend|learn|help|tech|reset|cal/.test(t)) s -= 8; if (el.tagName === 'BUTTON') s += 1; return s; };
    cands.sort((a, b) => score(b) - score(a));
    for (const el of cands.slice(0, 6)) { if (score(el) <= 0) break; const cls0 = el.className, chk0 = el.checked; el.click(); await sleep(400); flush(); if (!graphBuilt() && (el.className !== cls0 || el.checked !== chk0)) { el.click(); await sleep(100); flush(); } if (graphBuilt()) { startControl = { id: el.id || null, text: (el.textContent || '').trim().slice(0, 40), selector: el.id ? '#' + el.id : null }; break; } }
  }
  const deadline = Date.now() + timeoutMs; while (Date.now() < deadline && !graphBuilt()) { await sleep(100); flush(); }
  await sleep(300); flush();
  const bootOps = ops.filter(o => o.op !== 'log');   // page console forwarding is not part of the graph
  // which blob urls were worklet modules
  const modules = {}; for (const u of addModuleUrls) if (blobs[u]) modules[u] = blobs[u];
  const unresolvedModules = addModuleUrls.filter(u => !blobs[u]);
  // boot params = last message state per worklet node
  const lastParams = {}; for (const o of bootOps) if (o.op === 'post') flattenParams(o.data, lastParams);
  const workletIds = bootOps.filter(o => o.op === 'create' && o.type === 'AudioWorklet').map(o => o.id);

  /* ---------------- probe UI controls ---------------- */
  const bindings = {}; const probeLog = [];
  const paramsNow = () => { const p = {}; for (const o of ops) if (o.op === 'post' && workletIds.includes(o.id)) flattenParams(o.data, p); return p; };
  const settle = async () => { let n = -1, quiet = 0; for (let t = 0; t < 12 && quiet < 2; t++) { await sleep(25); flush(); if (ops.length === n) quiet++; else { quiet = 0; n = ops.length; } } }; // wait until the page stops posting (debounced / rAF handlers)
  const diffAfter = async (action) => { await settle(); const before = paramsNow(); const n0 = ops.length; try { action(); } catch (e) { return { changed: {}, err: String(e) }; } await settle(); const after = paramsNow(); const changed = {}; for (const k in after) if (before[k] !== after[k] && ops.slice(n0).some(o => o.op === 'post')) changed[k] = { from: before[k], to: after[k] }; return { changed, after, posts: ops.slice(n0).filter(o => o.op === 'post').map(o => o.data) }; };
  const norm = x => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const single = (ch, hint) => { // one control usually moves one parameter; when several move (linked channels, derived values) prefer the one named like the control
    const ks = Object.keys(ch); if (ks.length <= 1) return ks[0] || null;
    const h = norm(hint); if (h) { const hit = ks.find(k => norm(k) === h) || ks.find(k => h.includes(norm(k)) || norm(k).includes(h)); if (hit) return hit; }
    return ks[0];
  };
  const fire = (el, type, init) => { const Ev = type.startsWith('pointer') ? w.PointerEvent || w.MouseEvent : type === 'wheel' ? w.WheelEvent : type.startsWith('mouse') ? w.MouseEvent : w.Event; el.dispatchEvent(new Ev(type, Object.assign({ bubbles: true, cancelable: true, composed: true }, init || {}))); };
  const consider = (name, b) => { if (!bindings[name] || (b.quality || 0) > (bindings[name].quality || 0)) bindings[name] = b; };

  if (opts.probeHook) await opts.probeHook({ d, w, diffAfter, fire, paramsNow, flush });
  const inputs = [...d.querySelectorAll('input, select, textarea')];
  for (const el of inputs) {
    const sel = el.id ? '#' + el.id : (el.name ? `${el.tagName.toLowerCase()}[name="${el.name}"]` : null); if (!sel) continue;
    if (el.tagName === 'SELECT') {
      const map = []; let key = null;
      for (let i = 0; i < el.options.length; i++) { if (el.selectedIndex === i && el.options.length > 1) { await diffAfter(() => { el.selectedIndex = (i + 1) % el.options.length; fire(el, 'input'); fire(el, 'change'); }); } // leave it first so selecting it is a change the page reports
        const r = await diffAfter(() => { el.selectedIndex = i; fire(el, 'input'); fire(el, 'change'); }); const k = single(r.changed); if (k) { key = key || k; map.push({ index: i, value: el.options[i].value, label: el.options[i].text.trim(), param: r.after[k] }); } }
      if (key) consider(key, { selector: sel, kind: 'select', options: map, quality: 9 });
      continue;
    }
    const type = (el.type || 'text').toLowerCase();
    if (type === 'checkbox' || type === 'radio') { // jsdom re-toggles a checkbox nested in its <label> on click(); set the state directly like a real toggle would, click() only as fallback
      const toggle = () => { el.checked = !el.checked; fire(el, 'input'); fire(el, 'change'); };
      let r1 = await diffAfter(toggle); let k = single(r1.changed, el.id || el.name); if (k) await diffAfter(toggle); else { r1 = await diffAfter(() => el.click()); k = single(r1.changed, el.id || el.name); await diffAfter(() => el.click()); }
      probeLog.push(`${sel}: checkbox -> ${k} ${JSON.stringify(r1.changed)}`); if (k) consider(k, { selector: sel, kind: 'checkbox', onValue: el.checked ? r1.changed[k].from : r1.changed[k].to, offValue: el.checked ? r1.changed[k].to : r1.changed[k].from, quality: 9 }); continue; }
    if (type === 'range' || type === 'number') {
      const min = parseFloat(el.min), max = parseFloat(el.max); if (!isFinite(min) || !isFinite(max)) continue; const orig = el.value;
      const r1 = await diffAfter(() => { el.value = String(min); fire(el, 'input'); fire(el, 'change'); }); const r2 = await diffAfter(() => { el.value = String(max); fire(el, 'input'); fire(el, 'change'); });
      const k = single(r2.changed, el.id || el.name) || single(r1.changed, el.id || el.name);
      if (k) { const pMin = r1.after ? r1.after[k] : undefined, pMax = r2.after[k]; const a = (pMax - pMin) / (max - min); consider(k, { selector: sel, kind: 'range', min, max, step: parseFloat(el.step) || 0, paramAtMin: pMin, paramAtMax: pMax, scale: a, offset: pMin - a * min, quality: 10 }); }
      el.value = orig; fire(el, 'input'); fire(el, 'change'); await sleep(20); flush();
      continue;
    }
  }
  // buttons / divs: click toggles & cycles, wheel knobs, pointer-drag knobs
  const cssPath = (el) => { if (el.id) return '#' + CSS_escape(el.id); const parts = []; let cur = el; while (cur && cur.nodeType === 1 && cur !== d.body && cur !== d.documentElement) { if (cur.id) { parts.unshift('#' + CSS_escape(cur.id)); break; } const parent = cur.parentElement; const idx = parent ? [...parent.children].indexOf(cur) + 1 : 1; parts.unshift(cur.tagName.toLowerCase() + `:nth-child(${idx})`); cur = parent; } return parts.join(' > '); };
  const CSS_escape = s => String(s).replace(/([^a-zA-Z0-9_-])/g, '\\$1');
  const clickResults = []; // {selector, label, key, value}
  const others = [...new Set([...d.querySelectorAll('[id]'), ...d.querySelectorAll('button, [role=button]'), ...d.querySelectorAll('*')].filter(el => el.dataset && Object.keys(el.dataset).length || el.id || el.tagName === 'BUTTON' || /knob|dial|slider|fader|hit|handle|thumb|toggle|switch|lever|btn|button|pad|key|control|rotary|encoder/i.test(String(el.className))))].filter(el => !['INPUT', 'SELECT', 'TEXTAREA', 'SCRIPT', 'STYLE', 'CANVAS', 'SVG', 'BODY', 'HTML', 'HEAD', 'META', 'LINK', 'TITLE'].includes(el.tagName) && !(startControl && el.id && el.id === startControl.id));
  for (const el of others) {
    const sel = cssPath(el); const idText = (el.id + ' ' + el.className + ' ' + (el.textContent || '').trim().slice(0, 30)).toLowerCase(); if (/export|download|legend|learn|help|close|modal|reset|cal now|cal-now/.test(idText)) continue;
    // wheel
    const rw = await diffAfter(() => { fire(el, 'wheel', { deltaY: -100 }); }); const kw = single(rw.changed);
    if (kw) {
      const step = rw.changed[kw].to - rw.changed[kw].from; let lo = rw.after[kw], hi = rw.after[kw];
      for (let i = 0; i < 400; i++) { const r = await diffAfter(() => fire(el, 'wheel', { deltaY: -100 })); if (!r.changed[kw]) break; hi = r.changed[kw].to; }
      for (let i = 0; i < 800; i++) { const r = await diffAfter(() => fire(el, 'wheel', { deltaY: 100 })); if (!r.changed[kw]) break; lo = r.changed[kw].to; }
      consider(kw, { selector: sel, kind: 'wheel', step: Math.abs(step), min: lo, max: hi, quality: 7 }); probeLog.push(`${sel}: wheel -> ${kw} step ${step} range [${lo}, ${hi}]`);
      // restore towards boot value
      const target = lastParams[kw]; if (typeof target === 'number') { const ticks = Math.round((target - lo) / Math.abs(step)); for (let i = 0; i < ticks; i++) fire(el, 'wheel', { deltaY: -100 }); await sleep(20); flush(); }
    }
    // pointer drag (vertical): small drag to detect, then slam to both ends to learn the page's clamps, then restore the boot value
    const pd = (dy) => { // a real drag is many move events; pages that sync linked controls one event late need the extra moves
      const P = (type, y, extra) => fire(el, type, Object.assign({ clientX: 50, clientY: y, pointerId: 1, isPrimary: true, pointerType: 'mouse' }, extra));
      P('pointerdown', 400, { button: 0, buttons: 1 }); for (const f of [0.25, 0.5, 0.75, 1, 1]) P('pointermove', 400 - dy * f, { buttons: 1 }); P('pointerup', 400 - dy, { button: 0, buttons: 0 });
    };
    const hint = el.id || (el.parentElement && el.parentElement.querySelector && (el.parentElement.querySelector('input[id]') || {}).id) || el.className;
    let dragPx = 20, rp = await diffAfter(() => pd(dragPx));
    if (!Object.keys(rp.changed).length) { dragPx = 200; rp = await diffAfter(() => pd(dragPx)); } // coarse-stepped knobs need more travel before they tick
    const kp = single(rp.changed, hint);
    if (!kp && /hit|knob/i.test(String(el.className))) probeLog.push(`${sel} (${hint}): drag -> nothing ${JSON.stringify(rp.changed)}`);
    if (kp) {
      const perPx = (rp.changed[kp].to - rp.changed[kp].from) / dragPx;
      await diffAfter(() => pd(4000)); let hi = paramsNow()[kp]; await diffAfter(() => pd(-8000)); let lo = paramsNow()[kp];
      if (typeof lo === 'number' && typeof hi === 'number' && lo > hi) { const t = lo; lo = hi; hi = t; }
      const span = Math.abs(hi - lo), bounded = typeof lo === 'number' && typeof hi === 'number' && isFinite(span) && span < 0.6 * 12000 * Math.abs(perPx); // a page without clamps would have travelled the full 12000 px
      const b = { selector: sel, kind: 'drag', unitsPerPixelUp: perPx, min: bounded ? lo : (bindings[kp] && bindings[kp].min), max: bounded ? hi : (bindings[kp] && bindings[kp].max), wheelStep: bindings[kp] && bindings[kp].step, quality: bounded ? 9 : 8 }; consider(kp, b);
      probeLog.push(`${sel} (${hint}): drag -> ${kp} ${perPx}/px${bounded ? ` clamps [${lo}, ${hi}]` : ''}`);
      // restore towards boot value (we are at the low end now if bounded, else 20 px below where we started)
      const target = lastParams[kp];
      if (bounded && typeof target === 'number' && perPx) { const cur = paramsNow()[kp]; pd((target - cur) / perPx); } else pd(-20 + 4000 - 8000 > 0 ? 0 : 4000); 
      await sleep(20); flush();
    }
    if (kw || kp) continue;
    // click: toggle or cycle
    const seq = []; let key = null;
    for (let i = 0; i < 8; i++) { const r = await diffAfter(() => el.click()); const k = single(r.changed, el.id || el.textContent.trim().slice(0, 24)); if (!k || (key && k !== key)) break; key = k; seq.push(r.after[k]); if (seq.length >= 2 && r.after[k] === seq[0] && i >= 1) break; }
    if (key && seq.length) { const uniq = [...new Set(seq)]; const label = (el.textContent || '').trim().slice(0, 30) || el.id;
      if (uniq.length === 1) clickResults.push({ selector: sel, label, key, value: uniq[0] });   // one button = one value (segmented group member)
      else if (uniq.length === 2 && seq.length <= 3) consider(key, { selector: sel, kind: 'click-toggle', values: uniq, quality: 8 }); else consider(key, { selector: sel, kind: 'click-cycle', values: uniq, quality: 5 });
      probeLog.push(`${sel}: click -> ${key} ${JSON.stringify(uniq)}`); }
  }
  // segmented groups: several single-value buttons driving the same key => choice binding
  const byKey = {}; for (const r of clickResults) (byKey[r.key] = byKey[r.key] || []).push(r);
  // second pass: siblings of a single-value button that were already 'active' at probe time produced no change; click around the group twice
  for (const key in byKey) {
    if (byKey[key].length >= 2) continue;
    const el = d.querySelector(byKey[key][0].selector); const parent = el && el.parentElement; if (!parent) continue;
    const sibs = [...parent.children].filter(c => c !== el && (c.tagName === 'BUTTON' || c.getAttribute('role') === 'button' || Object.keys(c.dataset || {}).length));
    for (let pass = 0; pass < 2; pass++) for (const sib of [...sibs, el]) { const r = await diffAfter(() => sib.click()); const k = single(r.changed); if (k === key) { const label = (sib.textContent || '').trim().slice(0, 30); const selector = cssPath(sib); if (!byKey[key].some(x => x.selector === selector)) byKey[key].push({ selector, label, key, value: r.after[k] }); } }
  }
  for (const key in byKey) { const opts = []; for (const r of byKey[key]) if (!opts.some(o => o.value === r.value)) opts.push({ selector: r.selector, label: r.label, value: r.value }); if (typeof lastParams[key] === 'number' && !opts.some(o => o.value === lastParams[key])) { /* boot value not reachable by a probed button: still fine, host default maps to nearest */ } if (opts.length >= 2) consider(key, { selector: opts[0].selector, kind: 'choice', options: opts.sort((a, b) => a.value - b.value), quality: 9 }); else if (opts.length === 1) consider(key, { selector: opts[0].selector, kind: 'click-set', value: opts[0].value, quality: 3 }); }
  // put the page back to its boot state as far as the probes changed it (DSP-side: we never ship this DOM, so it only matters for consistency of lastParams)
  const uiSize = { width: Math.max(d.documentElement.scrollWidth || 0, 900), height: Math.max(d.documentElement.scrollHeight || 0, 600) };
  const title = (d.title || '').trim();
  w.close();
  return { bootOps, modules, unresolvedModules, addModuleUrls, workletIds, bootParams: lastParams, bindings, probeLog, startControl, errors, consoleLog, title, uiSize };
}

module.exports = { bootPage, flattenParams };
