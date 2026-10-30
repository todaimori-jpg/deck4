/**
 * Verifies the transport worklet's maths outside a browser.
 *
 * Master tempo is the one feature that is easy to get subtly wrong: a stretcher
 * that changes duration but also shifts pitch, or one that clicks at every
 * crossfade, still "sounds kind of fine" for thirty seconds and ruins a mix.
 * These checks measure duration, pitch and discontinuity directly.
 *
 *   ELECTRON_RUN_AS_NODE=1 Qoder.exe tools/test-worklet.mjs
 */

// The worklet module expects these to exist in its scope; stub them first.
globalThis.sampleRate = 44100;
globalThis.currentTime = 0;
globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.port = { postMessage: () => {} };
  }
};

const { DeckProcessor } = await import('../src/audio/deck-worklet.js');

const SR = 44100;

/** A tone plus aperiodic transients: structure a naive stretcher must keep. */
function testSignal(seconds) {
  const n = Math.round(SR * seconds);
  const out = new Float32Array(n);
  let seed = 0x1234abcd;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed / 4294967296;
  };

  // Transients deliberately avoid a regular interval, so the only periodicity
  // left in the file is the tone the test is measuring.
  const tr = new Float32Array(n);
  for (let at = 500; at < n; at += 900 + Math.floor(rand() * 2600)) {
    for (let d = 0; d < 400 && at + d < n; d++) tr[at + d] = 0.8 * Math.exp(-d / 80) * (rand() * 2 - 1);
  }

  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = 0.6 + 0.4 * Math.sin(2 * Math.PI * 0.7 * t);
    out[i] = (env * (Math.sin(2 * Math.PI * 220 * t) + 0.5 * Math.sin(2 * Math.PI * 440 * t)) + tr[i]) * 0.3;
  }
  return out;
}

/**
 * A single partial. Vinyl mode scales every partial by `rate`, so a stacked
 * tone lets the 2nd harmonic win the dominant-frequency contest at the exact
 * frequency the test is asserting against.
 */
function toneSignal(seconds) {
  const n = Math.round(SR * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    out[i] = (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.7 * t)) * Math.sin(2 * Math.PI * 220 * t) * 0.5;
  }
  return out;
}

function run({ seconds = 2, tempo = 1, flx = false, rate = 1, tone = false }) {
  const src = (tone ? toneSignal : testSignal)(seconds);
  const p = new DeckProcessor();
  p.onMessage({ type: 'load', channels: [src, src], frames: src.length });
  p.onMessage({ type: 'param', rate, tempo, flx, dir: 1, gain: 1 });
  p.onMessage({ type: 'playing', value: true });

  // AudioWorklet hands the processor outputs[deckIndex][channelIndex], not a
  // flat channel list.
  const outputs = [[new Float32Array(128), new Float32Array(128)]];
  const collected = [];
  let guard = 0;
  while (p.playing && guard++ < 60000) {
    p.process([], outputs);
    collected.push(outputs[0][0].slice());
    globalThis.currentTime += 128 / SR;
  }
  const n = collected.length * 128;
  const mono = new Float32Array(n);
  for (let b = 0; b < collected.length; b++) mono.set(collected[b], b * 128);
  return { mono, frames: n, seconds: n / SR };
}

/** Strongest tone between 150 and 600 Hz, via a Goertzel sweep. */
function dominantFreq(x) {
  const seg = x.subarray(Math.floor(x.length * 0.2), Math.floor(x.length * 0.8));
  let best = -1;
  let bestF = 0;
  for (let f = 150; f <= 600; f += 2) {
    const c = 2 * Math.cos((2 * Math.PI * f) / SR);
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < seg.length; i++) {
      const s0 = seg[i] + c * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    const power = s1 * s1 + s2 * s2 - c * s1 * s2;
    if (power > best) {
      best = power;
      bestF = f;
    }
  }
  return bestF;
}

/** Largest single-sample jump; a bad anchor shows up as an impulse here. */
function maxStep(x) {
  let m = 0;
  for (let i = 1; i < x.length; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
  return m;
}

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
}

const base = run({ seconds: 2, tempo: 1, flx: true });
const baseFreq = dominantFreq(base.mono);
const baseStep = maxStep(base.mono);
check('1:1 stretch is transparent', Math.abs(base.frames - SR * 2) < SR * 0.1, `${(base.frames / SR).toFixed(3)}s out`);

// --- master tempo: duration changes, pitch must not ------------------------

for (const tempo of [0.75, 1.25, 1.5, 2]) {
  const r = run({ seconds: 2, tempo, flx: true });
  const expected = 2 / tempo;
  const ratio = r.frames / SR;
  check(
    `FLX on: tempo x${tempo} shortens duration`,
    Math.abs(ratio - expected) / expected < 0.06,
    `${ratio.toFixed(3)}s vs ${expected.toFixed(3)}s`,
  );
  const f = dominantFreq(r.mono);
  check(
    `FLX on: tempo x${tempo} holds pitch`,
    Math.abs(f - baseFreq) < baseFreq * 0.03,
    `${f.toFixed(1)} Hz vs ${baseFreq.toFixed(1)} Hz`,
  );
  check(
    `FLX on: tempo x${tempo} stays click-free`,
    maxStep(r.mono) < baseStep * 1.6,
    `max step ${maxStep(r.mono).toFixed(4)} vs ${baseStep.toFixed(4)}`,
  );
}

// --- vinyl mode: pitch and duration move together --------------------------

const toneRef = run({ seconds: 2, flx: false, rate: 1, tone: true });
const toneFreq = dominantFreq(toneRef.mono);

for (const rate of [1, 1.25, 1.5]) {
  const r = run({ seconds: 2, flx: false, rate, tone: true });
  const f = dominantFreq(r.mono);
  check(
    `FLX off: rate x${rate} raises pitch`,
    Math.abs(f - toneFreq * rate) < toneFreq * rate * 0.04,
    `${f.toFixed(1)} Hz (expected ~${(toneFreq * rate).toFixed(1)})`,
  );
  check(
    `FLX off: rate x${rate} shortens duration`,
    Math.abs(r.frames / SR - 2 / rate) < 0.12,
    `${(r.frames / SR).toFixed(3)}s`,
  );
}

// --- loops -----------------------------------------------------------------

{
  const p = new DeckProcessor();
  const src = testSignal(2);
  p.onMessage({ type: 'load', channels: [src, src], frames: src.length });
  p.onMessage({ type: 'param', rate: 1, dir: 1 });
  p.onMessage({ type: 'loop', on: true, start: SR * 0.5, end: SR * 1.0 });
  p.onMessage({ type: 'playing', value: true });
  const outs = [[new Float32Array(128), new Float32Array(128)]];
  let last = p.pos;
  let wraps = 0;
  for (let i = 0; i < 20000; i++) {
    p.process([], outs);
    if (p.pos < last - 1000) wraps++;
    last = p.pos;
  }
  check('loop wraps instead of running out', wraps > 20 && p.playing, `${wraps} wraps, still playing`);
  check('looped playhead stays inside the region', p.pos >= SR * 0.5 && p.pos <= SR * 1.0, `${(p.pos / SR).toFixed(3)}s`);
}

// --- reverse ---------------------------------------------------------------

{
  const p = new DeckProcessor();
  const src = testSignal(2);
  p.onMessage({ type: 'load', channels: [src, src], frames: src.length });
  p.onMessage({ type: 'param', rate: 1, dir: -1 });
  p.onMessage({ type: 'playing', value: true });
  p.seek(SR * 1.0);
  const outs = [[new Float32Array(128), new Float32Array(128)]];
  let guard = 0;
  while (p.playing && guard++ < 40000) p.process([], outs);
  check('reverse runs backwards to the start', p.pos <= 1, `${(p.pos / SR).toFixed(4)}s`);
  check('reverse stops at the top of the track', !p.playing);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall worklet checks passed');
process.exit(failures ? 1 : 0);
