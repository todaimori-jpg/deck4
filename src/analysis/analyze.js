/**
 * Offline analysis: frequency-split peak envelopes and a beat-aligned tempo
 * estimate. Everything runs on the decoded AudioBuffer before a deck ever
 * plays, so the transport stays sample-accurate during a set.
 */

export const BUCKETS_PER_SEC = 200;

/**
 * Two-band peak envelope matching Traktor's stacked waveform: low energy is
 * drawn below the axis, high energy above it.
 */
export function analyzePeaks(buffer) {
  const sr = buffer.sampleRate;
  const ch = Math.min(2, buffer.numberOfChannels);
  const left = buffer.getChannelData(0);
  const right = ch > 1 ? buffer.getChannelData(1) : left;
  const frames = buffer.length;
  const bucket = Math.max(1, Math.floor(sr / BUCKETS_PER_SEC));
  const count = Math.max(1, Math.ceil(frames / bucket));

  const lo = new Float32Array(count);
  const hi = new Float32Array(count);
  const amp = new Float32Array(count);

  // One-pole split around ~180 Hz: cheap, stable, and enough to pull kick and
  // bass body away from hats and snare content for display purposes.
  const k = 1 - Math.exp((-2 * Math.PI * 180) / sr);
  let lp = 0;
  let bLo = 0;
  let bHi = 0;
  let bAmp = 0;
  let bi = 0;

  for (let i = 0; i < frames; i++) {
    const x = (left[i] + right[i]) * 0.5;
    lp += (x - lp) * k;
    const h = x - lp;
    const al = Math.abs(lp);
    const ah = Math.abs(h);
    if (al > bLo) bLo = al;
    if (ah > bHi) bHi = ah;
    const st = Math.abs(left[i]) > Math.abs(right[i]) ? Math.abs(left[i]) : Math.abs(right[i]);
    if (st > bAmp) bAmp = st;

    if (i + 1 >= (bi + 1) * bucket) {
      lo[bi] = bLo;
      hi[bi] = bHi;
      amp[bi] = bAmp;
      bLo = 0;
      bHi = 0;
      bAmp = 0;
      bi++;
      if (bi >= count) break;
    }
  }

  const norm = (arr, floor) => {
    let m = 0;
    for (let i = 0; i < arr.length; i++) if (arr[i] > m) m = arr[i];
    if (m <= 0) return;
    const g = 1 / Math.max(m, floor);
    for (let i = 0; i < arr.length; i++) arr[i] = Math.min(1, arr[i] * g);
  };
  norm(lo, 0.05);
  norm(hi, 0.05);
  norm(amp, 0.02);

  return { lo, hi, amp, bucket, count, sr };
}

/**
 * Onset strength envelope: positive half-wave rectified flux across a
 * cascaded one-pole filterbank, windowed at ~11 ms hops.
 */
function onsetEnvelope(buffer) {
  const sr = buffer.sampleRate;
  const hop = Math.max(64, Math.round(sr * 0.011));
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  const frames = buffer.length;

  const cuts = [180, 700, 2400, 7000];
  const bands = cuts.length;
  const k = cuts.map((f) => 1 - Math.exp((-2 * Math.PI * f) / sr));
  const lp = new Float64Array(bands);
  const energy = new Float64Array(bands);
  const prev = new Float64Array(bands);

  const n = Math.max(1, Math.ceil(frames / hop));
  const out = new Float32Array(n);
  let idx = 0;
  let acc = 0;

  for (let i = 0; i < frames; i++) {
    const x = Math.abs((left[i] + right[i]) * 0.5);
    // Cascaded: each band taps the low-pass of what is left after the previous
    // band removed its own low end, giving four non-overlapping regions.
    let residual = x;
    for (let b = 0; b < bands; b++) {
      lp[b] += (residual - lp[b]) * k[b];
      energy[b] += lp[b] * lp[b];
      residual = x - lp[b];
    }
    if (++acc >= hop) {
      let flux = 0;
      for (let b = 0; b < bands; b++) {
        const e = energy[b] / acc;
        const d = e - prev[b];
        if (d > 0) flux += d;
        prev[b] = e;
        energy[b] = 0;
      }
      if (idx < n) out[idx++] = flux;
      acc = 0;
    }
  }

  // Subtract a fraction of the mean so sustained energy stops scoring and only
  // transients survive.
  let mean = 0;
  for (let i = 0; i < n; i++) mean += out[i];
  mean /= n;
  for (let i = 0; i < n; i++) out[i] = Math.max(0, out[i] - mean * 0.4);
  return { env: out, hopSec: hop / sr };
}

/**
 * Estimate BPM plus a downbeat offset by autocorrelating the onset envelope
 * over plausible beat periods and folding into the DJ-usable range.
 */
export function analyzeTempo(buffer) {
  const { env, hopSec } = onsetEnvelope(buffer);
  const n = env.length;
  if (n < 16) return { bpm: 120, phase: 0, confidence: 0 };

  const minLag = Math.max(2, Math.round(60 / 180 / hopSec));
  const maxLag = Math.min(n - 2, Math.round(60 / 60 / hopSec));

  const score = new Float64Array(maxLag + 2);
  let total = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += env[i] * env[i + lag];
    s /= n - lag;
    score[lag] = s;
    total += s;
  }

  // A mild preference for 105-150 BPM is where a wrong octave actually wrecks a
  // mix; outside it we trust the raw correlation more loosely.
  let bestLag = minLag;
  let bestVal = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = 60 / (lag * hopSec);
    const bias = bpm >= 105 && bpm <= 150 ? 1.3 : bpm >= 80 ? 1 : 0.7;
    const v = score[lag] * bias;
    if (v > bestVal) {
      bestVal = v;
      bestLag = lag;
    }
  }

  // Parabolic interpolation around the peak. Autocorrelation only samples whole
  // hops, which biases the result by up to half a hop — around 1 BPM at house
  // tempos, enough to hear a slow drift once two decks are synced.
  const s0 = score[bestLag - 1] ?? score[bestLag];
  const s1 = score[bestLag];
  const s2 = score[bestLag + 1] ?? score[bestLag];
  const denom = s0 - 2 * s1 + s2;
  const shift = denom !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (s0 - s2)) / denom)) : 0;
  const bpm = 60 / ((bestLag + shift) * hopSec);
  const meanScore = total / (maxLag - minLag + 1) || 1;
  const confidence = Math.max(0, Math.min(1, score[bestLag] / (meanScore * 2.2) - 0.35));

  // Refine the downbeat by sliding a comb over one period and keeping the
  // alignment that collects the most onset energy.
  const period = 60 / bpm;
  const window = Math.min(n, Math.round((60 * 16) / hopSec));
  const bin = period / 64;
  let bestPhase = 0;
  let bestPhaseScore = -1;
  for (let p = 0; p < 64; p++) {
    const off = (p / 64) * period;
    let s = 0;
    for (let i = 0; i < window; i++) {
      const t = i * hopSec;
      const e = (t + off) % period;
      const d = Math.min(e, period - e);
      if (d < bin) s += env[i];
    }
    if (s > bestPhaseScore) {
      bestPhaseScore = s;
      bestPhase = off;
    }
  }

  return { bpm, phase: bestPhase, confidence };
}
