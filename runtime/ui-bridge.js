/* html2plugin UI bridge (runs after webaudio-shim.js, before the page's own scripts).
 * - exposes the forge manifest (processor descriptors, bindings, start control) to the shim
 * - tracks the page's current parameter values from the messages it posts
 * - applies host/automation changes to the page's own controls using the empirically probed bindings
 *   (range/select/checkbox/segmented buttons/toggles/wheel knobs/drag knobs), so the page updates itself and re-posts
 * - auto-presses the page's start/power control once the DOM is ready (plugins have no mic permission step) */
(function () {
  const H = window.__h2p; if (!H) return;
  const init = window.__JUCE__ && window.__JUCE__.initialisationData || {};
  const manifest = (init.h2p_manifest && init.h2p_manifest[0]) || window.__h2p_manifest || null;
  if (!manifest) { console.log('[h2p] no manifest; bridge idle'); return; }
  window.__h2p_registry = { '*': { processors: manifest.processors } };
  const bindings = manifest.bindings || {}; const current = {}; H.current = current; H.manifest = manifest;
  const log = (...a) => { try { console.log('[h2p-ui]', ...a); } catch (e) { } };

  // mirror the forge's flattenParams so we know what the page thinks each value is
  function flatten(data, into) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return into;
    const kf = ['name', 'key', 'id', 'param', 'parameter'].find(k => typeof data[k] === 'string'); const vf = ['value', 'val', 'v'].find(k => typeof data[k] === 'number' || typeof data[k] === 'boolean');
    if (kf && vf) { into[data[kf]] = +data[vf]; return into; }
    for (const k in data) {
      const v = data[k]; if (k === 'type') continue;
      if (typeof v === 'number' || typeof v === 'boolean') into[k] = +v;
      else if (Array.isArray(v)) { if (v.length >= 1 && v.length <= 8 && v.every(x => typeof x === 'number' || typeof x === 'boolean')) v.forEach((x, i) => { into[v.length === 2 ? k + (i === 0 ? '_L' : '_R') : k + '_' + (i + 1)] = +x; }); }   // {input:[L,R]} -> input_L / input_R, same naming as the forge and engine
      else if (v && typeof v === 'object') flatten(v, into);
    }
    return into;
  }
  H.onPost = data => flatten(data, current);

  // Synthetic pointer events (pointerId 7) are not "active pointers" to WebKit, so a page's hit.setPointerCapture(e.pointerId) throws
  // NotFoundError and aborts its own pointerdown handler before it arms the drag. Make capture calls for our pointer id no-ops.
  const SYN_ID = 7;
  let applying = false;
  if (typeof Element !== 'undefined' && Element.prototype.setPointerCapture) {
    const spc = Element.prototype.setPointerCapture, rpc = Element.prototype.releasePointerCapture, hpc = Element.prototype.hasPointerCapture;
    Element.prototype.setPointerCapture = function (id) { if (id === SYN_ID || applying) { try { return spc.call(this, id); } catch (e) { return; } } return spc.call(this, id); };
    Element.prototype.releasePointerCapture = function (id) { if (id === SYN_ID || applying) { try { return rpc.call(this, id); } catch (e) { return; } } return rpc.call(this, id); };
    if (hpc) Element.prototype.hasPointerCapture = function (id) { if (id === SYN_ID) return true; return hpc.call(this, id); };
  }
  const fire = (el, type, init) => { const Ev = type.startsWith('pointer') ? (window.PointerEvent || MouseEvent) : type === 'wheel' ? WheelEvent : type.startsWith('mouse') ? MouseEvent : Event; el.dispatchEvent(new Ev(type, Object.assign({ bubbles: true, cancelable: true, composed: true, view: window }, init || {}))); };
  /* ---- visual-state parameters (ui_*): the control rebuilds the model and carries no plain value; its position is read from the DOM ---- */
  const rotOf = x => { const m = /rotate\(\s*(-?[\d.]+)deg\s*\)/.exec((x.style && x.style.transform) || ''); return m ? parseFloat(m[1]) : null; };
  const numOf = x => { if (x.children && x.children.length) return null; const m = /-?\d+(?:\.\d+)?/.exec(x.textContent || ''); return m ? parseFloat(m[0]) : null; };
  const ariaOf = x => { const a = x.getAttribute('aria-valuenow'); return a == null || a === '' || isNaN(+a) ? null : +a; };
  const readVisual = (b) => {
    switch (b.kind) {
      case 'wheel-visual': { const x = document.querySelector(b.indicator); if (!x) return null; const v = b.read === 'aria' ? ariaOf(x) : b.read === 'rotate' ? rotOf(x) : numOf(x); if (typeof v !== 'number') return null; const pos = (v - b.vmin) / ((b.vmax - b.vmin) || 1); return Math.min(1, Math.max(0, b.inverted ? 1 - pos : pos)); }
      case 'state-choice': { const i = b.options.findIndex(o => { const e = document.querySelector(o.selector); return e && e.classList.contains(b.className); }); return i < 0 ? null : i; }
      case 'state-toggle': { const e = document.querySelector(b.selector); return e ? (e.classList.contains(b.className) ? 1 : 0) : null; }
      case 'select': { if (!b.uiParam) return null; const e = document.querySelector(b.selector); return e ? e.selectedIndex : null; }
      case 'range-ui': { const e = document.querySelector(b.selector); if (!e) return null; const v = parseFloat(e.value); return isFinite(v) ? v : null; }
    }
    return null;
  };
  const visualNames = Object.keys(bindings).filter(n => bindings[n].uiParam);
  const lastVisual = {};
  H.uiValue = name => readVisual(bindings[name]);
  // UI -> host for visual parameters: compared on every engine tick (30 Hz) and reported through the engine's hostParams channel
  function pollVisual() { if (applying) return; for (const n of visualNames) { const v = readVisual(bindings[n]); if (v == null || v === lastVisual[n]) continue; if (lastVisual[n] !== undefined) H.emit({ op: 'hostParam', name: n, value: v }); lastVisual[n] = v; } }
  H.pollVisual = pollVisual;
  const nearest = (opts, v, key) => opts.reduce((best, o) => (best == null || Math.abs(o[key] - v) < Math.abs(best[key] - v)) ? o : best, null);
  // The page computes its own values (1073: inGain = 1/(gain1k*inScale*outScale) through Math.exp/log) and JavaScriptCore's libm
  // differs from V8's by ULPs, so the forge's measured option values and the live page's never compare equal with !==. Discrete
  // controls are compared by the option they are nearest to, never by exact float equality (a mismatch here double-clicks the
  // control and silently undoes the host's change).
  const near = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));
  const sameOption = (opts, key, cur, want) => typeof cur === 'number' && nearest(opts, cur, key) === nearest(opts, want, key);
  function setFromHost(name, value) {
    const b = bindings[name]; if (!b) return false; const el = document.querySelector(b.selector); if (!el) return false;
    applying = true;
    try {
      switch (b.kind) {
        case 'range-ui': { const v = b.step ? Math.round(value / b.step) * b.step : value; if (Math.abs(parseFloat(el.value) - v) < 1e-9) { lastVisual[name] = v; return true; } el.value = String(v); fire(el, 'input'); fire(el, 'change'); lastVisual[name] = parseFloat(el.value); return true; }
        case 'range': { const v = (value - (b.offset || 0)) / (b.scale || 1); el.value = String(b.step ? Math.round(v / b.step) * b.step : v); fire(el, 'input'); fire(el, 'change'); return true; }
        case 'wheel-visual': { const cur = readVisual(b); if (cur == null) return false; const ticks = Math.round((value - cur) * b.ticks); const dir = ticks < 0 ? 100 : -100; for (let i = 0; i < Math.min(Math.abs(ticks), b.ticks + 5); i++) fire(el, 'wheel', { deltaY: dir, deltaMode: 0 }); lastVisual[name] = readVisual(b); return true; }
        case 'state-choice': { const idx = Math.max(0, Math.min(b.options.length - 1, Math.round(value))); if (readVisual(b) !== idx) { const btn = document.querySelector(b.options[idx].selector); if (!btn) return false; btn.click(); } lastVisual[name] = idx; return true; }
        case 'state-toggle': { const want = value >= 0.5 ? 1 : 0; if (readVisual(b) !== want) el.click(); lastVisual[name] = want; return true; }
        case 'select': { if (b.uiParam) { const idx = Math.max(0, Math.min(el.options.length - 1, Math.round(value))); if (el.selectedIndex !== idx) { el.selectedIndex = idx; fire(el, 'input'); fire(el, 'change'); } lastVisual[name] = idx; return true; }
          const o = nearest(b.options, value, 'param'); if (!o) return false; if (el.selectedIndex !== o.index) { el.selectedIndex = o.index; fire(el, 'input'); fire(el, 'change'); } return true; }
        case 'checkbox': { const want = Math.abs(value - b.onValue) < Math.abs(value - b.offValue); if (el.checked !== want) el.click(); return true; }
        case 'choice': { const o = nearest(b.options, value, 'value'); const btn = o && document.querySelector(o.selector); if (!btn) return false; if (!sameOption(b.options, 'value', current[name], o.value)) btn.click(); return true; }
        case 'click-toggle': { const opts = b.values.map(v => ({ v })); const want = nearest(opts, value, 'v').v; if (!sameOption(opts, 'v', current[name], want)) el.click(); return true; }
        case 'click-set': { if (!near(current[name], b.value) && Math.abs(value - b.value) < 1e-9) el.click(); return true; }
        case 'click-cycle': { for (let i = 0; i < b.values.length + 1 && !near(current[name], value); i++) el.click(); return true; }
        case 'wheel': { const cur = current[name]; if (typeof cur !== 'number' || !b.step) return false;
          const ticks = b.seq ? b.seq.indexOf(nearest(b.seq.map(v => ({ v })), value, 'v').v) - b.seq.indexOf(nearest(b.seq.map(v => ({ v })), cur, 'v').v) : Math.round((value - cur) / b.step); const dir = ticks < 0 ? 100 : -100; for (let i = 0; i < Math.min(Math.abs(ticks), 400); i++) fire(el, 'wheel', { deltaY: dir, deltaMode: 0 }); return true; }
        case 'drag': {
          const cur = current[name]; if (typeof cur !== 'number' || !b.unitsPerPixelUp) return false;
          if (Math.abs(value - cur) <= Math.abs(b.wheelStep || b.unitsPerPixelUp) * 1e-3) return true;   // already there: no synthetic gesture (a gesture makes the page re-post its params)
          const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y0 = r.top + r.height / 2;
          if (typeof b.min === 'number' && typeof b.max === 'number') value = Math.min(b.max, Math.max(b.min, value));
          // px for a value: the forge-measured response curve (dB knobs post linear gain etc.), else the linear slope
          const f = b.curveLog ? Math.log : (x => x);
          const pxOf = v => { const c = b.curve; if (!c || c.length < 2) return v / b.unitsPerPixelUp; const inc = c[c.length - 1][1] >= c[0][1]; let i = 0; while (i < c.length - 2 && (inc ? c[i + 1][1] < v : c[i + 1][1] > v)) i++; const [p0, v0] = c[i], [p1, v1] = c[i + 1]; return v1 === v0 ? p0 : p0 + (f(v) - f(v0)) * (p1 - p0) / (f(v1) - f(v0)); };
          const mouse = b.events === 'mouse'; const ev = t => mouse ? t.replace('pointer', 'mouse') : t;
          const common = Object.assign({ clientX: x, screenX: x }, mouse ? {} : { pointerId: SYN_ID, pointerType: 'mouse', isPrimary: true });
          const gesture = dy => {
            fire(el, ev('pointerdown'), Object.assign({ clientY: y0, screenY: y0, button: 0, buttons: 1 }, common));
            for (const f of [0.5, 1, 1]) fire(el, ev('pointermove'), Object.assign({ clientY: y0 - dy * f, screenY: y0 - dy * f, buttons: 1 }, common)); // several moves: some pages apply linked/partner state one event late
            fire(el, ev('pointerup'), Object.assign({ clientY: y0 - dy, screenY: y0 - dy, button: 0, buttons: 0 }, common));
          };
          gesture(pxOf(value) - pxOf(cur));
          // the page may round or clamp per gesture: correct with the local slope, twice at most
          const tol = Math.abs(value) * 1e-3 + 1e-9;
          // (now === prev: the page reports asynchronously; never stack a second gesture on a stale reading)
          for (let k = 0, prev = cur; k < 4; k++) { const now = current[name]; if (typeof now !== 'number' || now === prev || Math.abs(now - value) <= tol) break; prev = now; const d = pxOf(value) - pxOf(now); if (!isFinite(d) || Math.abs(d) < 0.01) break; gesture(d); }
          // fine trim with the wheel if the page exposes a finer step than one pixel gives us
          if (b.wheelStep) { const after = current[name]; if (typeof after === 'number') { const t = Math.round((value - after) / b.wheelStep); const dir = t < 0 ? 100 : -100; for (let i = 0; i < Math.min(Math.abs(t), 50); i++) fire(el, 'wheel', { deltaY: dir, deltaMode: 0 }); } }
          return true;
        }
      }
    } catch (e) { log('setFromHost failed', name, e); } finally { applying = false; }
    return false;
  }
  H.setFromHost = setFromHost; H.isApplying = () => applying;
  H.onHostParam = (name, value) => setFromHost(name, value);
  // batch form used by the native side: {name: value, ...}
  H.applyHostParams = (obj) => { const res = {}; for (const k in obj) res[k] = setFromHost(k, obj[k]); return res; };

  // auto-start: the page may gate its graph behind a POWER/START control (mic permission in the browser). Press it for the user.
  // File-player pages (Load -> decode -> Play) get the same synthetic WAV the forge used (keep in sync with forge/boot.js
  // syntheticWavBytes); the DAW track replaces the file inside the engine, so what the page decodes never reaches the output.
  function syntheticWav(sampleRate) {
    const sr = sampleRate || 48000, frames = Math.round(sr * 0.5), ch = 2, bps = 2;
    const ab = new ArrayBuffer(44 + frames * ch * bps), dv = new DataView(ab);
    const str = (o, t) => { for (let i = 0; i < t.length; i++) dv.setUint8(o + i, t.charCodeAt(i)); };
    str(0, 'RIFF'); dv.setUint32(4, 36 + frames * ch * bps, true); str(8, 'WAVE'); str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, ch, true);
    dv.setUint32(24, sr, true); dv.setUint32(28, sr * ch * bps, true); dv.setUint16(32, ch * bps, true); dv.setUint16(34, 16, true); str(36, 'data'); dv.setUint32(40, frames * ch * bps, true);
    for (let i = 0; i < frames; i++) { const v = Math.round(Math.sin(2 * Math.PI * 1000 * i / sr) * 0.1 * 32767); dv.setInt16(44 + i * 4, v, true); dv.setInt16(46 + i * 4, v, true); }
    return ab;
  }
  function feedFile(kind, el) {
    const ab = syntheticWav(manifest.captureSampleRate || 48000);
    const file = new File([ab], (manifest.ui && manifest.ui.startFileName) || 'h2p-input.wav', { type: 'audio/wav' });
    if (typeof file.arrayBuffer !== 'function') { try { file.arrayBuffer = () => Promise.resolve(ab.slice(0)); } catch (e) { } }   // jsdom (golden test) lacks Blob.arrayBuffer
    let dt = null, files; try { dt = new DataTransfer(); dt.items.add(file); files = dt.files; } catch (e) { files = { 0: file, length: 1, item: i => (i === 0 ? file : null), [Symbol.iterator]: function* () { yield file; } }; dt = { files, items: [{ kind: 'file', type: file.type, getAsFile: () => file }], types: ['Files'], getData: () => '', setData() { } }; }
    if (kind === 'file') { let set = false; try { el.files = files; set = el.files === files || (el.files && el.files.length === 1); } catch (e) { } if (!set) { try { Object.defineProperty(el, 'files', { configurable: true, get: () => files }); } catch (e2) { } } el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
    else for (const type of ['dragenter', 'dragover', 'drop']) { let ev; try { ev = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }); } catch (e) { ev = new Event(type, { bubbles: true, cancelable: true }); try { Object.defineProperty(ev, 'dataTransfer', { value: dt }); } catch (e2) { } } el.dispatchEvent(ev); }
    log('fed synthetic file via', kind, manifest.ui.startSelector);
  }
  function autoStart() {
    const sel = manifest.ui && manifest.ui.startSelector; if (!sel) return;
    const kind = (manifest.ui && manifest.ui.startKind) || 'click';
    let tries = 0, fed = false; const t = setInterval(() => {
      tries++; const el = document.querySelector(sel);
      const booted = H.contexts.length > 0 && H.nodesById.size > 1;
      if (booted || tries > 40) { clearInterval(t); return; }
      if (!el) return;
      if (kind === 'file' || kind === 'drop') { if (!fed || tries % 10 === 0) { fed = true; try { feedFile(kind, el); } catch (e) { log('feedFile failed', e); } } return; }
      el.click(); log('auto-pressed', sel); const extra = (manifest.ui.startClicks || 1) - 1; for (let i = 0; i < extra; i++) setTimeout(() => { el.click(); log('auto-pressed again (restore state)', sel); }, 250 * (i + 1));
    }, 150);
  }
  if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(autoStart, 50); else window.addEventListener('DOMContentLoaded', () => setTimeout(autoStart, 50));
  // disable browser-only affordances that make no sense inside a plugin (file export of a mic recording etc. still work if the page supports them)
  log('bridge ready;', Object.keys(bindings).length, 'bound controls');
})();
