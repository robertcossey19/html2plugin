/* html2plugin — pull-based Web Audio graph engine.
 * Runs unchanged in Node (golden master / tests) and inside JavaScriptCore in the plugin.
 * The page's own graph calls are replayed here as RPC ops (see applyOp); AudioWorklet processors run unchanged.
 * Scope: Gain, Delay, BiquadFilter, WaveShaper, StereoPanner, ChannelSplitter/Merger, ConstantSource,
 * Oscillator, BufferSource, DynamicsCompressor, Analyser, Convolver (direct, short IR), MediaStreamSource (= plugin
 * input), Destination (= plugin output), AudioWorkletNode. Fixed 128-frame quantum, stereo bus.
 */
(function (root) {
  'use strict';
  const Q = 128;

  /* ------------------------------------------------------------------ AudioParam */
  class AudioParam {
    constructor(ctx, defaultValue, minValue, maxValue, rate) {
      this.ctx = ctx; this.defaultValue = defaultValue; this._v = defaultValue;
      this.minValue = minValue == null ? -3.4028235e38 : minValue; this.maxValue = maxValue == null ? 3.4028235e38 : maxValue;
      this.automationRate = rate || 'a-rate';
      this.events = []; this.inputs = []; this.buf = new Float32Array(Q); this.active = null;
    }
    get value() { return this._v; }
    set value(v) { this.setValueAtTime(this._clamp(+v), this.ctx.currentTime); }
    _clamp(v) { return v < this.minValue ? this.minValue : (v > this.maxValue ? this.maxValue : v); }
    _insert(ev) { const evs = this.events; let i = evs.length; while (i > 0 && evs[i - 1].time > ev.time) i--; evs.splice(i, 0, ev); return this; }
    setValueAtTime(v, t) { return this._insert({ type: 'set', value: +v, time: +t }); }
    linearRampToValueAtTime(v, t) { return this._insert({ type: 'lin', value: +v, time: +t }); }
    exponentialRampToValueAtTime(v, t) { return this._insert({ type: 'exp', value: +v, time: +t }); }
    setTargetAtTime(v, t, tc) { return this._insert({ type: 'tgt', value: +v, time: +t, tc: Math.max(+tc, 1e-6) }); }
    setValueCurveAtTime(curve, t, dur) { const c = Array.from(curve, Number); return this._insert({ type: 'curve', curve: c, time: +t, dur: Math.max(+dur, 1e-9), value: c[c.length - 1] }); }
    cancelScheduledValues(t) { this.events = this.events.filter(e => e.time < t); return this; }
    cancelAndHoldAtTime(t) { this.events = this.events.filter(e => e.time < t); this.active = null; return this; }
    hasAutomation() { return this.events.length > 0 || this.inputs.length > 0 || this.active !== null; }
    /* Fill out[0..n) with the timeline value for frames starting at absolute time t0 (dt = 1/sr). */
    _fill(out, t0, n, dt) {
      const evs = this.events; let v = this._v; let active = this.active;
      for (let i = 0; i < n; i++) {
        const t = t0 + i * dt;
        while (evs.length && evs[0].time <= t) {
          const e = evs.shift();
          if (e.type === 'set' || e.type === 'lin' || e.type === 'exp') { v = e.value; active = null; }
          else if (e.type === 'tgt') active = e;
          else if (e.type === 'curve') active = e;
        }
        const nxt = evs[0];
        if (nxt && (nxt.type === 'lin' || nxt.type === 'exp')) {
          if (nxt._sv == null) { nxt._sv = v; nxt._st = t; }                       // ramp starts where the timeline is when it becomes next
          const span = nxt.time - nxt._st; const a = span > 0 ? Math.min(1, (t - nxt._st) / span) : 1;
          v = nxt.type === 'lin' ? nxt._sv + (nxt.value - nxt._sv) * a : ((nxt._sv > 0 && nxt.value > 0) ? nxt._sv * Math.pow(nxt.value / nxt._sv, a) : (a >= 1 ? nxt.value : nxt._sv));
          active = null;
        } else if (active) {
          if (active.type === 'tgt') v = active.value + (v - active.value) * Math.exp(-dt / active.tc);
          else { const e = active; const a = (t - e.time) / e.dur; if (a >= 1) { v = e.value; active = null; } else { const x = a * (e.curve.length - 1), k = Math.floor(x), f = x - k; v = e.curve[k] + (e.curve[Math.min(k + 1, e.curve.length - 1)] - e.curve[k]) * f; } }
        }
        if (out) out[i] = v;
      }
      this._v = v; this.active = active;
      return out;
    }
    /* Float32Array(Q) of values for this quantum (computed a-rate; k-rate consumers read [0]). */
    values() {
      const ctx = this.ctx; const dt = 1 / ctx.sampleRate;
      this._fill(this.buf, ctx.currentTime, Q, dt);
      const buf = this.buf;
      for (let k = 0; k < this.inputs.length; k++) { const src = this.inputs[k]; const o = src.node._pull(src.output); for (let i = 0; i < Q; i++) buf[i] += 0.5 * (o[0][i] + o[1][i]); }
      if (this.minValue > -3e38 || this.maxValue < 3e38) for (let i = 0; i < Q; i++) buf[i] = this._clamp(buf[i]);
      return buf;
    }
  }

  /* ------------------------------------------------------------------ AudioNode */
  let nextTick = 1;
  class AudioNode {
    constructor(ctx, numOutputs) {
      this.ctx = ctx; this.id = -1; this.inputs = [[]]; // inputs[inIdx] = [{node, output}]
      this.numberOfOutputs = numOutputs == null ? 1 : numOutputs;
      this.outBufs = []; for (let o = 0; o < this.numberOfOutputs; o++) this.outBufs.push([new Float32Array(Q), new Float32Array(Q)]);
      this.tick = 0; this.rendering = false; this.channelCount = 2; this.params = {};
      this.mixL = new Float32Array(Q); this.mixR = new Float32Array(Q);
    }
    connect(dst, outIdx, inIdx) {
      outIdx = outIdx | 0; inIdx = inIdx | 0;
      if (dst instanceof AudioParam) { dst.inputs.push({ node: this, output: outIdx }); return dst; }
      while (dst.inputs.length <= inIdx) dst.inputs.push([]);
      dst.inputs[inIdx].push({ node: this, output: outIdx }); return dst;
    }
    disconnect(dst, outIdx, inIdx) {
      const match = c => c.node === this && (outIdx == null || c.output === outIdx);
      if (dst instanceof AudioParam) { dst.inputs = dst.inputs.filter(c => !match(c)); return; }
      const targets = dst ? [dst] : this.ctx.nodes.filter(Boolean);
      for (const n of targets) {
        if (!n || !n.inputs) continue;
        for (let i = 0; i < n.inputs.length; i++) if (inIdx == null || i === inIdx) n.inputs[i] = n.inputs[i].filter(c => !match(c));
      }
      if (!dst) for (const n of this.ctx.nodes) if (n && n.params) for (const k in n.params) n.params[k].inputs = n.params[k].inputs.filter(c => !match(c));
    }
    /* sum all connections of input inIdx into mixL/mixR; returns [L,R] */
    _mixInput(inIdx) {
      const L = this.mixL, R = this.mixR; L.fill(0); R.fill(0);
      const conns = this.inputs[inIdx] || [];
      for (let k = 0; k < conns.length; k++) {
        const c = conns[k]; const o = c.node._pull(c.output);
        if (!o) continue; const oL = o[0], oR = o[1] || o[0];
        for (let i = 0; i < Q; i++) { L[i] += oL[i]; R[i] += oR[i]; }
      }
      return [L, R, conns.length];
    }
    _pull(outIdx) {
      outIdx = outIdx | 0;
      if (this.tick === this.ctx.tick) return this.outBufs[outIdx];
      if (this.rendering) return this.outBufs[outIdx];      // cycle: return previous quantum (DelayNode in loop)
      this.rendering = true; this.process(); this.rendering = false; this.tick = this.ctx.tick;
      return this.outBufs[outIdx];
    }
    process() { const [L, R] = this._mixInput(0); this.outBufs[0][0].set(L); this.outBufs[0][1].set(R); }
  }
  function defParam(node, name, def, min, max, rate) { const p = new AudioParam(node.ctx, def, min, max, rate); node.params[name] = p; Object.defineProperty(node, name, { value: p, enumerable: true }); return p; }

  class DestinationNode extends AudioNode { constructor(ctx) { super(ctx, 1); this.maxChannelCount = 2; } process() { const [L, R] = this._mixInput(0); this.outBufs[0][0].set(L); this.outBufs[0][1].set(R); } }
  class InputNode extends AudioNode { constructor(ctx) { super(ctx, 1); } process() { this.outBufs[0][0].set(this.ctx.inL); this.outBufs[0][1].set(this.ctx.inR); } }

  class GainNode extends AudioNode {
    constructor(ctx) { super(ctx, 1); defParam(this, 'gain', 1); }
    process() {
      const [L, R] = this._mixInput(0); const oL = this.outBufs[0][0], oR = this.outBufs[0][1];
      if (this.gain.hasAutomation()) { const g = this.gain.values(); for (let i = 0; i < Q; i++) { oL[i] = L[i] * g[i]; oR[i] = R[i] * g[i]; } }
      else { const g = this.gain._v; for (let i = 0; i < Q; i++) { oL[i] = L[i] * g; oR[i] = R[i] * g; } }
    }
  }

  class DelayNode extends AudioNode {
    constructor(ctx, maxDelay) {
      super(ctx, 1); this.maxDelayTime = maxDelay == null ? 1 : +maxDelay;
      defParam(this, 'delayTime', 0, 0, this.maxDelayTime);
      this.len = Math.ceil(this.maxDelayTime * ctx.sampleRate) + Q + 2; this.bL = new Float32Array(this.len); this.bR = new Float32Array(this.len); this.w = 0;
    }
    process() {
      const [L, R] = this._mixInput(0); const oL = this.outBufs[0][0], oR = this.outBufs[0][1]; const sr = this.ctx.sampleRate; const len = this.len;
      const auto = this.delayTime.hasAutomation(); const d = auto ? this.delayTime.values() : null; const dk = this.delayTime._v;
      for (let i = 0; i < Q; i++) {
        this.bL[this.w] = L[i]; this.bR[this.w] = R[i];
        let ds = (auto ? d[i] : dk) * sr; if (ds < 0) ds = 0; if (ds > len - 2) ds = len - 2;
        let rp = this.w - ds; while (rp < 0) rp += len;
        const i0 = Math.floor(rp), f = rp - i0, i1 = (i0 + 1) % len;
        oL[i] = this.bL[i0] + (this.bL[i1] - this.bL[i0]) * f; oR[i] = this.bR[i0] + (this.bR[i1] - this.bR[i0]) * f;
        this.w = (this.w + 1) % len;
      }
    }
  }

  class BiquadFilterNode extends AudioNode {
    constructor(ctx) {
      super(ctx, 1); this.type = 'lowpass';
      defParam(this, 'frequency', 350, 0, ctx.sampleRate / 2); defParam(this, 'detune', 0); defParam(this, 'Q', 1); defParam(this, 'gain', 0);
      this.x1 = [0, 0]; this.x2 = [0, 0]; this.y1 = [0, 0]; this.y2 = [0, 0]; this._c = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 }; this._key = '';
    }
    _coef(freq, Q, gainDb, detune) {
      const sr = this.ctx.sampleRate; let f = freq * Math.pow(2, detune / 1200); f = Math.max(0, Math.min(f, sr / 2)); const nf = f / (sr / 2);
      const A = Math.pow(10, gainDb / 40); const c = this._c; let b0, b1, b2, a0, a1, a2;
      const w0 = Math.PI * nf, cw = Math.cos(w0), sw = Math.sin(w0);
      switch (this.type) {
        case 'lowpass': { if (nf >= 1) { b0 = 1; b1 = b2 = a1 = a2 = 0; a0 = 1; break; } if (nf <= 0) { b0 = b1 = b2 = a1 = a2 = 0; a0 = 1; break; }
          const g = Math.pow(10, 0.05 * Q); const d = Math.sqrt((4 - Math.sqrt(16 - 16 / (g * g))) / 2); const th = Math.PI * nf; const sn = d * Math.sin(th) / 2; const beta = 0.5 * (1 - sn) / (1 + sn); const gamma = (0.5 + beta) * Math.cos(th); const alpha = 0.25 * (0.5 + beta - gamma);
          b0 = 2 * alpha; b1 = 4 * alpha; b2 = 2 * alpha; a0 = 1; a1 = 2 * -gamma; a2 = 2 * beta; break; }
        case 'highpass': { if (nf >= 1) { b0 = b1 = b2 = a1 = a2 = 0; a0 = 1; break; } if (nf <= 0) { b0 = 1; b1 = b2 = a1 = a2 = 0; a0 = 1; break; }
          const g = Math.pow(10, 0.05 * Q); const d = Math.sqrt((4 - Math.sqrt(16 - 16 / (g * g))) / 2); const th = Math.PI * nf; const sn = d * Math.sin(th) / 2; const beta = 0.5 * (1 - sn) / (1 + sn); const gamma = (0.5 + beta) * Math.cos(th); const alpha = 0.25 * (0.5 + beta + gamma);
          b0 = 2 * alpha; b1 = -4 * alpha; b2 = 2 * alpha; a0 = 1; a1 = 2 * -gamma; a2 = 2 * beta; break; }
        case 'bandpass': { const q = Math.max(Q, 0); const al = q > 0 ? sw / (2 * q) : 0; b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break; }
        case 'notch': { const q = Math.max(Q, 0); const al = q > 0 ? sw / (2 * q) : 0; b0 = 1; b1 = -2 * cw; b2 = 1; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break; }
        case 'allpass': { const q = Math.max(Q, 0); const al = q > 0 ? sw / (2 * q) : 0; b0 = 1 - al; b1 = -2 * cw; b2 = 1 + al; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break; }
        case 'peaking': { const q = Math.max(Q, 0); const al = q > 0 ? sw / (2 * q) : 0; b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A; break; }
        case 'lowshelf': { const al = sw / 2 * Math.SQRT2; const sa = 2 * Math.sqrt(A) * al; b0 = A * ((A + 1) - (A - 1) * cw + sa); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - sa); a0 = (A + 1) + (A - 1) * cw + sa; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - sa; break; }
        case 'highshelf': { const al = sw / 2 * Math.SQRT2; const sa = 2 * Math.sqrt(A) * al; b0 = A * ((A + 1) + (A - 1) * cw + sa); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - sa); a0 = (A + 1) - (A - 1) * cw + sa; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - sa; break; }
        default: b0 = 1; b1 = b2 = a1 = a2 = 0; a0 = 1;
      }
      c.b0 = b0 / a0; c.b1 = b1 / a0; c.b2 = b2 / a0; c.a1 = a1 / a0; c.a2 = a2 / a0;
    }
    process() {
      const [L, R] = this._mixInput(0); const out = this.outBufs[0]; const ins = [L, R];
      const auto = this.frequency.hasAutomation() || this.Q.hasAutomation() || this.gain.hasAutomation() || this.detune.hasAutomation();
      let fv, qv, gv, dv; if (auto) { fv = this.frequency.values().slice(); qv = this.Q.values().slice(); gv = this.gain.values().slice(); dv = this.detune.values().slice(); }
      else { const key = this.type + '|' + this.frequency._v + '|' + this.Q._v + '|' + this.gain._v + '|' + this.detune._v; if (key !== this._key) { this._coef(this.frequency._v, this.Q._v, this.gain._v, this.detune._v); this._key = key; } }
      for (let ch = 0; ch < 2; ch++) {
        const x = ins[ch], y = out[ch]; let x1 = this.x1[ch], x2 = this.x2[ch], y1 = this.y1[ch], y2 = this.y2[ch]; const c = this._c;
        for (let i = 0; i < Q; i++) {
          if (auto && ch === 0) { this._coef(fv[i], qv[i], gv[i], dv[i]); }
          const xi = x[i]; const yi = c.b0 * xi + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
          x2 = x1; x1 = xi; y2 = y1; y1 = yi; y[i] = yi;
        }
        this.x1[ch] = x1; this.x2[ch] = x2; this.y1[ch] = y1; this.y2[ch] = y2;
        if (auto && ch === 0) { this._key = ''; }
      }
      if (auto) { this._coef(fv[0], qv[0], gv[0], dv[0]); } // leave coefficients at quantum start for ch1 consistency next time
    }
    getFrequencyResponse() { }
  }

  class WaveShaperNode extends AudioNode {
    constructor(ctx) { super(ctx, 1); this._curve = null; this.oversample = 'none'; }
    get curve() { return this._curve; } set curve(c) { this._curve = c ? Float32Array.from(c) : null; }
    process() {
      const [L, R] = this._mixInput(0); const out = this.outBufs[0]; const c = this._curve;
      if (!c || c.length < 2) { out[0].set(L); out[1].set(R); return; }
      const n = c.length; const ins = [L, R];
      for (let ch = 0; ch < 2; ch++) { const x = ins[ch], y = out[ch]; for (let i = 0; i < Q; i++) { const v = (n - 1) / 2 * (x[i] + 1); if (v <= 0) y[i] = c[0]; else if (v >= n - 1) y[i] = c[n - 1]; else { const k = Math.floor(v), f = v - k; y[i] = c[k] + (c[k + 1] - c[k]) * f; } } }
    }
  }

  class StereoPannerNode extends AudioNode {
    constructor(ctx) { super(ctx, 1); defParam(this, 'pan', 0, -1, 1); }
    process() {
      const [L, R, nconn] = this._mixInput(0); const oL = this.outBufs[0][0], oR = this.outBufs[0][1]; const auto = this.pan.hasAutomation(); const pv = auto ? this.pan.values() : null;
      for (let i = 0; i < Q; i++) { const p = auto ? pv[i] : this.pan._v; const x = (p <= 0 ? p + 1 : p) * Math.PI / 2; const gl = Math.cos(x), gr = Math.sin(x);
        if (p <= 0) { oL[i] = L[i] + R[i] * gl; oR[i] = R[i] * gr; } else { oL[i] = L[i] * gl; oR[i] = R[i] + L[i] * gr; } }
    }
  }

  class ChannelSplitterNode extends AudioNode {
    constructor(ctx, n) { super(ctx, n || 6); }
    process() { const [L, R] = this._mixInput(0); for (let o = 0; o < this.numberOfOutputs; o++) { const src = o === 0 ? L : (o === 1 ? R : null); const b = this.outBufs[o]; if (src) { b[0].set(src); b[1].set(src); } else { b[0].fill(0); b[1].fill(0); } } }
  }
  class ChannelMergerNode extends AudioNode {
    constructor(ctx, n) { super(ctx, 1); this.inputs = []; for (let i = 0; i < (n || 6); i++) this.inputs.push([]); }
    process() { const oL = this.outBufs[0][0], oR = this.outBufs[0][1]; const [L] = this._mixInput(0); oL.set(L); const [L2] = this._mixInput(1); oR.set(L2); }
  }

  class ConstantSourceNode extends AudioNode {
    constructor(ctx) { super(ctx, 1); defParam(this, 'offset', 1); this.started = false; }
    start() { this.started = true; } stop() { this.started = false; }
    process() { const o = this.outBufs[0]; if (!this.started) { o[0].fill(0); o[1].fill(0); return; } if (this.offset.hasAutomation()) { const v = this.offset.values(); o[0].set(v); o[1].set(v); } else { o[0].fill(this.offset._v); o[1].fill(this.offset._v); } }
  }

  class OscillatorNode extends AudioNode {
    constructor(ctx) { super(ctx, 1); this.type = 'sine'; defParam(this, 'frequency', 440); defParam(this, 'detune', 0); this.ph = 0; this.started = false; }
    start() { this.started = true; } stop() { this.started = false; } setPeriodicWave() { }
    process() {
      const o = this.outBufs[0]; if (!this.started) { o[0].fill(0); o[1].fill(0); return; }
      const sr = this.ctx.sampleRate; const auto = this.frequency.hasAutomation() || this.detune.hasAutomation(); const fv = auto ? this.frequency.values().slice() : null; const dv = auto ? this.detune.values() : null;
      for (let i = 0; i < Q; i++) {
        const f = (auto ? fv[i] : this.frequency._v) * Math.pow(2, (auto ? dv[i] : this.detune._v) / 1200); const t = this.ph; let v;
        switch (this.type) { case 'square': v = t < 0.5 ? 1 : -1; break; case 'sawtooth': v = 2 * t - 1; break; case 'triangle': v = 1 - 4 * Math.abs(t - 0.5); break; default: v = Math.sin(2 * Math.PI * t); }
        o[0][i] = v; o[1][i] = v; this.ph += f / sr; if (this.ph >= 1) this.ph -= 1; if (this.ph < 0) this.ph += 1;
      }
    }
  }

  class AudioBuffer { constructor(ch, len, sr) { this.numberOfChannels = ch; this.length = len; this.sampleRate = sr; this.duration = len / sr; this._d = []; for (let i = 0; i < ch; i++) this._d.push(new Float32Array(len)); } getChannelData(i) { return this._d[i]; } copyToChannel(src, ch, off) { this._d[ch].set(src, off | 0); } copyFromChannel(dst, ch, off) { dst.set(this._d[ch].subarray(off | 0, (off | 0) + dst.length)); } }

  class AudioBufferSourceNode extends AudioNode {
    constructor(ctx) { super(ctx, 1); this.buffer = null; this.loop = false; this.loopStart = 0; this.loopEnd = 0; defParam(this, 'playbackRate', 1); defParam(this, 'detune', 0); this.pos = 0; this.started = false; this.onended = null; }
    start(when, offset) { this.started = true; this.pos = (offset || 0) * (this.buffer ? this.buffer.sampleRate : this.ctx.sampleRate); } stop() { this.started = false; }
    process() {
      const o = this.outBufs[0]; const b = this.buffer; if (!this.started || !b) { o[0].fill(0); o[1].fill(0); return; }
      const rate = this.playbackRate._v * Math.pow(2, this.detune._v / 1200) * (b.sampleRate / this.ctx.sampleRate); const L = b._d[0], R = b._d[1] || b._d[0]; const n = b.length;
      const le = this.loopEnd > 0 ? Math.min(this.loopEnd * b.sampleRate, n) : n, ls = this.loopStart * b.sampleRate;
      for (let i = 0; i < Q; i++) {
        if (this.pos >= (this.loop ? le : n)) { if (this.loop) this.pos = ls + (this.pos - le); else { this.started = false; for (; i < Q; i++) { o[0][i] = 0; o[1][i] = 0; } if (this.onended) this.ctx._later(() => this.onended({})); break; } }
        const k = Math.floor(this.pos), f = this.pos - k, k1 = Math.min(k + 1, n - 1); o[0][i] = L[k] + (L[k1] - L[k]) * f; o[1][i] = R[k] + (R[k1] - R[k]) * f; this.pos += rate;
      }
    }
  }

  class DynamicsCompressorNode extends AudioNode {
    // Spec-shaped feed-forward compressor with soft knee; Chrome's internal pre-delay/adaptive release are not replicated.
    constructor(ctx) { super(ctx, 1); defParam(this, 'threshold', -24, -100, 0); defParam(this, 'knee', 30, 0, 40); defParam(this, 'ratio', 12, 1, 20); defParam(this, 'attack', 0.003, 0, 1); defParam(this, 'release', 0.25, 0, 1); this.reduction = 0; this.env = 0; }
    process() {
      const [L, R] = this._mixInput(0); const oL = this.outBufs[0][0], oR = this.outBufs[0][1]; const sr = this.ctx.sampleRate;
      const T = this.threshold._v, K = this.knee._v, Rr = this.ratio._v; const aA = Math.exp(-1 / (Math.max(1e-4, this.attack._v) * sr)), aR = Math.exp(-1 / (Math.max(1e-4, this.release._v) * sr));
      const makeup = Math.pow(10, -(gainDb(0)) / 20);
      function gainDb(xDb) { const over = xDb - T; if (over <= -K / 2) return 0; if (over >= K / 2) return -(over - over / Rr); const t = over + K / 2; return -((1 / Rr - 1) * -1) * 0 - (t * t / (2 * K)) * (1 - 1 / Rr); }
      for (let i = 0; i < Q; i++) {
        const x = Math.max(Math.abs(L[i]), Math.abs(R[i])); const xDb = 20 * Math.log10(x + 1e-12); const gDb = gainDb(xDb); const target = Math.pow(10, gDb / 20);
        this.env = target < this.env ? aA * this.env + (1 - aA) * target : aR * this.env + (1 - aR) * target;
        const g = this.env * makeup; oL[i] = L[i] * g; oR[i] = R[i] * g; this.reduction = 20 * Math.log10(this.env + 1e-12);
      }
    }
  }

  class AnalyserNode extends AudioNode {
    constructor(ctx) { super(ctx, 1); this.fftSize = 2048; this.smoothingTimeConstant = 0.8; this.minDecibels = -100; this.maxDecibels = -30; this.ring = new Float32Array(32768); this.w = 0; this._sm = null; }
    get frequencyBinCount() { return this.fftSize / 2; }
    process() { const [L, R] = this._mixInput(0); this.outBufs[0][0].set(L); this.outBufs[0][1].set(R); for (let i = 0; i < Q; i++) { this.ring[this.w] = 0.5 * (L[i] + R[i]); this.w = (this.w + 1) & 32767; } }
    getFloatTimeDomainData(a) { const n = Math.min(a.length, this.fftSize); for (let i = 0; i < n; i++) a[i] = this.ring[(this.w - n + i) & 32767]; }
    getByteTimeDomainData(a) { const n = Math.min(a.length, this.fftSize); for (let i = 0; i < n; i++) a[i] = Math.max(0, Math.min(255, Math.round(128 * (1 + this.ring[(this.w - n + i) & 32767])))); }
    _spectrum() {
      const N = this.fftSize; const re = new Float64Array(N), im = new Float64Array(N);
      for (let i = 0; i < N; i++) { const w = 0.5 * (1 - Math.cos(2 * Math.PI * i / N)); re[i] = this.ring[(this.w - N + i) & 32767] * w; }
      fft(re, im); const out = new Float32Array(N / 2); if (!this._sm || this._sm.length !== N / 2) this._sm = new Float32Array(N / 2);
      for (let k = 0; k < N / 2; k++) { const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]) / N; this._sm[k] = this.smoothingTimeConstant * this._sm[k] + (1 - this.smoothingTimeConstant) * m; out[k] = 20 * Math.log10(this._sm[k] + 1e-20); }
      return out;
    }
    getFloatFrequencyData(a) { const s = this._spectrum(); for (let i = 0; i < Math.min(a.length, s.length); i++) a[i] = s[i]; }
    getByteFrequencyData(a) { const s = this._spectrum(); const lo = this.minDecibels, hi = this.maxDecibels; for (let i = 0; i < Math.min(a.length, s.length); i++) a[i] = Math.max(0, Math.min(255, Math.round(255 * (s[i] - lo) / (hi - lo)))); }
  }
  function fft(re, im) { const n = re.length; for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let len = 2; len <= n; len <<= 1) { const ang = -2 * Math.PI / len; const wr = Math.cos(ang), wi = Math.sin(ang); for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let j = 0; j < len / 2; j++) { const ur = re[i + j], ui = im[i + j]; const vr = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci, vi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr; re[i + j] = ur + vr; im[i + j] = ui + vi; re[i + j + len / 2] = ur - vr; im[i + j + len / 2] = ui - vi; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } } } }

  class ConvolverNode extends AudioNode {
    // Direct-form convolution; adequate for short IRs (< ~4096 taps). Longer IRs are flagged by the forge.
    constructor(ctx) { super(ctx, 1); this._buffer = null; this.normalize = true; this.hist = [new Float32Array(65536), new Float32Array(65536)]; this.hw = 0; }
    get buffer() { return this._buffer; }
    set buffer(b) { this._buffer = b; if (!b) return; let scale = 1; if (this.normalize) { let e = 0; for (let c = 0; c < b.numberOfChannels; c++) { const d = b._d[c]; for (let i = 0; i < d.length; i++) e += d[i] * d[i]; } e = Math.sqrt(e / b.numberOfChannels); if (e > 0) scale = Math.pow(10, -0.0 / 20) * (1 / e) * 0.00125 * Math.sqrt(b.length) ; if (!isFinite(scale) || scale <= 0) scale = 1; } this._irL = Float32Array.from(b._d[0], v => v * scale); this._irR = Float32Array.from(b._d[1] || b._d[0], v => v * scale); }
    process() { const [L, R] = this._mixInput(0); const oL = this.outBufs[0][0], oR = this.outBufs[0][1]; if (!this._irL) { oL.set(L); oR.set(R); return; } const irL = this._irL, irR = this._irR, n = Math.min(irL.length, 65536), hL = this.hist[0], hR = this.hist[1];
      for (let i = 0; i < Q; i++) { hL[this.hw] = L[i]; hR[this.hw] = R[i]; let aL = 0, aR = 0; for (let k = 0; k < n; k++) { const idx = (this.hw - k) & 65535; aL += hL[idx] * irL[k]; aR += hR[idx] * irR[k]; } oL[i] = aL; oR[i] = aR; this.hw = (this.hw + 1) & 65535; } }
  }

  /* ------------------------------------------------------------------ AudioWorklet */
  class MessagePort {
    constructor() { this.onmessage = null; this._peer = null; this._listeners = []; }
    postMessage(data) { const p = this._peer; if (!p) return; p._deliver(data); }
    _deliver(data) { const ev = { data: data }; if (this.onmessage) this.onmessage(ev); for (const f of this._listeners) f(ev); }
    addEventListener(t, f) { if (t === 'message') this._listeners.push(f); } removeEventListener(t, f) { this._listeners = this._listeners.filter(x => x !== f); } start() { } close() { }
  }
  const registry = Object.create(null);
  class AudioWorkletProcessor {
    constructor(options) { const inst = AudioWorkletProcessor._pending; this.port = inst ? inst.procPort : new MessagePort(); }
  }
  function registerProcessor(name, cls) {
    if (typeof cls !== 'function') throw new TypeError('registerProcessor: not a constructor');
    registry[name] = cls;
  }

  class AudioWorkletNode extends AudioNode {
    constructor(ctx, name, options) {
      options = options || {};
      const cls = registry[name]; if (!cls) throw new Error("AudioWorkletNode: '" + name + "' is not registered (addModule first)");
      super(ctx, options.numberOfOutputs == null ? 1 : options.numberOfOutputs);
      this.numberOfInputs = options.numberOfInputs == null ? 1 : options.numberOfInputs; this.inputs = []; for (let i = 0; i < this.numberOfInputs; i++) this.inputs.push([]);
      this.outputChannelCount = options.outputChannelCount || null; this.name = name; this.onprocessorerror = null;
      this.port = new MessagePort(); const procPort = new MessagePort(); this.port._peer = procPort; procPort._peer = this.port;
      const descs = (cls.parameterDescriptors || []); this.parameters = new Map(); this._paramBufs = {};
      for (const d of descs) { const p = new AudioParam(ctx, d.defaultValue == null ? 0 : d.defaultValue, d.minValue, d.maxValue, d.automationRate || 'a-rate'); this.parameters.set(d.name, p); this.params[d.name] = p; this._paramBufs[d.name] = new Float32Array(1); }
      if (options.parameterData) for (const k in options.parameterData) if (this.parameters.has(k)) this.parameters.get(k).value = options.parameterData[k];
      // instantiate processor with its port available in the base constructor
      AudioWorkletProcessor._pending = { procPort: procPort };
      try { this.processor = new cls({ numberOfInputs: this.numberOfInputs, numberOfOutputs: this.numberOfOutputs, outputChannelCount: this.outputChannelCount, parameterData: options.parameterData, processorOptions: reviveMessage(options.processorOptions || {}) }); }
      finally { AudioWorkletProcessor._pending = null; }
      if (!this.processor.port) this.processor.port = procPort;
      this._inputs = []; for (let i = 0; i < this.numberOfInputs; i++) this._inputs.push([new Float32Array(Q), new Float32Array(Q)]);
      this._outputs = []; for (let o = 0; o < this.numberOfOutputs; o++) { const nch = this.outputChannelCount ? this.outputChannelCount[o] : 2; const arr = []; for (let c = 0; c < nch; c++) arr.push(new Float32Array(Q)); this._outputs.push(arr); }
      this._silentIn = []; this.alive = true; this.paramObj = {};
    }
    process() {
      if (!this.alive) { for (const o of this.outBufs) { o[0].fill(0); o[1].fill(0); } return; }
      const ins = this._inputs;
      for (let i = 0; i < this.numberOfInputs; i++) { const [L, R, nconn] = this._mixInput(i); if (nconn === 0) { this._inputs[i] = []; } else { if (!Array.isArray(this._inputs[i]) || this._inputs[i].length !== 2) this._inputs[i] = [new Float32Array(Q), new Float32Array(Q)]; this._inputs[i][0].set(L); this._inputs[i][1].set(R); } }
      const outs = this._outputs; for (const o of outs) for (const c of o) c.fill(0);
      const po = this.paramObj;
      this.parameters.forEach((p, k) => { if (p.hasAutomation() && p.automationRate !== 'k-rate') { po[k] = p.values(); } else { const b = this._paramBufs[k]; if (p.hasAutomation()) { p.values(); } b[0] = p._v; po[k] = b; } });
      let keep = true;
      try { keep = this.processor.process(ins, outs, po); }
      catch (e) { this.alive = false; this.ctx._error('AudioWorklet "' + this.name + '" threw: ' + (e && e.stack || e)); if (this.onprocessorerror) this.ctx._later(() => this.onprocessorerror({ message: String(e) })); }
      for (let o = 0; o < this.numberOfOutputs; o++) { const src = outs[o]; this.outBufs[o][0].set(src[0]); this.outBufs[o][1].set(src[1] || src[0]); }
      if (keep === false && !this._hasSources()) this.alive = false;
    }
    _hasSources() { return true; }
  }

  /* ------------------------------------------------------------------ Context / RPC */
  class Context {
    constructor(sampleRate) {
      this.sampleRate = sampleRate || 48000; this.currentFrame = 0; this.currentTime = 0; this.tick = 0; this.state = 'running';
      this.nodes = []; this.inL = new Float32Array(Q); this.inR = new Float32Array(Q); this.outL = new Float32Array(Q); this.outR = new Float32Array(Q);
      this.destination = this._reg(new DestinationNode(this)); this.input = this._reg(new InputNode(this)); this.outbox = []; this.errors = []; this._deferred = [];
      this.listener = {}; this.baseLatency = Q / this.sampleRate; this.audioWorklet = { addModule: (code) => this.addModule(code) };
    }
    _reg(n) { n.id = this.nodes.length; this.nodes.push(n); return n; }
    _error(m) { this.errors.push(m); this.outbox.push({ id: -1, data: { type: '__error', message: m } }); }
    _later(f) { this._deferred.push(f); }
    addModule(code) {
      // AudioWorkletGlobalScope: registerProcessor, AudioWorkletProcessor, sampleRate, currentFrame, currentTime
      const g = (typeof globalThis !== 'undefined') ? globalThis : root; const ctx = this;
      g.registerProcessor = registerProcessor; g.AudioWorkletProcessor = AudioWorkletProcessor;
      try { Object.defineProperty(g, 'sampleRate', { get: () => ctx.sampleRate, configurable: true }); } catch (e) { g.sampleRate = ctx.sampleRate; }
      try { Object.defineProperty(g, 'currentFrame', { get: () => ctx.currentFrame, configurable: true }); } catch (e) { }
      try { Object.defineProperty(g, 'currentTime', { get: () => ctx.currentTime, configurable: true }); } catch (e) { }
      (0, eval)(code);  // indirect eval: module code runs in global scope, exactly like a worklet module
      return Promise.resolve();
    }
    createGain() { return this._reg(new GainNode(this)); } createDelay(m) { return this._reg(new DelayNode(this, m)); } createBiquadFilter() { return this._reg(new BiquadFilterNode(this)); }
    createWaveShaper() { return this._reg(new WaveShaperNode(this)); } createStereoPanner() { return this._reg(new StereoPannerNode(this)); } createChannelSplitter(n) { return this._reg(new ChannelSplitterNode(this, n)); }
    createChannelMerger(n) { return this._reg(new ChannelMergerNode(this, n)); } createConstantSource() { return this._reg(new ConstantSourceNode(this)); } createOscillator() { return this._reg(new OscillatorNode(this)); }
    createBufferSource() { return this._reg(new AudioBufferSourceNode(this)); } createDynamicsCompressor() { return this._reg(new DynamicsCompressorNode(this)); } createAnalyser() { return this._reg(new AnalyserNode(this)); }
    createConvolver() { return this._reg(new ConvolverNode(this)); } createMediaStreamSource() { return this.input; } createMediaElementSource() { return this.input; } createMediaStreamDestination() { return this.destination; }
    createBuffer(ch, len, sr) { return new AudioBuffer(ch, len, sr || this.sampleRate); }
    createWorklet(name, options) { return this._reg(new AudioWorkletNode(this, name, options)); }
    resume() { this.state = 'running'; return Promise.resolve(); } suspend() { return Promise.resolve(); } close() { return Promise.resolve(); }
    /* Render one 128-frame quantum: inL/inR -> outL/outR. */
    renderQuantum() {
      this.tick++; const d = this.destination;
      if (!d.inputs[0] || d.inputs[0].length === 0) { this.outL.set(this.inL); this.outR.set(this.inR); }  // empty graph => pass-through, never silence
      else { d._pull(0); this.outL.set(d.outBufs[0][0]); this.outR.set(d.outBufs[0][1]); }
      this.currentFrame += Q; this.currentTime = this.currentFrame / this.sampleRate;
      if (this._deferred.length) { const fs = this._deferred; this._deferred = []; for (const f of fs) { try { f(); } catch (e) { this._error(String(e)); } } }
    }
    /* Render n frames (any n). zeroLatency=true writes each finished quantum straight back into the current block, which is
       only correct when every block is a multiple of 128 (then the plugin reports 0 latency); otherwise a 128-frame FIFO delay is used. */
    render(inL, inR, outL, outR, n, zeroLatency) {
      if (!this._fifo) { this._fifo = { inL: new Float32Array(Q), inR: new Float32Array(Q), outL: new Float32Array(Q), outR: new Float32Array(Q), fill: 0, ready: false }; }
      const f = this._fifo;
      if (zeroLatency) {
        for (let i = 0; i < n; i++) {
          f.inL[f.fill] = inL[i]; f.inR[f.fill] = inR ? inR[i] : inL[i]; f.fill++;
          if (f.fill === Q) { this.inL.set(f.inL); this.inR.set(f.inR); this.renderQuantum(); const base = i - (Q - 1); if (base >= 0) { outL.set(this.outL, base); if (outR) outR.set(this.outR, base); } else { for (let k = 0; k < Q; k++) { const j = base + k; if (j >= 0) { outL[j] = this.outL[k]; if (outR) outR[j] = this.outR[k]; } } } f.fill = 0; }
        }
        if (f.fill !== 0) { for (let i = n - f.fill; i < n; i++) if (i >= 0) { outL[i] = 0; if (outR) outR[i] = 0; } }
        return;
      }
      for (let i = 0; i < n; i++) {
        f.inL[f.fill] = inL[i]; f.inR[f.fill] = inR ? inR[i] : inL[i];
        outL[i] = f.ready ? f.outL[f.fill] : 0; if (outR) outR[i] = f.ready ? f.outR[f.fill] : 0;
        f.fill++;
        if (f.fill === Q) { this.inL.set(f.inL); this.inR.set(f.inR); this.renderQuantum(); f.outL.set(this.outL); f.outR.set(this.outR); f.fill = 0; f.ready = true; }
      }
    }
    get latencySamples() { return Q; }
    /* -------- RPC replay (ops recorded by the WebView shim) -------- */
    applyOp(op) {
      try {
        switch (op.op) {
          case 'addModule': return this.addModule(op.code);
          case 'create': {
            let n;
            switch (op.type) {
              case 'Gain': n = this.createGain(); break; case 'Delay': n = this.createDelay(op.args && op.args[0]); break; case 'BiquadFilter': n = this.createBiquadFilter(); break;
              case 'WaveShaper': n = this.createWaveShaper(); break; case 'StereoPanner': n = this.createStereoPanner(); break; case 'ChannelSplitter': n = this.createChannelSplitter(op.args && op.args[0]); break;
              case 'ChannelMerger': n = this.createChannelMerger(op.args && op.args[0]); break; case 'ConstantSource': n = this.createConstantSource(); break; case 'Oscillator': n = this.createOscillator(); break;
              case 'BufferSource': n = this.createBufferSource(); break; case 'DynamicsCompressor': n = this.createDynamicsCompressor(); break; case 'Analyser': n = this.createAnalyser(); break; case 'Convolver': n = this.createConvolver(); break;
              case 'MediaStreamSource': case 'MediaElementSource': n = this.input; break; case 'Destination': n = this.destination; break;
              case 'MediaStreamDestination': n = this.destination; break;
              case 'AudioWorklet': n = this.createWorklet(op.name, op.options || {}); break;
              default: throw new Error('unsupported node type ' + op.type);
            }
            this.alias = this.alias || {}; this.alias[op.id] = n; if (op.type === 'AudioWorklet') this.captureMessages(); return n;
          }
          case 'connect': { const a = this._n(op.from), b = this._n(op.to); if (op.param) a.connect(b.params[op.param], op.fromOut || 0); else a.connect(b, op.fromOut || 0, op.toIn || 0); return; }
          case 'disconnect': { const a = this._n(op.from); if (op.to == null) a.disconnect(); else { const b = this._n(op.to); if (op.param) a.disconnect(b.params[op.param]); else a.disconnect(b, op.fromOut, op.toIn); } return; }
          case 'param': { const n = this._n(op.id); const p = n.params[op.name] || (n.parameters && n.parameters.get(op.name)); if (!p) throw new Error('no param ' + op.name); 
            if (op.method === 'value') { p.value = op.args[0]; return; }
            const args = op.args.slice(); // remap scheduled times from the page clock to the engine clock: page 'now' -> engine now
            if (op.now != null) { for (let i = 0; i < args.length; i++) if (op.timeArgs && op.timeArgs.indexOf(i) >= 0) args[i] = this.currentTime + Math.max(0, args[i] - op.now); }
            if (op.method === 'setValueCurveAtTime') { p.setValueCurveAtTime(args[0], args[1], args[2]); return; }
            p[op.method].apply(p, args); return; }
          case 'prop': { const n = this._n(op.id); if (op.name === 'buffer' && op.value && op.value.channels) { const b = this.createBuffer(op.value.channels.length, op.value.length, op.value.sampleRate); op.value.channels.forEach((c, i) => b._d[i].set(c)); n.buffer = b; } else if (op.name === 'curve') n.curve = op.value; else n[op.name] = op.value; return; }
          case 'start': { const n = this._n(op.id); n.start(op.when == null ? undefined : this.currentTime + Math.max(0, op.when), op.offset, op.duration); return; }
          case 'stop': { const n = this._n(op.id); n.stop(op.when == null ? undefined : this.currentTime + Math.max(0, op.when)); return; }
          case 'hostParam': { this.outbox.push({ id: -2, data: { type: '__hostParams', values: { [op.name]: op.value } } }); return; }   // page-side UI-state parameter moved (bridge)
        case 'post': { const n = this._n(op.id); n.port.postMessage(reviveMessage(op.data)); this._notePost(op.id, op.data); return; }
          case 'reset': return this.resetGraph();
          case 'setSampleRate': return;
          case 'log': return;   // page console/error forwarding; consumed by the native editor
          default: throw new Error('unknown op ' + op.op);
        }
      } catch (e) { this._error('applyOp ' + JSON.stringify(op).slice(0, 200) + ': ' + (e && e.message || e)); }
    }
    _n(id) { const n = this._alias(id); if (!n) throw new Error('unknown node ' + id); return n; }
    _alias(id) { if (!this.alias) return null; const n = this.alias[id]; if (n) return n; return null; }
    /* Drop every page-created node (a fresh page load is about to rebuild the graph). Input/destination survive. */
    resetGraph() {
      for (const n of this.nodes) { if (n === this.input || n === this.destination) continue; try { n.disconnect(); } catch (e) { } n.alive = false; }
      this.input.disconnect(); this.destination.inputs = [[]];
      // rebuild node list so the engine never iterates dead nodes
      this.nodes = [this.destination, this.input]; this.destination.id = 0; this.input.id = 1; this.alias = {}; this.lastPost = {};
      return true;
    }
    /* ---- diagnostics: a compact picture of the live graph (for logs / HostTest) ---- */
    describe() {
      const idOf = n => { for (const k in (this.alias || {})) if (this.alias[k] === n) return +k; return n === this.destination ? 'dest' : n === this.input ? 'in' : n.id; };
      const nodes = this.nodes.map(n => ({
        id: idOf(n), type: n.constructor.name + (n.name ? '(' + n.name + ')' : ''),
        inputs: n.inputs.map(list => list.map(c => idOf(c.node) + (c.output ? ':' + c.output : ''))),
        paramInputs: Object.keys(n.params || {}).filter(k => n.params[k].inputs && n.params[k].inputs.length).map(k => k + '<-' + n.params[k].inputs.map(c => idOf(c.node)).join(',')),
        gain: n.params && n.params.gain ? +n.params.gain.value.toFixed(4) : undefined,
        started: n._started !== undefined ? !!n._started : undefined, alive: n.alive
      }));
      return { currentTime: +this.currentTime.toFixed(3), passThrough: !this.destination.inputs.some(l => l.length), nodes };
    }
    describeJSON() { try { return JSON.stringify(this.describe()); } catch (e) { return JSON.stringify({ error: String(e) }); } }
    /* ---- host parameter bridge ---- */
    setHostParamNames(names) { this.hostParamNames = names || []; }
    _notePost(id, data) {
      if (!data || typeof data !== 'object' || Array.isArray(data)) return;
      this.lastPost = this.lastPost || {}; this.lastPost[id] = data;
      // Remember, per worklet node and per parameter, the exact message that last carried it and where the value sits in it.
      // Shapes seen in the wild: {gain: 0.5, drive: 2} (keyed), {type:'param', name:'inGainA', value: 3} (named), nested objects of either.
      this.templates = this.templates || {}; const T = this.templates[id] = this.templates[id] || {};
      const names = this.hostParamNames || []; const found = {}; let any = false;
      const KEYF = ['name', 'key', 'id', 'param', 'parameter'], VALF = ['value', 'val', 'v'];
      const scan = (o, path) => {
        const kf = KEYF.find(k => typeof o[k] === 'string'), vf = VALF.find(k => typeof o[k] === 'number' || typeof o[k] === 'boolean');
        if (kf && vf) { const nm = o[kf]; T[nm] = { msg: data, path: path.concat(vf) }; if (names.indexOf(nm) >= 0) { found[nm] = +o[vf]; any = true; } return; }
        for (const k in o) { const v = o[k]; if (typeof v === 'number' || typeof v === 'boolean') { T[k] = { msg: data, path: path.concat(k) }; if (names.indexOf(k) >= 0) { found[k] = +v; any = true; } } else if (v && typeof v === 'object' && !Array.isArray(v)) scan(v, path.concat(k)); }
      };
      scan(data, []); if (any && names.length) this.outbox.push({ id: -2, data: { type: '__hostParams', values: found } });
    }
    /* Apply a host/automation value the way the page's UI would: re-send the last params-style message with the key changed,
       else drive the worklet AudioParam. Returns 'message' | 'audioparam' | false. */
    hostParam(name, value) {
      if (!this.alias) return false; let how = false;
      for (const id in this.alias) {
        const n = this.alias[id]; if (!(n instanceof AudioWorkletNode)) continue;
        // 1) replay the page's own message for this parameter with the value swapped (works for keyed and named shapes alike)
        const t = this.templates && this.templates[id] && this.templates[id][name];
        if (t) {
          const copy = JSON.parse(JSON.stringify(t.msg)); let o = copy; for (let i = 0; i < t.path.length - 1; i++) o = o[t.path[i]];
          const leaf = t.path[t.path.length - 1]; o[leaf] = typeof o[leaf] === 'boolean' ? !!value : value;
          n.port.postMessage(reviveMessage(copy)); this.lastPost[id] = copy; how = 'message'; continue;
        }
        const last = this.lastPost && this.lastPost[id];
        if (last) {
          const setIn = (o) => { for (const k in o) { if (k === name && (typeof o[k] === 'number' || typeof o[k] === 'boolean')) { o[k] = typeof o[k] === 'boolean' ? !!value : value; return true; } if (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k]) && setIn(o[k])) return true; } return false; };
          const copy = JSON.parse(JSON.stringify(last)); if (setIn(copy)) { n.port.postMessage(reviveMessage(copy)); this.lastPost[id] = copy; how = 'message'; continue; }
        }
        // 2) else a real AudioParam (parameterDescriptors)
        const p = n.parameters.get(name); if (p) { p.value = value; how = how || 'audioparam'; }
      }
      return how;
    }
    /* hook worklet -> page messages into outbox (called once per worklet node by the host) */
    captureMessages() { for (const n of this.nodes) if (n instanceof AudioWorkletNode && !n._captured) { n._captured = true; n.port.onmessage = ev => this.outbox.push({ id: this._idOf(n), data: ev.data }); } }
    _idOf(n) { if (this.alias) for (const k in this.alias) if (this.alias[k] === n) return k; return n.id; }
    drainOutbox() { const o = this.outbox; this.outbox = []; for (const m of o) { try { m.data = serializeMessage(m.data); } catch (e) { m.data = { type: '__error', message: 'unserialisable worklet message: ' + e.message }; } } return o; }
    /* -------- string-based entry points for the native (JavaScriptCore) host -------- */
    applyJSON(str) { let ops; try { ops = JSON.parse(str); } catch (e) { this._error('bad op JSON: ' + e.message); return; } if (!Array.isArray(ops)) ops = [ops]; for (const op of ops) this.applyOp(op); this._autoInput(); }
    /* Pages that only wire the source after a user action (mic picker, file drop) boot as `worklet -> destination` with the
       worklet's input unconnected. In a plugin the host track IS the source: feed it into every input-bearing node that is
       reachable from the destination but has nothing connected, unless the page already routed ctx.input somewhere itself. */
    _autoInput() {
      for (const n of this.nodes) if (n && n._autoFed) { n.inputs[0] = n.inputs[0].filter(c => !c.auto); n._autoFed = false; }
      const usesInput = this.nodes.some(n => n && n !== this.input && n.inputs && n.inputs.some(a => a.some(c => c.node === this.input)));
      if (usesInput) return;
      const seen = new Set(); const stack = [this.destination]; const heads = [];
      while (stack.length) {
        const n = stack.pop(); if (!n || seen.has(n)) continue; seen.add(n);
        const slots = n.inputs || []; const connected = slots.some(a => a.length);
        if (n !== this.destination && slots.length && !connected) heads.push(n);
        for (const a of slots) for (const c of a) stack.push(c.node);
      }
      for (const h of heads) { h.inputs[0].push({ node: this.input, output: 0, auto: true }); h._autoFed = true; }
    }
    /* analyser snapshots for the UI (float time + float freq dB), keyed by page id */
    analyserSnapshots() {
      const out = {}; if (!this.alias) return out;
      for (const k in this.alias) { const n = this.alias[k]; if (n && typeof n.getFloatTimeDomainData === 'function') { const t = new Float32Array(n.fftSize), f = new Float32Array(n.frequencyBinCount); n.getFloatTimeDomainData(t); n.getFloatFrequencyData(f); out[k] = { time: Array.from(t), freq: Array.from(f) }; } }
      return out;
    }
    drainOutboxJSON(withAnalysers) { const msgs = this.drainOutbox(); const o = { time: this.currentTime, msgs }; if (withAnalysers) o.analysers = this.analyserSnapshots(); return JSON.stringify(o); }
  }


  /* -------- binary message codec (page <-> engine). Typed arrays, ArrayBuffers and WebAssembly.Module cross the JSON bridge as base64. -------- */
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const B64I = (() => { const t = new Int16Array(256).fill(-1); for (let i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i; t[61] = 0; return t; })();
  function b64enc(u8) { let s = ''; for (let i = 0; i < u8.length; i += 3) { const a = u8[i], b = i + 1 < u8.length ? u8[i + 1] : 0, c = i + 2 < u8.length ? u8[i + 2] : 0; s += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)] + (i + 1 < u8.length ? B64[((b & 15) << 2) | (c >> 6)] : '=') + (i + 2 < u8.length ? B64[c & 63] : '='); } return s; }
  function b64dec(str) { str = String(str).replace(/[^A-Za-z0-9+/=]/g, ''); let pad = 0; while (str.length && str[str.length - 1 - pad] === '=') pad++; const out = new Uint8Array(Math.floor(str.length * 3 / 4) - pad); let o = 0; for (let i = 0; i < str.length; i += 4) { const n = (B64I[str.charCodeAt(i)] << 18) | (B64I[str.charCodeAt(i + 1)] << 12) | (B64I[str.charCodeAt(i + 2)] << 6) | B64I[str.charCodeAt(i + 3)]; if (o < out.length) out[o++] = n >> 16 & 255; if (o < out.length) out[o++] = n >> 8 & 255; if (o < out.length) out[o++] = n & 255; } return out; }
  const TA = { Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array };
  if (typeof BigInt64Array !== 'undefined') { TA.BigInt64Array = BigInt64Array; TA.BigUint64Array = BigUint64Array; }
  function taFromBytes(name, u8) { const C = TA[name] || Uint8Array; const bpe = C.BYTES_PER_ELEMENT; const n = Math.floor(u8.length / bpe); const buf = new ArrayBuffer(n * bpe); new Uint8Array(buf).set(u8.subarray(0, n * bpe)); return new C(buf); }
  const wasmBytes = typeof WeakMap !== 'undefined' ? new WeakMap() : null;      // WebAssembly.Module -> bytes it was compiled from (for re-serialisation)
  function reviveMessage(d) {
    if (d === null || typeof d !== 'object') return d;
    if (Array.isArray(d)) return d.map(reviveMessage);
    if (typeof d.__ta === 'string') { if (typeof d.b64 === 'string') return taFromBytes(d.__ta, b64dec(d.b64)); if (Array.isArray(d.data)) return (TA[d.__ta] || Float32Array).from(d.data); }
    if (typeof d.__ab === 'string') return b64dec(d.__ab).buffer;
    if (typeof d.__wasm === 'string') { if (typeof WebAssembly === 'undefined') throw new Error('page sent a WebAssembly.Module but this engine host has no WebAssembly'); const bytes = b64dec(d.__wasm); const m = new WebAssembly.Module(bytes); if (wasmBytes) wasmBytes.set(m, bytes); return m; }
    if (Array.isArray(d.__map)) return new Map(d.__map.map(([k, v]) => [reviveMessage(k), reviveMessage(v)]));
    if (d.__audiobuffer) { const a = d.__audiobuffer; const ab = new AudioBuffer(a.channels.length, a.length, a.sampleRate); a.channels.forEach((c, i) => ab.getChannelData(i).set(reviveMessage(c))); return ab; }
    if (d.__date) return new Date(d.__date);
    const o = {}; for (const k in d) o[k] = reviveMessage(d[k]); return o;
  }
  function serializeMessage(d, depth) {
    depth = depth || 0; if (depth > 64) return null;
    if (d === null || typeof d !== 'object') return (typeof d === 'number' && !isFinite(d)) ? null : (typeof d === 'bigint' ? Number(d) : (typeof d === 'function' || typeof d === 'symbol' || typeof d === 'undefined' ? null : d));
    if (ArrayBuffer.isView(d)) { if (d instanceof DataView) return { __ab: b64enc(new Uint8Array(d.buffer, d.byteOffset, d.byteLength)) }; return { __ta: d.constructor.name, b64: b64enc(new Uint8Array(d.buffer, d.byteOffset, d.byteLength)) }; }
    if (d instanceof ArrayBuffer) return { __ab: b64enc(new Uint8Array(d)) };
    if (typeof WebAssembly !== 'undefined' && d instanceof WebAssembly.Module) { const b = wasmBytes && wasmBytes.get(d); if (!b) throw new Error('WebAssembly.Module with unknown bytes cannot cross the bridge'); return { __wasm: b64enc(b) }; }
    if (d instanceof Map) return { __map: Array.from(d.entries()).map(([k, v]) => [serializeMessage(k, depth + 1), serializeMessage(v, depth + 1)]) };
    if (d instanceof Set) return Array.from(d).map(v => serializeMessage(v, depth + 1));
    if (d instanceof Date) return { __date: d.getTime() };
    if (d instanceof AudioBuffer) return { __audiobuffer: { sampleRate: d.sampleRate, length: d.length, channels: d._d.map(c => ({ __ta: 'Float32Array', b64: b64enc(new Uint8Array(c.buffer, c.byteOffset, c.byteLength)) })) } };
    if (Array.isArray(d)) return d.map(v => serializeMessage(v, depth + 1));
    const o = {}; for (const k in d) { const v = serializeMessage(d[k], depth + 1); if (v !== undefined) o[k] = v; } return o;
  }

  const api = { Context, AudioParam, AudioNode, AudioWorkletNode, AudioWorkletProcessor, registerProcessor, registry, AudioBuffer, Q, serializeMessage, reviveMessage, b64enc, b64dec };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; root.WebAudioEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
