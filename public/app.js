// WordsExpire, a never-ending garden you can wander and zoom through.
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

// A few lilypads drift in the water. Hovering one reveals a note from the
// person who planted the pond, in their own hand. A small thing to find.
const LILYPADS = [
  { x: 470, y: -380, r: 124, note: 'i only dug this pond. everyone who comes is the gardener now.' },
  { x: -600, y: 200, r: 156, note: 'i sat with this idea for a long time, after rereading old texts i never answered.' },
  { x: 340, y: 560, r: 104, note: 'thank you for wandering this far. i hope you tend something here.' },
  { x: -360, y: -560, r: 138, note: 'whatever grows here is yours. i just set out the water and the first flowers.' },
];

// Faint, optional prompts to help past the blank page.
const PROMPTS = [
  'what did you never get to say?',
  'what are you carrying?',
  'what would you forgive?',
  'what are you grateful for?',
  'what do you hope for?',
  'what are you letting go of?',
  'who do you miss?',
];

const LIFESPAN_SECONDS = 604800; // 7 days; mirrors the Worker's decay window
const MIN_CHARS = 2; // a note needs at least a little
const MAX_CHARS = 280;
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
let flowerNodes = []; // { node, wx, wy } for the cursor-wave displacement
let koiSwimEls = []; // koi fish elements, for the ripples they leave

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
function fadeRgb(hex, aliveness) {
  const [r, g, b] = hexToRgb(hex);
  const t = (1 - clamp(aliveness, 0, 1)) * 0.7;
  return [
    Math.round(r + (WILTED[0] - r) * t),
    Math.round(g + (WILTED[1] - g) * t),
    Math.round(b + (WILTED[2] - b) * t),
  ];
}
function mixRgb(a, b, t) {
  return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
}
const rgbStr = (a) => `rgb(${a[0]}, ${a[1]}, ${a[2]})`;
function fadeColor(hex, aliveness) {
  return rgbStr(fadeRgb(hex, aliveness));
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

// "said to my father · in person", and so on, only from what was offered.
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

// How long a petal has left, and how often it's been renewed.
function petalLife(p) {
  const n = p.reactionCount || 0;
  const kept = n > 0 ? `kept alive ${n} ${n === 1 ? 'time' : 'times'}` : null;
  if (p.aliveness <= 0) {
    return kept ? `${kept} · now faded` : 'these words have faded';
  }
  const left = p.aliveness * LIFESPAN_SECONDS;
  let when;
  if (left >= 2 * 86400) when = `fades in about ${Math.round(left / 86400)} days`;
  else if (left >= 86400) when = 'fades in about a day';
  else if (left >= 2 * 3600) when = `fades in about ${Math.round(left / 3600)} hours`;
  else when = 'fades within the hour';
  return kept ? `${kept} · ${when}` : when;
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
  svg.appendChild(defs);

  // A soft warm glow behind the bloom, for a painterly, lit-from-within feel.
  const halo = makeEl('radialGradient', { id: `halo-${flower.id}` });
  halo.appendChild(makeEl('stop', { offset: '0%', 'stop-color': 'rgba(247,236,206,0.55)' }));
  halo.appendChild(makeEl('stop', { offset: '100%', 'stop-color': 'rgba(247,236,206,0)' }));
  defs.appendChild(halo);
  svg.appendChild(makeEl('circle', { cx, cy, r: 150, fill: `url(#halo-${flower.id})` }));

  // The glowing center.
  const heartGrad = makeEl('radialGradient', { id: `heart-${flower.id}` });
  heartGrad.appendChild(makeEl('stop', { offset: '0%', 'stop-color': '#f6ead0' }));
  heartGrad.appendChild(makeEl('stop', { offset: '55%', 'stop-color': '#e3cf9c' }));
  heartGrad.appendChild(makeEl('stop', { offset: '100%', 'stop-color': '#c9a86a' }));
  defs.appendChild(heartGrad);

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
      const base = fadeRgb(COLORS[petal.color] || COLORS.rose, petal.aliveness);
      const deep = mixRgb(base, [104, 78, 66], 0.42); // shaded base
      const light = mixRgb(base, [255, 251, 240], 0.55); // sunlit tip
      const len = 104 + seeded(petal.id, 1) * 26;

      // A gradient running base-to-tip gives each petal painterly dimension.
      const pg = makeEl('linearGradient', {
        id: `pg-${flower.id}-${i}`,
        gradientUnits: 'userSpaceOnUse',
        x1: 0,
        y1: 0,
        x2: 0,
        y2: -len,
      });
      pg.appendChild(makeEl('stop', { offset: '0%', 'stop-color': rgbStr(deep) }));
      pg.appendChild(makeEl('stop', { offset: '55%', 'stop-color': rgbStr(base) }));
      pg.appendChild(makeEl('stop', { offset: '100%', 'stop-color': rgbStr(light) }));
      defs.appendChild(pg);

      // A fuller petal sitting just behind, for depth.
      const a = petal.aliveness;
      const expired = petal.expired;
      // Wilting petals shrink toward their base; expired ones droop the most.
      const droop = Math.max(0.78, Math.min(1, 0.78 + a * 0.55));

      const under = makeEl('path', {
        d: petalPath(`${petal.id}-u`),
        fill: rgbStr(deep),
        transform: 'scale(1.13)',
      });
      under.style.opacity = expired ? '0.16' : String(0.32 * a + 0.12);

      const path = makeEl('path', {
        d: petalPath(petal.id),
        class: 'petal' + (expired ? ' expired' : ''),
        fill: `url(#pg-${flower.id}-${i})`,
        stroke: rgbStr(deep),
        'stroke-width': '0.75',
        'stroke-opacity': '0.35',
      });
      path.style.opacity = expired ? '0.5' : String(0.5 + 0.5 * a);
      path.style.transform = `scaleY(${droop})`;
      path.dataset.petalId = petal.id;

      // A truncated preview, kept upright. Expired petals blur, unreadable.
      const label = makeEl('text', {
        class: 'petal-label' + (expired ? ' faded' : ''),
        x: 0,
        y: -len * 0.52,
        'text-anchor': 'middle',
        transform: `rotate(${-angle} 0 ${-len * 0.52})`,
      });
      label.textContent = snippet(petal.text);
      label.style.opacity = expired ? '0.55' : String(0.32 + 0.4 * a);

      g.appendChild(under);
      g.appendChild(path);
      g.appendChild(label);
      // One handler per petal (on the group), so moving between the shape and
      // its label doesn't flicker the preview between different petals.
      g.classList.add('bloom-hit');
      g.addEventListener('click', (e) => {
        e.stopPropagation();
        if (moved) return;
        openReader(petal, path);
      });
      g.addEventListener('mouseenter', () => showPetalTip(petal, path));
      g.addEventListener('mouseleave', hideTip);
    } else {
      const path = makeEl('path', {
        d: petalPath(slotSeed),
        class: 'petal empty',
        fill: 'rgba(255,255,255,0.06)',
        stroke: 'rgba(58,51,44,0.16)',
        'stroke-width': '1',
        'stroke-dasharray': '3 7',
      });
      path.style.opacity = '0.7';
      g.appendChild(path);
      // An empty slot is also an invitation to leave a note.
      if (flower.hasRoom) {
        g.classList.add('bloom-hit');
        g.addEventListener('click', (e) => {
          e.stopPropagation();
          if (moved) return;
          openComposer(flower);
        });
      }
    }
    sway.appendChild(g);
  }

  // The heart of the flower: a lit core ringed with little stamens.
  const heart = makeEl('g', { class: 'heart' + (flower.hasRoom ? ' has-room' : '') });
  const coreR = 22 + seeded(flower.id, 9) * 4;
  heart.appendChild(makeEl('circle', { cx, cy, r: coreR + 6, fill: 'rgba(201,168,106,0.25)' }));
  const core = makeEl('circle', {
    class: 'heart-core',
    cx,
    cy,
    r: coreR,
    fill: `url(#heart-${flower.id})`,
    stroke: 'rgba(120,90,50,0.18)',
    'stroke-width': '1',
  });
  heart.appendChild(core);
  // A scatter of stamens for a lifelike center.
  const stamens = 16;
  for (let s = 0; s < stamens; s++) {
    const a = (Math.PI * 2 * s) / stamens + seeded(flower.id, s + 20);
    const rr = coreR * (0.35 + seeded(flower.id, s + 40) * 0.6);
    heart.appendChild(
      makeEl('circle', {
        cx: cx + Math.cos(a) * rr,
        cy: cy + Math.sin(a) * rr,
        r: 1.4 + seeded(flower.id, s + 60) * 1.4,
        fill: s % 3 === 0 ? 'rgba(150,108,52,0.6)' : 'rgba(252,245,224,0.85)',
      }),
    );
  }
  heart.classList.add('bloom-hit');
  heart.addEventListener('click', (e) => {
    e.stopPropagation();
    if (moved) return;
    openComposer(flower);
  });
  heart.addEventListener('mouseenter', () =>
    showTip(flower.hasRoom ? 'click to leave a note' : 'this flower is full', core),
  );
  heart.addEventListener('mouseleave', hideTip);
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

  const shadow = document.createElement('div');
  shadow.className = 'flower-shadow';
  node.appendChild(shadow);

  // The inner layer bobs on the water; the outer .flower carries the wave.
  const bob = document.createElement('div');
  bob.className = 'flower-bob';
  const r = seeded(flower.id, 11);
  bob.style.animationDuration = `${6 + r * 4}s`;
  bob.style.animationDelay = `${-r * 6}s`; // desync each flower's float
  bob.appendChild(drawFlowerSvg(flower));
  node.appendChild(bob);
  return node;
}

// A flat leaf with a notch, a few veins, sitting on the water.
function drawLilypadSvg(seed) {
  const svg = makeEl('svg', { viewBox: '0 0 100 100', role: 'img' });
  svg.setAttribute('aria-label', 'a lilypad');
  const defs = makeEl('defs');
  const grad = makeEl('radialGradient', { id: `lp-${seed}`, cx: '42%', cy: '36%' });
  grad.appendChild(makeEl('stop', { offset: '0%', 'stop-color': '#a4bb88' }));
  grad.appendChild(makeEl('stop', { offset: '100%', 'stop-color': '#6f8c5b' }));
  defs.appendChild(grad);
  svg.appendChild(defs);
  svg.appendChild(
    makeEl('path', {
      d: 'M50 50 L61.4 7.5 A44 44 0 1 1 81.1 18.9 Z',
      fill: `url(#lp-${seed})`,
      stroke: 'rgba(60,80,50,0.22)',
      'stroke-width': '1',
    }),
  );
  for (let i = 0; i < 4; i++) {
    const a = ((30 + i * 30) * Math.PI) / 180;
    svg.appendChild(
      makeEl('line', {
        x1: 50,
        y1: 50,
        x2: 50 + Math.cos(a) * 40,
        y2: 50 + Math.sin(a) * 40,
        stroke: 'rgba(60,80,50,0.16)',
        'stroke-width': '1',
      }),
    );
  }
  return svg;
}

function buildLilypadNode(lp, idx) {
  const node = document.createElement('div');
  node.className = 'lilypad';
  node.style.left = `${lp.x}px`;
  node.style.top = `${lp.y}px`;
  node.style.width = `${lp.r}px`;
  node.style.height = `${lp.r}px`;
  node.style.marginLeft = `${-lp.r / 2}px`;
  node.style.marginTop = `${-lp.r / 2}px`;

  const bob = document.createElement('div');
  bob.className = 'lilypad-bob';
  const r = seeded(`lily${idx}`, 3);
  bob.style.animationDuration = `${9 + r * 5}s`;
  bob.style.animationDelay = `${-r * 7}s`;
  const svg = drawLilypadSvg(`lily${idx}`);
  bob.appendChild(svg);
  bob.addEventListener('mouseenter', () => showTip(lp.note, svg, true));
  bob.addEventListener('mouseleave', hideTip);
  bob.addEventListener('click', (e) => {
    e.stopPropagation();
    if (moved) return;
    showTip(lp.note, svg, true);
    setTimeout(hideTip, 4500);
  });
  node.appendChild(bob);
  return node;
}

// A simple koi, seen from above, pointing right.
function drawKoiSvg(scale) {
  const svg = makeEl('svg', { viewBox: '0 0 64 32', role: 'img' });
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('width', String(64 * scale));
  svg.setAttribute('height', String(32 * scale));
  svg.appendChild(makeEl('path', { d: 'M14 16 L2 6 Q7 16 2 26 Z', fill: '#e3a06a' }));
  svg.appendChild(makeEl('ellipse', { cx: 38, cy: 16, rx: 24, ry: 9, fill: '#eaad73' }));
  svg.appendChild(makeEl('ellipse', { cx: 46, cy: 14, rx: 8, ry: 4.5, fill: '#f5ecdd' }));
  svg.appendChild(makeEl('circle', { cx: 30, cy: 17, r: 4.5, fill: '#d57f47' }));
  svg.appendChild(makeEl('path', { d: 'M34 8 Q40 2 44 8 Z', fill: '#e3a06a' }));
  return svg;
}

// A few koi glide beneath the surface, leaving ripples as they go.
function setupKoi() {
  if (reduceMotion) return;
  const world = $('#world');
  const koi = [
    { x: 220, y: 300, dur: 36, scale: 1, delay: -5 },
    { x: -420, y: -180, dur: 49, scale: 1.3, delay: -22 },
    { x: 520, y: -360, dur: 42, scale: 0.85, delay: -34 },
  ];
  koiSwimEls = [];
  for (const k of koi) {
    const node = document.createElement('div');
    node.className = 'koi';
    node.style.left = `${k.x}px`;
    node.style.top = `${k.y}px`;
    const swim = document.createElement('div');
    swim.className = 'koi-swim';
    swim.style.animationDuration = `${k.dur}s`;
    swim.style.animationDelay = `${k.delay}s`;
    swim.appendChild(drawKoiSvg(k.scale));
    node.appendChild(swim);
    world.appendChild(node);
    koiSwimEls.push(swim);
  }
}

// The koi stir the water as they pass.
function koiRipples() {
  if (!reduceMotion && !$('#viewport').hidden && koiSwimEls.length) {
    const el = koiSwimEls[Math.floor(Math.random() * koiSwimEls.length)];
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width * 0.7;
    const cy = r.top + r.height / 2;
    if (cx > 0 && cx < window.innerWidth && cy > 0 && cy < window.innerHeight) {
      makeRipple(cx, cy, Math.random() < 0.4);
    }
  }
  setTimeout(koiRipples, 1600 + Math.random() * 2200);
}

// Fireflies drift above the pond and glow at dusk and through the night.
function setupFireflies() {
  if (reduceMotion) return;
  const layer = $('#fireflies');
  const n = window.innerWidth < 560 ? 8 : 14; // fewer on phones
  for (let i = 0; i < n; i++) {
    const f = document.createElement('div');
    f.className = 'firefly';
    f.style.left = `${Math.random() * 100}vw`;
    f.style.top = `${Math.random() * 100}vh`;
    f.style.setProperty('--fx', `${Math.random() * 120 - 60}px`);
    f.style.setProperty('--fy', `${Math.random() * 120 - 60}px`);
    f.style.setProperty('--fd', `${16 + Math.random() * 16}s`);
    f.style.setProperty('--fg', `${2.6 + Math.random() * 3}s`);
    f.style.animationDelay = `${-Math.random() * 16}s, ${-Math.random() * 4}s`;
    layer.appendChild(f);
  }
}

// Now and then a brief, soft shower dimples the whole pond.
function rain() {
  let left = 26 + Math.floor(Math.random() * 20);
  const tick = () => {
    if (left-- <= 0 || $('#viewport').hidden) return;
    makeRipple(Math.random() * window.innerWidth, Math.random() * window.innerHeight, Math.random() < 0.5);
    setTimeout(tick, 170 + Math.random() * 230);
  };
  tick();
}
function rainSchedule() {
  setTimeout(
    () => {
      if (!reduceMotion && !$('#viewport').hidden && Math.random() < 0.5) rain();
      rainSchedule();
    },
    180000 + Math.random() * 240000,
  );
}

function drawFrogSvg() {
  const svg = makeEl('svg', { viewBox: '0 0 32 32' });
  svg.appendChild(makeEl('ellipse', { cx: 16, cy: 20, rx: 11, ry: 9, fill: '#7f9c66' }));
  svg.appendChild(makeEl('ellipse', { cx: 16, cy: 23.5, rx: 8, ry: 5, fill: '#90af75' }));
  svg.appendChild(makeEl('circle', { cx: 10, cy: 10, r: 5, fill: '#7f9c66' }));
  svg.appendChild(makeEl('circle', { cx: 22, cy: 10, r: 5, fill: '#7f9c66' }));
  svg.appendChild(makeEl('circle', { cx: 10, cy: 9.2, r: 3.2, fill: '#fbf7f1' }));
  svg.appendChild(makeEl('circle', { cx: 22, cy: 9.2, r: 3.2, fill: '#fbf7f1' }));
  svg.appendChild(makeEl('circle', { cx: 10.6, cy: 9.6, r: 1.5, fill: '#3a332c' }));
  svg.appendChild(makeEl('circle', { cx: 21.4, cy: 9.6, r: 1.5, fill: '#3a332c' }));
  svg.appendChild(makeEl('path', { d: 'M11 21 Q16 25 21 21', stroke: '#4f6347', 'stroke-width': '1.4', fill: 'none', 'stroke-linecap': 'round' }));
  return svg;
}

// Once in a while a frog hops onto a lilypad that's on screen, then leaves.
function frogVisit() {
  const pads = [...$('#world').querySelectorAll('.lilypad')].filter((pad) => {
    if (pad.querySelector('.lily-frog')) return false;
    const r = pad.getBoundingClientRect();
    return r.right > 0 && r.left < window.innerWidth && r.bottom > 0 && r.top < window.innerHeight;
  });
  if (!pads.length) return;
  const pad = pads[Math.floor(Math.random() * pads.length)];
  const frog = document.createElement('div');
  frog.className = 'lily-frog';
  frog.appendChild(drawFrogSvg());
  pad.appendChild(frog);
  setTimeout(() => {
    const r = frog.getBoundingClientRect();
    if (r.top > 0 && r.top < window.innerHeight) makeRipple(r.left + r.width / 2, r.bottom, false);
  }, 600);
  setTimeout(() => {
    frog.classList.add('leaving');
    setTimeout(() => frog.remove(), 520);
  }, 4000 + Math.random() * 3500);
}
function frogSchedule() {
  setTimeout(
    () => {
      if (!reduceMotion && !$('#viewport').hidden) frogVisit();
      frogSchedule();
    },
    60000 + Math.random() * 90000,
  );
}

function renderWorld() {
  const world = $('#world');
  // Remove only flowers and lilypads; the koi keep swimming across re-renders.
  world.querySelectorAll('.flower, .lilypad').forEach((n) => n.remove());
  flowerNodes = [];
  state.flowers.forEach((flower, i) => {
    const node = buildFlowerNode(flower, i);
    world.appendChild(node);
    const p = flowerPosition(i);
    flowerNodes.push({ node, wx: p.x, wy: p.y });
  });
  LILYPADS.forEach((lp, i) => world.appendChild(buildLilypadNode(lp, i)));
}

// ---------- the cursor wave ----------
// Where the cursor moves on the water, nearby flowers drift away from it and
// settle back, and a ripple spreads.

let wavePending = false;
let waveCx = 0;
let waveCy = 0;
let lastRippleX = -999;
let lastRippleY = -999;

function applyWave(cx, cy) {
  // No push within the bloom itself, so hovering or reading a flower leaves it
  // still; only the ring of water around it is disturbed as the cursor passes.
  const inner = 130 * view.scale;
  const band = 150; // width of the disturbed ring, in screen pixels
  const R = inner + band;
  for (const f of flowerNodes) {
    const sx = view.x + f.wx * view.scale;
    const sy = view.y + f.wy * view.scale;
    const dx = sx - cx;
    const dy = sy - cy;
    const d = Math.hypot(dx, dy);
    let tx = 0;
    let ty = 0;
    if (d > inner && d < R) {
      const t = (d - inner) / band; // 0..1 across the ring
      const push = Math.sin(t * Math.PI) * 18; // peaks mid-ring, zero at both edges
      tx = (dx / d) * push;
      ty = (dy / d) * push;
    }
    f.node.style.transform = `translate(${tx}px, ${ty}px)`;
  }
}

function requestWave(cx, cy) {
  if (reduceMotion) return;
  waveCx = cx;
  waveCy = cy;
  if (!wavePending) {
    wavePending = true;
    requestAnimationFrame(() => {
      wavePending = false;
      applyWave(waveCx, waveCy);
    });
  }
}

function settleWave() {
  for (const f of flowerNodes) f.node.style.transform = 'translate(0px, 0px)';
}

function makeRipple(x, y, big) {
  if (reduceMotion) return;
  const layer = $('#ripples');
  if (!layer || layer.childElementCount > 32) return;
  const r = document.createElement('div');
  r.className = big ? 'ripple ripple-big' : 'ripple';
  r.style.left = `${x}px`;
  r.style.top = `${y}px`;
  r.addEventListener('animationend', () => r.remove());
  layer.appendChild(r);
}

function cursorRipple(x, y) {
  if (Math.hypot(x - lastRippleX, y - lastRippleY) < 34) return;
  lastRippleX = x;
  lastRippleY = y;
  makeRipple(x, y, false);
}

// The pond stirs on its own, slowly: a larger, soft ripple now and then.
function ambientRipple() {
  if (!reduceMotion && !$('#viewport').hidden) {
    makeRipple(Math.random() * window.innerWidth, Math.random() * window.innerHeight, true);
  }
  setTimeout(ambientRipple, 2600 + Math.random() * 3200);
}

function setFlowers(list) {
  state.flowers = list || [];
  renderWorld();
}

// ---------- the view (pan / zoom) ----------

function applyView() {
  $('#world').style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  updateCompass();
}

// The world point currently at the center of the screen.
function viewCenterWorld() {
  return {
    x: (window.innerWidth / 2 - view.x) / view.scale,
    y: (window.innerHeight / 2 - view.y) / view.scale,
  };
}

function nearestFlowerIndex() {
  const c = viewCenterWorld();
  let best = -1;
  let bestDist = Infinity;
  state.flowers.forEach((_, i) => {
    const p = flowerPosition(i);
    const d = (p.x - c.x) ** 2 + (p.y - c.y) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  return best;
}

let compassTarget = -1;

// When no flower is on screen, point the way back to the nearest one.
function updateCompass() {
  const compass = $('#compass');
  if (!compass) return;
  if (!state.flowers.length) {
    compass.hidden = true;
    return;
  }
  const W = window.innerWidth;
  const H = window.innerHeight;
  const margin = 200 * view.scale; // a flower's reach
  const anyVisible = state.flowers.some((_, i) => {
    const p = flowerPosition(i);
    const sx = view.x + p.x * view.scale;
    const sy = view.y + p.y * view.scale;
    return sx > -margin && sx < W + margin && sy > -margin && sy < H + margin;
  });
  if (anyVisible) {
    compass.hidden = true;
    return;
  }
  compassTarget = nearestFlowerIndex();
  const p = flowerPosition(compassTarget);
  const c = viewCenterWorld();
  const ang = (Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI;
  $('#compassArrow').style.transform = `rotate(${ang}deg)`;
  compass.hidden = false;
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
  let lastT = 0;
  let pinchDist = 0;
  let velX = 0;
  let velY = 0;

  // After a flick, the pond keeps gliding and slows to rest.
  function glide() {
    const token = tweenToken;
    function step() {
      if (token !== tweenToken) return; // a new touch took over
      velX *= 0.93;
      velY *= 0.93;
      view.x += velX;
      view.y += velY;
      applyView();
      if (Math.hypot(velX, velY) > 0.35) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  vp.addEventListener('pointerdown', (e) => {
    tweenToken++; // stop any easing (or glide) the moment a hand touches the world
    settleWave(); // flowers shouldn't stay leaned while dragging the pond
    velX = 0;
    velY = 0;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = false;
    if (pointers.size === 1) {
      last = { x: e.clientX, y: e.clientY };
      lastT = performance.now();
    }
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
    // Note: no pointer capture, it would retarget the synthesized click away
    // from a petal, breaking tap-to-read. Events bubble to the viewport anyway.
  });

  vp.addEventListener('pointermove', (e) => {
    // Hovering (no button down): stir the water and nudge the flowers.
    if (pointers.size === 0) {
      requestWave(e.clientX, e.clientY);
      cursorRipple(e.clientX, e.clientY);
      return;
    }
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, dist / pinchDist);
      pinchDist = dist;
      velX = 0;
      velY = 0; // no fling out of a pinch
      moved = true;
      return;
    }

    const dx = e.clientX - last.x;
    const dy = e.clientY - last.y;
    if (Math.hypot(dx, dy) > 3) moved = true;
    const t = performance.now();
    const dt = Math.max(8, t - lastT);
    velX = (dx / dt) * 16; // carry the speed for the glide
    velY = (dy / dt) * 16;
    view.x += dx;
    view.y += dy;
    last = { x: e.clientX, y: e.clientY };
    lastT = t;
    applyView();
  });

  const release = (e) => {
    const wasSingle = pointers.size === 1;
    pointers.delete(e.pointerId);
    if (pointers.size === 1) {
      const p = [...pointers.values()][0];
      last = { x: p.x, y: p.y };
      lastT = performance.now();
    }
    pinchDist = 0;
    // Let go of a drag with speed behind it, and the pond glides on.
    if (pointers.size === 0 && wasSingle && moved && Math.hypot(velX, velY) > 1) glide();
  };
  vp.addEventListener('pointerup', release);
  vp.addEventListener('pointercancel', release);
  vp.addEventListener('pointerleave', settleWave);

  vp.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      // Pinch (and ctrl/cmd + wheel) zooms toward the cursor; a plain
      // two-finger scroll simply moves the garden.
      if (e.ctrlKey) {
        zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
      } else {
        tweenToken++;
        view.x -= e.deltaX;
        view.y -= e.deltaY;
        applyView();
      }
    },
    { passive: false },
  );

  window.addEventListener('resize', applyView);
}

// ---------- the hover tooltip ----------

function positionTip(el) {
  const tip = $('#petalTip');
  const r = el.getBoundingClientRect();
  tip.style.left = `${r.left + r.width / 2}px`;
  tip.style.top = `${r.top + r.height / 2}px`;
  tip.hidden = false;
}

function showTip(text, el, hand) {
  const tip = $('#petalTip');
  tip.classList.toggle('hand', !!hand);
  tip.textContent = text;
  positionTip(el);
}

// A petal's preview: the words (blurred if expired) and how long it has left.
function showPetalTip(petal, el) {
  const tip = $('#petalTip');
  tip.classList.remove('hand');
  tip.textContent = '';
  const words = document.createElement('div');
  words.textContent = petal.text;
  if (petal.expired) words.className = 'tip-faded';
  const life = document.createElement('div');
  life.className = 'tip-life';
  life.textContent = petalLife(petal);
  tip.append(words, life);
  positionTip(el);
}
function hideTip() {
  $('#petalTip').hidden = true;
}

// ---------- overlays open and close with a soft fade ----------

function openOverlay(el) {
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('open'));
}

function closeOverlay(el) {
  if (!el || el.hidden) return;
  el.classList.remove('open');
  if (el.id === 'reader' && location.pathname !== '/') history.replaceState(null, '', '/');
  if (reduceMotion) {
    el.hidden = true;
  } else {
    setTimeout(() => {
      el.hidden = true;
    }, 460);
  }
}

// ---------- comments (anonymous replies) ----------

function ago(sec) {
  const d = Math.floor(Date.now() / 1000) - sec;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

// Quietly flag a note or reply for the keeper to review.
async function reportTarget(type, id, btn) {
  const prev = btn.textContent;
  btn.disabled = true;
  await api('/api/report', { method: 'POST', body: JSON.stringify({ type, id }) }).catch(() => {});
  btn.textContent = 'thank you';
  setTimeout(() => {
    btn.textContent = prev;
    btn.disabled = false;
  }, 2600);
}

function commentEl(c) {
  const wrap = document.createElement('div');
  wrap.className = 'comment';
  const t = document.createElement('p');
  t.className = 'comment-text';
  t.textContent = c.text;
  const foot = document.createElement('div');
  foot.className = 'comment-foot';
  const m = document.createElement('span');
  m.className = 'comment-time';
  m.textContent = c.createdAt ? ago(c.createdAt) : 'just now';
  const rep = document.createElement('button');
  rep.type = 'button';
  rep.className = 'text-link comment-report';
  rep.textContent = 'report';
  rep.addEventListener('click', () => reportTarget('comment', c.id, rep));
  foot.append(m, rep);
  wrap.append(t, foot);
  return wrap;
}

function renderComments(list) {
  const el = $('#comments');
  el.textContent = '';
  for (const c of list) el.appendChild(commentEl(c));
}

function setRepliesSummary(n) {
  $('#repliesSummary').textContent = n > 0 ? `${n} ${n === 1 ? 'reply' : 'replies'}` : 'leave a reply';
}

async function loadComments(petalId) {
  renderComments([]);
  setRepliesSummary(0);
  const { ok, body } = await api(`/api/petals/${petalId}/comments`);
  if (ok && body.comments) renderComments(body.comments);
  setRepliesSummary($('#comments').childElementCount);
  $('#comments').scrollTop = $('#comments').scrollHeight;
}

async function submitComment(e) {
  e.preventDefault();
  const text = $('#commentText').value.trim();
  if (!text || !state.openPetalId) return;
  const btn = $('#commentBtn');
  btn.disabled = true;
  const { ok, body } = await api(`/api/petals/${state.openPetalId}/comments`, {
    method: 'POST',
    body: JSON.stringify({ text, website: $('#commentForm').elements.website.value }),
  });
  btn.disabled = false;
  if (!ok) {
    btn.textContent = body.message || 'not now';
    setTimeout(() => (btn.textContent = 'reply'), 2400);
    return;
  }
  $('#commentText').value = '';
  if (body.comment) {
    const el = $('#comments');
    el.appendChild(commentEl(body.comment));
    el.scrollTop = el.scrollHeight;
    setRepliesSummary(el.childElementCount);
  }
}

// ---------- reading a petal ----------

function openReader(petal, pathEl) {
  hideTip();
  state.openPetalId = petal.id;
  state.openPetalEl = pathEl;
  history.replaceState(null, '', `/p/${petal.id}`); // a shareable address for this note

  const img = $('#petalImage');
  if (petal.imageUrl) {
    img.src = petal.imageUrl;
    img.hidden = false;
  } else {
    img.hidden = true;
    img.removeAttribute('src');
  }

  $('#petalText').textContent = petal.text;
  $('#petalText').classList.toggle('faded', petal.expired);
  $('#petalFadedNote').hidden = !petal.expired;
  $('#petalExample').hidden = !petal.isExample;
  // An expired petal cannot be kept alive; hide the offer entirely.
  $('.keep').hidden = petal.expired;

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

  $('#petalLife').textContent = petalLife(petal);
  $('#petalLife').hidden = petal.expired; // the faded note already says it

  $('.keep').classList.remove('kept');
  $('#keepLabel').textContent = 'keep alive';
  $('#keepBtn').disabled = false;

  // Replies live with a living petal; a faded one keeps no conversation.
  const replies = $('#repliesWrap');
  if (petal.expired) {
    replies.hidden = true;
  } else {
    replies.hidden = false;
    replies.open = false; // tucked away until asked for
    $('#commentText').value = '';
    loadComments(petal.id);
  }

  openOverlay($('#reader'));
}

async function keepAlive(e) {
  if (e) e.preventDefault();
  if (!state.openPetalId) return;
  $('#keepBtn').disabled = true;

  const { ok, body } = await api(`/api/petals/${state.openPetalId}/react`, { method: 'POST' });
  if (!ok) {
    $('#keepLabel').textContent = body.message || 'not now';
    return;
  }

  $('.keep').classList.add('kept');
  $('#keepLabel').textContent = body.alreadyKept ? 'already kept alive' : 'renewed';
  $('#petalLife').textContent = petalLife(body.petal);
  $('#petalLife').hidden = false;
  if (!body.alreadyKept) playRenewFx();

  const petal = body.petal;
  const flower = state.flowers.find((f) => f.petals.some((p) => p.id === petal.id));
  if (flower) {
    const found = flower.petals.find((p) => p.id === petal.id);
    if (found) Object.assign(found, petal);
  }

  // The note is legible again now that it's been brought back.
  $('#petalText').classList.toggle('faded', petal.expired);
  $('#petalFadedNote').hidden = !petal.expired;

  // Un-wilt the petal and its label in place (no full-garden rebuild).
  const pathEl = state.openPetalEl;
  if (pathEl) {
    pathEl.classList.remove('expired', 'renewing');
    void pathEl.offsetWidth;
    pathEl.classList.add('renewing');
    pathEl.setAttribute('fill', fadeColor(COLORS[petal.color] || COLORS.rose, petal.aliveness));
    pathEl.style.opacity = String(0.5 + 0.5 * petal.aliveness);
    pathEl.style.transform = 'scaleY(1)';
    const label = pathEl.parentNode && pathEl.parentNode.querySelector('.petal-label');
    if (label) {
      label.classList.remove('faded');
      label.style.opacity = String(0.32 + 0.4 * petal.aliveness);
    }
  }

  // The petal updated in place above, so just close, no full-garden rebuild.
  // Give the sunlight-and-water animation room to finish before closing.
  setTimeout(() => {
    closeOverlay($('#reader'));
    if (!body.alreadyKept) maybeNudgeShare();
  }, body.alreadyKept ? 1100 : 1900);
}

// Plays the sunlight-and-water renewal once. Re-adding the class after a
// reflow restarts the animation on every keep-alive.
function playRenewFx() {
  const fx = $('#renewFx');
  fx.classList.remove('play');
  void fx.offsetWidth;
  fx.classList.add('play');
}

// ---------- leaving a petal ----------

// ---------- optional image ----------

let pendingImage = null; // a downscaled Blob awaiting upload with the next petal

// Shrink and re-encode in the browser so what we store stays small (and EXIF
// is stripped along the way).
async function downscaleImage(file, maxDim = 1280) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
  if (bmp.close) bmp.close();
  const toBlob = (type, q) => new Promise((res) => canvas.toBlob(res, type, q));
  return (await toBlob('image/webp', 0.82)) || (await toBlob('image/jpeg', 0.85));
}

function clearImage() {
  pendingImage = null;
  $('#composeImage').value = '';
  $('#imagePreview').hidden = true;
  $('#imageThumb').removeAttribute('src');
  $('#imagePick').hidden = false;
}

function setupImage() {
  $('#imagePick').addEventListener('click', () => $('#composeImage').click());
  $('#imageRemove').addEventListener('click', clearImage);
  $('#composeImage').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const blob = await downscaleImage(file);
      if (!blob) throw new Error('no blob');
      pendingImage = blob;
      $('#imageThumb').src = URL.createObjectURL(blob);
      $('#imagePreview').hidden = false;
      $('#imagePick').hidden = true;
      $('#details').open = true;
    } catch {
      pendingImage = null;
      const pick = $('#imagePick');
      pick.textContent = 'that image would not open';
      setTimeout(() => (pick.textContent = 'add an image'), 2600);
    }
  });
}

// Keep the counter and the "place it" button in step with what's typed.
function updateComposerState() {
  const len = $('#composeText').value.length;
  const trimmed = $('#composeText').value.trim().length;
  const counter = $('#counter');
  counter.hidden = false;
  counter.textContent = `${len} / ${MAX_CHARS}`;
  counter.classList.toggle('near', len > MAX_CHARS - 20);
  counter.classList.toggle('short', trimmed < MIN_CHARS);
  $('#placeBtn').disabled = trimmed < MIN_CHARS;
}

async function openComposer(flower) {
  let target = flower;
  if (!target || !target.hasRoom) {
    target = state.flowers.find((f) => f.hasRoom);
    if (!target) {
      // All full, let the garden grow a fresh one, then go to it.
      const { ok, body } = await api('/api/flowers');
      if (ok && body.flowers) setFlowers(body.flowers);
      target = state.flowers.find((f) => f.hasRoom);
    }
  }
  if (!target) return;

  state.composeFlowerId = target.id;
  focusFlower(target.id, 1.15);

  $('#composePrompt').textContent = PROMPTS[Math.floor(Math.random() * PROMPTS.length)];
  $('#composeText').value = '';
  $('#composeWhen').max = todayInputValue();
  $('#composeWhen').value = todayInputValue();
  $('#composeMedium').value = '';
  $('#composeDirection').value = '';
  $('#composeRelationship').value = '';
  $('#whomLabel').textContent = 'with whom?';
  clearImage();
  $('#details').open = false;
  $('#composeForm').hidden = false;
  $('#composeDone').hidden = true;
  updateComposerState(); // shows "0 / 280" and disables the button until there are words
  openOverlay($('#composer'));
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

  // If an image is attached, store it first and carry its key with the note.
  let imageId;
  if (pendingImage) {
    btn.textContent = 'placing…';
    const up = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': pendingImage.type },
      body: pendingImage,
    }).catch(() => null);
    if (!up || !up.ok) {
      btn.disabled = false;
      btn.textContent = 'the image would not attach';
      setTimeout(() => (btn.textContent = 'place it'), 2600);
      return;
    }
    imageId = (await up.json()).id;
  }

  const { ok, body } = await api(`/api/flowers/${flower.id}/petals`, {
    method: 'POST',
    body: JSON.stringify({
      text,
      website: $('#composeForm').elements.website.value,
      spokenAt,
      medium: $('#composeMedium').value || undefined,
      direction: $('#composeDirection').value || undefined,
      relationship: $('#composeRelationship').value || undefined,
      imageId,
    }),
  });

  if (!ok) {
    btn.disabled = false;
    btn.textContent = body.message || 'something held it back';
    setTimeout(() => (btn.textContent = 'place it'), 2600);
    return;
  }
  clearImage();

  $('#composeForm').hidden = true;
  $('#composeDone').hidden = false;
  // Offer the author a link back to their own note, and remember it locally.
  if (body.petal) {
    $('#shareNew').onclick = () => shareNote(body.petal.id, $('#shareNew'));
    saveMyNote(body.petal.id);
    flower.petals.push(body.petal);
  }
  flower.hasRoom = flower.petals.length < flower.maxPetals;

  setTimeout(async () => {
    closeOverlay($('#composer'));
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
    maybeNudgeShare();
  }, 4200);
}

// Share (or copy) a link straight to one note.
async function shareNote(id, btn) {
  const url = `${location.origin}/p/${id}`;
  const flash = (msg) => {
    if (!btn) return;
    const prev = btn.textContent;
    btn.textContent = msg;
    setTimeout(() => (btn.textContent = prev), 2200);
  };
  if (navigator.share) {
    try {
      await navigator.share({ title: 'A note on WordsExpire', url });
      return;
    } catch {
      /* cancelled; fall through to copy */
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    flash('link copied');
  } catch {
    flash(url);
  }
}

// Drift to a particular note by id, then open it.
function goToPetal(id) {
  let fi = -1;
  let petal = null;
  state.flowers.forEach((f, i) => {
    const p = f.petals.find((x) => x.id === id);
    if (p) {
      fi = i;
      petal = p;
    }
  });
  if (fi < 0) return false;
  const pos = flowerPosition(fi);
  focusOn(pos.x, pos.y, 1.05);
  setTimeout(() => {
    const el = $('#world').querySelector(`[data-petal-id="${id}"]`);
    openReader(petal, el);
  }, 800);
  return true;
}

// Drift to a random living note and open it.
function wanderToRandom() {
  const all = [];
  state.flowers.forEach((f) => f.petals.forEach((p) => all.push(p.id)));
  if (!all.length) return;
  goToPetal(all[Math.floor(Math.random() * all.length)]);
}

// The notes this browser has left, kept locally (no account).
function getMyNotes() {
  try {
    return JSON.parse(localStorage.getItem('we_my_notes') || '[]');
  } catch {
    return [];
  }
}
function saveMyNote(id) {
  const a = getMyNotes().filter((x) => x !== id);
  a.push(id);
  localStorage.setItem('we_my_notes', JSON.stringify(a.slice(-100)));
  const seen = getSeen();
  if (seen[id] === undefined) seen[id] = 0; // a fresh note starts unkept
  saveSeen(seen);
}

// How many times we last saw each of our notes kept alive, to notice when a
// stranger has tended one while we were away.
function getSeen() {
  try {
    return JSON.parse(localStorage.getItem('we_my_seen') || '{}');
  } catch {
    return {};
  }
}
function saveSeen(m) {
  localStorage.setItem('we_my_seen', JSON.stringify(m));
}

let welcomeTimer = 0;
function hideWelcome() {
  const w = $('#welcome');
  w.classList.remove('show');
  setTimeout(() => (w.hidden = true), 600);
}

// A gentle invite after planting or keeping a note: pass this small place to
// someone you love. Shown at most once per visit, and never while the
// "welcome back" toast is still up.
function maybeNudgeShare() {
  if (sessionStorage.getItem('we_invite_shown')) return;
  setTimeout(() => {
    if (sessionStorage.getItem('we_invite_shown')) return;
    const welcome = $('#welcome');
    if (welcome && !welcome.hidden && welcome.classList.contains('show')) return;
    sessionStorage.setItem('we_invite_shown', '1');
    const el = $('#shareInvite');
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add('show'));
  }, 1400);
}

function hideShareInvite() {
  const el = $('#shareInvite');
  el.classList.remove('show');
  setTimeout(() => (el.hidden = true), 700);
}

async function shareSite(btn) {
  const url = location.origin + '/';
  const flash = (msg) => {
    const prev = btn.textContent;
    btn.textContent = msg;
    setTimeout(() => (btn.textContent = prev), 2000);
  };
  if (navigator.share) {
    try {
      await navigator.share({ title: 'WordsExpire', text: 'a small place to leave a note.', url });
      hideShareInvite();
      return;
    } catch {
      /* cancelled; fall through to copy */
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    flash('link copied');
    setTimeout(hideShareInvite, 1200);
  } catch {
    flash(url);
  }
}

// On return, a quiet word about the notes you left: tended by a stranger, or
// fading and in need of you.
function welcomeBack() {
  const ids = getMyNotes();
  if (!ids.length) return;
  const byId = new Map();
  state.flowers.forEach((f) => f.petals.forEach((p) => byId.set(p.id, p)));
  const mine = ids.map((id) => byId.get(id)).filter(Boolean);
  if (!mine.length) return;

  const seen = getSeen();
  const tended = mine.filter((p) => (p.reactionCount || 0) > (seen[p.id] ?? 0));
  const fading = mine.filter((p) => !p.expired && p.aliveness > 0 && p.aliveness < 0.3);
  mine.forEach((p) => (seen[p.id] = p.reactionCount || 0)); // reset the baseline
  saveSeen(seen);

  let text = null;
  let target = null;
  if (tended.length) {
    target = tended[tended.length - 1];
    text = 'while you were away, someone kept your words alive.';
  } else if (fading.length) {
    target = fading[0];
    text = 'one of the notes you left is fading. it could use you.';
  }
  if (!target) return;

  $('#hint').classList.remove('show'); // don't crowd the top with the hint
  $('#welcomeText').textContent = text;
  $('#welcomeSnippet').textContent = `“${target.text.length > 70 ? `${target.text.slice(0, 70)}…` : target.text}”`;
  $('#welcomeGo').onclick = () => {
    hideWelcome();
    goToPetal(target.id);
  };
  const w = $('#welcome');
  w.hidden = false;
  requestAnimationFrame(() => w.classList.add('show'));
  clearTimeout(welcomeTimer);
  welcomeTimer = setTimeout(hideWelcome, 10000);
}

// ---------- overlays + chrome ----------

function wireOverlays() {
  document.querySelectorAll('[data-close]').forEach((b) =>
    b.addEventListener('click', () => closeOverlay(b.closest('.overlay'))),
  );
  document.querySelectorAll('.overlay').forEach((ov) =>
    ov.addEventListener('click', (e) => {
      if (e.target === ov) closeOverlay(ov);
    }),
  );
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeOverlay($('#reader'));
      closeOverlay($('#composer'));
      closeOverlay($('#about'));
      closeOverlay($('#book'));
    }
  });

  $('#aboutBtn').addEventListener('click', openAbout);
  $('#bookBtn').addEventListener('click', () => {
    closeOverlay($('#about'));
    openBook();
  });
  $('#leaveBtn').addEventListener('click', () => openComposer());
  $('#logo').addEventListener('click', () => focusOn(flowerPosition(0).x, flowerPosition(0).y, 1.0));
  $('#wanderBtn').addEventListener('click', wanderToRandom);
  $('#shareBtn').addEventListener('click', () => {
    if (state.openPetalId) shareNote(state.openPetalId, $('#shareBtn'));
  });
  $('#reportBtn').addEventListener('click', () => {
    if (state.openPetalId) reportTarget('petal', state.openPetalId, $('#reportBtn'));
  });
  $('#compass').addEventListener('click', () => {
    const i = compassTarget >= 0 ? compassTarget : nearestFlowerIndex();
    if (i < 0) return;
    const p = flowerPosition(i);
    focusOn(p.x, p.y, 1.0);
  });
  $('#welcomeClose').addEventListener('click', hideWelcome);
  $('#inviteShare').addEventListener('click', (e) => shareSite(e.currentTarget));
  $('#inviteLater').addEventListener('click', hideShareInvite);
  $('#keepBtn').addEventListener('click', keepAlive);
  $('#commentForm').addEventListener('submit', submitComment);
  $('#composeForm').addEventListener('submit', placePetal);
  $('#composeText').addEventListener('input', updateComposerState);
  setupImage();

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

// The notes this visitor has left, resolved against what's still in the pond.
function renderMine() {
  const el = $('#mine');
  el.textContent = '';
  const byId = new Map();
  state.flowers.forEach((f) => f.petals.forEach((p) => byId.set(p.id, p)));
  const mine = getMyNotes()
    .map((id) => byId.get(id))
    .filter(Boolean)
    .reverse(); // newest first
  if (!mine.length) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const head = document.createElement('p');
  head.className = 'mine-head';
  head.textContent = 'the notes you have left';
  el.appendChild(head);
  for (const p of mine) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'mine-row';
    const t = document.createElement('span');
    t.className = 'mine-text';
    t.textContent = p.text;
    const s = document.createElement('span');
    s.className = 'mine-status';
    s.textContent = p.expired ? 'faded' : p.aliveness < 0.38 ? 'fading' : '';
    row.append(t, s);
    row.addEventListener('click', () => {
      closeOverlay($('#about'));
      goToPetal(p.id);
    });
    el.appendChild(row);
  }
}

// The garden, in words: every living note as plain, readable text. Also the
// keyboard/screen-reader path into the otherwise spatial pond.
function openBook() {
  const list = $('#bookList');
  list.textContent = '';
  const living = [];
  state.flowers.forEach((f) => f.petals.forEach((p) => !p.expired && living.push(p)));
  living.sort((a, b) => b.createdAt - a.createdAt);
  if (!living.length) {
    const e = document.createElement('p');
    e.className = 'book-empty';
    e.textContent = 'the garden is quiet just now.';
    list.appendChild(e);
  }
  for (const p of living) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'book-note';
    const t = document.createElement('p');
    t.className = 'book-text';
    t.textContent = p.text;
    row.appendChild(t);
    const metaText = [p.isExample ? 'example' : null, contextLine(p) || null].filter(Boolean).join(' · ');
    if (metaText) {
      const m = document.createElement('p');
      m.className = 'book-meta';
      m.textContent = metaText;
      row.appendChild(m);
    }
    row.addEventListener('click', () => {
      closeOverlay($('#book'));
      goToPetal(p.id);
    });
    list.appendChild(row);
  }
  openOverlay($('#book'));
}

async function openAbout() {
  openOverlay($('#about'));
  renderMine();
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
  lines.push(
    `<p class="stat"><span class="n">${s.faded.toLocaleString()}</span> ${s.faded === 1 ? 'note has' : 'notes have'} faded<small>their words gone now, blurred for good</small></p>`,
  );
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
    // "begin" keeps its place in the layout from the start (invisible), so the
    // lines never shift when it arrives; it simply fades in last.
    setTimeout(() => begin.classList.add('show'), 600 + lines.length * 1900);

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
  const touch = window.matchMedia('(hover: none)').matches;
  hint.textContent = touch
    ? 'drag to wander · pinch to zoom · tap a flower'
    : 'drag or scroll to wander · pinch to zoom · touch a flower to leave a note';
  hint.hidden = false;
  hint.classList.add('show');
  setTimeout(() => hint.classList.remove('show'), 6000);
}

// ---------- ambient sound (a hidden, looping YouTube player) ----------

const SOUND_VIDEO = 'YZrdpuC8D6Y';
let ytPlayer = null;
let ytReady = false;
let soundOn = false;

function savedVolume() {
  const v = Number(localStorage.getItem('we_volume'));
  return Number.isFinite(v) && v >= 0 && v <= 100 ? v : 45;
}

window.onYouTubeIframeAPIReady = () => {
  ytPlayer = new YT.Player('yt', {
    videoId: SOUND_VIDEO,
    playerVars: {
      autoplay: 0,
      controls: 0,
      loop: 1,
      playlist: SOUND_VIDEO, // required for a single video to loop
      disablekb: 1,
      modestbranding: 1,
      playsinline: 1,
      rel: 0,
    },
    events: {
      onReady: () => {
        ytReady = true;
        ytPlayer.setVolume(savedVolume());
        if (soundOn) ytPlayer.playVideo();
      },
      onStateChange: (e) => {
        if (e.data === YT.PlayerState.ENDED && soundOn) ytPlayer.playVideo();
      },
      onError: () => {
        soundOn = false;
        $('#sound').classList.remove('on');
        const btn = $('#soundToggle');
        btn.classList.remove('on');
        btn.disabled = true;
        btn.setAttribute('aria-label', 'sound unavailable');
      },
    },
  });
};

function setSound(on) {
  soundOn = on;
  $('#sound').classList.toggle('on', on);
  const btn = $('#soundToggle');
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  if (!ytReady) return; // onReady will start it if soundOn
  if (on) ytPlayer.playVideo();
  else ytPlayer.pauseVideo();
}

function setupSound() {
  const vol = $('#soundVol');
  vol.value = String(savedVolume());
  $('#soundToggle').addEventListener('click', () => setSound(!soundOn));
  vol.addEventListener('input', () => {
    const v = Number(vol.value);
    localStorage.setItem('we_volume', String(v));
    if (ytReady) ytPlayer.setVolume(v);
  });
  // Load the YouTube IFrame API once.
  if (window.YT && window.YT.Player) {
    window.onYouTubeIframeAPIReady();
  } else {
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
  }
}

// ---------- start ----------

// ---------- time of day ----------
// The pond's water drifts with the local clock: night, dawn, day, dusk.
const WATER_PHASES = [
  { h: 0, c: ['#c6d1d3', '#aabbc1', '#8ca2aa', '#76909b'] }, // night
  { h: 6, c: ['#f4ebdc', '#e8e0cf', '#d3d8c8', '#c0cdbe'] }, // dawn
  { h: 13, c: ['#e9efe4', '#d2e0d4', '#b9cec3', '#a6c0b5'] }, // day
  { h: 19, c: ['#f2e3cf', '#e2cdbd', '#c7b6ad', '#ad9ea0'] }, // dusk
  { h: 24, c: ['#c6d1d3', '#aabbc1', '#8ca2aa', '#76909b'] }, // back to night
];
function applyWater() {
  const d = new Date();
  const h = d.getHours() + d.getMinutes() / 60;
  let lo = WATER_PHASES[0];
  let hi = WATER_PHASES[WATER_PHASES.length - 1];
  for (let i = 0; i < WATER_PHASES.length - 1; i++) {
    if (h >= WATER_PHASES[i].h && h <= WATER_PHASES[i + 1].h) {
      lo = WATER_PHASES[i];
      hi = WATER_PHASES[i + 1];
      break;
    }
  }
  const span = hi.h - lo.h;
  const t = span ? (h - lo.h) / span : 0;
  const root = document.documentElement;
  for (let i = 0; i < 4; i++) {
    root.style.setProperty(`--w${i}`, rgbStr(mixRgb(hexToRgb(lo.c[i]), hexToRgb(hi.c[i]), t)));
  }
  // Fireflies come out at dusk and stay through the night.
  const fireflies = $('#fireflies');
  if (fireflies) fireflies.classList.toggle('lit', h >= 18 || h < 6);
}

// The quieter, secondary controls appear only once the visitor begins.
let chromeRevealed = false;
function revealChrome() {
  if (chromeRevealed) return;
  chromeRevealed = true;
  for (const sel of ['#logo', '#aboutBtn', '#wanderBtn', '#credit', '#sound']) $(sel).hidden = false;
}

async function start() {
  applyWater();
  setInterval(applyWater, 300000); // drift the water every few minutes
  wireWorld();
  wireOverlays();
  await runOnboarding();

  const { ok, body } = await api('/api/flowers');
  if (ok && body.flowers) setFlowers(body.flowers);
  setupKoi();
  setupFireflies();
  applyWater(); // re-evaluate now that the fireflies layer exists

  // On arrival, show only the pond and the one invitation. The rest of the
  // chrome fades in once the visitor first reaches into the garden.
  $('#viewport').hidden = false;
  $('#leaveBtn').hidden = false;
  setupSound();
  ['pointerdown', 'wheel', 'keydown', 'touchstart'].forEach((ev) =>
    window.addEventListener(ev, revealChrome, { once: true, passive: true }),
  );
  setTimeout(revealChrome, 6000);

  // A shared link drifts straight to its note; otherwise we arrive at the first.
  if (!openFromPath()) {
    const first = state.flowers[0];
    const pos = first ? flowerPosition(0) : { x: 0, y: 0 };
    view.scale = 0.55;
    view.x = window.innerWidth / 2 - pos.x * view.scale;
    view.y = window.innerHeight / 2 - pos.y * view.scale;
    applyView();
    focusOn(pos.x, pos.y, 1.0, 1600);
  }

  showHint();
  ambientRipple();
  koiRipples();
  rainSchedule();
  frogSchedule();
  setTimeout(welcomeBack, 2800);
}

// If the URL points at one note (/p/:id) or flower (/f/:id), go there.
function openFromPath() {
  const m = location.pathname.match(/^\/(p|f)\/([\w-]+)/);
  if (!m) return false;
  const [, kind, id] = m;

  if (kind === 'f') {
    const i = state.flowers.findIndex((f) => f.id === id);
    if (i < 0) return false;
    const pos = flowerPosition(i);
    view.scale = 1;
    view.x = window.innerWidth / 2 - pos.x;
    view.y = window.innerHeight / 2 - pos.y;
    applyView();
    return true;
  }

  let fi = -1;
  let petal = null;
  state.flowers.forEach((f, i) => {
    const found = f.petals.find((p) => p.id === id);
    if (found) {
      fi = i;
      petal = found;
    }
  });
  if (fi < 0) {
    history.replaceState(null, '', '/'); // the note has drifted away
    return false;
  }
  const pos = flowerPosition(fi);
  view.scale = 1.05;
  view.x = window.innerWidth / 2 - pos.x * view.scale;
  view.y = window.innerHeight / 2 - pos.y * view.scale;
  applyView();
  setTimeout(() => {
    const el = $('#world').querySelector(`[data-petal-id="${id}"]`);
    openReader(petal, el);
  }, 650);
  return true;
}

start();
