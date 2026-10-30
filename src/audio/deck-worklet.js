/**
 * Deck transport processor.
 *
 * Two playback modes:
 *  - vinyl (FLX off): one read head at `rate`, pitch and tempo move together.
 *  - master tempo (FLX on): WSOLA time-scale modification, so `tempo` changes
 *    duration only and pitch holds. Anchors are re-selected every hop by
 *    minimising the SAD between the outgoing window's tail and the incoming
 *    window's head.
 */

const WIN = 2048; // source frames per window
const HOP = WIN >> 1; // output frames per hop
const SEARCH = 384; // anchor search radius (source frames)
const CORR = 192; // samples compared when scoring a candidate anchor
const STEP = 2; // candidate granularity
const BIAS = 0.05; // weight pulling a tied anchor back to the predicted tempo
const REPORT = 1024; // frames between position reports

export class DeckProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ch = null;
    this.frames = 0;
    this.rate = 1;
    this.tempo = 1;
    this.flx = false;
    this.dir = 1;
    this.playing = false;
    this.pos = 0;
    this.ref = 0;
    this.t = 0;
    this.aCur = 0;
    this.aPrev = 0;
    this.mode = -1;
    this.loopStart = 0;
    this.loopEnd = 0;
    this.loopOn = false;
    this.gain = 1;
    this.since = 0;
    this.port.onmessage = (e) => this.onMessage(e.data);
    this.port.postMessage({ type: 'ready' });
  }

  onMessage(m) {
    switch (m.type) {
      case 'load':
        this.ch = m.channels;
        this.frames = m.frames;
        this.playing = false;
        this.seek(0);
        this.port.postMessage({ type: 'load' });
        break;
      case 'param':
        if (m.rate !== undefined) this.rate = m.rate;
        if (m.tempo !== undefined) this.tempo = m.tempo;
        if (m.flx !== undefined) this.flx = m.flx;
        if (m.dir !== undefined) this.dir = m.dir;
        if (m.gain !== undefined) this.gain = m.gain;
        break;
      case 'playing':
        this.playing = m.value;
        break;
      case 'seek':
        this.seek(m.value);
        break;
      case 'loop':
        this.loopOn = m.on;
        this.loopStart = m.start;
        this.loopEnd = m.end;
        break;
    }
  }

  seek(frame) {
    this.pos = Math.max(0, Math.min(this.frames - 1, frame));
    // aPrev sits one hop behind aCur so that, before the first re-anchor, both
    // readers address the same sample and the crossfade is a no-op.
    this.aCur = this.pos;
    this.aPrev = this.pos - HOP;
    this.ref = this.pos;
    this.t = 0;
  }

  readMono(p) {
    const c0 = this.ch[0];
    const i = p | 0;
    if (i < 0 || i >= this.frames - 1) return 0;
    const f = p - i;
    return c0[i] + (c0[i + 1] - c0[i]) * f;
  }

  readCh(c, p) {
    const data = this.ch[c];
    const i = p | 0;
    if (i < 0) return data[0] || 0;
    if (i >= this.frames - 1) return data[this.frames - 1] || 0;
    const f = p - i;
    return data[i] + (data[i + 1] - data[i]) * f;
  }

  /** Pick the source frame that best continues the outgoing window. */
  anchor(prevAnchor, ref) {
    const predict = ref;
    const base = prevAnchor + HOP;
    const limit = this.frames - CORR - 2;
    let best = predict;
    let bestCost = Infinity;
    for (let s = -SEARCH; s <= SEARCH; s += STEP) {
      const cand = predict + s;
      if (cand < 0 || cand > limit) continue;
      let cost = 0;
      for (let i = 0; i < CORR; i++) {
        cost += Math.abs(this.readMono(cand + i) - this.readMono(base + i));
      }
      // Purely periodic material scores every candidate in the search window
      // as an exact match, which would collapse the stretch back to 1:1. The
      // proximity term breaks those ties toward the predicted continuation.
      const score = cost / CORR + (Math.abs(s) / HOP) * BIAS;
      if (score < bestCost) {
        bestCost = score;
        best = cand;
      }
    }
    return best;
  }

  wrap(p) {
    if (!this.loopOn) return null;
    const span = this.loopEnd - this.loopStart;
    if (span <= 0) return null;
    if (p >= this.loopEnd || p < this.loopStart) {
      return this.loopStart + (((p - this.loopStart) % span) + span) % span;
    }
    return null;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const nCh = out.length;
    if (!this.ch) {
      for (let c = 0; c < nCh; c++) out[c].fill(0);
      return true;
    }
    const stretched = this.flx && this.dir > 0;
    const speed = (stretched ? this.tempo : this.rate) * this.dir;
    const modeKey = (stretched ? 1 : 0) + (this.dir < 0 ? 2 : 0);
    if (modeKey !== this.mode) {
      this.mode = modeKey;
      this.seek(this.pos);
    }
    const buf = out[0];

    for (let i = 0; i < buf.length; i++) {
      if (!this.playing) {
        for (let c = 0; c < nCh; c++) out[c][i] = 0;
        continue;
      }

      if (stretched) {
        if (this.t >= HOP) {
          this.aPrev = this.aCur;
          this.aCur = this.anchor(this.aPrev, this.ref);
          this.t = 0;
        }
        const f = this.t / HOP;
        const s0 = this.aPrev + HOP + this.t;
        const s1 = this.aCur + this.t;
        for (let c = 0; c < nCh; c++) {
          out[c][i] = (this.readCh(c, s0) * (1 - f) + this.readCh(c, s1) * f) * this.gain;
        }
        // The reference, not the chosen anchor, carries the playhead: anchors
        // wobble around it to track the waveform, but duration stays exact.
        this.ref += speed;
        this.pos = this.ref;
        this.t++;
      } else {
        this.pos += speed;
        this.ref = this.pos;
        const p = this.pos;
        for (let c = 0; c < nCh; c++) out[c][i] = this.readCh(c, p) * this.gain;
      }

      const wrapped = this.wrap(this.pos);
      if (wrapped !== null) this.seek(wrapped);

      const finished = this.dir > 0 ? this.pos >= this.frames - 2 : this.pos <= 1;
      if (finished && this.playing) {
        this.playing = false;
        this.port.postMessage({ type: 'ended', at: currentTime });
        for (let c = 0; c < nCh; c++) out[c][i] = 0;
      }

      if (++this.since >= REPORT) {
        this.since = 0;
        this.port.postMessage({ type: 'pos', pos: this.pos, at: currentTime });
      }
    }
    return true;
  }
}

// Guarded so the class can be imported and unit-tested outside the worklet
// scope, where neither global exists.
if (typeof registerProcessor === 'function') registerProcessor('deck-transport', DeckProcessor);
