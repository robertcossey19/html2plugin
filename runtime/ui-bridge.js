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
    for (const k in data) { const v = data[k]; if (k === 'type') continue; if (typeof v === 'number' || typeof v === 'boolean') into[k] = +v; else if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, into); }
    return into;
  }
  H.onPost = data => flatten(data, current);

  const fire = (el, type, init) => { const Ev = type.startsWith('pointer') ? (window.PointerEvent || MouseEvent) : type === 'wheel' ? WheelEvent : type.startsWith('mouse') ? MouseEvent : Event; el.dispatchEvent(new Ev(type, Object.assign({ bubbles: true, cancelable: true, composed: true, view: window }, init || {}))); };
  const nearest = (opts, v, key) => opts.reduce((best, o) => (best == null || Math.abs(o[key] - v) < Math.abs(best[key] - v)) ? o : best, null);
  let applying = false;
  function setFromHost(name, value) {
    const b = bindings[name]; if (!b) return false; const el = document.querySelector(b.selector); if (!el) return false;
    applying = true;
    try {
      switch (b.kind) {
        case 'range': { const v = (value - (b.offset || 0)) / (b.scale || 1); el.value = String(b.step ? Math.round(v / b.step) * b.step : v); fire(el, 'input'); fire(el, 'change'); return true; }
        case 'select': { const o = nearest(b.options, value, 'param'); if (!o) return false; if (el.selectedIndex !== o.index) { el.selectedIndex = o.index; fire(el, 'input'); fire(el, 'change'); } return true; }
        case 'checkbox': { const want = Math.abs(value - b.onValue) < Math.abs(value - b.offValue); if (el.checked !== want) el.click(); return true; }
        case 'choice': { const o = nearest(b.options, value, 'value'); const btn = o && document.querySelector(o.selector); if (!btn) return false; if (current[name] !== o.value) btn.click(); return true; }
        case 'click-toggle': { const want = nearest(b.values.map(v => ({ v })), value, 'v').v; if (current[name] !== want) el.click(); return true; }
        case 'click-set': { if (current[name] !== b.value && Math.abs(value - b.value) < 1e-9) el.click(); return true; }
        case 'click-cycle': { for (let i = 0; i < b.values.length + 1 && Math.abs((current[name] ?? NaN) - value) > 1e-9; i++) el.click(); return true; }
        case 'wheel': { const cur = current[name]; if (typeof cur !== 'number' || !b.step) return false; const ticks = Math.round((value - cur) / b.step); const dir = ticks < 0 ? 100 : -100; for (let i = 0; i < Math.min(Math.abs(ticks), 400); i++) fire(el, 'wheel', { deltaY: dir, deltaMode: 0 }); return true; }
        case 'drag': {
          const cur = current[name]; if (typeof cur !== 'number' || !b.unitsPerPixelUp) return false;
          const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y0 = r.top + r.height / 2; const dy = (value - cur) / b.unitsPerPixelUp;
          const common = { pointerId: 7, pointerType: 'mouse', isPrimary: true, clientX: x, screenX: x };
          fire(el, 'pointerdown', Object.assign({ clientY: y0, screenY: y0, button: 0, buttons: 1 }, common));
          fire(el, 'pointermove', Object.assign({ clientY: y0 - dy, screenY: y0 - dy, buttons: 1 }, common));
          fire(el, 'pointerup', Object.assign({ clientY: y0 - dy, screenY: y0 - dy, button: 0, buttons: 0 }, common));
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
  function autoStart() {
    const sel = manifest.ui && manifest.ui.startSelector; if (!sel) return;
    let tries = 0; const t = setInterval(() => {
      tries++; const el = document.querySelector(sel);
      const booted = H.contexts.length > 0 && H.nodesById.size > 1;
      if (booted || tries > 40) { clearInterval(t); return; }
      if (el) { el.click(); log('auto-pressed', sel); }
    }, 150);
  }
  if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(autoStart, 50); else window.addEventListener('DOMContentLoaded', () => setTimeout(autoStart, 50));
  // disable browser-only affordances that make no sense inside a plugin (file export of a mic recording etc. still work if the page supports them)
  log('bridge ready;', Object.keys(bindings).length, 'bound controls');
})();
