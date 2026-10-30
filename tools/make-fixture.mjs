/**
 * Generates a deterministic test crate: short synthetic tracks with known
 * tempo, used to check the analyser without depending on copyrighted audio.
 *
 *   ELECTRON_RUN_AS_NODE=1 Qoder.exe tools/make-fixture.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'fixtures');
mkdirSync(out, { recursive: true });

function wav(samples, sr) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 4, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(3, 20); // IEEE float
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 8, 28);
  buf.writeUInt16LE(8, 32);
  buf.writeUInt16LE(32, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 4, 40);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < n; i++) view.setFloat32(44 + i * 4, samples[i], true);
  return buf;
}

/** Simple xorshift so the noise pattern is identical on every machine. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return (s / 0xffffffff) * 2 - 1;
  };
}

function synth({ sr, seconds, bpm, kickDecay = 0.14, hatEvery = 2, drift = 0 }) {
  const total = sr * seconds;
  const data = new Float32Array(total);
  const rand = rng(0x9e3779b9);
  const beatSec = 60 / bpm;
  let lp = 0;

  for (let i = 0; i < total; i++) {
    const t = i / sr;
    // `drift` bends the tempo linearly across the track, which is what a live
    // funk or disco record actually does.
    const localBeatSec = beatSec * (1 + drift * (t / seconds - 0.5));
    const beat = t / localBeatSec;
    const phase = beat - Math.floor(beat);
    const sinceBeat = phase * localBeatSec;
    const slot = Math.round(beat * hatEvery) / hatEvery;
    const sinceHat = (beat * hatEvery - Math.round(beat * hatEvery)) / hatEvery * localBeatSec;

    const kick = Math.sin(2 * Math.PI * (52 + 26 * Math.exp(-sinceBeat * 22)) * sinceBeat) * Math.exp(-sinceBeat / kickDecay);
    const hat = sinceHat >= 0 && sinceHat < 0.03 ? rand() * Math.exp(-sinceHat / 0.012) * 0.35 : 0;
    const bassPhase = (beat / 4) % 1;
    const bass = Math.sin(2 * Math.PI * 55 * t) * 0.22 * (bassPhase < 0.5 ? 1 : 0.4);
    const pad = (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 330 * t) * 0.6) * 0.06;

    let x = kick * 0.9 + bass + pad + hat;
    x = Math.tanh(x * 1.1) * 0.85;
    lp += (x - lp) * 0.02;
    data[i] = x;
  }

  // Interleave to stereo.
  const stereo = new Float32Array(total * 2);
  for (let i = 0; i < total; i++) {
    stereo[i * 2] = data[i];
    stereo[i * 2 + 1] = data[i] * 0.96;
  }
  return stereo;
}

const sr = 44100;
const jobs = [
  { file: 'house-126.wav', bpm: 126, seconds: 24, drift: 0 },
  { file: 'techno-132.wav', bpm: 132, seconds: 24, drift: 0, hatEvery: 4 },
  { file: 'live-disco-drifting.wav', bpm: 112, seconds: 30, drift: 0.12, kickDecay: 0.2 },
];

for (const j of jobs) {
  const buf = wav(synth({ sr, ...j }), sr);
  writeFileSync(join(out, j.file), buf);
  console.log(`wrote fixtures/${j.file} (${(buf.length / 1024 / 1024).toFixed(1)} MB, ${j.bpm} BPM)`);
}
