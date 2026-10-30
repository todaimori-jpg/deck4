/**
 * Headless checks for the DSP and grid maths, run in Node so regressions show
 * up without a browser or real audio files.
 *
 *   ELECTRON_RUN_AS_NODE=1 Qoder.exe tools/test-analysis.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzePeaks, analyzeTempo } from '../src/analysis/analyze.js';
import { BeatGrid } from '../src/analysis/grid.js';
import { packPeaks, unpackPeaks } from '../src/store/library.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readWav(file) {
  const buf = readFileSync(join(root, file));
  let offset = 12;
  let fmt = null;
  let dataAt = 0;
  let dataLen = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ') fmt = { offset: offset + 8 };
    if (id === 'data') {
      dataAt = offset + 8;
      dataLen = size;
    }
    offset += 8 + size + (size % 2);
  }
  const format = buf.readUInt16LE(fmt.offset);
  const channels = buf.readUInt16LE(fmt.offset + 2);
  const sampleRate = buf.readUInt32LE(fmt.offset + 4);
  const bits = buf.readUInt16LE(fmt.offset + 14);
  if (format !== 3 || bits !== 32) throw new Error(`unsupported wav format ${format}/${bits}`);

  const frames = dataLen / 4 / channels;
  const chans = Array.from({ length: channels }, () => new Float32Array(frames));
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) chans[c][i] = view.getFloat32(dataAt + (i * channels + c) * 4, true);
  }
  return {
    sampleRate,
    length: frames,
    duration: frames / sampleRate,
    numberOfChannels: channels,
    getChannelData: (c) => chans[c],
  };
}

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
}

// --- tempo analysis --------------------------------------------------------

const cases = [
  { file: 'fixtures/house-126.wav', bpm: 126, tol: 1.5 },
  { file: 'fixtures/techno-132.wav', bpm: 132, tol: 1.5 },
  // A record that speeds up 12% across its length only has an average tempo.
  { file: 'fixtures/live-disco-drifting.wav', bpm: 112, tol: 4 },
];

for (const c of cases) {
  const buffer = readWav(c.file);
  const t = analyzeTempo(buffer);
  const err = Math.abs(t.bpm - c.bpm);
  check(`${c.file} tempo within ${c.tol} BPM`, err <= c.tol, `got ${t.bpm.toFixed(2)} vs ${c.bpm}, conf ${t.confidence.toFixed(2)}`);
}

// --- peak envelope ---------------------------------------------------------

{
  const buffer = readWav('fixtures/house-126.wav');
  const p = analyzePeaks(buffer);
  const expected = Math.ceil(buffer.length / p.bucket);
  check('peaks cover the whole track', p.count === expected, `${p.count} vs ${expected}`);
  const finite = [...p.lo, ...p.hi, ...p.amp].every((v) => Number.isFinite(v) && v >= 0 && v <= 1);
  check('peaks normalised into 0..1', finite);
  const energy = p.amp.reduce((a, b) => a + b, 0) / p.amp.length;
  check('peaks are not silent', energy > 0.05, `mean ${energy.toFixed(3)}`);
  check('low band dominates a four-on-the-floor track', p.lo.reduce((a, b) => a + b) > p.hi.reduce((a, b) => a + b));
}

// --- quantised storage round trip -----------------------------------------

{
  const buffer = readWav('fixtures/techno-132.wav');
  const p = analyzePeaks(buffer);
  const back = unpackPeaks(packPeaks(p));
  let maxErr = 0;
  for (let i = 0; i < p.lo.length; i++) maxErr = Math.max(maxErr, Math.abs(p.lo[i] - back.lo[i]));
  check('byte-quantised peaks survive a round trip', maxErr <= 1 / 254, `max error ${maxErr.toFixed(4)}`);
}

// --- beat grid maths -------------------------------------------------------

{
  const sr = 44100;
  const g = new BeatGrid({ sampleRate: sr, duration: 30 });
  g.lockTo(120, 0);
  check('grid reports the locked tempo', Math.abs(g.bpmAt(sr * 10) - 120) < 0.001, `${g.bpmAt(sr * 10)}`);
  check('one beat is half a second at 120 BPM', Math.abs(g.sampleAtBeat(1) - sr * 0.5) < 1, `${g.sampleAtBeat(1)}`);
  check('beatAt inverts sampleAtBeat', Math.abs(g.beatAt(g.sampleAtBeat(37)) - 37) < 1e-6);
  check('bar 2 downbeat lands on beat 4', g.barBeat(g.sampleAtBeat(4)).beat === 1 && g.barBeat(g.sampleAtBeat(4)).bar === 2);
  check('snap pulls a late hit back onto the grid', Math.abs(g.snap(sr * 4.53) - sr * 4.5) < sr * 0.02);

  // Two zones: 120 up to 10 s, then 132. The grid must follow the change.
  g.setAnchors([
    { sample: 0, bpm: 120 },
    { sample: sr * 10, bpm: 132 },
  ]);
  const before = g.sampleAtBeat(g.beatAt(sr * 5));
  check('tempo before the second anchor is still 120', Math.abs(before - sr * 5) < sr * 0.01, `${before}`);
  check('tempo past the second anchor reaches 132', Math.abs(g.bpmAt(sr * 25) - 132) < 0.5, `${g.bpmAt(sr * 25).toFixed(2)}`);
  check('tempo ramps between anchors', g.bpmAt(sr * 5) > 120 && g.bpmAt(sr * 5) < 132);
  check('beat spacing tightens as tempo rises', g.sampleAtBeat(2) - g.sampleAtBeat(1) > g.sampleAtBeat(24) - g.sampleAtBeat(23));

  const json = g.toJSON();
  const h = BeatGrid.fromJSON(json);
  check('grid serialises and reloads', h.beats.length === g.beats.length && Math.abs(h.sampleAtBeat(20) - g.sampleAtBeat(20)) < 1e-6);

  h.addAnchor(sr * 20, 128);
  check('adding a marker keeps anchors sorted', h.anchors.every((a, i, arr) => i === 0 || arr[i - 1].sample <= a.sample));
  check('the new marker takes effect at its own position', Math.abs(h.bpmAt(sr * 21) - 128) < 1.5, `${h.bpmAt(sr * 21).toFixed(2)}`);
  h.removeAnchor(2);
  check('removing a marker restores the previous tempo', Math.abs(h.bpmAt(sr * 25) - 132) < 0.5, `${h.bpmAt(sr * 25).toFixed(2)}`);
  h.removeAnchor(1);
  check('a lone anchor leaves a flat grid', Math.abs(h.bpmAt(sr * 25) - 120) < 0.001);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
