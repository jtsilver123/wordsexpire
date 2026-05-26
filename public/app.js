// WordsExpire — the garden, drawn and tended in the browser.
// No framework, no build step. Just gentle DOM.

const COLORS = {
  rose: '#d9a6a0',
  sage: '#a9b89a',
  lavender: '#b8aecc',
  gold: '#d9c99e',
  sky: '#a6b8c7',
};
const WILTED = [185, 178, 168]; // warm gray a fading petal drifts toward

const SVG_NS = 'http://www.w3.org/2000/svg';

const state = {
  flowers: [],
  index: 0,
  openPetalId: null,
};

// ---------- tiny helpers ----------

const $ = (sel) => document.querySelector(sel);

// A small, stable pseudo-random number in [0,1) from a string seed,
// so each petal keeps the same gentle imperfections across renders.
function seeded(seed, salt = 0) {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h = (h >>> 0) / 4294967295;
  return h;
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Blend a petal's color toward warm gray as it loses aliveness.
function fadeColor(hex, aliveness) {
  const [r, g, b] = hexToRgb(hex);
  const t = (1 - Math.max(0, Math.min(1, aliveness))) * 0.7; // up to ~70% desaturated
  const mix = (c, w) => Math.round(c + (w - c) * t);
  return `rgb(${mix(r, WILTED[0])}, ${mix(g, WILTED[1])}, ${mix(b, WILTED[2])})`;
}

// Has this note's words been carried from an earlier day than it was placed?
// We only surface the date when it reaches meaningfully back in time.
function isBackdated(petal) {
  return petal.spokenAt && petal.createdAt - petal.spokenAt > 72000; // ~20 hours
}

function formatSpoken(epochSeconds) {
  const d = new Date(epochSeconds * 1000);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

function todayInputValue() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let body = {};
  try {
    body = await res.json();
  } catch {
    /* empty bodies are fine */
  }
  return { ok: res.ok, status: res.status, body };
}

// ---------- drawing a flower ----------

// One petal path in local coordinates: base at origin, reaching upward,
// with a little asymmetry so nothing looks machined.
function petalPath(seed) {
  const len = 104 + seeded(seed, 1) * 26; // length of the petal
  const wide = 30 + seeded(seed, 2) * 12; // half-width at the belly
  const leanL = wide * (0.85 + seeded(seed, 3) * 0.3);
  const leanR = wide * (0.85 + seeded(seed, 4) * 0.3);
  const tip = len * (0.92 + seeded(seed, 5) * 0.12);
  return (
    `M 0 0 ` +
    `C ${-leanL} ${-len * 0.32}, ${-wide} ${-len * 0.74}, 0 ${-tip} ` +
    `C ${wide} ${-len * 0.74}, ${leanR} ${-len * 0.32}, 0 0 Z`
  );
}

function makeEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function drawFlower(flower) {
  const size = 400;
  const cx = size / 2;
  const cy = size / 2;
  const svg = makeEl('svg', { viewBox: `0 0 ${size} ${size}`, role: 'img' });
  svg.setAttribute('aria-label', 'a flower holding small notes');

  const sway = makeEl('g', { class: 'flower-sway' });
  svg.appendChild(sway);

  const slots = flower.maxPetals;
  const petals = flower.petals;

  for (let i = 0; i < slots; i++) {
    const petal = petals[i];
    const slotSeed = `${flower.id}-${i}`;
    const angle = (360 / slots) * i + (seeded(slotSeed, 7) - 0.5) * 10; // gentle jitter
    const g = makeEl('g', {
      transform: `translate(${cx} ${cy}) rotate(${angle})`,
    });

    if (petal) {
      const path = makeEl('path', {
        d: petalPath(petal.id),
        class: 'petal',
        fill: fadeColor(COLORS[petal.color] || COLORS.rose, petal.aliveness),
        stroke: 'rgba(58,51,44,0.10)',
        'stroke-width': '1',
      });
      // Aliveness shows as fullness: fresh petals are present, faded ones recede.
      path.style.opacity = petal.isGhost ? '0.14' : String(0.4 + 0.6 * petal.aliveness);
      path.dataset.petalId = petal.id;
      path.addEventListener('click', (e) => {
        e.stopPropagation();
        openReader(petal, path);
      });
      g.appendChild(path);
    } else {
      // An empty slot: a faint outline, a held breath.
      const path = makeEl('path', {
        d: petalPath(slotSeed),
        class: 'petal empty',
        fill: 'none',
        stroke: 'rgba(58,51,44,0.14)',
        'stroke-width': '1',
        'stroke-dasharray': '3 6',
      });
      path.style.opacity = '0.6';
      if (flower.hasRoom) {
        path.style.cursor = 'pointer';
        path.classList.remove('empty');
        path.addEventListener('click', (e) => {
          e.stopPropagation();
          openComposer();
        });
      }
      g.appendChild(path);
    }
    sway.appendChild(g);
  }

  // The heart of the flower — where a new note begins.
  const heart = makeEl('g', { class: 'heart' + (flower.hasRoom ? ' has-room' : '') });
  const grad = makeEl('radialGradient', { id: `heart-${flower.id}` });
  grad.appendChild(makeEl('stop', { offset: '0%', 'stop-color': '#efe2c8' }));
  grad.appendChild(makeEl('stop', { offset: '100%', 'stop-color': '#d9c99e' }));
  const defs = makeEl('defs');
  defs.appendChild(grad);
  svg.appendChild(defs);
  const core = makeEl('circle', {
    class: 'heart-core',
    cx,
    cy,
    r: 26 + seeded(flower.id, 9) * 4,
    fill: `url(#heart-${flower.id})`,
    stroke: 'rgba(58,51,44,0.08)',
    'stroke-width': '1',
  });
  heart.appendChild(core);
  if (flower.hasRoom) {
    heart.addEventListener('click', openComposer);
  }
  svg.appendChild(heart);

  return svg;
}

// ---------- rendering the stage ----------

function render() {
  const flower = state.flowers[state.index];
  const holder = $('#flowerHolder');
  holder.innerHTML = '';

  if (!flower) {
    $('#theme').textContent = '';
    $('#hint').textContent = 'The garden is quiet just now.';
    return;
  }

  $('#theme').textContent = flower.theme || '';
  holder.appendChild(drawFlower(flower));

  if (flower.petals.length === 0) {
    $('#hint').textContent = 'This flower waits for its first word.';
  } else if (flower.hasRoom) {
    $('#hint').textContent = 'touch a petal to read it · touch the center to leave one';
  } else {
    $('#hint').textContent = 'this flower is full — find another';
  }

  const many = state.flowers.length > 1;
  $('#navPrev').hidden = !many;
  $('#navNext').hidden = !many;
}

// ---------- reading a petal ----------

function openReader(petal, pathEl) {
  state.openPetalId = petal.id;
  state.openPetalEl = pathEl;
  $('#petalText').textContent = petal.text;

  const spoken = $('#petalSpoken');
  if (isBackdated(petal)) {
    spoken.textContent = `spoken · ${formatSpoken(petal.spokenAt)}`;
    spoken.hidden = false;
  } else {
    spoken.hidden = true;
  }

  const keep = $('.keep');
  keep.classList.remove('kept');
  $('#keepLabel').textContent = 'keep alive';
  $('#keepBtn').disabled = false;
  show($('#reader'));
}

async function keepAlive() {
  if (!state.openPetalId) return;
  const btn = $('#keepBtn');
  btn.disabled = true;

  const { ok, body } = await api(`/api/petals/${state.openPetalId}/react`, { method: 'POST' });
  if (!ok) {
    $('#keepLabel').textContent = body.message || 'not now';
    return;
  }

  // The petal glows and settles, a little renewed.
  $('.keep').classList.add('kept');
  $('#keepLabel').textContent = body.alreadyKept ? 'already kept alive' : 'renewed';

  const petal = body.petal;
  const flower = state.flowers[state.index];
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
    hide($('#reader'));
    render();
  }, 1100);
}

// ---------- leaving a petal ----------

function openComposer() {
  const flower = state.flowers[state.index];
  if (!flower || !flower.hasRoom) return;
  $('#composeText').value = '';
  const when = $('#composeWhen');
  when.max = todayInputValue(); // never forward in time
  when.value = todayInputValue(); // defaults to today
  $('#composeForm').hidden = false;
  $('#composeDone').hidden = true;
  $('#counter').hidden = true;
  $('#placeBtn').disabled = false;
  show($('#composer'));
  setTimeout(() => $('#composeText').focus(), 400);
}

async function placePetal(e) {
  e.preventDefault();
  const text = $('#composeText').value.trim();
  if (!text) return;
  const honeypot = $('#composeForm').elements.website.value;

  // Turn the chosen day into seconds. An empty or future date falls back to now.
  const whenValue = $('#composeWhen').value;
  let spokenAt = whenValue ? Math.floor(new Date(`${whenValue}T00:00:00`).getTime() / 1000) : Math.floor(Date.now() / 1000);
  if (!Number.isFinite(spokenAt)) spokenAt = Math.floor(Date.now() / 1000);

  const btn = $('#placeBtn');
  btn.disabled = true;

  const flower = state.flowers[state.index];
  const { ok, body } = await api(`/api/flowers/${flower.id}/petals`, {
    method: 'POST',
    body: JSON.stringify({ text, website: honeypot, spokenAt }),
  });

  if (!ok) {
    btn.disabled = false;
    btn.textContent = body.message || 'something held it back';
    setTimeout(() => (btn.textContent = 'place it'), 2600);
    return;
  }

  // "Thank you for that." — then the view closes and the petal blooms.
  $('#composeForm').hidden = true;
  $('#composeDone').hidden = false;

  if (body.petal) flower.petals.push(body.petal);
  flower.hasRoom = flower.petals.length < flower.maxPetals;

  setTimeout(() => {
    hide($('#composer'));
    render();
    // Let the freshest petal bloom in.
    const fresh = $('#flowerHolder').querySelector(`[data-petal-id="${body.petal && body.petal.id}"]`);
    if (fresh) fresh.classList.add('blooming');
  }, 2000);
}

// ---------- overlays ----------

function show(el) {
  el.hidden = false;
}
function hide(el) {
  el.hidden = true;
  if (el.id === 'reader') {
    state.openPetalId = null;
    state.openPetalEl = null;
  }
}

function wireOverlays() {
  document.querySelectorAll('[data-close]').forEach((b) =>
    b.addEventListener('click', () => {
      hide($('#reader'));
      hide($('#composer'));
    }),
  );
  document.querySelectorAll('.overlay').forEach((ov) =>
    ov.addEventListener('click', (e) => {
      if (e.target === ov) hide(ov);
    }),
  );
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hide($('#reader'));
      hide($('#composer'));
    }
    if (!$('#reader').hidden) return;
    if (!$('#composer').hidden) return;
    if (e.key === 'ArrowLeft') goTo(state.index - 1);
    if (e.key === 'ArrowRight') goTo(state.index + 1);
  });

  $('#keepBtn').addEventListener('click', keepAlive);
  $('#composeForm').addEventListener('submit', placePetal);
  $('#composeText').addEventListener('input', (e) => {
    const left = 280 - e.target.value.length;
    const counter = $('#counter');
    if (left <= 40) {
      counter.hidden = false;
      counter.textContent = `${left}`;
    } else {
      counter.hidden = true;
    }
  });

  $('#navPrev').addEventListener('click', () => goTo(state.index - 1));
  $('#navNext').addEventListener('click', () => goTo(state.index + 1));
}

function goTo(i) {
  const n = state.flowers.length;
  if (n === 0) return;
  state.index = (i + n) % n;
  render();
}

// ---------- onboarding (first visit only) ----------

function runOnboarding() {
  return new Promise((resolve) => {
    const seen = localStorage.getItem('we_seen_onboarding');
    if (seen) return resolve();

    const overlay = $('#onboarding');
    overlay.hidden = false;
    const lines = [...overlay.querySelectorAll('.line')];
    const begin = $('#begin');

    lines.forEach((line, i) => {
      setTimeout(() => line.classList.add('show'), 600 + i * 1900);
    });
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

// ---------- start ----------

async function start() {
  wireOverlays();
  await runOnboarding();

  const { ok, body } = await api('/api/flowers');
  if (ok && body.flowers) state.flowers = body.flowers;

  $('#stage').hidden = false;
  render();
}

start();
