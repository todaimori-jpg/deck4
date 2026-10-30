/**
 * Fluid beatgrid.
 *
 * A grid is a list of anchors, each carrying a local BPM at a sample position.
 * Tempo between two anchors ramps linearly, which is what lets one grid follow
 * a live funk take that drifts or a hard genre jump mid-track. Everything is
 * derived data: the audio and the file's own tags are never rewritten.
 */

export class BeatGrid {
  constructor({ sampleRate, duration = 0, anchors = null } = {}) {
    this.sampleRate = sampleRate;
    this.duration = duration;
    this.anchors = anchors && anchors.length
      ? anchors.map((a) => ({ sample: a.sample, bpm: a.bpm })).sort((x, y) => x.sample - y.sample)
      : [];
    this.beats = new Float64Array(0);
    this.origin = 0;
    this.rebuild();
  }

  static fromJSON(o) {
    return new BeatGrid({
      sampleRate: o.sampleRate,
      duration: o.duration,
      anchors: o.anchors,
    });
  }

  toJSON() {
    return {
      sampleRate: this.sampleRate,
      duration: this.duration,
      anchors: this.anchors.map((a) => ({ sample: a.sample, bpm: a.bpm })),
    };
  }

  get ready() {
    return this.anchors.length > 0 && this.beats.length > 1;
  }

  /** Local BPM at a sample position, clamped to the outer anchor tempos. */
  bpmAt(sample) {
    const a = this.anchors;
    if (!a.length) return 0;
    if (sample <= a[0].sample) return a[0].bpm;
    if (sample >= a[a.length - 1].sample) return a[a.length - 1].bpm;
    for (let i = 1; i < a.length; i++) {
      if (sample < a[i].sample) {
        const span = a[i].sample - a[i - 1].sample;
        const t = span > 0 ? (sample - a[i - 1].sample) / span : 0;
        return a[i - 1].bpm + (a[i].bpm - a[i - 1].bpm) * t;
      }
    }
    return a[a.length - 1].bpm;
  }

  /**
   * Walk the track beat by beat from the first anchor, integrating the local
   * tempo so drifting zones stay aligned to the audio.
   */
  rebuild() {
    if (!this.anchors.length) {
      this.beats = new Float64Array(0);
      this.origin = 0;
      return;
    }
    const sr = this.sampleRate;
    const end = this.duration * sr || Number.POSITIVE_INFINITY;
    const start = this.anchors[0].sample;

    const fwd = [];
    let s = start;
    let guard = 0;
    while (s <= end && guard++ < 40000) {
      fwd.push(s);
      s += (60 / Math.max(20, this.bpmAt(s))) * sr;
    }

    const back = [];
    s = start;
    guard = 0;
    while (s - (60 / Math.max(20, this.bpmAt(s - 1))) * sr >= 0 && guard++ < 4000) {
      s -= (60 / Math.max(20, this.bpmAt(s - 1))) * sr;
      back.push(s);
    }
    back.reverse();

    const all = new Float64Array(back.length + fwd.length);
    all.set(back, 0);
    all.set(fwd, back.length);
    this.beats = all;
    this.origin = back.length; // beat index 0 sits on the first anchor
  }

  /** Fractional beat index for a sample position. */
  beatAt(sample) {
    const b = this.beats;
    if (b.length < 2) return 0;
    if (sample <= b[0]) return (sample - b[0]) / ((b[1] - b[0]) || 1);
    if (sample >= b[b.length - 1]) {
      const n = b.length - 1;
      return n + (sample - b[n]) / ((b[n] - b[n - 1]) || 1);
    }
    let lo = 0;
    let hi = b.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (b[mid] <= sample) lo = mid;
      else hi = mid;
    }
    return lo + (sample - b[lo]) / (b[hi] - b[lo]);
  }

  sampleAtBeat(beat) {
    const b = this.beats;
    if (!b.length) return 0;
    const i = Math.floor(beat);
    if (i < 0) return b[0] + (beat - i) * ((b[1] ?? b[0]) - b[0]);
    if (i >= b.length - 1) return b[b.length - 1] + (beat - (b.length - 1)) * (b[b.length - 1] - b[b.length - 2] || 1);
    return b[i] + (beat - i) * (b[i + 1] - b[i]);
  }

  /** Nearest grid line at or before `sample`, optionally on a subdivision. */
  snap(sample, division = 1) {
    const beat = this.beatAt(sample);
    return this.sampleAtBeat(Math.round(beat * division) / division);
  }

  quantize(sample, division = 1) {
    const beat = this.beatAt(sample);
    return this.sampleAtBeat(Math.round(beat * division) / division);
  }

  /** Bar number (1-based) and beat-within-bar for a sample position. */
  barBeat(sample) {
    const beat = this.beatAt(sample);
    const idx = Math.floor(beat) - this.origin;
    const bar = Math.floor(idx / 4) + 1;
    return { bar, beat: (idx % 4 + 4) % 4 + 1, fraction: beat - Math.floor(beat) };
  }

  setAnchors(anchors) {
    this.anchors = anchors.map((a) => ({ sample: a.sample, bpm: a.bpm })).sort((x, y) => x.sample - y.sample);
    this.rebuild();
  }

  /** Drop a tempo-zone marker at a sample position. */
  addAnchor(sample, bpm) {
    const anchors = this.anchors.filter((a) => Math.abs(a.sample - sample) > this.sampleRate * 0.05);
    anchors.push({ sample, bpm });
    this.setAnchors(anchors);
    return this.anchors[this.anchors.findIndex((a) => a.sample === sample)];
  }

  moveAnchor(index, patch = {}) {
    const a = this.anchors[index];
    if (!a) return;
    Object.assign(a, patch);
    this.setAnchors(this.anchors);
  }

  removeAnchor(index) {
    if (this.anchors.length <= 1) return;
    const anchors = this.anchors.slice();
    anchors.splice(index, 1);
    this.setAnchors(anchors);
  }

  /** Replace the whole grid with a fixed tempo locked to a downbeat. */
  lockTo(bpm, firstBeatSample) {
    this.setAnchors([{ sample: firstBeatSample, bpm }]);
  }
}

/** Running BPM tapper — returns the rolling average of the last four intervals. */
export class TempoTapper {
  constructor(keep = 4) {
    this.keep = keep;
    this.times = [];
  }

  tap(nowMs = performance.now()) {
    this.times.push(nowMs);
    if (this.times.length > this.keep + 1) this.times.shift();
    return this.bpm;
  }

  reset() {
    this.times = [];
  }

  get bpm() {
    if (this.times.length < 2) return 0;
    const span = (this.times[this.times.length - 1] - this.times[0]) / 1000;
    return span > 0 ? ((this.times.length - 1) * 60) / span : 0;
  }
}
