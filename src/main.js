/**
 * App wiring: boots the audio context behind the iPad gesture gate, owns the
 * deck/mixer/browser views, and runs the single animation frame loop that
 * repaints every canvas.
 */

import { AudioEngine } from './audio/engine.js';
import { Deck } from './audio/deck.js';
import { analyzePeaks, analyzeTempo } from './analysis/analyze.js';
import { BeatGrid, TempoTapper } from './analysis/grid.js';
import { Library, packPeaks, unpackPeaks } from './store/library.js';
import { DeckView } from './ui/deckview.js';
import { MixerView } from './ui/mixerview.js';
import { BrowserView } from './ui/browser.js';
import { RecordingView } from './ui/recordingview.js';
import { el } from './ui/widgets.js';

const $ = (id) => document.getElementById(id);

class App {
  constructor() {
    this.engine = new AudioEngine();
    this.library = new Library();
    this.decks = [];
    this.views = [];
    this.masterDeck = null;
    this.quantize = 1;
    this.gridMode = false;
    this.deckCount = 4;
    this.tappers = new Map();
    this.saveTimers = new Map();
  }

  async boot() {
    await this.engine.init();
    await this.library.load();
    await this.library.requestPersist();

    for (let i = 0; i < 4; i++) {
      const deck = new Deck(this.engine, i);
      this.decks.push(deck);
      this.views.push(new DeckView(deck, this));
    }

    this.mixer = new MixerView(this);
    // Strips need the deck chains, which only exist after Deck has bound.
    this.decks.forEach((d) => this.mixer.addStrip(d));

    this.browser = new BrowserView(this);
    this.recording = new RecordingView(this);
    this.bindChrome();
    this.setDeckCount(2);
    this.loop();
  }

  bindChrome() {
    document.querySelectorAll('[data-deck-count]').forEach((b) => {
      b.addEventListener('click', () => this.setDeckCount(Number(b.dataset.deckCount)));
    });
    $('gridModeBtn').addEventListener('click', (e) => {
      this.gridMode = !this.gridMode;
      e.currentTarget.classList.toggle('is-on', this.gridMode);
      $('stage').classList.toggle('is-grid', this.gridMode);
      if (this.gridMode) this.views.forEach((v) => v.grid.draw());
    });
    $('browserBtn').addEventListener('click', (e) => {
      const closed = $('browser').classList.toggle('is-closed');
      document.querySelector('.shell').style.setProperty('--browser-h', closed ? '0px' : '32%');
      e.currentTarget.classList.toggle('is-on', !closed);
    });
    $('globalQuant').addEventListener('click', (e) => {
      const steps = [1 / 4, 1 / 2, 1, 2, 4];
      const i = (steps.indexOf(this.quantize) + 1) % steps.length;
      this.quantize = steps[i];
      e.currentTarget.textContent = `QUANT ${this.quantize < 1 ? `1/${Math.round(1 / this.quantize)}` : this.quantize}`;
    });
    window.addEventListener('resize', () => this.relayout());
    window.addEventListener('orientationchange', () => setTimeout(() => this.relayout(), 250));
    this.bindKeys();
  }

  bindKeys() {
    // Physical keyboards are common on iPad stands; map transport to keys.
    window.addEventListener('keydown', (e) => {
      if (e.repeat || e.metaKey || e.ctrlKey) return;
      if (/INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
      if ($('recordingsDialog').open) return;
      if (document.activeElement.closest('.record-tools')) return;
      const map = { q: 0, w: 1, a: 2, s: 3 };
      if (map[e.key] !== undefined) {
        this.arm();
        this.decks[map[e.key]].toggle();
      } else if (e.key === ' ') {
        e.preventDefault();
        this.arm();
        this.decks[0].toggle();
      }
    });
  }

  setDeckCount(n) {
    this.deckCount = n;
    $('stage').dataset.decks = String(n);
    document.querySelectorAll('[data-deck-count]').forEach((b) => b.classList.toggle('is-on', Number(b.dataset.deckCount) === n));
    this.views.forEach((v, i) => {
      v.root.style.display = i < n ? '' : 'none';
    });
    // Columns hold ceil(n/2) decks each.
    const perCol = Math.ceil(n / 2);
    const left = $('colLeft');
    const right = $('colRight');
    const order = n === 2 ? [0, 1] : [0, 2, 1, 3];
    [left, right].forEach((col, ci) => {
      col.style.gridTemplateRows = `repeat(${perCol}, 1fr)`;
      col.innerHTML = '';
      order.slice(ci * perCol, ci * perCol + perCol).forEach((i) => col.appendChild(this.views[i].root));
    });
    this.mixer.setDeckCount(n);
    this.relayout();
  }

  relayout() {
    this.views.forEach((v) => {
      v.pitch.paint();
      v.over.draw();
    });
    if (this.mixer) this.mixer.strips.forEach((s) => s && s.fader.paint());
  }

  arm() {
    return this.engine.resume();
  }

  toast(msg, ms = 2200) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('is-on');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('is-on'), ms);
  }

  // --- library -------------------------------------------------------------

  async importFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    await this.arm();
    let done = 0;
    for (const file of files) {
      this.toast(`Analysing ${done + 1}/${files.length}: ${file.name}`, 60000);
      try {
        await this.importOne(file);
        done++;
      } catch (err) {
        console.warn('import failed', file.name, err);
        this.toast(`Could not read ${file.name}`, 3000);
      }
    }
    this.browser.refresh();
    this.toast(done ? `${done} track${done === 1 ? '' : 's'} added` : 'Nothing imported');
  }

  async importOne(file) {
    const bytes = await file.arrayBuffer();
    // decodeAudioData may detach the buffer it is handed, so keep a pristine
    // copy for the library before anything touches it.
    const archive = bytes.slice(0);
    const decoded = await this.engine.decode(bytes);
    const sr = decoded.sampleRate;
    const peaks = analyzePeaks(decoded);
    const tempo = analyzeTempo(decoded);
    const grid = new BeatGrid({ sampleRate: sr, duration: decoded.duration });
    grid.lockTo(tempo.bpm, tempo.phase * sr);

    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const { title, artist } = readName(file.name);
    await this.library.add({
      id,
      title,
      artist,
      fileName: file.name,
      size: file.size,
      duration: decoded.duration,
      peaks: packPeaks(peaks),
      grid: grid.toJSON(),
      bpm: tempo.bpm,
      confidence: tempo.confidence,
    });
    await this.library.putAudio(id, archive);
    return id;
  }

  async loadTrack(track, deckIndex) {
    await this.arm();
    const deck = this.decks[deckIndex];
    if (!deck) return;
    this.toast(`Loading ${track.title}…`, 8000);
    const bytes = await this.library.getAudio(track.id);
    if (!bytes) {
      this.toast('Audio for this track is no longer stored locally');
      return;
    }
    const buffer = await this.engine.decode(bytes.slice(0));
    const peaks = unpackPeaks(track.peaks) || analyzePeaks(buffer);
    const withPeaks = { ...track, peaks, grid: track.grid };
    await deck.load(withPeaks, buffer);
    this.views[deckIndex].setTrackText(track);
    this.browser.refresh();
    this.toast(`${deck.letter} ← ${track.title}`);
  }

  async clearLibrary() {
    for (const t of this.library.tracks.slice()) await this.library.remove(t.id);
    this.decks.forEach((d, i) => {
      d.unload();
      this.views[i].setTrackText(null);
    });
    this.browser.refresh();
    this.toast('Library cleared');
  }

  // --- grid ----------------------------------------------------------------

  setMasterDeck(deck) {
    this.masterDeck = this.masterDeck === deck ? null : deck;
    this.views.forEach((v) => v.syncState());
  }

  tapTempo(deck) {
    if (!deck.loaded) return;
    let t = this.tappers.get(deck);
    if (!t) {
      t = new TempoTapper(5);
      this.tappers.set(deck, t);
    }
    t.tap();
    const bpm = t.bpm;
    if (bpm < 40 || bpm > 260) {
      this.toast(`TAP ${deck.letter}: keep going`);
      return;
    }
    const i = this.nearestAnchor(deck);
    if (i >= 0) {
      deck.grid.moveAnchor(i, { bpm });
      this.onGridEdited(deck);
      this.toast(`${deck.letter} grid → ${bpm.toFixed(2)} BPM`);
    }
  }

  nearestAnchor(deck) {
    if (!deck.grid || !deck.grid.anchors.length) return -1;
    let best = 0;
    let bd = Infinity;
    deck.grid.anchors.forEach((a, i) => {
      const d = Math.abs(a.sample - deck.position);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  }

  onGridEdited(deck) {
    if (!deck.track) return;
    clearTimeout(this.saveTimers.get(deck));
    this.saveTimers.set(
      deck,
      setTimeout(() => {
        this.library.update(deck.track.id, { grid: deck.grid.toJSON() });
      }, 500),
    );
  }

  async reanalyse(deck) {
    if (!deck.buffer || !deck.track) return;
    this.toast('Re-analysing grid…', 8000);
    const tempo = analyzeTempo(deck.buffer);
    deck.grid.lockTo(tempo.bpm, tempo.phase * deck.sampleRate);
    await this.library.update(deck.track.id, { grid: deck.grid.toJSON(), bpm: tempo.bpm, confidence: tempo.confidence });
    this.browser.refresh();
    this.toast(`${deck.letter}: ${tempo.bpm.toFixed(2)} BPM, confidence ${(tempo.confidence * 100) | 0}%`);
  }

  // --- frame loop ----------------------------------------------------------

  loop = () => {
    requestAnimationFrame(this.loop);
    for (let i = 0; i < this.deckCount; i++) this.views[i].refresh();
    this.mixer.refresh();
    const md = this.masterDeck && this.masterDeck.loaded ? this.masterDeck : this.decks.find((d) => d.playing && d.loaded);
    const bpm = md && md.grid && md.grid.ready ? md.grid.bpmAt(md.position) * md.displayTempo : 0;
    $('globalTempoValue').textContent = bpm ? bpm.toFixed(2) : '--.--';
  };
}

/** "Artist - Title.mp3" is the convention almost every crate follows. */
function readName(fileName) {
  const base = fileName.replace(/\.[^.]+$/, '').replace(/_/g, ' ');
  const m = base.match(/^(.+?)\s*[-–—]\s*(.+)$/);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  return { artist: '', title: base.trim() };
}

const app = new App();
window.__deck = app;

const bootGate = $('boot');
const start = async () => {
  bootGate.removeEventListener('pointerdown', start);
  try {
    await app.boot();
    bootGate.classList.add('is-gone');
    $('shell').setAttribute('aria-hidden', 'false');
    if (!app.library.tracks.length) app.toast('Import tracks from the browser below');
  } catch (err) {
    console.error(err);
    bootGate.innerHTML = '';
    bootGate.appendChild(
      el('div', { class: 'boot-inner' }, [
        el('div', { class: 'boot-logo', text: 'AUDIO UNAVAILABLE' }),
        el('div', { class: 'boot-hint', text: String(err && err.message ? err.message : err) }),
      ]),
    );
  }
};
bootGate.addEventListener('pointerdown', start);

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {
    /* offline support is a progressive enhancement */
  });
}
