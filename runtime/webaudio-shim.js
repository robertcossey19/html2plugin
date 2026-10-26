/* html2plugin WebView shim.
 * Replaces the realtime AudioContext inside the plugin's WebView. The page's own code runs untouched; every graph call
 * (create/connect/param automation/port.postMessage/start/stop/property sets) is recorded as an RPC op and sent to the
 * native side, which replays it into engine/webaudio-engine.js running in JavaScriptCore on the audio thread.
 * Messages from AudioWorkletProcessors come back and are delivered to the page's port.onmessage, exactly as in a browser.
 *
 * Transport (set by the host before the page runs):  window.__h2p_transport = { send(opsArray), onReceive(fn) }
 * Default transport = JUCE 8 native integration (window.__JUCE__.backend).  Init data: window.__h2p_init = { sampleRate }.
 */
(function () {
  if (window.__h2p) return;
  const init = window.__h2p_init || (window.__JUCE__ && window.__JUCE__.initialisationData && window.__JUCE__.initialisationData.h2p_init && window.__JUCE__.initialisationData.h2p_init[0]) || {};
  const SR = init.sampleRate || 48000;
  const log = (...a) => { try { console.log('[h2p]', ...a); } catch (e) { } };

  /* ---------------- transport ---------------- */
  const transport = window.__h2p_transport || (function () {
    const J = window.__JUCE__ && window.__JUCE__.backend;
    if (!J) { log('no JUCE backend; running in record-only mode'); return { send: ops => { (window.__h2p_recorded = window.__h2p_recorded || []).push(...ops); }, onReceive: () => { } }; }
    return { send: ops => J.emitEvent('h2p', { ops }), onReceive: fn => J.addEventListener('h2p_in', fn) };
  })();
  let queue = [], flushScheduled = false;
  function emit(op) { queue.push(op); if (!flushScheduled) { flushScheduled = true; Promise.resolve().then(flush); } }
  function flush() { flushScheduled = false; if (!queue.length) return; const q = queue; queue = []; try { transport.send(q); } catch (e) { log('send failed', e); } }

  /* ---------------- clock: engine time pushed by native, interpolated with performance.now() ---------------- */
  let engineTime = 0, engineTimeAt = performance.now(), lastNow = 0;
  // monotonic: the engine clock arrives in bursts (and faster than wall time in offline hosts/tests); currentTime must never run backwards
  function now() { const t = engineTime + (performance.now() - engineTimeAt) / 1000; if (t > lastNow) lastNow = t; return lastNow; }

  /* ---------------- ids / registry ---------------- */
  let nextId = 1; const nodesById = new Map(); const analyserSnap = new Map();
  const clone = v => { try { return JSON.parse(JSON.stringify(v)); } catch (e) { return String(v); } };
  function serializeMessage(data) {
    // structured-clone-ish: typed arrays -> {__ta:type, data:[...]}, ArrayBuffer -> bytes
    return JSON.parse(JSON.stringify(data, (k, v) => {
      if (ArrayBuffer.isView(v)) return { __ta: v.constructor.name, data: Array.from(v) };
      if (v instanceof ArrayBuffer) return { __ta: 'Uint8Array', data: Array.from(new Uint8Array(v)) };
      if (v instanceof AudioBufferShim) return { __audiobuffer: { sampleRate: v.sampleRate, length: v.length, channels: v._d.map(c => Array.from(c)) } };
      if (v instanceof Map) return { __map: Array.from(v.entries()) };
      return v;
    }));
  }
  function reviveMessage(data) {
    if (data && typeof data === 'object') {
      if (data.__ta && Array.isArray(data.data)) { const C = window[data.__ta] || Float32Array; return C.from(data.data); }
      if (data.__map) return new Map(data.__map.map(([k, v]) => [k, reviveMessage(v)]));
      if (Array.isArray(data)) return data.map(reviveMessage);
      const o = {}; for (const k in data) o[k] = reviveMessage(data[k]); return o;
    }
    return data;
  }

  /* ---------------- AudioParam ---------------- */
  const TIME_ARGS = { setValueAtTime: [1], linearRampToValueAtTime: [1], exponentialRampToValueAtTime: [1], setTargetAtTime: [1], setValueCurveAtTime: [1], cancelScheduledValues: [0], cancelAndHoldAtTime: [0] };
  class AudioParamShim {
    constructor(node, name, def, min, max, rate) { this._node = node; this._name = name; this._v = def; this.defaultValue = def; this.minValue = min == null ? -3.4028235e38 : min; this.maxValue = max == null ? 3.4028235e38 : max; this.automationRate = rate || 'a-rate'; }
    get value() { return this._v; }
    set value(v) { v = +v; if (!isFinite(v)) return; this._v = v; emit({ op: 'param', id: this._node._id, name: this._name, method: 'value', args: [v] }); }
    _sched(method, args) { const a = Array.from(args).map(x => (ArrayBuffer.isView(x) || Array.isArray(x)) ? Array.from(x) : +x); if (method !== 'cancelScheduledValues' && method !== 'cancelAndHoldAtTime' && method !== 'setValueCurveAtTime') this._v = a[0]; if (method === 'setValueCurveAtTime') this._v = a[0][a[0].length - 1]; emit({ op: 'param', id: this._node._id, name: this._name, method, args: a, now: now(), timeArgs: TIME_ARGS[method] }); return this; }
  }
  for (const m of Object.keys(TIME_ARGS)) AudioParamShim.prototype[m] = function () { return this._sched(m, arguments); };

  /* ---------------- AudioBuffer (real data lives in the page; shipped when assigned to a node) ---------------- */
  class AudioBufferShim {
    constructor(ch, len, sr) { this.numberOfChannels = ch; this.length = len; this.sampleRate = sr; this.duration = len / sr; this._d = []; for (let i = 0; i < ch; i++) this._d.push(new Float32Array(len)); }
    getChannelData(i) { return this._d[i]; }
    copyFromChannel(dst, ch, start) { dst.set(this._d[ch].subarray(start || 0, (start || 0) + dst.length)); }
    copyToChannel(src, ch, start) { this._d[ch].set(src, start || 0); }
    _wire() { return { sampleRate: this.sampleRate, length: this.length, channels: this._d.map(c => Array.from(c)) }; }
  }

  /* ---------------- nodes ---------------- */
  class AudioNodeShim extends EventTarget {
    constructor(ctx, type, args, inputs, outputs) {
      super(); this.context = ctx; this._id = nextId++; this._type = type; this.numberOfInputs = inputs; this.numberOfOutputs = outputs; this._channelCount = 2; this.channelCountMode = 'max'; this.channelInterpretation = 'speakers';
      nodesById.set(this._id, this); emit(Object.assign({ op: 'create', id: this._id, type }, args ? { args } : {}));
    }
    get channelCount() { return this._channelCount; } set channelCount(v) { this._channelCount = v; emit({ op: 'prop', id: this._id, name: 'channelCount', value: v }); }
    connect(dst, outIdx, inIdx) {
      if (dst instanceof AudioParamShim) { emit({ op: 'connect', from: this._id, to: dst._node._id, param: dst._name, fromOut: outIdx || 0 }); return; }
      if (!dst || dst._id == null) throw new TypeError('connect(): destination is not a node of this context');
      emit({ op: 'connect', from: this._id, to: dst._id, fromOut: outIdx || 0, toIn: inIdx || 0 }); return dst;
    }
    disconnect(dst, outIdx, inIdx) {
      if (dst === undefined || typeof dst === 'number') { emit({ op: 'disconnect', from: this._id }); return; }
      if (dst instanceof AudioParamShim) { emit({ op: 'disconnect', from: this._id, to: dst._node._id, param: dst._name }); return; }
      emit({ op: 'disconnect', from: this._id, to: dst._id, fromOut: outIdx, toIn: inIdx });
    }
    _param(name, def, min, max, rate) { const p = new AudioParamShim(this, name, def, min, max, rate); Object.defineProperty(this, name, { value: p, enumerable: true }); return p; }
    _prop(name, def, map) { let v = def; Object.defineProperty(this, name, { get: () => v, set: nv => { v = nv; emit({ op: 'prop', id: this._id, name, value: map ? map(nv) : clone(nv) }); }, enumerable: true }); }
  }
  class ScheduledNode extends AudioNodeShim {
    start(when, offset, duration) { emit({ op: 'start', id: this._id, when: when == null ? undefined : when - now(), offset, duration }); }
    stop(when) { emit({ op: 'stop', id: this._id, when: when == null ? undefined : when - now() }); }
  }
  const mk = {
    Gain: (c) => { const n = new AudioNodeShim(c, 'Gain', null, 1, 1); n._param('gain', 1); return n; },
    Delay: (c, max) => { const n = new AudioNodeShim(c, 'Delay', [max == null ? 1 : max], 1, 1); n._param('delayTime', 0, 0, max == null ? 1 : max); return n; },
    BiquadFilter: (c) => { const n = new AudioNodeShim(c, 'BiquadFilter', null, 1, 1); n._param('frequency', 350); n._param('detune', 0); n._param('Q', 1); n._param('gain', 0); n._prop('type', 'lowpass'); n.getFrequencyResponse = () => { }; return n; },
    WaveShaper: (c) => { const n = new AudioNodeShim(c, 'WaveShaper', null, 1, 1); n._prop('curve', null, v => v ? Array.from(v) : null); n._prop('oversample', 'none'); return n; },
    StereoPanner: (c) => { const n = new AudioNodeShim(c, 'StereoPanner', null, 1, 1); n._param('pan', 0, -1, 1); return n; },
    ChannelSplitter: (c, k) => new AudioNodeShim(c, 'ChannelSplitter', [k || 6], 1, k || 6),
    ChannelMerger: (c, k) => new AudioNodeShim(c, 'ChannelMerger', [k || 6], k || 6, 1),
    ConstantSource: (c) => { const n = new ScheduledNode(c, 'ConstantSource', null, 0, 1); n._param('offset', 1); return n; },
    Oscillator: (c) => { const n = new ScheduledNode(c, 'Oscillator', null, 0, 1); n._param('frequency', 440); n._param('detune', 0); n._prop('type', 'sine'); n.setPeriodicWave = () => emit({ op: 'prop', id: n._id, name: 'type', value: 'sine' }); return n; },
    BufferSource: (c) => { const n = new ScheduledNode(c, 'BufferSource', null, 0, 1); n._param('playbackRate', 1); n._param('detune', 0); n._prop('buffer', null, b => b && b._wire ? b._wire() : null); n._prop('loop', false); n._prop('loopStart', 0); n._prop('loopEnd', 0); return n; },
    DynamicsCompressor: (c) => { const n = new AudioNodeShim(c, 'DynamicsCompressor', null, 1, 1); n._param('threshold', -24); n._param('knee', 30); n._param('ratio', 12); n._param('attack', 0.003); n._param('release', 0.25); Object.defineProperty(n, 'reduction', { get: () => 0 }); return n; },
    Analyser: (c) => {
      const n = new AudioNodeShim(c, 'Analyser', null, 1, 1); n._prop('fftSize', 2048); n._prop('smoothingTimeConstant', 0.8); n._prop('minDecibels', -100); n._prop('maxDecibels', -30);
      Object.defineProperty(n, 'frequencyBinCount', { get: () => n.fftSize / 2 });
      const snap = () => analyserSnap.get(n._id) || { time: [], freq: [] };
      n.getFloatTimeDomainData = a => { const s = snap().time; for (let i = 0; i < a.length; i++) a[i] = s[i] || 0; };
      n.getByteTimeDomainData = a => { const s = snap().time; for (let i = 0; i < a.length; i++) a[i] = Math.max(0, Math.min(255, Math.round(128 + 128 * (s[i] || 0)))); };
      n.getFloatFrequencyData = a => { const s = snap().freq; for (let i = 0; i < a.length; i++) a[i] = s[i] == null ? -Infinity : s[i]; };
      n.getByteFrequencyData = a => { const s = snap().freq, lo = n.minDecibels, hi = n.maxDecibels; for (let i = 0; i < a.length; i++) { const v = s[i] == null ? lo : s[i]; a[i] = Math.max(0, Math.min(255, Math.round(255 * (v - lo) / (hi - lo)))); } };
      return n;
    },
    Convolver: (c) => { const n = new AudioNodeShim(c, 'Convolver', null, 1, 1); n._prop('buffer', null, b => b && b._wire ? b._wire() : null); n._prop('normalize', true); return n; },
    MediaStreamSource: (c) => new AudioNodeShim(c, 'MediaStreamSource', null, 0, 1),
    MediaElementSource: (c) => new AudioNodeShim(c, 'MediaElementSource', null, 0, 1),
    MediaStreamDestination: (c) => { const n = new AudioNodeShim(c, 'MediaStreamDestination', null, 1, 0); n.stream = new FakeStream(); return n; },
    Destination: (c) => { const n = new AudioNodeShim(c, 'Destination', null, 1, 0); n.maxChannelCount = 2; return n; },
  };

  class AudioWorkletNodeShim extends AudioNodeShim {
    constructor(ctx, name, options) {
      options = options || {};
      const opts = { numberOfInputs: options.numberOfInputs == null ? 1 : options.numberOfInputs, numberOfOutputs: options.numberOfOutputs == null ? 1 : options.numberOfOutputs, outputChannelCount: options.outputChannelCount, channelCount: options.channelCount, parameterData: options.parameterData ? clone(options.parameterData) : undefined, processorOptions: options.processorOptions ? serializeMessage(options.processorOptions) : undefined };
      super(ctx, 'AudioWorklet', null, opts.numberOfInputs, opts.numberOfOutputs);
      this._name = name; this.onprocessorerror = null;
      // rewrite the create op in-flight so it carries name + options
      const op = queue[queue.length - 1]; op.name = name; op.options = opts;
      const desc = (ctx._descriptors && ctx._descriptors[name]) || [];
      const params = new Map(); for (const d of desc) params.set(d.name, new AudioParamShim(this, d.name, d.defaultValue == null ? 0 : d.defaultValue, d.minValue, d.maxValue, d.automationRate));
      this.parameters = params;
      const self = this;
      this.port = { onmessage: null, _listeners: [], postMessage(data) { if (window.__h2p && window.__h2p.onPost) { try { window.__h2p.onPost(data); } catch (e) { } } emit({ op: 'post', id: self._id, data: serializeMessage(data) }); }, start() { }, close() { }, addEventListener(t, f) { if (t === 'message') this._listeners.push(f); }, removeEventListener(t, f) { this._listeners = this._listeners.filter(x => x !== f); } };
    }
    _deliver(data) { const ev = { data, type: 'message', target: this.port }; try { if (typeof this.port.onmessage === 'function') this.port.onmessage(ev); for (const f of this.port._listeners) f(ev); } catch (e) { log('onmessage threw', e); } }
  }

  /* ---------------- media stubs ---------------- */
  class FakeTrack { constructor() { this.kind = 'audio'; this.enabled = true; this.readyState = 'live'; this.label = 'Plugin input'; this.id = 'h2p-track'; } stop() { } getSettings() { return { sampleRate: SR, channelCount: 2 }; } getCapabilities() { return {}; } applyConstraints() { return Promise.resolve(); } addEventListener() { } removeEventListener() { } }
  class FakeStream { constructor() { this.active = true; this.id = 'h2p-stream'; this._t = [new FakeTrack()]; } getTracks() { return this._t; } getAudioTracks() { return this._t; } getVideoTracks() { return []; } addTrack() { } removeTrack() { } addEventListener() { } removeEventListener() { } }

  /* ---------------- AudioContext ---------------- */
  class AudioContextShim extends EventTarget {
    constructor(opts) {
      super(); this.sampleRate = SR; this.state = 'running'; this.baseLatency = 128 / SR; this.outputLatency = 0; this.onstatechange = null; this._descriptors = {};
      emit({ op: 'reset' });  // a new page-side context replaces whatever graph the engine had (boot replay or a previous editor instance)
      this.destination = mk.Destination(this); this.listener = { positionX: {}, positionY: {}, positionZ: {}, setPosition() { }, setOrientation() { } };
      this.audioWorklet = { addModule: (url) => this._addModule(url) };
      AudioContextShim.instances.push(this);
    }
    get currentTime() { return now(); }
    resume() { this.state = 'running'; return Promise.resolve(); } suspend() { return Promise.resolve(); } close() { this.state = 'closed'; return Promise.resolve(); }
    createGain() { return mk.Gain(this); } createDelay(m) { return mk.Delay(this, m); } createBiquadFilter() { return mk.BiquadFilter(this); } createWaveShaper() { return mk.WaveShaper(this); } createStereoPanner() { return mk.StereoPanner(this); }
    createChannelSplitter(k) { return mk.ChannelSplitter(this, k); } createChannelMerger(k) { return mk.ChannelMerger(this, k); } createConstantSource() { return mk.ConstantSource(this); } createOscillator() { return mk.Oscillator(this); }
    createBufferSource() { return mk.BufferSource(this); } createDynamicsCompressor() { return mk.DynamicsCompressor(this); } createAnalyser() { return mk.Analyser(this); } createConvolver() { return mk.Convolver(this); }
    createMediaStreamSource() { return mk.MediaStreamSource(this); } createMediaElementSource() { return mk.MediaElementSource(this); } createMediaStreamDestination() { return mk.MediaStreamDestination(this); }
    createPanner() { return mk.StereoPanner(this); } createScriptProcessor() { throw new Error('html2plugin: ScriptProcessorNode is not supported; use an AudioWorklet (the forge reports this at generation time)'); }
    createBuffer(ch, len, sr) { return new AudioBufferShim(ch, len, sr || SR); }
    createPeriodicWave() { return {}; }
    decodeAudioData(ab, ok, fail) {
      const p = new Promise((res, rej) => { try { res(decodeWav(ab)); } catch (e) { rej(e); } });
      if (ok) p.then(ok, fail); return p;
    }
    _addModule(url) {
      // Worklet module code was extracted by the forge and already lives in the engine; the registry tells us the descriptors.
      const reg = window.__h2p_registry || {}; const key = String(url);
      const entry = reg[key] || reg[key.split('/').pop()] || Object.values(reg).find(r => r.blobKeys && r.blobKeys.includes(key));
      if (entry) for (const name in entry.processors) this._descriptors[name] = entry.processors[name];
      else for (const k in reg) for (const name in reg[k].processors) this._descriptors[name] = reg[k].processors[name];  // single-module pages
      return Promise.resolve();
    }
  }
  AudioContextShim.instances = [];

  // minimal PCM WAV decoder so pages embedding base64 WAV IRs/samples keep working (compressed formats are reported by the forge)
  function decodeWav(ab) {
    const dv = new DataView(ab); if (dv.getUint32(0, false) !== 0x52494646) throw new Error('decodeAudioData: only PCM/float WAV is supported inside the plugin');
    let off = 12, fmt = null, data = null;
    while (off + 8 <= dv.byteLength) { const id = String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3)); const sz = dv.getUint32(off + 4, true); if (id === 'fmt ') fmt = { tag: dv.getUint16(off + 8, true), ch: dv.getUint16(off + 10, true), sr: dv.getUint32(off + 12, true), bits: dv.getUint16(off + 22, true) }; if (id === 'data') data = { off: off + 8, sz }; off += 8 + sz + (sz & 1); }
    if (!fmt || !data) throw new Error('bad wav');
    const bps = fmt.bits / 8, frames = Math.floor(data.sz / (bps * fmt.ch)); const buf = new AudioBufferShim(fmt.ch, frames, fmt.sr);
    for (let i = 0; i < frames; i++) for (let c = 0; c < fmt.ch; c++) { const p = data.off + (i * fmt.ch + c) * bps; let v; if (fmt.tag === 3) v = bps === 4 ? dv.getFloat32(p, true) : dv.getFloat64(p, true); else if (bps === 2) v = dv.getInt16(p, true) / 32768; else if (bps === 3) { v = ((dv.getUint8(p) | (dv.getUint8(p + 1) << 8) | (dv.getInt8(p + 2) << 16)) / 8388608); } else if (bps === 4) v = dv.getInt32(p, true) / 2147483648; else v = (dv.getUint8(p) - 128) / 128; buf._d[c][i] = v; }
    return buf;
  }

  /* ---------------- inbound: engine time, worklet messages, analyser snapshots, host param pushes ---------------- */
  const receive = function (msg) {
    if (!msg) return; if (typeof msg === 'string') { try { msg = JSON.parse(msg); } catch (e) { return; } }
    if (typeof msg.time === 'number') { engineTime = msg.time; engineTimeAt = performance.now(); }
    if (msg.analysers) for (const id in msg.analysers) analyserSnap.set(+id, msg.analysers[id]);
    if (Array.isArray(msg.msgs)) for (const m of msg.msgs) { if (m.id === -1) { log('engine:', m.data && m.data.message); continue; } const n = nodesById.get(+m.id); if (n && n._deliver) n._deliver(reviveMessage(m.data)); }
    if (msg.hostParams && window.__h2p.applyHostParams) { try { window.__h2p.applyHostParams(msg.hostParams); } catch (e) { log(e); } }
  }; transport.onReceive(receive);

  /* ---------------- install ---------------- */
  window.AudioContext = AudioContextShim; window.webkitAudioContext = AudioContextShim;
  window.AudioWorkletNode = AudioWorkletNodeShim; window.AudioBuffer = AudioBufferShim; window.AudioParam = AudioParamShim; window.AudioNode = AudioNodeShim;
  window.AudioWorklet = function () { }; window.MediaStream = FakeStream;
  // Microphone -> plugin input. Replace navigator.mediaDevices wholesale at the PROTOTYPE level: an expando set on the real
  // MediaDevices wrapper can be dropped by WebKit's GC (wrapper re-created without own properties), which left the page
  // waiting forever on the real getUserMedia inside the plugin. A plain object held by this closure cannot be lost.
  const fakeGUM = () => Promise.resolve(new FakeStream());
  const fakeDevices = {
    getUserMedia: fakeGUM,
    enumerateDevices: () => Promise.resolve([{ deviceId: 'default', kind: 'audioinput', label: 'Plugin input', groupId: 'h2p', toJSON() { return this; } }]),
    getSupportedConstraints: () => ({ echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: true, channelCount: true }),
    getDisplayMedia: () => Promise.reject(new Error('getDisplayMedia is not available inside a plugin')),
    addEventListener() { }, removeEventListener() { }, dispatchEvent() { return true; }, ondevicechange: null
  };
  let installed = false;
  try { const NP = window.Navigator && window.Navigator.prototype; if (NP) { Object.defineProperty(NP, 'mediaDevices', { get: () => fakeDevices, configurable: true }); installed = navigator.mediaDevices === fakeDevices; } } catch (e) { }
  if (!installed) { try { Object.defineProperty(navigator, 'mediaDevices', { get: () => fakeDevices, configurable: true }); installed = navigator.mediaDevices === fakeDevices; } catch (e) { } }
  if (!installed) { try { navigator.mediaDevices.getUserMedia = fakeGUM; } catch (e) { } }
  if (window.MediaDevices && window.MediaDevices.prototype) { try { window.MediaDevices.prototype.getUserMedia = fakeGUM; } catch (e) { } }  // belt and braces
  if (navigator.getUserMedia || navigator.webkitGetUserMedia) { const legacy = (c, ok, fail) => { fakeGUM().then(ok, fail); }; try { navigator.getUserMedia = legacy; navigator.webkitGetUserMedia = legacy; } catch (e) { } }
  // Blob URLs for worklet modules: keep real behaviour, the forge has already matched module text to the registry
  window.__h2p = { version: 1, now, nodesById, receive, contexts: AudioContextShim.instances, flush, emit, onHostParam: null, serializeMessage, reviveMessage,
    // Host -> UI: let the host push a parameter change the way the page's own UI would (best-effort; the forge wires setters when it finds them)
    lastParamsMessage: null };
  // Page diagnostics -> native log (console.error/warn, uncaught errors, unhandled rejections). The engine ignores 'log' ops; the editor writes them to the plugin log.
  (function () {
    const fwd = (level, args) => { try { emit({ op: 'log', level, text: Array.from(args).map(a => (a && a.stack) ? String(a.stack) : (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ').slice(0, 2000) }); } catch (e) { } };
    const ce = console.error.bind(console), cw = console.warn.bind(console);
    console.error = function () { fwd('error', arguments); ce.apply(console, arguments); };
    console.warn = function () { fwd('warn', arguments); cw.apply(console, arguments); };
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('error', e => fwd('uncaught', [e.message, e.filename + ':' + e.lineno]));
      window.addEventListener('unhandledrejection', e => fwd('unhandledrejection', [e.reason && (e.reason.stack || e.reason.message) || e.reason]));
    }
    fwd('info', ['shim installed; mediaDevices ' + (navigator.mediaDevices ? 'present' : 'MISSING') + ', getUserMedia is ' + (navigator.mediaDevices && navigator.mediaDevices.getUserMedia === fakeGUM ? 'shim' : 'NOT the shim') + ', secureContext=' + window.isSecureContext + ', origin=' + (typeof location !== 'undefined' ? location.origin : '?')]);
  })();
  log('shim installed, sampleRate', SR);
})();
