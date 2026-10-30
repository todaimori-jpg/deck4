/**
 * Deck transport controller. The worklet owns the audio; this owns intent:
 * what the tempo fader means, where the cue point is, how sync catches up.
 */

import { BeatGrid } from '../analysis/grid.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class Deck {
  constructor(engine, index) {
    this.engine = engine;
    this.index = index;
    this.letter = ['A', 'B', 'C', 'D'][index] || String(index + 1);
    this.node = null;
    this.chain = null;

    this.track = null;
    this.buffer = null;
    this.grid = null;
    this.peaks = null;

    this.playing = false;
    this.tempoPct = 0;
    this.bend = 0;
    this.rangePct = 8;
    this.flx = false;
    this.reversed = false;
    this.volume = 0.85;
    this.gain = 1;
    this.eq = { low: 0, mid: 0, high: 0 };
    this.filterPos = 0;

    this.cue = 0;
    this.hotcues = new Array(8).fill(null);
    this.loop = { on: false, start: 0, end: 0, beats: 1 };
    this.syncOn = false;
    this.pflOn = false;

    this.lastPos = 0;
    this.lastAt = 0;
    this.drift = 0;
    this.rateTrim = 1;
    this.onStateChange = null;

    this._bind();
  }

  get loaded() {
    return !!this.buffer;
  }

  get frames() {
    return this.buffer ? this.buffer.length : 0;
  }

  get duration() {
    return this.buffer ? this.buffer.duration : 0;
  }

  get sampleRate() {
    return this.buffer ? this.buffer.sampleRate : this.engine.ctx.sampleRate;
  }

  /** Fader + nudge + sync catch-up, as a single multiplier over playback. */
  get tempoFactor() {
    return this.displayTempo * this.rateTrim;
  }

  /**
   * What the BPM readout should show: everything the DJ moved, none of the
   * sub-bar trim the sync glide uses to slide the phase into place.
   */
  get displayTempo() {
    return (1 + this.tempoPct / 100) * Math.pow(2, this.bend / 1200);
  }

  get rate() {
    return this.tempoFactor;
  }

  get direction() {
    return this.reversed ? -1 : 1;
  }

  _bind() {
    if (!this.engine.ready) return;
    const d = this.engine.createDeck(this.index);
    this.node = d.node;
    this.chain = d.chain;
    this.node.port.onmessage = (e) => this._onWorklet(e.data);
  }

  _onWorklet(m) {
    if (m.type === 'pos') {
      this.lastPos = m.pos;
      this.lastAt = m.at;
    } else if (m.type === 'ended') {
      this.playing = false;
      this.lastPos = this.direction > 0 ? this.frames - 1 : 0;
      this.lastAt = this.engine.now();
      this._emit();
    }
  }

  _emit() {
    if (this.onStateChange) this.onStateChange(this);
  }

  _param(patch) {
    this.node.port.postMessage({ type: 'param', ...patch });
  }

  _refreshRate() {
    const t = this.tempoFactor;
    this._param({ rate: t, tempo: t, dir: this.direction });
  }

  async load(track, buffer) {
    this.track = track;
    this.buffer = await this.engine.conform(buffer);
    const sr = this.buffer.sampleRate;
    this.grid = track.grid
      ? BeatGrid.fromJSON({ ...track.grid, sampleRate: sr, duration: this.buffer.duration })
      : new BeatGrid({ sampleRate: sr, duration: this.buffer.duration });
    this.peaks = track.peaks || null;

    const channels = [];
    const n = Math.min(2, this.buffer.numberOfChannels);
    for (let c = 0; c < n; c++) channels.push(new Float32Array(this.buffer.getChannelData(c)));

    await new Promise((resolve) => {
      const prev = this.node.port.onmessage;
      this.node.port.onmessage = (e) => {
        if (e.data.type === 'load') {
          this.node.port.onmessage = prev;
          resolve();
        } else if (prev) prev(e.data);
      };
      this.node.port.postMessage(
        { type: 'load', channels, frames: this.buffer.length },
        channels.map((c) => c.buffer),
      );
    });

    this.playing = false;
    this.cue = 0;
    this.hotcues = new Array(8).fill(null);
    this.loop = { on: false, start: 0, end: 0, beats: 1 };
    this.tempoPct = 0;
    this.syncOn = false;
    this.lastPos = 0;
    this.lastAt = this.engine.now();
    this._node_playing(false);
    this._refreshRate();
    this._emit();
  }

  unload() {
    this.track = null;
    this.buffer = null;
    this.grid = null;
    this.peaks = null;
    this.playing = false;
  }

  _node_playing(v) {
    this.node.port.postMessage({ type: 'playing', value: v });
  }

  /** Sample-accurate playhead, extrapolated between worklet reports. */
  get position() {
    if (!this.loaded) return 0;
    const now = this.engine.now();
    if (!this.playing) return clamp(this.lastPos, 0, this.frames);
    const dt = now - this.lastAt;
    const p = this.lastPos + dt * this.tempoFactor * this.direction * this.sampleRate;
    return clamp(p, 0, this.frames);
  }

  get beat() {
    return this.grid && this.grid.ready ? this.grid.beatAt(this.position) : 0;
  }

  seek(frame) {
    this.lastPos = clamp(frame, 0, this.frames);
    this.lastAt = this.engine.now();
    this.node.port.postMessage({ type: 'seek', value: this.lastPos });
    if (this.loop.on) this._pushLoop();
  }

  play() {
    if (!this.loaded || this.playing) return;
    this.playing = true;
    this.lastAt = this.engine.now();
    this._node_playing(true);
    this._emit();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.lastPos = this.position;
    this.lastAt = this.engine.now();
    this._node_playing(false);
    this._emit();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  /**
   * CUE behaviour: while playing, jump to the cue and hold. While paused at
   * the cue, pressing and holding previews the track, release stops.
   */
  cuePress() {
    if (this.playing) {
      this.pause();
      this.seek(this.cue);
    } else if (Math.abs(this.position - this.cue) > 2) {
      this.seek(this.cue);
    } else {
      this.play();
    }
  }

  cueHoldStart() {
    if (!this.playing && Math.abs(this.position - this.cue) <= 2) this.play();
  }

  cueHoldEnd() {
    if (this.playing && Math.abs(this.position - this.cue) <= this.sampleRate * 0.2) {
      this.pause();
      this.seek(this.cue);
    }
  }

  /** CUP: jump to cue and keep playing. */
  cueAndPlay() {
    this.seek(this.cue);
    this.play();
  }

  setCue(division = 1) {
    this.cue = this.quantize(this.position, division);
    this._emit();
  }

  setVolume(v) {
    this.volume = clamp(v, 0, 1);
    this.engine.setDeckVolume(this, this.volume);
  }

  /** Input trim, applied inside the transport before the EQ chain. */
  setGain(v) {
    this.gain = clamp(v, 0, 2);
    this._param({ gain: this.gain });
  }

  setEqBand(band, value) {
    this.eq[band] = clamp(value, -26, 26);
    this.engine.setEq(this, this.eq);
  }

  setFilter(value) {
    this.filterPos = clamp(value, -1, 1);
    this.engine.setFilter(this, this.filterPos);
  }

  setPfl(on) {
    this.pflOn = on;
    this.engine.setPfl(this, on);
  }

  // --- tempo / sync ------------------------------------------------------

  setTempo(pct, { keepSync = false } = {}) {
    this.tempoPct = clamp(pct, -this.rangePct, this.rangePct);
    if (!keepSync) this.syncOn = false;
    this._refreshRate();
    this._emit();
  }

  setRange(pct) {
    this.rangePct = pct;
    this.tempoPct = clamp(this.tempoPct, -pct, pct);
    this._refreshRate();
  }

  setBend(cents) {
    this.bend = clamp(cents, -600, 600);
    this._refreshRate();
  }

  setFlx(on) {
    this.flx = on;
    this._refreshRate();
    this._emit();
  }

  setReverse(on) {
    this.reversed = on;
    this._refreshRate();
    this._emit();
  }

  /** Match another deck's tempo, then glide onto its next downbeat. */
  syncTo(other) {
    if (!other || !other.loaded || !this.loaded) return false;
    if (!other.grid || !other.grid.ready || !this.grid || !this.grid.ready) return false;
    const otherBpm = other.grid.bpmAt(other.position);
    const myBpm = this.grid.bpmAt(this.position);
    if (!otherBpm || !myBpm) return false;

    this.tempoPct = clamp((otherBpm / myBpm - 1) * 100, -this.rangePct, this.rangePct);
    this.syncOn = true;
    this._refreshRate();
    this._catchUp(this._secToDownbeat() - other._secToDownbeat());
    this._emit();
    return true;
  }

  /** Seconds until this deck's playhead reaches the next bar line. */
  _secToDownbeat() {
    const g = this.grid;
    const beat = g.beatAt(this.position);
    const rel = beat - g.origin;
    const next = Math.ceil(rel / 4) * 4 + g.origin;
    return (g.sampleAtBeat(next) - this.position) / this.sampleRate / Math.max(0.05, this.tempoFactor);
  }

  /**
   * Nudge the rate for just long enough to close a phase gap. A hard seek would
   * be sample-exact but audible; a short proportional trim is not.
   */
  _catchUp(deltaSec) {
    if (this._driftTimer) {
      clearTimeout(this._driftTimer);
      this._driftTimer = null;
    }
    if (!this.playing || !this.grid || !this.grid.ready) {
      this.rateTrim = 1;
      this._refreshRate();
      return;
    }
    const bpm = Math.max(20, this.grid.bpmAt(this.position) * this.tempoFactor);
    const barSec = (60 / bpm) * 4;

    // Go round the short way: chasing a 0.9-bar miss forward takes almost a
    // whole bar of warp, when slipping back a tenth of a bar closes it.
    let err = deltaSec;
    if (err > barSec / 2) err -= barSec;
    else if (err < -barSec / 2) err += barSec;

    // Strength scales with the error, so the glide always finishes inside one
    // bar instead of the old fixed 6% running for seconds without converging.
    const strength = Math.min(0.15, Math.max(0.01, Math.abs(err) / barSec));
    if (Math.abs(err) < 0.005) {
      this.rateTrim = 1;
      this._refreshRate();
      return;
    }
    this.rateTrim = 1 + Math.sign(err) * strength;
    this._refreshRate();
    this._driftTimer = setTimeout(() => {
      this._driftTimer = null;
      this.rateTrim = 1;
      this._refreshRate();
    }, (Math.abs(err) / strength) * 1000 + 30);
  }

  // --- loops / hotcues ---------------------------------------------------

  quantize(frame, division = 1) {
    if (!this.grid || !this.grid.ready) return frame;
    return this.grid.quantize(frame, division);
  }

  _pushLoop() {
    this.node.port.postMessage({
      type: 'loop',
      on: this.loop.on,
      start: this.loop.start,
      end: this.loop.end,
    });
  }

  setLoopBeats(beats) {
    if (!this.loaded) return;
    const g = this.grid;
    let start;
    let end;
    if (g && g.ready) {
      const startBeat = Math.round(g.beatAt(this.position));
      start = g.sampleAtBeat(startBeat);
      end = g.sampleAtBeat(startBeat + beats);
    } else {
      const beatSec = 0.5;
      start = this.position;
      end = start + beats * beatSec * this.sampleRate;
    }
    this.loop.start = start;
    this.loop.end = end;
    this.loop.beats = beats;
    this.loop.on = true;
    this.seek(start);
    this._pushLoop();
    this._emit();
  }

  exitLoop() {
    this.loop.on = false;
    this._pushLoop();
    this._emit();
  }

  toggleLoop(beats) {
    if (this.loop.on && this.loop.beats === beats) this.exitLoop();
    else this.setLoopBeats(beats);
  }

  setHotcue(slot, division = 1) {
    this.hotcues[slot] = { sample: this.quantize(this.position, division) };
    this._emit();
  }

  clearHotcue(slot) {
    this.hotcues[slot] = null;
    this._emit();
  }

  jumpHotcue(slot, { division = 1 } = {}) {
    const hc = this.hotcues[slot];
    if (!hc) {
      this.setHotcue(slot, division);
      return;
    }
    const target = this.quantize(hc.sample, division);
    if (this.playing) {
      // Remember where we were so a second press returns to the mix.
      this._resumePoint = this.position;
      this.seek(target);
    } else if (Math.abs(this.position - target) < 10) {
      this.seek(this._resumePoint ?? target);
      this.play();
    } else {
      this.seek(target);
    }
    this._emit();
  }

  /** Remaining time as -mm:ss, or +mm:ss past the end. */
  get remaining() {
    if (!this.loaded) return '00:00';
    const secs = (this.frames - this.position) / this.sampleRate / Math.max(0.05, this.tempoFactor);
    const sign = secs < 0 ? '+' : '-';
    const abs = Math.abs(secs);
    const m = Math.floor(abs / 60);
    const s = Math.floor(abs % 60);
    return `${sign}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
}
