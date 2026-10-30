/**
 * Centre mixer: one strip per deck, master section, crossfader.
 *
 * Strips are built once and re-shown when the deck count changes rather than
 * rebuilt, so a live set never loses fader position.
 */

import { el, makeKnob, makeVFader, makeHFader, makeButton } from './widgets.js';

const EQ_COLOR = { high: '#3fb6e8', mid: '#e0479f', low: '#f08b2c' };

function vuHeight(rms, peak) {
  const db = 20 * Math.log10(Math.max(peak * 0.9 + rms * 0.1, 1e-6));
  return Math.max(0, Math.min(100, ((db + 54) / 54) * 100));
}

export class MixerView {
  constructor(app) {
    this.app = app;
    this.strips = [];
    // The stage already reserves the centre column; build into it rather than
    // creating a second .mixer that never gets mounted.
    this.root = document.getElementById('mixer');
    this.channels = el('div', { class: 'mixer-channels' });
    this.root.appendChild(this.channels);
    this.root.appendChild(this.buildMaster());
  }

  addStrip(deck) {
    const gain = makeKnob({
      label: 'GAIN',
      min: 0,
      max: 2,
      value: 1,
      color: '#f5b642',
      reset: 1,
      onChange: (v) => deck.setGain(v),
    });
    const eq = {};
    for (const band of ['high', 'mid', 'low']) {
      eq[band] = makeKnob({
        label: band === 'high' ? 'HI' : band === 'mid' ? 'MID' : 'LO',
        min: -26,
        max: 6,
        value: 0,
        color: EQ_COLOR[band],
        reset: 0,
        onChange: (v) => deck.setEqBand(band, v),
      });
    }
    const filter = makeKnob({
      label: 'FILT',
      min: -1,
      max: 1,
      value: 0,
      color: '#b07df5',
      reset: 0,
      onChange: (v) => deck.setFilter(v),
    });
    const pfl = makeButton({
      label: '◐',
      className: 'mini',
      title: 'Cue to headphones',
      onClick: () => {
        deck.setPfl(!deck.pflOn);
        pfl.setOn(deck.pflOn);
      },
    });
    const vu = el('i');
    const fader = makeVFader({
      min: 0,
      max: 1,
      value: 0.85,
      onChange: (v) => deck.setVolume(v),
    });
    const tag = el('span', { class: 'ch-tag', text: deck.letter });
    const strip = el('div', { class: 'channel', 'data-deck': String(deck.index) }, [
      el('div', { class: 'ch-head' }, [tag, pfl.root]),
      gain.root,
      el('div', { class: 'eq-stack' }, [eq.high.root, eq.mid.root, eq.low.root]),
      filter.root,
      el('div', { class: 'ch-mid' }, [fader.root, el('div', { class: 'ch-vu' }, [vu])]),
    ]);
    this.channels.appendChild(strip);
    const rec = { deck, strip, tag, vu, fader, gain, eq, filter, pfl };
    this.strips[deck.index] = rec;
    return rec;
  }

  buildMaster() {
    this.masterVu = el('i');
    this.xfader = makeHFader({
      min: 0,
      max: 1,
      value: 0.5,
      onChange: (v) => this.app.engine.setXfader(v),
    });
    this.curveBtn = makeButton({
      label: 'SMOOTH',
      className: 'mini',
      onClick: () => {
        const smooth = this.app.engine.xfaderCurve !== 'smooth';
        this.app.engine.setXfaderCurve(smooth ? 'smooth' : 'sharp');
        this.curveBtn.setLabel(smooth ? 'SMOOTH' : 'SHARP');
      },
    });
    const head = el('div', { class: 'xfader-head' }, [
      el('span', { text: 'CROSSFADER' }),
      el('div', { class: 'xfader-head-right' }, [
        el('div', { class: 'master-vu' }, [this.masterVu]),
        this.curveBtn.root,
      ]),
    ]);
    const zone = el('div', { class: 'xfader-zone' }, [
      head,
      this.xfader.root,
      el('div', { class: 'xfader-scale' }, [el('span', { text: 'A' }), el('span', { text: '·' }), el('span', { text: 'B' })]),
    ]);
    this.xfaderZone = zone;
    return zone;
  }

  setDeckCount(n) {
    this.channels.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
    for (let i = 0; i < this.strips.length; i++) {
      if (this.strips[i]) this.strips[i].strip.style.display = i < n ? '' : 'none';
    }
    // Left half of the fader owns the first pair, right half the second.
    this.app.decks.forEach((deck, i) => {
      const node = this.app.engine.decks[i];
      if (!node) return;
      node.group = n === 2 ? (i === 0 ? 0 : 1) : i < 2 ? 0 : 1;
    });
    this.app.engine.applyXfader();

    const scale = this.xfaderZone.querySelector('.xfader-scale');
    scale.children[0].textContent = this.app.decks[0] ? this.app.decks[0].letter : 'A';
    scale.children[2].textContent = this.app.decks[n - 1] ? this.app.decks[n - 1].letter : 'B';
  }

  refresh() {
    const eng = this.app.engine;
    if (!eng) return;
    for (const s of this.strips) {
      if (!s || !s.deck.chain) continue;
      if (!s.deck.chain.tap) {
        const a = eng.ctx.createAnalyser();
        a.fftSize = 512;
        s.deck.chain.pan.connect(a);
        s.deck.chain.tap = a;
      }
      const { peak, rms } = eng.meterLevel(s.deck.chain.tap);
      s.vu.style.height = `${vuHeight(rms, peak)}%`;
      s.strip.classList.toggle('is-active', s.deck.playing);
    }
    const m = eng.meterLevel(eng.analyser);
    this.masterVu.style.width = `${vuHeight(m.rms, m.peak)}%`;
  }
}
