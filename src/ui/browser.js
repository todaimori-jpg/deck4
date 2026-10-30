/**
 * Track browser: collection tree on the left, crate table on the right.
 *
 * Loading a track is a two-tap gesture because there is no drag onto a deck
 * with a finger on glass — first tap selects, then the deck chips appear in
 * that row where the filename normally sits.
 */

import { el } from './widgets.js';

function fmtLen(sec) {
  if (!sec) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function hueFor(bpm) {
  if (!bpm) return 210;
  return (Math.round(bpm) * 7) % 360;
}

export class BrowserView {
  constructor(app) {
    this.app = app;
    this.root = document.getElementById('browser');
    this.tree = document.getElementById('browserTree');
    this.list = document.getElementById('trackList');
    this.count = document.getElementById('trackCount');
    this.search = document.getElementById('searchBox');
    this.filter = 'all';
    this.selected = null;

    this.search.addEventListener('input', () => this.refresh());
    document.getElementById('importBtn').addEventListener('click', () => document.getElementById('filePick').click());
    document.getElementById('filePick').addEventListener('change', (e) => {
      this.app.importFiles(e.target.files);
      e.target.value = '';
    });

    this.buildTree();
    this.refresh();
  }

  buildTree() {
    const items = [
      { id: 'all', label: 'All Tracks' },
      { id: 'loaded', label: 'On Decks' },
      { id: 'recent', label: 'Recently Added' },
      { id: 'unanalysed', label: 'Needs Grid' },
    ];
    this.tree.innerHTML = '';
    this.tree.appendChild(
      el('div', { class: 'tree-item', style: 'color:#5b6068;letter-spacing:.12em;font-size:9px' }, [
        el('span', { text: 'DECK' }),
      ]),
    );
    for (const it of items) {
      const node = el('div', { class: 'tree-item' + (this.filter === it.id ? ' is-on' : ''), tabindex: '0' }, [
        el('span', { class: 'dot' }),
        el('span', { text: it.label }),
      ]);
      node.addEventListener('click', () => {
        this.filter = it.id;
        this.buildTree();
        this.refresh();
      });
      this.tree.appendChild(node);
    }
    this.tree.appendChild(el('div', { class: 'tree-sep' }));
    const wipe = el('div', { class: 'tree-item' }, [el('span', { class: 'dot', style: 'background:#e8523f' }), el('span', { text: 'Clear Library' })]);
    wipe.addEventListener('click', () => this.app.clearLibrary());
    this.tree.appendChild(wipe);
  }

  visible() {
    const q = this.search.value.trim().toLowerCase();
    const onDeck = new Set(this.app.decks.filter((d) => d.track).map((d) => d.track.id));
    let rows = this.app.library.tracks.slice();
    if (this.filter === 'loaded') rows = rows.filter((t) => onDeck.has(t.id));
    if (this.filter === 'recent') rows = rows.slice(-20).reverse();
    if (this.filter === 'unanalysed') rows = rows.filter((t) => !t.confidence || t.confidence < 0.25);
    if (q) {
      rows = rows.filter(
        (t) =>
          (t.title || '').toLowerCase().includes(q) ||
          (t.artist || '').toLowerCase().includes(q) ||
          (t.fileName || '').toLowerCase().includes(q),
      );
    }
    return rows;
  }

  refresh() {
    const rows = this.visible();
    const onDeck = new Map();
    this.app.decks.forEach((d) => {
      if (d.track) onDeck.set(d.track.id, d.letter);
    });
    this.count.textContent = `${this.app.library.tracks.length} track${this.app.library.tracks.length === 1 ? '' : 's'}`;
    this.list.innerHTML = '';

    if (!rows.length) {
      this.list.appendChild(
        el('div', { class: 'empty-lib' }, [
          this.app.library.tracks.length
            ? 'Nothing matches this filter.'
            : 'No tracks yet. Tap IMPORT FROM FILES and pick audio from the Files app, On My iPad, or a connected drive.',
        ]),
      );
      return;
    }

    rows.forEach((t, i) => {
      const chips = this.app.decks.map((d) => {
        const c = el('button', { class: 'chip', type: 'button', text: d.letter });
        c.addEventListener('click', (e) => {
          e.stopPropagation();
          this.app.loadTrack(t, d.index);
        });
        return c;
      });
      const nameCell =
        this.selected === t.id
          ? el('div', { class: 'chips' }, [el('span', { class: 'chips-lab', text: 'LOAD' }), ...chips])
          : el('span', { class: 'c-name', text: t.fileName || '' });

      const row = el('div', {
        class:
          'row' +
          (this.selected === t.id ? ' is-sel' : '') +
          (onDeck.has(t.id) ? ` is-loaded-${onDeck.get(t.id).toLowerCase()}` : ''),
      }, [
        el('span', { class: 'c-num', text: String(i + 1) }),
        el('span', {
          class: 'c-art',
          style: `background:linear-gradient(135deg,hsl(${hueFor(t.bpm)} 45% 32%),#14171a)`,
        }),
        el('span', { class: 'c-title', text: t.title || t.fileName || 'Untitled' }),
        el('span', { class: 'c-artist', text: t.artist || '—' }),
        el('span', { class: 'c-bpm', text: t.bpm ? t.bpm.toFixed(2) : '—' }),
        el('span', { class: 'c-key', text: t.key || '—' }),
        el('span', { class: 'c-len', text: fmtLen(t.duration) }),
        nameCell,
      ]);
      row.addEventListener('click', () => {
        this.selected = this.selected === t.id ? null : t.id;
        this.refresh();
      });
      this.list.appendChild(row);
    });
  }
}
