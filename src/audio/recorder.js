/** Records the master bus directly; no microphone or screen capture permission. */
const FORMATS = [
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
];

export function recordingExtension(type) {
  const container = type.split(';')[0].toLowerCase();
  if (container === 'audio/mp4' || container === 'audio/x-m4a') return 'm4a';
  if (container === 'video/mp4') return 'mp4';
  if (container === 'audio/ogg') return 'ogg';
  if (container === 'audio/webm' || container === 'video/webm') return 'webm';
  return 'bin';
}

export class MixRecorder extends EventTarget {
  constructor(engine) {
    super();
    this.engine = engine;
    this.state = 'idle';
    this.duration = 0;
    this.mediaRecorder = null;
  }

  get supported() {
    return typeof MediaRecorder !== 'undefined';
  }

  get elapsed() {
    return this.state === 'recording'
      ? Math.max(0, this.engine.now() - this.startedAt)
      : this.duration;
  }

  setState(state) {
    this.state = state;
    this.dispatchEvent(new Event('statechange'));
  }

  async start() {
    if (this.state !== 'idle') return;
    if (!this.supported) throw new Error('Recording is unavailable. Open DECK in an up-to-date Safari.');
    this.duration = 0;
    this.setState('starting');
    try {
      await this.engine.resume();
      if (this.engine.ctx.state !== 'running') throw new Error('The audio engine is paused. Tap a deck to resume, then try again.');
      const stream = this.engine.recordingStream();
      let recorder;
      // A supported MIME type can still fail when the device has no encoder.
      // Try the next container, then let the browser choose as a last resort.
      for (const mimeType of FORMATS) {
        if (MediaRecorder.isTypeSupported && !MediaRecorder.isTypeSupported(mimeType)) continue;
        try {
          recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 256000 });
          break;
        } catch { /* try another encoder */ }
      }
      if (!recorder) recorder = new MediaRecorder(stream);
      this.mediaRecorder = recorder;
      this.chunks = [];
      this.warning = '';
      this.createdAt = Date.now();
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size) this.chunks.push(event.data);
      };
      recorder.onerror = () => {
        this.warning = 'Recording was interrupted. Any captured audio is available below.';
        if (recorder.state !== 'inactive') this.stop();
        // The recorder also queues final dataavailable and stop events on error.
      };
      recorder.onstop = () => this.finish(recorder);
      this.onContextState = () => {
        if (this.state === 'recording' && this.engine.ctx.state !== 'running') {
          this.warning = 'Audio was interrupted. Your take was stopped; keep DECK in the foreground while recording.';
          this.stop();
        }
      };
      this.engine.ctx.addEventListener('statechange', this.onContextState);
      this.startedAt = this.engine.now();
      recorder.start(1000);
      this.setState('recording');
    } catch (err) {
      this.engine.ctx?.removeEventListener('statechange', this.onContextState);
      this.mediaRecorder = null;
      this.chunks = [];
      this.setState('idle');
      throw err;
    }
  }

  stop() {
    if (this.state !== 'recording') return;
    this.duration = this.elapsed;
    this.setState('stopping');
    // Never assemble a file here: the final chunk arrives BEFORE the stop event.
    if (this.mediaRecorder.state !== 'inactive') this.mediaRecorder.stop();
  }

  finish(recorder) {
    if (recorder !== this.mediaRecorder) return;
    if (this.state === 'recording') this.duration = this.elapsed;
    this.engine.ctx.removeEventListener('statechange', this.onContextState);
    const type = recorder.mimeType || this.chunks[0]?.type || 'application/octet-stream';
    const blob = new Blob(this.chunks, { type });
    const createdAt = this.createdAt;
    const stamp = new Date(createdAt).toISOString().replace(/[:.]/g, '-');
    this.chunks = [];
    this.mediaRecorder = null;
    this.setState('idle');
    if (!blob.size) {
      this.dispatchEvent(new CustomEvent('recordingerror', { detail: 'No audio was captured. Please try recording again.' }));
      return;
    }
    this.dispatchEvent(new CustomEvent('recorded', {
      detail: {
        id: `${createdAt}-${Math.random().toString(36).slice(2, 8)}`,
        fileName: `DECK4-${stamp}.${recordingExtension(type)}`,
        createdAt,
        duration: this.duration,
        blob,
        warning: this.warning,
      },
    }));
  }
}
