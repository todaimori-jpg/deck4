/**
 * Audio graph: one AudioContext, a master bus with a brickwall limiter, and a
 * chain per deck. Deck sample positions are always in the context's own rate,
 * so buffers are resampled once on load before anything reads them.
 */

const WORKLET_URL = new URL('./deck-worklet.js', import.meta.url).href;

function dbToGain(db) {
  return Math.pow(10, db / 20);
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.decks = [];
    this.ready = false;
    this.xfaderCurve = 'smooth';
    this._scratch = new Map();
  }

  async init() {
    if (this.ctx) return this;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx({ latencyHint: 'interactive' });
    await this.ctx.audioWorklet.addModule(WORKLET_URL);

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.9;

    // Three-band master EQ, then the "maximiser": a hard-knee limiter with
    // makeup gain that stops the sum of two loud decks from clipping.
    this.masterLow = this.biquad('lowshelf', 120, 0);
    this.masterMid = this.biquad('peaking', 1000, 0.8);
    this.masterHigh = this.biquad('highshelf', 6000, 0);

    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.12;

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.6;

    this.masterLow.connect(this.masterMid);
    this.masterMid.connect(this.masterHigh);
    this.masterHigh.connect(this.limiter);
    this.limiter.connect(this.masterGain);
    this.masterGain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);

    this.pflGain = this.ctx.createGain();
    this.pflGain.gain.value = 0;
    this.pflAnalyser = this.ctx.createAnalyser();
    this.pflAnalyser.fftSize = 1024;
    this.pflGain.connect(this.pflAnalyser);

    this.xfaderPos = 0.5;
    this.ready = true;
    return this;
  }

  biquad(type, freq, q) {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    if (q !== null) f.Q.value = q;
    return f;
  }

  async resume() {
    if (this.ctx && this.ctx.state === 'suspended') await this.ctx.resume();
  }

  now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /** Resample to the context rate with the browser's high-quality converter. */
  async conform(buffer) {
    if (!buffer || buffer.sampleRate === this.ctx.sampleRate) return buffer;
    const oac = new OfflineAudioContext(
      buffer.numberOfChannels,
      Math.max(1, Math.ceil(buffer.duration * this.ctx.sampleRate)),
      this.ctx.sampleRate,
    );
    const src = oac.createBufferSource();
    src.buffer = buffer;
    src.connect(oac.destination);
    src.start(0);
    return oac.startRendering();
  }

  /** Decode a File/Blob into a context-rate AudioBuffer. */
  async decode(data) {
    const raw = await this.ctx.decodeAudioData(data);
    return this.conform(raw);
  }

  createDeck(index) {
    const ctx = this.ctx;
    const node = new AudioWorkletNode(ctx, 'deck-transport', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });

    const volume = ctx.createGain();
    volume.gain.value = 0.85;

    const low = this.biquad('lowshelf', 100, null);
    const mid = this.biquad('peaking', 1000, 0.4);
    const high = this.biquad('highshelf', 4500, null);
    const filter = this.biquad('lowpass', 22050, 0.7);

    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
    const out = ctx.createGain();
    const pfl = ctx.createGain();
    pfl.gain.value = 0;

    node.connect(volume);
    volume.connect(low);
    low.connect(mid);
    mid.connect(high);
    high.connect(filter);
    filter.connect(pan);
    pan.connect(out);
    pan.connect(pfl);
    out.connect(this.masterLow);
    pfl.connect(this.pflGain);

    const deck = {
      index,
      node,
      chain: { volume, low, mid, high, filter, pan, out, pfl },
      group: index < 2 ? 0 : 1,
    };
    this.decks[index] = deck;
    this.applyXfader();
    return deck;
  }

  setDeckVolume(deck, v) {
    deck.chain.volume.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
  }

  setEq(deck, { low = 0, mid = 0, high = 0 }) {
    const t = this.ctx.currentTime;
    deck.chain.low.gain.setTargetAtTime(low, t, 0.01);
    deck.chain.mid.gain.setTargetAtTime(mid, t, 0.01);
    deck.chain.high.gain.setTargetAtTime(high, t, 0.01);
  }

  setFilter(deck, value) {
    // -1..0..1 sweeps a lowpass down and a highpass up, resting wide open.
    const f = deck.chain.filter;
    const t = this.ctx.currentTime;
    const v = Math.min(1, Math.abs(value));
    if (value >= 0) {
      f.type = 'lowpass';
      f.Q.setTargetAtTime(0.7 + v * 4, t, 0.02);
      f.frequency.setTargetAtTime(Math.max(120, 22050 * Math.pow(120 / 22050, v)), t, 0.02);
    } else {
      f.type = 'highpass';
      f.Q.setTargetAtTime(0.7 + v * 4, t, 0.02);
      f.frequency.setTargetAtTime(Math.min(16000, 20 * Math.pow(16000 / 20, v)), t, 0.02);
    }
  }

  setPfl(deck, on) {
    deck.chain.pfl.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.01);
  }

  setXfaderGroup(deck, group) {
    deck.group = group;
    this.applyXfader();
  }

  /** Crossfader curve: `sharp` cuts, `smooth` is constant power. */
  applyXfader() {
    const p = this.xfaderPos;
    const shape = this.xfaderCurve === 'sharp'
      ? (x) => Math.max(0, Math.min(1, 1 - Math.max(0, x - 0.5) / 0.04))
      : (x) => Math.cos((Math.max(0, Math.min(1, x)) * Math.PI) / 2);
    const left = shape(p);
    const right = shape(1 - p);
    const t = this.ctx.currentTime;
    for (const d of this.decks) {
      if (!d) continue;
      d.chain.out.gain.setTargetAtTime(d.group === 0 ? left : right, t, 0.008);
    }
  }

  setXfader(pos) {
    this.xfaderPos = Math.max(0, Math.min(1, pos));
    this.applyXfader();
  }

  setXfaderCurve(name) {
    this.xfaderCurve = name;
    this.applyXfader();
  }

  setMasterTrim(v) {
    this.masterGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
  }

  meterLevel(analyser) {
    let buf = this._scratch.get(analyser);
    if (!buf) {
      buf = new Float32Array(analyser.fftSize);
      this._scratch.set(analyser, buf);
    }
    analyser.getFloatTimeDomainData(buf);
    let peak = 0;
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const a = Math.abs(buf[i]);
      if (a > peak) peak = a;
      sum += buf[i] * buf[i];
    }
    return { peak, rms: Math.sqrt(sum / buf.length) };
  }
}

export { dbToGain };
