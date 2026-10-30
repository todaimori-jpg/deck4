/**
 * One deck panel: header, scrolling waveform, overview strip, transport.
 * The layout mirrors the reference — title/remaining/BPM/letter across the top,
 * waveform with the pitch strip pinned to its right edge, controls underneath.
 */

import { el, makeVFader, makeButton, makeCycler, makePad } from './widgets.js';
import { Waveform, Overview, GridStrip, HOTCUE_COLORS } from './waveform.js';

const LOOP_STEPS = [0.25, 0.5, 1, 2, 4, 8];
const RANGES = [8, 16, 100];

function loopLabel(beats) {
  if (beats < 1) return `1/${Math.round(1 / beats)}`;
  return `${beats}`;
}

export class DeckView {
  constructor(deck, app) {
    this.deck = deck;
    this.app = app;
    this.hotcuePage = 0;
    this.build();
    deck.onStateChange = () => this.syncState();
    this.syncState();
  }

  build() {
    const deck = this.deck;

    this.title = el('span', { class: 'dh-title', text: '— no track —' });
    this.artist = el('span', { class: 'dh-artist', text: '' });
    this.remaining = el('span', { class: 'dh-rem', text: '00:00' });
    this.bpmOut = el('span', { class: 'dh-bpm', text: '--.--' });
    this.badge = el('span', { class: 'dh-badge', text: deck.letter });

    const head = el('div', { class: 'deck-head' }, [this.title, this.artist, this.remaining, this.bpmOut, this.badge]);

    // --- control row -------------------------------------------------------
    this.syncBtn = makeButton({
      label: 'SYNC',
      className: 'mini',
      onClick: () => {
        if (deck.syncOn && this.syncTarget() === deck) {
          deck.syncOn = false;
          this.syncBtn.setOn(false);
        } else {
          const t = this.syncTarget();
          if (!t || !t.loaded) {
            this.app.toast('No playing deck to sync to');
            return;
          }
          if (t === deck) {
            this.app.toast('Deck needs a partner that is playing');
            return;
          }
          const ok = deck.syncTo(t);
          this.syncBtn.setOn(ok);
          if (ok) this.app.toast(`${deck.letter} synced to ${t.letter}`);
        }
      },
    });
    this.masterBtn = makeButton({
      label: 'MASTER',
      className: 'mini',
      onClick: () => this.app.setMasterDeck(deck),
    });
    this.quantBtn = makeCycler({
      options: [1 / 4, 1 / 2, 1, 2, 4],
      index: 2,
      className: 'btn mini',
      render: (v) => `Q ${loopLabel(v)}`,
      onChange: (v) => (this.app.quantize = v),
    });
    const zoomOut = makeButton({ label: '−', className: 'mini', onClick: () => this.wave.setZoom(0.72) });
    const zoomIn = makeButton({ label: '+', className: 'mini', onClick: () => this.wave.setZoom(1.38) });
    const spacer = el('span', { class: 'spacer' });

    const row = el('div', { class: 'deck-row' }, [
      this.syncBtn.root,
      this.masterBtn.root,
      this.quantBtn.root,
      spacer,
      zoomOut.root,
      zoomIn.root,
    ]);

    // --- waveform + pitch --------------------------------------------------
    this.waveCanvas = el('canvas');
    this.emptyLabel = el('div', { class: 'wave-empty', text: 'LOAD A TRACK FROM THE BROWSER' });
    const waveWrap = el('div', { class: 'wave-wrap' }, [this.waveCanvas, this.emptyLabel]);
    this.wave = new Waveform(this.waveCanvas, deck);

    this.pitchRead = el('div', { class: 'pitch-read', text: '+0.00%' });
    this.pitchCap = el('div', { class: 'pitch-cap', text: '±8%' });
    this.pitch = makeVFader({
      min: -1,
      max: 1,
      value: 0,
      bipolar: true,
      onChange: (t) => deck.setTempo(t * deck.rangePct),
    });
    this.rangeBtn = makeCycler({
      options: RANGES,
      className: 'pitch-cap',
      render: (v) => `±${v}%`,
      onChange: (v) => {
        deck.setRange(v);
        this.pitch.set((deck.tempoPct / v) || 0);
      },
    });
    const pitchCol = el('div', { class: 'pitch' }, [this.rangeBtn.root, this.pitch.root, this.pitchRead]);

    const body = el('div', { class: 'deck-body' }, [waveWrap, pitchCol]);

    // --- overview ----------------------------------------------------------
    this.overCanvas = el('canvas');
    const overview = el('div', { class: 'overview' }, [this.overCanvas]);
    this.over = new Overview(this.overCanvas, deck);
    this.overViewRoot = overview;

    // --- grid editor -------------------------------------------------------
    this.gridCanvas = el('canvas');
    this.grid = new GridStrip(this.gridCanvas, deck);
    this.grid.onEdit = () => this.app.onGridEdited(deck);
    const tapBtn = makeButton({
      label: 'TAP',
      className: 'mini',
      onClick: () => this.app.tapTempo(deck),
    });
    const resetBtn = makeButton({
      label: 'AUTO',
      className: 'mini',
      onClick: () => this.app.reanalyse(deck),
    });
    const gridTools = el('div', { class: 'grid-tools' }, [tapBtn.root, resetBtn.root]);
    this.gridRoot = el('div', { class: 'gridview' }, [this.gridCanvas, gridTools]);

    // --- transport ---------------------------------------------------------
    this.playBtn = makeButton({
      label: '▶',
      className: 'play',
      onClick: () => {
        this.app.arm();
        deck.toggle();
      },
    });
    this.cueBtn = makeButton({
      label: 'CUE',
      onClick: () => deck.cuePress(),
      onHold: () => {
        deck.setCue(this.app.quantize);
        this.app.toast(`${deck.letter} cue set`);
      },
    });
    const cupBtn = makeButton({ label: 'CUP', onClick: () => deck.cueAndPlay() });
    this.flxBtn = makeButton({
      label: 'FLX',
      className: 'warn',
      onClick: () => {
        deck.setFlx(!deck.flx);
        this.flxBtn.setOn(deck.flx);
        pitchCol.classList.toggle('is-flx', deck.flx);
      },
    });
    const revBtn = el('button', { class: 'btn danger', type: 'button', text: 'REV' });
    const setRev = (on) => {
      deck.setReverse(on);
      revBtn.classList.toggle('is-on', on);
    };
    revBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.app.arm();
      setRev(true);
    });
    const revUp = () => setRev(false);
    revBtn.addEventListener('pointerup', revUp);
    revBtn.addEventListener('pointercancel', revUp);
    revBtn.addEventListener('pointerleave', revUp);

    const loopBtns = LOOP_STEPS.map((b) =>
      makeButton({
        label: loopLabel(b),
        className: 'mini',
        onClick: () => deck.toggleLoop(b),
      }),
    );
    this.loopBtns = loopBtns;
    const exitLoop = makeButton({ label: '✕', className: 'mini', onClick: () => deck.exitLoop() });

    const transport = el('div', { class: 'deck-foot' }, [
      this.playBtn.root,
      this.cueBtn.root,
      cupBtn.root,
      this.flxBtn.root,
      revBtn,
      el('span', { class: 'spacer' }),
      ...loopBtns.map((b) => b.root),
      exitLoop.root,
    ]);

    // --- hotcue pads -------------------------------------------------------
    this.hotcuePads = [];
    const padRow = el('div', { class: 'deck-foot deck-pads' });
    for (let i = 0; i < 4; i++) {
      const slot = i;
      const pad = makePad({
        label: String(slot + 1),
        onPress: () => {
          this.app.arm();
          deck.jumpHotcue(this.hotcuePage * 4 + slot, { division: this.app.quantize });
        },
        onRelease: () => {},
      });
      pad.root.dataset.slot = String(slot);
      this.hotcuePads.push(pad);
      padRow.appendChild(pad.root);
    }
    const pageBtn = makeButton({
      label: '1/2',
      className: 'mini',
      onClick: () => {
        this.hotcuePage = this.hotcuePage ? 0 : 1;
        pageBtn.setLabel(`${this.hotcuePage + 1}/2`);
        this.paintHotcues();
      },
    });
    const clearBtn = makeButton({
      label: 'CLR',
      className: 'mini',
      onClick: () => {
        const slot = this.hotcuePage * 4 + 3;
        deck.clearHotcue(slot);
        this.paintHotcues();
      },
      onHold: () => {
        deck.hotcues = deck.hotcues.map(() => null);
        this.paintHotcues();
      },
    });
    padRow.appendChild(el('span', { class: 'spacer' }));
    padRow.appendChild(pageBtn.root);
    padRow.appendChild(clearBtn.root);

    this.root = el('section', { class: 'deck', 'data-deck': String(deck.index) }, [
      head,
      row,
      body,
      overview,
      this.gridRoot,
      transport,
      padRow,
    ]);
  }

  /** The deck we follow: first other playing deck, else first other loaded. */
  syncTarget() {
    const others = this.app.decks.filter((d) => d !== this.deck && d.loaded);
    return others.find((d) => d.playing) || others[0] || this.deck;
  }

  setTrackText(track) {
    this.title.textContent = track ? track.title : '— no track —';
    this.artist.textContent = track && track.artist ? track.artist : '';
    this.emptyLabel.style.display = track ? 'none' : 'grid';
  }

  syncState() {
    const deck = this.deck;
    this.playBtn.setOn(deck.playing);
    this.root.classList.toggle('is-playing', deck.playing);
    this.masterBtn.setOn(this.app.masterDeck === deck);
    this.flxBtn.setOn(deck.flx);
    this.syncBtn.setOn(deck.syncOn);
    this.paintHotcues();
    this.loopBtns.forEach((b, i) => b.setOn(deck.loop.on && deck.loop.beats === LOOP_STEPS[i]));
  }

  paintHotcues() {
    const deck = this.deck;
    this.hotcuePads.forEach((pad, i) => {
      const hc = deck.hotcues[this.hotcuePage * 4 + i];
      if (hc) {
        pad.root.className = 'pad is-set';
        pad.root.style.background = HOTCUE_COLORS[(this.hotcuePage * 4 + i) % HOTCUE_COLORS.length];
        pad.root.style.borderColor = '#00000055';
      } else {
        pad.root.className = 'pad empty';
        pad.root.style.background = '';
        pad.root.style.borderColor = '';
      }
    });
  }

  /** Per-frame text and readouts. */
  refresh() {
    const deck = this.deck;
    this.remaining.textContent = deck.loaded ? deck.remaining : '00:00';
    const bpm = deck.loaded && deck.grid && deck.grid.ready ? deck.grid.bpmAt(deck.position) * deck.displayTempo : 0;
    this.bpmOut.textContent = bpm ? bpm.toFixed(2) : '--.--';
    const pct = deck.tempoPct;
    this.pitchRead.textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
    if (Math.abs(this.pitch.value * deck.rangePct - pct) > 0.05 && !this.pitchDragging) {
      this.pitch.set(pct / deck.rangePct, true);
    }
    this.wave.draw();
    this.over.draw();
    this.over.commit();
    if (this.app.gridMode) this.grid.draw();
  }
}
