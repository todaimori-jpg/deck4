/**
 * Touch widgets. Everything is pointer-driven with capture, because on iPad a
 * knob has to survive the finger sliding off its own 26 px hit target. A tap
 * with no movement resets a knob, since there is no double-click on touch.
 */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style') node.setAttribute('style', v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

function bindDrag(node, onStart, onMove, onEnd) {
  let state = null;
  node.addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      try {
        node.setPointerCapture(e.pointerId);
      } catch {
        /* capture is best-effort */
      }
      state = Object.assign({ id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0 }, onStart ? onStart(e) || {} : {});
      e.preventDefault();
    },
    { passive: false },
  );
  node.addEventListener(
    'pointermove',
    (e) => {
      if (!state || e.pointerId !== state.id) return;
      state.moved = Math.max(state.moved, Math.abs(e.clientX - state.x) + Math.abs(e.clientY - state.y));
      onMove(e, state);
      e.preventDefault();
    },
    { passive: false },
  );
  const finish = (e) => {
    if (!state || e.pointerId !== state.id) return;
    const s = state;
    state = null;
    if (onEnd) onEnd(e, s);
  };
  node.addEventListener('pointerup', finish);
  node.addEventListener('pointercancel', finish);
}

export function makeKnob({
  label = '',
  min = 0,
  max = 1,
  value = 0.5,
  color = '#cfd4da',
  sensitivity = 0.006,
  onChange,
  reset,
  format,
} = {}) {
  let v = clamp(value, min, max);
  const ind = el('i');
  const dial = el('div', { class: 'knob-dial' }, [ind]);
  const lab = el('span', { class: 'knob-lab', text: label });
  const root = el('div', { class: 'knob', 'aria-label': label }, [dial, lab]);
  root.style.setProperty('--knob-color', color);

  function paint() {
    const t = (v - min) / (max - min || 1);
    dial.style.setProperty('--knob-arc', `${(t * 280).toFixed(1)}deg`);
    ind.style.transform = `rotate(${(-140 + t * 280).toFixed(1)}deg)`;
    lab.textContent = format ? `${label} ${format(v)}` : label;
  }

  function set(next, silent = false) {
    const c = clamp(next, min, max);
    if (c === v) return;
    v = c;
    paint();
    if (!silent && onChange) onChange(v);
  }

  bindDrag(
    root,
    () => ({ v0: v }),
    (e, s) => set(s.v0 + (s.y - e.clientY) * (max - min) * sensitivity),
    (e, s) => {
      if (s.moved < 4 && reset !== undefined) {
        set(reset);
      }
    },
  );
  paint();

  return {
    root,
    set,
    paint,
    get value() {
      return v;
    },
  };
}

export function makeVFader({ min = 0, max = 1, value = 1, onChange, bipolar = false } = {}) {
  let v = clamp(value, min, max);
  const cap = el('div', { class: 'cap' });
  const root = el('div', { class: 'fader-v' + (bipolar ? ' is-mid' : '') }, [cap]);

  function paint() {
    const t = (v - min) / (max - min || 1);
    cap.style.top = `calc((1 - ${t}) * (100% - 15px) + 7.5px)`;
  }

  function setFromY(clientY) {
    const r = root.getBoundingClientRect();
    const t = 1 - clamp((clientY - r.top - 7.5) / Math.max(1, r.height - 15), 0, 1);
    set(min + t * (max - min));
  }

  function set(next, silent = false) {
    const c = clamp(next, min, max);
    if (c === v) return;
    v = c;
    paint();
    if (!silent && onChange) onChange(v);
  }

  bindDrag(root, (e) => setFromY(e.clientY), (e) => setFromY(e.clientY));
  paint();

  return {
    root,
    set,
    paint,
    get value() {
      return v;
    },
  };
}

export function makeHFader({ min = 0, max = 1, value = 0.5, onChange } = {}) {
  let v = clamp(value, min, max);
  const cap = el('div', { class: 'cap' });
  const root = el('div', { class: 'fader-h' }, [cap]);

  function paint() {
    const t = (v - min) / (max - min || 1);
    cap.style.left = `calc(4px + ${t} * (100% - 8px))`;
  }

  function setFromX(clientX) {
    const r = root.getBoundingClientRect();
    const t = clamp((clientX - r.left - 4) / Math.max(1, r.width - 8), 0, 1);
    set(min + t * (max - min));
  }

  function set(next, silent = false) {
    const c = clamp(next, min, max);
    if (c === v) return;
    v = c;
    paint();
    if (!silent && onChange) onChange(v);
  }

  bindDrag(root, (e) => setFromX(e.clientX), (e) => setFromX(e.clientX));
  paint();

  return {
    root,
    set,
    paint,
    get value() {
      return v;
    },
  };
}

/** Press-to-toggle button that also reports how long it was held. */
export function makeButton({ label, className = '', onClick, onHold, title, value = false } = {}) {
  const root = el('button', { class: `btn ${className}`, type: 'button', text: label, title: title || '' });
  let downAt = 0;
  let held = false;
  let timer = null;

  root.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    downAt = performance.now();
    held = false;
    if (onHold) {
      timer = setTimeout(() => {
        held = true;
        onHold();
      }, 420);
    }
  });
  const up = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (held) return;
    onClick && onClick(!valueRef(), root);
  };
  const valueRef = () => root.classList.contains('is-on');
  root.addEventListener('pointerup', up);
  root.addEventListener('pointercancel', () => {
    if (timer) clearTimeout(timer);
    timer = null;
  });
  if (value) root.classList.add('is-on');

  return {
    root,
    setOn(on) {
      root.classList.toggle('is-on', !!on);
    },
    get on() {
      return root.classList.contains('is-on');
    },
    setLabel(t) {
      root.textContent = t;
    },
  };
}

/** Momentary pad: fires on touch-down, and again on lift for scratch-style use. */
export function makePad({ label, onPress, onRelease, className = '' } = {}) {
  const root = el('div', { class: `pad ${className}`, text: label });
  let active = false;
  root.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try {
      root.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    active = true;
    onPress && onPress();
  });
  const up = () => {
    if (!active) return;
    active = false;
    onRelease && onRelease();
  };
  root.addEventListener('pointerup', up);
  root.addEventListener('pointercancel', up);
  return {
    root,
    setClass(c) {
      root.className = `pad ${c}`;
    },
    setLabel(t) {
      root.textContent = t;
    },
  };
}

export function makeCycler({ options, index = 0, className = 'btn mini', onChange, render } = {}) {
  let i = index;
  const root = el('button', { class: className, type: 'button' });
  const paint = () => {
    root.textContent = render ? render(options[i]) : String(options[i]);
  };
  root.addEventListener('click', (e) => {
    e.preventDefault();
    i = (i + 1) % options.length;
    paint();
    onChange && onChange(options[i], i);
  });
  paint();
  return {
    root,
    set(next) {
      const at = options.indexOf(next);
      if (at >= 0) i = at;
      paint();
    },
    get value() {
      return options[i];
    },
  };
}
