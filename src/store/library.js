/**
 * Local track library.
 *
 * Stores the original file bytes plus the analysis (peaks and beatgrid), never
 * the decoded AudioBuffer — that is rebuilt on demand. Peak envelopes are
 * quantised to one byte per bucket because a display curve does not need the
 * dynamic range, and it keeps a 50-track crate inside iPad storage limits.
 */

const DB_NAME = 'deck-library';
const DB_VERSION = 2;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('tracks')) {
        const s = db.createObjectStore('tracks', { keyPath: 'id' });
        s.createIndex('addedAt', 'addedAt');
      }
      if (!db.objectStoreNames.contains('audio')) {
        db.createObjectStore('audio', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('recordings')) {
        db.createObjectStore('recordings', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const out = fn(t.objectStore(store));
        t.oncomplete = () => {
          db.close();
          resolve(out && out.result !== undefined ? out.result : out);
        };
        t.onerror = () => {
          db.close();
          reject(t.error);
        };
        t.onabort = () => {
          db.close();
          reject(t.error);
        };
      }),
  );
}

const q8 = (arr) => {
  const out = new Uint8Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = Math.round(Math.max(0, Math.min(1, arr[i])) * 255);
  return out;
};
const unq8 = (arr) => {
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = arr[i] / 255;
  return out;
};

export function packPeaks(peaks) {
  return { bucket: peaks.bucket, sr: peaks.sr, lo: q8(peaks.lo), hi: q8(peaks.hi), amp: q8(peaks.amp) };
}

export function unpackPeaks(packed) {
  if (!packed) return null;
  return { bucket: packed.bucket, sr: packed.sr, lo: unq8(packed.lo), hi: unq8(packed.hi), amp: unq8(packed.amp) };
}

export class Library {
  constructor() {
    this.tracks = [];
  }

  async load() {
    this.tracks = (await tx('tracks', 'readonly', (s) => s.getAll())) || [];
    this.tracks.sort((a, b) => a.addedAt - b.addedAt);
    return this.tracks;
  }

  async add({ id, title, artist, fileName, size, duration, peaks, grid, bpm, confidence }) {
    const rec = {
      id,
      title,
      artist,
      fileName,
      size,
      duration,
      peaks,
      grid,
      bpm,
      confidence,
      addedAt: Date.now(),
    };
    await tx('tracks', 'readwrite', (s) => s.put(rec));
    this.tracks.push(rec);
    return rec;
  }

  async update(id, patch) {
    const rec = this.tracks.find((t) => t.id === id);
    if (!rec) return null;
    Object.assign(rec, patch);
    await tx('tracks', 'readwrite', (s) => s.put(rec));
    return rec;
  }

  async putAudio(id, bytes) {
    await tx('audio', 'readwrite', (s) => s.put({ id, bytes }));
  }

  async getAudio(id) {
    const rec = await tx('audio', 'readonly', (s) => s.get(id));
    return rec ? rec.bytes : null;
  }

  async remove(id) {
    await tx('tracks', 'readwrite', (s) => s.delete(id));
    await tx('audio', 'readwrite', (s) => s.delete(id));
    this.tracks = this.tracks.filter((t) => t.id !== id);
  }

  async saveRecording(take) {
    await tx('recordings', 'readwrite', (s) => s.put(take));
  }

  async listRecordings() {
    const rows = [];
    await tx('recordings', 'readonly', (s) => {
      const req = s.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        const { blob, ...metadata } = cursor.value;
        rows.push({ ...metadata, size: blob.size });
        cursor.continue();
      };
    });
    return rows.sort((a, b) => b.createdAt - a.createdAt);
  }

  async getRecording(id) {
    return tx('recordings', 'readonly', (s) => s.get(id));
  }

  async removeRecording(id) {
    await tx('recordings', 'readwrite', (s) => s.delete(id));
  }

  async estimate() {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    return navigator.storage.estimate();
  }

  async requestPersist() {
    if (navigator.storage && navigator.storage.persist) {
      return navigator.storage.persist();
    }
    return false;
  }
}
