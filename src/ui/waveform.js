/**
 * Waveform rendering.
 *
 * `Waveform` is the scrolling performance view: frequency-split bars around a
 * fixed playhead, with the beat grid drawn over the top so a drifting tempo
 * zone is visible as the lines tighten or widen. `Overview` is the whole-track
 * strip used for seeking and for reading where the hotcues sit.
 */

import { BUCKETS_PER_SEC } from '../analysis/analyze.js';

const HI = '#e8523f';
const LO = '#3f9de8';
const HI_DIM = '#7d2b21';
const LO_DIM = '#22506f';

function prep(canvas) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return null;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

export class Waveform {
  constructor(canvas, deck) {
    this.canvas = canvas;
    this.deck = deck;
    this.pxPerSec = 190;
    this.playheadAt = 0.5;
    this.showGrid = true;
  }

  setZoom(mult) {
    this.pxPerSec = Math.max(40, Math.min(900, this.pxPerSec * mult));
  }

  /** Sample position for a CSS x coordinate, and the inverse. */
  sampleAtX(x, w) {
    return this.deck.position + ((x - w * this.playheadAt) / this.pxPerSec) * this.deck.sampleRate;
  }

  xAtSample(s, w) {
    return w * this.playheadAt + ((s - this.deck.position) / this.deck.sampleRate) * this.pxPerSec;
  }

  draw() {
    const box = prep(this.canvas);
    if (!box) return;
    const { ctx, w, h } = box;
    const deck = this.deck;
    const axis = h / 2;

    ctx.fillStyle = '#0c0e10';
    ctx.fillRect(0, 0, w, h);

    if (!deck.loaded || !deck.peaks) {
      this.drawGridLines(ctx, w, h, axis);
      return;
    }

    const { lo, hi, bucket } = deck.peaks;
    const framesPerPx = deck.sampleRate / this.pxPerSec;
    const startSample = this.sampleAtX(0, w);

    // Bars are drawn per pixel column, taking the loudest bucket under that
    // column so the shape never thins out when zoomed far in.
    const half = axis - 1;
    for (let x = 0; x < w; x++) {
      const b0 = Math.floor((startSample + x * framesPerPx) / bucket);
      const b1 = Math.floor((startSample + (x + 1) * framesPerPx) / bucket);
      let peakLo = 0;
      let peakHi = 0;
      for (let b = Math.max(0, b0); b <= Math.min(lo.length - 1, Math.max(b0, b1)); b++) {
        if (lo[b] > peakLo) peakLo = lo[b];
        if (hi[b] > peakHi) peakHi = hi[b];
      }
      const past = b0 > Math.floor(deck.position / bucket);
      ctx.fillStyle = past ? HI_DIM : HI;
      ctx.fillRect(x, axis - peakHi * half, 1, peakHi * half);
      ctx.fillStyle = past ? LO_DIM : LO;
      ctx.fillRect(x, axis, 1, peakLo * half);
    }

    if (this.showGrid) this.drawGridLines(ctx, w, h, axis);
    this.drawMarkers(ctx, w, h, axis);
    this.drawPlayhead(ctx, w, h);
  }

  drawGridLines(ctx, w, h, axis) {
    const deck = this.deck;
    if (!deck.grid || !deck.grid.ready) return;
    const g = deck.grid;
    const from = this.sampleAtX(0, w);
    const to = this.sampleAtX(w, w);
    let beat = Math.floor(g.beatAt(from));
    for (let guard = 0; guard < 4000; guard++, beat++) {
      const s = g.sampleAtBeat(beat);
      if (s > to) break;
      if (s < from) continue;
      const x = Math.round(this.xAtSample(s, w));
      const rel = Math.round(beat) - g.origin;
      const isBar = ((rel % 4) + 4) % 4 === 0;
      ctx.fillStyle = isBar ? 'rgba(255,255,255,0.42)' : 'rgba(255,255,255,0.14)';
      ctx.fillRect(x, isBar ? 0 : axis - 7, 1, isBar ? h : 14);
    }
  }

  drawMarkers(ctx, w, h, axis) {
    const deck = this.deck;
    if (deck.loop.on) {
      const x0 = this.xAtSample(deck.loop.start, w);
      const x1 = this.xAtSample(deck.loop.end, w);
      ctx.fillStyle = 'rgba(240,139,44,0.16)';
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h);
      ctx.fillStyle = 'rgba(240,139,44,0.8)';
      ctx.fillRect(Math.round(x0), 0, 1, h);
      ctx.fillRect(Math.round(x1), 0, 1, h);
    }
    const cueX = this.xAtSample(deck.cue, w);
    if (cueX > -2 && cueX < w + 2) {
      ctx.fillStyle = '#c3e64b';
      ctx.fillRect(Math.round(cueX) - 1, 0, 2, h);
    }
    deck.hotcues.forEach((hc, i) => {
      if (!hc) return;
      const x = Math.round(this.xAtSample(hc.sample, w));
      if (x < -6 || x > w + 6) return;
      ctx.fillStyle = HOTCUE_COLORS[i % HOTCUE_COLORS.length];
      ctx.fillRect(x, 0, 2, 9);
      ctx.font = '700 8px system-ui';
      ctx.fillText(String(i + 1), x + 3, 8);
    });
  }

  drawPlayhead(ctx, w, h) {
    const x = Math.round(w * this.playheadAt);
    ctx.fillStyle = '#f2f4f6';
    ctx.fillRect(x, 0, 1, h);
    ctx.fillStyle = '#f2f4f6';
    ctx.beginPath();
    ctx.moveTo(x - 4, 0);
    ctx.lineTo(x + 4, 0);
    ctx.lineTo(x, 6);
    ctx.closePath();
    ctx.fill();
  }
}

export const HOTCUE_COLORS = ['#c3e64b', '#3fb6e8', '#e0479f', '#f08b2c', '#7ed321', '#b07df5', '#f5b642', '#ff6b6b'];

export class Overview {
  constructor(canvas, deck) {
    this.canvas = canvas;
    this.deck = deck;
    this.onSeek = null;
    canvas.addEventListener('pointerdown', (e) => this.fromEvent(e));
    canvas.addEventListener('pointermove', (e) => {
      if (e.buttons & 1) this.fromEvent(e);
    });
  }

  fromEvent(e) {
    const deck = this.deck;
    if (!deck.loaded) return;
    const r = this.canvas.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    this.dragTo = t * deck.frames;
  }

  commit() {
    if (this.dragTo !== undefined && this.dragTo !== null) {
      this.deck.seek(this.dragTo);
      this.dragTo = null;
    }
  }

  draw() {
    const box = prep(this.canvas);
    if (!box) return;
    const { ctx, w, h } = box;
    const deck = this.deck;
    ctx.fillStyle = '#0b0d0f';
    ctx.fillRect(0, 0, w, h);
    if (!deck.loaded || !deck.peaks) return;

    const { amp, bucket, count } = deck.peaks;
    const mid = h / 2;
    ctx.fillStyle = '#5c6470';
    for (let x = 0; x < w; x++) {
      const b0 = Math.floor((x / w) * count);
      const b1 = Math.max(b0 + 1, Math.floor(((x + 1) / w) * count));
      let peak = 0;
      for (let b = b0; b < Math.min(count, b1); b++) if (amp[b] > peak) peak = amp[b];
      ctx.fillRect(x, mid - peak * (mid - 1), 1, peak * (mid - 1) * 2);
    }

    const sx = (s) => (s / deck.frames) * w;

    if (deck.loop.on) {
      ctx.fillStyle = 'rgba(240,139,44,0.28)';
      ctx.fillRect(sx(deck.loop.start), 0, Math.max(1, sx(deck.loop.end) - sx(deck.loop.start)), h);
    }
    ctx.fillStyle = '#c3e64b';
    ctx.fillRect(sx(deck.cue), 0, 1, h);
    deck.hotcues.forEach((hc, i) => {
      if (!hc) return;
      ctx.fillStyle = HOTCUE_COLORS[i % HOTCUE_COLORS.length];
      ctx.fillRect(sx(hc.sample), h - 6, 3, 6);
    });

    // Played portion dimmed, matching Traktor's overview treatment.
    const px = sx(deck.position);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(px, 0, w - px, h);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(Math.round(px), 0, 2, h);
  }
}

/**
 * Beatgrid editor strip: shows the grid as tick marks with the tempo-zone
 * anchors as draggable handles, over a compressed waveform silhouette.
 */
export class GridStrip {
  constructor(canvas, deck) {
    this.canvas = canvas;
    this.deck = deck;
    this.onEdit = null;
    this.pxPerSec = 60;
    this.dragging = null;
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointercancel', () => (this.dragging = null));
  }

  geom() {
    const r = this.canvas.getBoundingClientRect();
    const deck = this.deck;
    const origin = deck.position - ((r.width * 0.5) / this.pxPerSec) * deck.sampleRate;
    return { r, origin, xAt: (s) => ((s - origin) / deck.sampleRate) * this.pxPerSec, sAt: (x) => origin + (x / this.pxPerSec) * deck.sampleRate };
  }

  hitAnchor(x) {
    const deck = this.deck;
    if (!deck.grid) return -1;
    const g = this.geom();
    for (let i = 0; i < deck.grid.anchors.length; i++) {
      if (Math.abs(g.xAt(deck.grid.anchors[i].sample) - x) < 9) return i;
    }
    return -1;
  }

  down(e) {
    const deck = this.deck;
    if (!deck.loaded || !deck.grid) return;
    const r = this.canvas.getBoundingClientRect();
    const g = this.geom();
    const x = e.clientX - r.left;
    const hit = this.hitAnchor(x);
    if (hit >= 0) {
      this.dragging = { index: hit };
    } else {
      // Empty space: drop a new tempo-zone marker here and grab it.
      deck.grid.addAnchor(g.sAt(x), deck.grid.bpmAt(g.sAt(x)));
      this.dragging = { index: this.nearestAnchorTo(g.sAt(x)), created: true };
    }
    this.canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
    this.draw();
    this.onEdit && this.onEdit();
  }

  move(e) {
    if (!this.dragging || !this.deck.grid) return;
    const g = this.geom();
    const r = this.canvas.getBoundingClientRect();
    this.deck.grid.moveAnchor(this.dragging.index, { sample: g.sAt(e.clientX - r.left) });
    this.draw();
    this.onEdit && this.onEdit();
  }

  nearestAnchorTo(sample) {
    const a = this.deck.grid.anchors;
    let best = -1;
    let bd = Infinity;
    a.forEach((x, i) => {
      const d = Math.abs(x.sample - sample);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  }

  up() {
    if (this.dragging && this.deck.grid) {
      const i = this.dragging.index;
      const a = this.deck.grid.anchors[i];
      if (a) this.deck.grid.moveAnchor(i, { sample: this.deck.grid.quantize(a.sample) });
      this.draw();
      this.onEdit && this.onEdit();
    }
    this.dragging = null;
  }

  draw() {
    const box = prep(this.canvas);
    if (!box) return;
    const { ctx, w, h } = box;
    const deck = this.deck;
    ctx.fillStyle = '#0a0c0e';
    ctx.fillRect(0, 0, w, h);
    if (!deck.loaded) return;

    const g = this.geom();
    const { lo, hi, bucket } = deck.peaks || { lo: null };
    if (lo) {
      const mid = h * 0.62;
      ctx.fillStyle = '#2c3a48';
      for (let x = 0; x < w; x++) {
        const b = Math.floor(g.sAt(x) / bucket);
        if (b < 0 || b >= lo.length) continue;
        const v = Math.max(lo[b], hi[b]);
        ctx.fillRect(x, mid - v * (h * 0.34), 1, v * (h * 0.34) * 2);
      }
    }

    if (deck.grid && deck.grid.ready) {
      const from = g.sAt(0);
      const to = g.sAt(w);
      let beat = Math.floor(deck.grid.beatAt(from));
      for (let guard = 0; guard < 6000; guard++, beat++) {
        const s = deck.grid.sampleAtBeat(beat);
        if (s > to) break;
        if (s < from) continue;
        const x = Math.round(g.xAt(s));
        const rel = ((Math.round(beat) - deck.grid.origin) % 4 + 4) % 4;
        ctx.fillStyle = rel === 0 ? 'rgba(195,230,75,0.85)' : 'rgba(255,255,255,0.22)';
        ctx.fillRect(x, rel === 0 ? 2 : 8, 1, rel === 0 ? 12 : 6);
      }
    }

    (deck.grid ? deck.grid.anchors : []).forEach((a, i) => {
      const x = Math.round(g.xAt(a.sample));
      ctx.fillStyle = '#f08b2c';
      ctx.fillRect(x - 1, 0, 2, h);
      ctx.fillStyle = '#1a1206';
      ctx.fillRect(x - 6, h - 14, 12, 12);
      ctx.fillStyle = '#f08b2c';
      ctx.font = '700 8px system-ui';
      ctx.fillText(String(i + 1), x - 3, h - 5);
    });

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(Math.round(w * 0.5), 0, 1, h);
  }
}
