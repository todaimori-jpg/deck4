import { MixRecorder, recordingExtension } from '../audio/recorder.js';

const $ = (id) => document.getElementById(id);

export function recordingTime(seconds) {
  const total = Math.floor(Math.max(0, seconds));
  const s = String(total % 60).padStart(2, '0');
  const m = String(Math.floor(total / 60) % 60).padStart(2, '0');
  return total >= 3600 ? `${Math.floor(total / 3600)}:${m}:${s}` : `${m}:${s}`;
}

export function recordingFile(take, name = take.fileName) {
  const extension = recordingExtension(take.blob.type);
  const base = name.trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\.(m4a|mp4|webm|ogg|wav|mp3|aac|bin)$/i, '').trim().slice(0, 100) || 'DECK4-mix';
  return new File([take.blob], `${base}.${extension}`, {
    type: take.blob.type.split(';')[0],
    lastModified: take.createdAt,
  });
}

export class RecordingView {
  constructor(app) {
    this.app = app;
    this.recorder = new MixRecorder(app.engine);
    this.dialog = $('recordingsDialog');
    this.button = $('recordBtn');
    this.preview = $('recordingPreview');
    this.pending = new Map();
    this.takes = [];
    this.busy = false;
    this.selectionRequest = 0;
    this.recorder.addEventListener('statechange', () => this.updateState());
    this.recorder.addEventListener('recorded', (event) => this.complete(event.detail));
    this.recorder.addEventListener('recordingerror', (event) => {
      this.app.toast(event.detail, 6000);
      this.releaseWakeLock();
    });
    this.button.addEventListener('click', () => this.toggle());
    $('recordingsBtn').addEventListener('click', () => this.open());
    $('closeRecordings').addEventListener('click', () => this.dialog.close());
    $('recordingSelect').addEventListener('change', (event) => this.select(event.target.value));
    $('recordingName').addEventListener('input', () => this.prepareFile());
    // No asynchronous work before share(): Safari requires this tap's activation.
    $('shareRecording').addEventListener('click', () => this.share());
    $('downloadRecording').addEventListener('click', () => {
      this.status('Download requested. Check Files → Downloads, or use the share button in the audio preview.');
    });
    $('deleteRecording').addEventListener('click', () => this.remove());
    this.dialog.addEventListener('close', () => this.clearPreview());
    window.addEventListener('beforeunload', (event) => {
      if (this.recorder.state !== 'idle' || this.busy || this.pending.size) {
        event.preventDefault();
        event.returnValue = '';
      }
    });
    this.refresh().catch(() => this.app.toast('Saved takes are unavailable. New recordings can still be exported.', 5000));
    this.updateState();
  }

  updateState() {
    const state = this.recorder.state;
    const recording = state === 'recording';
    this.button.classList.toggle('is-recording', recording);
    this.button.setAttribute('aria-pressed', String(recording));
    this.button.setAttribute('aria-label', recording ? 'Stop recording master mix' : 'Start recording master mix');
    this.button.disabled = !this.recorder.supported || this.busy || state === 'starting' || state === 'stopping';
    this.button.title = this.recorder.supported ? 'Record the stereo master mix' : 'Recording requires an up-to-date browser';
    $('recordLabel').textContent = state === 'starting' ? 'WAIT' : state === 'stopping' ? 'FINISH' : recording ? 'STOP' : 'REC';
    $('recordingsBtn').disabled = this.busy || state !== 'idle';
    clearInterval(this.clock);
    this.updateClock();
    if (recording) this.clock = setInterval(() => this.updateClock(), 250);
    if (state === 'idle') this.releaseWakeLock();
  }

  updateClock() {
    $('recordTime').textContent = recordingTime(this.recorder.elapsed);
  }

  async toggle() {
    if (this.busy) return;
    if (this.recorder.state === 'recording') {
      this.recorder.stop();
      return;
    }
    if (this.recorder.state !== 'idle') return;
    try {
      this.preview.pause();
      await this.recorder.start();
      this.app.toast('Recording the master mix. Keep DECK open and your screen unlocked.', 5000);
      if (navigator.wakeLock?.request) {
        navigator.wakeLock.request('screen').then((lock) => {
          if (this.recorder.state === 'recording') this.wakeLock = lock;
          else lock.release().catch(() => {});
        }).catch(() => {});
      }
    } catch (err) {
      this.app.toast(`Could not start recording: ${err.message}`, 6000);
    }
  }

  releaseWakeLock() {
    this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
  }

  async refresh() {
    let stored;
    try {
      stored = await this.app.library.listRecordings();
    } catch (err) {
      if (!this.pending.size) throw err;
      stored = this.takes.filter((take) => !this.pending.has(take.id));
    }
    const all = new Map(stored.map((take) => [take.id, take]));
    for (const take of this.pending.values()) {
      all.set(take.id, { ...take, size: take.blob.size });
    }
    this.takes = [...all.values()].sort((a, b) => b.createdAt - a.createdAt);
    this.renderList();
  }

  renderList() {
    $('recordingCount').textContent = String(this.takes.length);
    const select = $('recordingSelect');
    select.replaceChildren();
    for (const take of this.takes) {
      const option = document.createElement('option');
      option.value = take.id;
      option.textContent = `${new Date(take.createdAt).toLocaleString()} · ${recordingTime(take.duration)}`;
      select.appendChild(option);
    }
    $('recordingEmpty').hidden = this.takes.length > 0;
    $('recordingDetails').hidden = !this.takes.length;
  }

  async complete(take) {
    this.busy = true;
    this.pending.set(take.id, take);
    this.updateState();
    let message = take.warning || 'Take stored on this device. Save a copy to Files below.';
    try {
      await this.app.library.saveRecording(take);
      this.pending.delete(take.id);
    } catch {
      message = 'This take could not be stored locally (storage may be full). Save to Files or download it before closing DECK.';
    }
    try {
      await this.refresh();
    } catch {
      this.takes = [{ ...take, size: take.blob.size }, ...this.takes.filter((t) => t.id !== take.id)];
      this.renderList();
    }
    this.busy = false;
    this.updateState();
    // Use the in-memory take immediately even if IndexedDB is unavailable.
    this.showDialog();
    this.display(take);
    this.status(message);
  }

  showDialog() {
    if (!this.dialog.open) this.dialog.showModal();
  }

  async open() {
    if (this.busy || this.recorder.state !== 'idle') return;
    this.showDialog();
    this.setActionsDisabled(true);
    this.status('');
    try {
      await this.refresh();
      if (this.takes.length && this.dialog.open) await this.select(this.takes[0].id);
    } catch {
      this.status('Could not read saved takes. Close and reopen this panel to try again.');
    }
  }

  async select(id) {
    const request = ++this.selectionRequest;
    this.clearPreview(false);
    this.setActionsDisabled(true);
    try {
      const take = this.pending.get(id) || await this.app.library.getRecording(id);
      if (request !== this.selectionRequest || !this.dialog.open) return;
      if (!take) throw new Error('Take not found');
      this.display(take);
      this.status(this.pending.has(id) ? 'Save this take to Files before closing DECK; local storage failed.' : '');
    } catch {
      if (request === this.selectionRequest) this.status('Could not load this take. Choose another take or reopen this panel.');
    }
  }

  display(take) {
    this.clearPreview(false);
    this.selected = take;
    $('recordingSelect').value = take.id;
    $('recordingName').value = take.fileName;
    $('recordingMeta').textContent = `${recordingTime(take.duration)} · ${(take.blob.size / 1048576).toFixed(1)} MB · ${recordingExtension(take.blob.type).toUpperCase()}`;
    this.objectURL = URL.createObjectURL(take.blob);
    this.preview.src = this.objectURL;
    $('downloadRecording').href = this.objectURL;
    this.setActionsDisabled(false);
    this.prepareFile();
  }

  prepareFile() {
    if (!this.selected) return;
    this.file = recordingFile(this.selected, $('recordingName').value);
    $('downloadRecording').download = this.file.name;
    let canShare = false;
    try {
      canShare = !!(navigator.share && navigator.canShare?.({ files: [this.file] }));
      // Some iPad versions recognise the .m4a UTType only with this MIME alias.
      if (!canShare && this.file.type === 'audio/mp4') {
        const alias = new File([this.file], this.file.name, { type: 'audio/x-m4a', lastModified: this.file.lastModified });
        if (navigator.share && navigator.canShare?.({ files: [alias] })) {
          this.file = alias;
          canShare = true;
        }
      }
    } catch { /* download remains available */ }
    $('shareRecording').hidden = !canShare;
  }

  async share() {
    if (!this.file) return;
    const button = $('shareRecording');
    button.disabled = true;
    try {
      await navigator.share({ files: [this.file] });
      this.status('Share sheet closed. Your take is still available here.');
    } catch (err) {
      this.status(err.name === 'AbortError'
        ? 'Share sheet closed. Your take is still here; tap Save to Files to try again.'
        : 'Could not open the share sheet. Try Download, then check the Files app.');
    } finally {
      button.disabled = false;
    }
  }

  async remove() {
    const take = this.selected;
    if (!take || !window.confirm(`Delete ${take.fileName} from DECK? Any copy saved in Files will remain.`)) return;
    this.setActionsDisabled(true);
    try {
      // An in-memory take is one for which the original storage write failed.
      if (!this.pending.has(take.id)) await this.app.library.removeRecording(take.id);
      this.pending.delete(take.id);
      this.clearPreview();
      this.takes = this.takes.filter((t) => t.id !== take.id);
      this.renderList();
      if (this.takes.length) await this.select(this.takes[0].id);
      this.status('Take deleted from DECK.');
    } catch {
      this.status('Could not delete this take. Please try again.');
      this.setActionsDisabled(false);
    }
  }

  setActionsDisabled(disabled) {
    $('shareRecording').disabled = disabled;
    $('deleteRecording').disabled = disabled;
    $('recordingName').disabled = disabled;
    $('downloadRecording').hidden = disabled;
  }

  clearPreview(cancelSelection = true) {
    if (cancelSelection) ++this.selectionRequest;
    this.preview.pause();
    this.preview.removeAttribute('src');
    this.preview.load();
    if (this.objectURL) URL.revokeObjectURL(this.objectURL);
    this.objectURL = null;
    this.selected = null;
    this.file = null;
    $('downloadRecording').removeAttribute('href');
  }

  status(message) {
    $('recordingStatus').textContent = message;
  }
}
