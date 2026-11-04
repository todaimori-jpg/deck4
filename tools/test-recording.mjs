/** Regression checks for recording lifecycle and Files export; no dependencies. */
import assert from 'node:assert/strict';
import { MixRecorder, recordingExtension } from '../src/audio/recorder.js';
import { AudioEngine } from '../src/audio/engine.js';
import { RecordingView, recordingFile, recordingTime } from '../src/ui/recordingview.js';

let count = 0;
async function test(name, fn) {
  await fn();
  count++;
  console.log(`ok   ${name}`);
}

class FakeRecorder {
  static supported = ['audio/mp4'];
  static rejected = [];
  static actualType = null;
  static instances = [];
  static isTypeSupported(type) { return this.supported.includes(type); }
  constructor(stream, options = {}) {
    if (FakeRecorder.rejected.includes(options.mimeType)) throw new Error('Encoder unavailable');
    this.stream = stream;
    this.mimeType = FakeRecorder.actualType || options.mimeType || 'audio/webm';
    this.state = 'inactive';
    FakeRecorder.instances.push(this);
  }
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    // Native stop is asynchronous; its last data chunk must not be missed.
    queueMicrotask(() => {
      this.ondataavailable({ data: new Blob(['final audio'], { type: this.mimeType }) });
      this.onstop();
    });
  }
}

function setup() {
  globalThis.MediaRecorder = FakeRecorder;
  FakeRecorder.supported = ['audio/mp4'];
  FakeRecorder.rejected = [];
  FakeRecorder.actualType = null;
  FakeRecorder.instances = [];
  const ctx = new EventTarget();
  ctx.state = 'running';
  let time = 4;
  const stream = {};
  const engine = { ctx, now: () => time, resume: async () => {}, recordingStream: () => stream };
  const recorder = new MixRecorder(engine);
  return { recorder, ctx, engine, stream, advance: (seconds) => { time += seconds; } };
}

function nextTake(recorder) {
  return new Promise((resolve) => recorder.addEventListener('recorded', (event) => resolve(event.detail), { once: true }));
}

await test('post-trim master tap reuses a stereo stream without disconnecting playback', () => {
  const engine = new AudioEngine();
  const connections = [];
  const destination = { stream: { id: 'stereo master' } };
  let creates = 0;
  engine.ctx = { createMediaStreamDestination: () => { creates++; return destination; } };
  engine.masterGain = { connect: (node) => connections.push(node) };
  assert.throws(() => engine.recordingStream(), /audio engine/);
  engine.ready = true;
  assert.equal(engine.recordingStream(), destination.stream);
  assert.equal(engine.recordingStream(), destination.stream);
  assert.equal(creates, 1);
  assert.deepEqual(connections, [destination]);
});

await test('recording includes the final asynchronous chunk and stops only once', async () => {
  const { recorder, stream, advance } = setup();
  const states = [];
  recorder.addEventListener('statechange', () => states.push(recorder.state));
  await recorder.start();
  await recorder.start();
  assert.equal(FakeRecorder.instances.length, 1);
  assert.equal(recorder.mediaRecorder.stream, stream);
  advance(65);
  const takePromise = nextTake(recorder);
  recorder.stop();
  recorder.stop();
  const take = await takePromise;
  assert.equal(await take.blob.text(), 'final audio');
  assert.equal(take.duration, 65);
  assert.match(take.fileName, /\.m4a$/);
  assert.deepEqual(states, ['starting', 'recording', 'stopping', 'idle']);
});

await test('repeated takes contain no chunks from the previous take', async () => {
  const { recorder } = setup();
  for (let i = 0; i < 2; i++) {
    await recorder.start();
    const result = nextTake(recorder);
    recorder.stop();
    assert.equal(await (await result).blob.text(), 'final audio');
  }
});

await test('unsupported MP4 falls back to Opus with the correct extension', async () => {
  const { recorder } = setup();
  FakeRecorder.supported = ['audio/webm;codecs=opus'];
  await recorder.start();
  const result = nextTake(recorder);
  recorder.stop();
  const take = await result;
  assert.equal(take.blob.type, 'audio/webm;codecs=opus');
  assert.match(take.fileName, /\.webm$/);
});

await test('an unavailable advertised encoder falls through to the next format', async () => {
  const { recorder } = setup();
  FakeRecorder.supported = ['audio/mp4', 'audio/webm'];
  FakeRecorder.rejected = ['audio/mp4'];
  await recorder.start();
  assert.equal(recorder.mediaRecorder.mimeType, 'audio/webm');
  const result = nextTake(recorder);
  recorder.stop();
  await result;
});

await test('the browser-selected actual MIME type determines the file container', async () => {
  const { recorder } = setup();
  FakeRecorder.supported = [];
  FakeRecorder.actualType = 'audio/ogg;codecs=opus';
  await recorder.start();
  const result = nextTake(recorder);
  recorder.stop();
  assert.match((await result).fileName, /\.ogg$/);
});

await test('an iPad audio interruption finalizes captured audio with a warning', async () => {
  const { recorder, ctx, advance } = setup();
  await recorder.start();
  advance(10);
  const result = nextTake(recorder);
  ctx.state = 'interrupted';
  ctx.dispatchEvent(new Event('statechange'));
  const take = await result;
  assert.equal(take.duration, 10);
  assert.match(take.warning, /interrupted/);
  assert.equal(recorder.state, 'idle');
});

await test('native encoder errors retain the final audio instead of dropping it', async () => {
  const { recorder } = setup();
  await recorder.start();
  const result = nextTake(recorder);
  recorder.mediaRecorder.onerror();
  const take = await result;
  assert.equal(await take.blob.text(), 'final audio');
  assert.match(take.warning, /interrupted/);
});

await test('a suspended audio engine produces a recoverable start error', async () => {
  const { recorder, ctx } = setup();
  ctx.state = 'suspended';
  await assert.rejects(recorder.start(), /paused/);
  assert.equal(recorder.state, 'idle');
  ctx.state = 'running';
  await recorder.start();
  const result = nextTake(recorder);
  recorder.stop();
  await result;
});

await test('missing MediaRecorder reports unsupported without entering a busy state', async () => {
  const { recorder } = setup();
  delete globalThis.MediaRecorder;
  assert.equal(recorder.supported, false);
  await assert.rejects(recorder.start(), /unavailable/);
  assert.equal(recorder.state, 'idle');
});

await test('empty takes report an error and can be recorded again', async () => {
  const { recorder } = setup();
  await recorder.start();
  let error = '';
  recorder.addEventListener('recordingerror', (event) => { error = event.detail; });
  const native = recorder.mediaRecorder;
  native.state = 'inactive';
  native.onstop();
  assert.match(error, /No audio/);
  assert.equal(recorder.state, 'idle');
});

await test('Files export sanitizes names and keeps the real container and bytes', async () => {
  const take = { blob: new Blob(['mix bytes'], { type: 'audio/mp4;codecs=mp4a.40.2' }), createdAt: 10 };
  const file = recordingFile(take, 'Sunday / mix.mp3');
  assert.equal(file.name, 'Sunday - mix.m4a');
  assert.equal(file.type, 'audio/mp4');
  assert.equal(await file.text(), 'mix bytes');
  assert.equal(recordingFile(take, '  ').name, 'DECK4-mix.m4a');
  assert.equal(recordingExtension('audio/webm;codecs=opus'), 'webm');
  assert.equal(recordingExtension('video/mp4'), 'mp4');
});

await test('the timer handles hour-long DJ sets without wrapping minutes', () => {
  assert.equal(recordingTime(0), '00:00');
  assert.equal(recordingTime(65.8), '01:05');
  assert.equal(recordingTime(3665), '1:01:05');
});

await test('Save to Files calls share inside the tap, and cancellation retains the take', async () => {
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const button = { disabled: false };
  globalThis.document = { getElementById: () => button };
  let calls = 0;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    share: ({ files }) => {
      calls++;
      assert.equal(files[0].name, 'mix.m4a');
      return Promise.reject(new DOMException('Cancelled', 'AbortError'));
    },
  } });
  const view = { file: new File(['audio'], 'mix.m4a'), status: (message) => { view.message = message; } };
  try {
    const result = RecordingView.prototype.share.call(view);
    assert.equal(calls, 1, 'No await may precede the native share call');
    await result;
    assert.match(view.message, /still here/);
    assert.equal(view.file.name, 'mix.m4a');
    assert.equal(button.disabled, false);
  } finally {
    delete globalThis.document;
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else delete globalThis.navigator;
  }
});

await test('a storage failure keeps a completed take exportable after reopening the panel', async () => {
  const take = { id: 'take-1', blob: new Blob(['audio']), createdAt: 1 };
  const quota = async () => { throw new DOMException('Full', 'QuotaExceededError'); };
  const view = Object.assign(Object.create(RecordingView.prototype), {
    app: { library: { saveRecording: quota, listRecordings: quota } },
    pending: new Map(), takes: [], dialog: { open: false }, recorder: { state: 'idle' },
    updateState() {}, renderList() {}, setActionsDisabled() {},
    showDialog() { this.dialog.open = true; },
    display(value) { this.displayed = value; },
    status(value) { this.message = value; },
    async select(id) { this.display(this.pending.get(id)); },
  });
  await view.complete(take);
  assert.equal(view.pending.get(take.id), take);
  assert.equal(view.displayed, take);
  assert.match(view.message, /could not be stored/);
  assert.equal(view.busy, false);
  view.dialog.open = false;
  view.displayed = null;
  await view.open();
  assert.equal(view.displayed, take);
  assert.equal(view.takes.length, 1);
});

delete globalThis.MediaRecorder;
console.log(`\n${count} recording checks passed`);
