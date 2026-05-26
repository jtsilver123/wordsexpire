// WordsExpire — a never-ending garden you can wander and zoom through.
// No framework, no build step. Just gentle DOM and a little arithmetic.

const COLORS = {
  rose: '#d9a6a0',
  sage: '#a9b89a',
  lavender: '#b8aecc',
  gold: '#d9c99e',
  sky: '#a6b8c7',
};
const WILTED = [185, 178, 168]; // warm gray a fading petal drifts toward

// How a note's context reads back, gently, in the reading card.
const RELATIONSHIP_LABEL = {
  wife: 'my wife', husband: 'my husband', partner: 'my partner',
  mother: 'my mother', father: 'my father', daughter: 'my daughter', son: 'my son',
  sister: 'my sister', brother: 'my brother', grandmother: 'my grandmother', grandfather: 'my grandfather',
  friend: 'a friend', stranger: 'a stranger', myself: 'myself', someone_else: 'someone else',
};
const MEDIUM_PHRASE = {
  in_person: 'in person', text: 'by text', call: 'by phone', video: 'over video',
  email: 'by email', letter: 'in a letter', other: '',
};

const SVG_NS = 'http://www.w3.org/2000/svg';
const GOLDEN = Math.PI * (3 - Math.sqrt(5)); // the angle seeds settle into
const SPACING = 560; // world distance between successive flowers
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const state = {
  flowers: [],
  openPetalId: null,
  openPetalEl: null,
  composeFlowerId: null,
};

// The world transform: where we are and how close.
const view = { x: 0, y: 0, scale: 1 };
let tweenToken = 0;
let moved = false; // did the last gesture drag, rather than tap?

// ---------- tiny helpers ----------

const $ = (sel) => document.querySelector(sel);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const lerp = (a, b, t) => a + (b - a) * t;
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

// A small, stable pseudo-random number in [0,1) from a string seed,
// so each flower and petal keeps the same gentle imperfections.
function seeded(seed, salt = 0) {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Blend a petal's color toward warm gray as it loses aliveness.
function fadeColor(hex, aliveness) {
  const [r, g, b] = hexToRgb(hex);
  const t = (1 - clamp(aliveness, 0, 1)) * 0.7;
  const mix = (c, w) => Math.round(c + (w - c) * t);
  return `rgb(${mix(r, WILTED[0])}, ${mix(g, WILTED[1])}, ${mix(b, WILTED[2])})`;
}

function isBackdated(petal) {
  return petal.spokenAt && petal.createdAt - petal.spokenAt > 72000; // ~20 hours
}

function formatSpoken(epochSeconds) {
  return new Date(epochSeconds * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function todayInputValue() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// "said to my father · in person", and so on — only from what was offered.
function contextLine(p) {
  const parts = [];
  const rel = RELATIONSHIP_LABEL[p.relationship];
  if (p.direction === 'gave') parts.push(rel ? `said to ${rel}` : 'I said it');
  else if (p.direction === 'received') parts.push(rel ? `heard from ${rel}` : 'it was said to me');
  else if (rel) parts.push(`with ${rel}`);
  const med = MEDIUM_PHRASE[p.medium];
  if (med) parts.push(med);
  return parts.join(' · ');
}

function snippet(text) {
  const s = text.trim().replace(/\s+/g, ' ');
  return s.length > 13 ? `${s.slice(0, 13).trimEnd()}…` : s;
}

async function api(path, options) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  let body = {};
  try {
    body = await res.json();
  } catch {
    /* empty bodies are fine */
  }
  return { ok: res.ok, status: res.status, body };
}

// ---------- placing flowers in the world ----------

// A phyllotaxis spiral: flowers settle outward the way seeds do in a head,
// evenly spaced and never repeating, so the field can grow without end.
function flowerPosition(index) {
  const r = SPACING * Math.sqrt(index);
  const a = index * GOLDEN;
  return { x: Math.cos(a) * r, y: Math.sin(a) * r };
}

// ---------- drawing a flower ----------

function makeEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

// One petal path in local coordinates: base at origin, reaching upward.
function petalPath(seed) {
  const len = 104 + seeded(seed, 1) * 26;
  const wide = 30 + seeded(seed, 2) * 12;
  const leanL = wide * (0.85 + seeded(seed, 3) * 0.3);
  const leanR = wide * (0.85 + seeded(seed, 4) * 0.3);
  const tip = len * (0.92 + seeded(seed, 5) * 0.12);
  return (
    `M 0 0 ` +
    `C ${-leanL} ${-len * 0.32}, ${-wide} ${-len * 0.74}, 0 ${-tip} ` +
    `C ${wide} ${-len * 0.74}, ${leanR} ${-len * 0.32}, 0 0 Z`
  );
}

function drawFlowerSvg(flower) {
  const size = 400;
  const cx = size / 2;
  const cy = size / 2;
  const svg = makeEl('svg', { viewBox: `0 0 ${size} ${size}`, role: 'img' });
  svg.setAttribute('aria-label', 'a flower holding small notes');

  const defs = makeEl('defs');
  const grad = makeEl('radialGradient', { id: `heart-${flower.id}` });
  grad.appendChild(makeEl('stop', { offset: '0%', 'stop-color': '#efe2c8' }));
  grad.appendChild(makeEl('stop', { offset: '100%', 'stop-color': '#d9c99e' }));
  defs.appendChild(grad);
  svg.appendChild(defs);

  const sway = makeEl('g', { class: 'flower-sway' });
  svg.appendChild(sway);

  const slots = flower.maxPetals;
  const petals = flower.petals;

  for (let i = 0; i < slots; i++) {
    const petal = petals[i];
    const slotSeed = `${flower.id}-${i}`;
    const angle = (360 / slots) * i + (seeded(slotSeed, 7) - 0.5) * 10;
    const g = makeEl('g', { transform: `translate(${cx} ${cy}) rotate(${angle})` });

    if (petal) {
      const path = makeEl('path', {
        d: petalPath(petal.id),
        class: 'petal',
        fill: fadeColor(COLORS[petal.color] || COLORS.rose, petal.aliveness),
        stroke: 'rgba(58,51,44,0.10)',
        'stroke-width': '1',
      });
      path.style.opacity = petal.isGhost ? '0.14' : String(0.4 + 0.6 * petal.aliveness);
      path.dataset.petalId = petal.id;

      // A truncated preview, kept upright; the whole note waits on hover or touch.
      const len = 104 + seeded(petal.id, 1) * 26;
      const label = makeEl('text', {
        class: 'petal-label',
        x: 0,
        y: -len * 0.52,
        'text-anchor': 'middle',
        transform: `rotate(${-angle} 0 ${-len * 0.52})`,
      });
      label.textContent = snippet(petal.text);
      label.style.opacity = petal.isGhost ? '0.18' : String(0.35 + 0.45 * petal.aliveness);

      const open = (e) => {
        e.stopPropagation();
        if (moved) return;
        openReader(petal, path);
      };
      for (const el of [path, label]) {
        el.addEventListener('click', open);
        el.addEventListener('mouseenter', () => showTip(petal.text, path));
        el.addEventListener('mouseleave', hideTip);
        el.style.cursor = 'pointer';
      }
      g.appendChild(path);
      g.appendChild(label);
    } else {
      const path = makeEl('path', {
        d: petalPath(slotSeed),
        class: 'petal empty',
        fill: 'none',
        stroke: 'rgba(58,51,44,0.14)',
        'stroke-width': '1',
        'stroke-dasharray': '3 6',
      });
      path.style.opacity = '0.6';
      g.appendChild(path);
    }
    sway.appendChild(g);
  }

  // The heart of the flower — touch it to leave a note.
  const heart = makeEl('g', { class: 'heart' + (flower.hasRoom ? ' has-room' : '') });
  const core = makeEl('circle', {
    class: 'heart-core',
    cx,
    cy,
    r: 26 + seeded(flower.id, 9) * 4,
    fill: `url(#heart-${flower.id})`,
    stroke: 'rgba(58,51,44,0.08)',
    'stroke-width': '1',
  });
  heart.style.cursor = 'pointer';
  heart.addEventListener('click', (e) => {
    e.stopPropagation();
    if (moved) return;
    openComposer(flower);
  });
  heart.appendChild(core);
  svg.appendChild(heart);

  return svg;
}

function buildFlowerNode(flower, index) {
  const node = document.createElement('div');
  node.className = 'flower';
  node.dataset.flowerId = flower.id;
  const pos = flowerPosition(index);
  node.style.left = `${pos.x}px`;
  node.style.top = `${pos.y}px`;

  if (flower.theme) {
    const theme = document.createElement('p');
    theme.className = 'flower-theme';
    theme.textContent = flower.theme;
    node.appendChild(theme);
  }
  node.appendChild(drawFlowerSvg(flower));
  return node;
}

function renderWorld() {
  const world = $('#world');
  world.innerHTML = '';
  state.flowers.forEach((flower, i) => world.appendChild(buildFlowerNode(flower, i)));
}

function setFlowers(list) {
  state.flowers = list || [];
  renderWorld();
}

// ---------- the view (pan / zoom) ----------

function applyView() {
  $('#world').style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
}

function focusOn(worldX, worldY, scale, ms = 900) {
  const target = {
    scale,
    x: window.innerWidth / 2 - worldX * scale,
    y: window.innerHeight / 2 - worldY * scale,
  };
  if (reduceMotion || ms === 0) {
    Object.assign(view, target);
    applyView();
    return;
  }
  const start = { ...view };
  const token = ++tweenToken;
  const t0 = performance.now();
  function step(t) {
    if (token !== tweenToken) return; // a newer move (or a drag) took over
    const k = clamp((t - t0) / ms, 0, 1);
    const e = easeInOut(k);
    view.scale = lerp(start.scale, target.scale, e);
    view.x = lerp(start.x, target.x, e);
    view.y = lerp(start.y, target.y, e);
    applyView();
    if (k < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function focusFlower(flowerId, scale = 1.05) {
  const i = state.flowers.findIndex((f) => f.id === flowerId);
  if (i < 0) return;
  const pos = flowerPosition(i);
  focusOn(pos.x, pos.y, scale);
}

function zoomAt(cx, cy, factor) {
  tweenToken++; // cancel any tween
  const newScale = clamp(view.scale * factor, 0.15, 3.2);
  const k = newScale / view.scale;
  view.x = cx - (cx - view.x) * k;
  view.y = cy - (cy - view.y) * k;
  view.scale = newScale;
  applyView();
}

function wireWorld() {
  const vp = $('#viewport');
  const pointers = new Map();
  let last = { x: 0, y: 0 };
  let pinchDist = 0;

  vp.addEventListener('pointerdown', (e) => {
    tweenToken++; // stop any easing the moment a hand touches the world
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = false;
    if (pointers.size === 1) last = { x: e.clientX, y: e.clientY };
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
    // Note: no pointer capture — it would retarget the synthesized click away
    // from a petal, breaking tap-to-read. Events bubble to the viewport anyway.
  });

  vp.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, dist / pinchDist);
      pinchDist = dist;
      moved = true;
      return;
    }

    const dx = e.clientX - last.x;
    const dy = e.clientY - last.y;
    if (Math.hypot(dx, dy) > 3) moved = true;
    view.x += dx;
    view.y += dy;
    last = { x: e.clientX, y: e.clientY };
    applyView();
  });

  const release = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size === 1) {
      const p = [...pointers.values()][0];
      last = { x: p.x, y: p.y };
    }
    pinchDist = 0;
  };
  vp.addEventListener('pointerup', release);
  vp.addEventListener('pointercancel', release);

  vp.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
    },
    { passive: false },
  );

  window.addEventListener('resize', applyView);
}

// ---------- the hover tooltip ----------

function showTip(text, el) {
  const tip = $('#petalTip');
  tip.textContent = text;
  const r = el.getBoundingClientRect();
  tip.style.left = `${r.left + r.width / 2}px`;
  tip.style.top = `${r.top + r.height / 2}px`;
  tip.hidden = false;
}
function hideTip() {
  $('#petalTip').hidden = true;
}

// ---------- reading a petal ----------

function openReader(petal, pathEl) {
  hideTip();
  state.openPetalId = petal.id;
  state.openPetalEl = pathEl;
  $('#petalText').textContent = petal.text;

  const context = contextLine(petal);
  const ctxEl = $('#petalContext');
  ctxEl.textContent = context;
  ctxEl.hidden = !context;

  const spoken = $('#petalSpoken');
  if (isBackdated(petal)) {
    spoken.textContent = `spoken · ${formatSpoken(petal.spokenAt)}`;
    spoken.hidden = false;
  } else {
    spoken.hidden = true;
  }

  $('.keep').classList.remove('kept');
  $('#keepLabel').textContent = 'keep alive';
  $('#keepBtn').disabled = false;
  $('#reader').hidden = false;
}

async function keepAlive() {
  if (!state.openPetalId) return;
  $('#keepBtn').disabled = true;

  const { ok, body } = await api(`/api/petals/${state.openPetalId}/react`, { method: 'POST' });
  if (!ok) {
    $('#keepLabel').textContent = body.message || 'not now';
    return;
  }

  $('.keep').classList.add('kept');
  $('#keepLabel').textContent = body.alreadyKept ? 'already kept alive' : 'renewed';

  const petal = body.petal;
  const flower = state.flowers.find((f) => f.petals.some((p) => p.id === petal.id));
  if (flower) {
    const found = flower.petals.find((p) => p.id === petal.id);
    if (found) Object.assign(found, petal);
  }
  if (state.openPetalEl) {
    state.openPetalEl.classList.add('renewing');
    state.openPetalEl.setAttribute('fill', fadeColor(COLORS[petal.color] || COLORS.rose, petal.aliveness));
    state.openPetalEl.style.opacity = String(0.4 + 0.6 * petal.aliveness);
  }

  setTimeout(() => {
    $('#reader').hidden = true;
    renderWorld();
  }, 1100);
}

// ---------- leaving a petal ----------

async function openComposer(flower) {
  let target = flower;
  if (!target || !target.hasRoom) {
    target = state.flowers.find((f) => f.hasRoom);
    if (!target) {
      // All full — let the garden grow a fresh one, then go to it.
      const { ok, body } = await api('/api/flowers');
      if (ok && body.flowers) setFlowers(body.flowers);
      target = state.flowers.find((f) => f.hasRoom);
    }
  }
  if (!target) return;

  state.composeFlowerId = target.id;
  focusFlower(target.id, 1.15);

  $('#composeText').value = '';
  $('#composeWhen').max = todayInputValue();
  $('#composeWhen').value = todayInputValue();
  $('#composeMedium').value = '';
  $('#composeDirection').value = '';
  $('#composeRelationship').value = '';
  $('#whomLabel').textContent = 'with whom?';
  $('#details').open = false;
  $('#composeForm').hidden = false;
  $('#composeDone').hidden = true;
  $('#counter').hidden = true;
  $('#placeBtn').disabled = false;
  $('#composer').hidden = false;
  setTimeout(() => $('#composeText').focus(), 420);
}

async function placePetal(e) {
  e.preventDefault();
  const text = $('#composeText').value.trim();
  if (!text) return;
  const flower = state.flowers.find((f) => f.id === state.composeFlowerId);
  if (!flower) return;

  const whenValue = $('#composeWhen').value;
  let spokenAt = whenValue ? Math.floor(new Date(`${whenValue}T00:00:00`).getTime() / 1000) : Math.floor(Date.now() / 1000);
  if (!Number.isFinite(spokenAt)) spokenAt = Math.floor(Date.now() / 1000);

  const btn = $('#placeBtn');
  btn.disabled = true;

  const { ok, body } = await api(`/api/flowers/${flower.id}/petals`, {
    method: 'POST',
    body: JSON.stringify({
      text,
      website: $('#composeForm').elements.website.value,
      spokenAt,
      medium: $('#composeMedium').value || undefined,
      direction: $('#composeDirection').value || undefined,
      relationship: $('#composeRelationship').value || undefined,
    }),
  });

  if (!ok) {
    btn.disabled = false;
    btn.textContent = body.message || 'something held it back';
    setTimeout(() => (btn.textContent = 'place it'), 2600);
    return;
  }

  $('#composeForm').hidden = true;
  $('#composeDone').hidden = false;

  if (body.petal) flower.petals.push(body.petal);
  flower.hasRoom = flower.petals.length < flower.maxPetals;

  setTimeout(async () => {
    $('#composer').hidden = true;
    // If this flower just filled, let the garden grow a fresh one for the next note.
    if (!flower.hasRoom) {
      const res = await api('/api/flowers');
      if (res.ok && res.body.flowers) setFlowers(res.body.flowers);
    } else {
      renderWorld();
    }
    focusFlower(flower.id, 1.05);
    const fresh = $('#world').querySelector(`[data-petal-id="${body.petal && body.petal.id}"]`);
    if (fresh) fresh.classList.add('blooming');
  }, 2000);
}

// ---------- overlays + chrome ----------

function wireOverlays() {
  document.querySelectorAll('[data-close]').forEach((b) =>
    b.addEventListener('click', () => {
      const overlay = b.closest('.overlay');
      if (overlay) overlay.hidden = true;
    }),
  );
  document.querySelectorAll('.overlay').forEach((ov) =>
    ov.addEventListener('click', (e) => {
      if (e.target === ov) ov.hidden = true;
    }),
  );
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $('#reader').hidden = true;
      $('#composer').hidden = true;
      $('#about').hidden = true;
    }
  });

  $('#aboutBtn').addEventListener('click', openAbout);
  $('#keepBtn').addEventListener('click', keepAlive);
  $('#composeForm').addEventListener('submit', placePetal);
  $('#composeText').addEventListener('input', (e) => {
    const left = 280 - e.target.value.length;
    const counter = $('#counter');
    counter.hidden = left > 40;
    if (!counter.hidden) counter.textContent = `${left}`;
  });

  // "with whom?" softens to "to" or "from" once a direction is chosen.
  $('#composeDirection').addEventListener('change', (e) => {
    const v = e.target.value;
    $('#whomLabel').textContent = v === 'gave' ? 'to whom?' : v === 'received' ? 'from whom?' : 'with whom?';
  });
}

// ---------- the garden's weather (community stats) ----------

function plural(n, one, many) {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

async function openAbout() {
  $('#about').hidden = false;
  const el = $('#stats');
  el.innerHTML = '<p class="stat">listening to the garden…</p>';
  const { ok, body } = await api('/api/stats');
  if (!ok || !body.stats) {
    el.innerHTML = '<p class="stat">the garden is quiet just now.</p>';
    return;
  }
  const s = body.stats;
  const lines = [];
  lines.push(
    `<p class="stat"><span class="n">${plural(s.petalsAlive, 'note', 'notes')}</span> are open in the garden right now<small>across ${plural(s.flowers, 'flower', 'flowers')}</small></p>`,
  );
  if (s.keptAlive > 0) {
    lines.push(
      `<p class="stat"><span class="n">${plural(s.keptAlive, 'time', 'times')}</span> a note has been kept alive<small>by hands their authors will never meet</small></p>`,
    );
  }
  if (s.faded > 0) {
    lines.push(`<p class="stat"><span class="n">${plural(s.faded, 'note has', 'notes have')}</span> quietly faded</p>`);
  }
  if (s.oldestSpokenAt) {
    const year = new Date(s.oldestSpokenAt * 1000).getFullYear();
    lines.push(`<p class="stat">the oldest words still here were spoken in <span class="n">${year}</span></p>`);
  }
  el.innerHTML = lines.join('');
}

// ---------- onboarding (first visit only) ----------

function runOnboarding() {
  return new Promise((resolve) => {
    if (localStorage.getItem('we_seen_onboarding')) return resolve();

    const overlay = $('#onboarding');
    overlay.hidden = false;
    const lines = [...overlay.querySelectorAll('.line')];
    const begin = $('#begin');

    lines.forEach((line, i) => setTimeout(() => line.classList.add('show'), 600 + i * 1900));
    setTimeout(() => (begin.hidden = false), 600 + lines.length * 1900);

    begin.addEventListener('click', () => {
      localStorage.setItem('we_seen_onboarding', '1');
      overlay.style.transition = 'opacity 1000ms ease';
      overlay.style.opacity = '0';
      setTimeout(() => {
        overlay.hidden = true;
        resolve();
      }, 1000);
    });
  });
}

function showHint() {
  const hint = $('#hint');
  hint.textContent = 'drag to wander · scroll to zoom · touch a flower to leave a note';
  hint.hidden = false;
  hint.classList.add('show');
  setTimeout(() => hint.classList.remove('show'), 6000);
}

// ---------- start ----------

async function start() {
  wireWorld();
  wireOverlays();
  await runOnboarding();

  const { ok, body } = await api('/api/flowers');
  if (ok && body.flowers) setFlowers(body.flowers);

  $('#viewport').hidden = false;
  $('#aboutBtn').hidden = false;

  // Arrive gently: start pulled back, then ease in toward the first flower.
  const first = state.flowers[0];
  const pos = first ? flowerPosition(0) : { x: 0, y: 0 };
  view.scale = 0.55;
  view.x = window.innerWidth / 2 - pos.x * view.scale;
  view.y = window.innerHeight / 2 - pos.y * view.scale;
  applyView();
  focusOn(pos.x, pos.y, 1.0, 1600);

  showHint();
}

start();
