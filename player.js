/*
 * player.js: one sketch page of the portfolio.
 * Same engine as the standalone animator (zentangle-core.js), but no colour features:
 * the artwork always shows as ink on paper. Visitors can't upload files here.
 */

const SITE = window.SITE || {};
const INK = '#1b1a17', PAPER = '#f4efe4';            // fixed palette: the artwork's own look
const MODE_ORDER = ['vertex', 'magnet', 'melt', 'shatter', 'lens', 'wind', 'morph', 'draw', 'ink', 'scan', 'grow', 'redraw'];
const LOOP = { draw: 9, melt: 11, shatter: 7.5, morph: 12, ink: 11, scan: 7, grow: 8, redraw: 12 };

const HINTS = {
  vertex: 'Every vertex of the drawing wanders on Perlin noise; shared edges stay joined.',
  magnet: 'Move your mouse (or finger) over the drawing: lines get pushed aside and spring back.',
  melt: 'The ink slides down in drips, faster towards the bottom, then un-melts.',
  shatter: 'The drawing cracks along noise lines; the pieces drift apart and come back. Noise scale = number of pieces.',
  lens: 'A magnifying bulge follows your mouse, or wanders by itself.',
  wind: 'Gusts sweep across, bending the lines one after another.',
  morph: 'Blends into another sketch from this collection, and back.',
  draw: 'Watch it being drawn: the pen traces every line, then fills it in.',
  ink: 'The drawing soaks into the paper from scattered blots of ink.',
  scan: 'A glowing scanline sweeps across, drawing everything it passes.',
  grow: 'The drawing grows outward from a seed with tendril-like edges.',
  redraw: 'Drawn, dissolved, drawn again: a continuous loop.',
};

// ---- page state ----
let Z = null, list = [], idx = -1;
let time = 0, paused = false, dirty = true, seed = 1;
let pointerInside = false;
const pointer = { x: 0, y: 0, down: false };
const perf = { sum: 0, n: 0, last: 0 };
const parsedCache = new Map();                        // slug → parsed sketch (for Morph targets)
const ui = {};

// Settings carry over when moving between sketches (kept for this browser tab only).
const state = Object.assign({
  mode: SITE.defaultMode || 'draw', speed: 1, amount: 0.6, noiseScale: 3, octaves: 2, order: 'center',
  magnetKind: 'repel', radius: 0.15, spring: 0.6, lensRadius: 0.2, morphSlug: null,
  glow: false, glowAmt: 0.6, echo: false, echoAmt: 0.7, kaleido: false, wedges: 8, grain: false, grainAmt: 0.5,
}, loadSettings());
if (!MODE_ORDER.includes(state.mode)) state.mode = 'draw';

function loadSettings() {
  try { return JSON.parse(sessionStorage.getItem('zen-player') || '{}'); } catch (e) { return {}; }
}
function saveSettings() {
  try { sessionStorage.setItem('zen-player', JSON.stringify(state)); } catch (e) { /* storage unavailable: fine */ }
}

/* ======================= p5 ======================= */

function setup() {
  const wrap = document.getElementById('canvas-wrap');
  createCanvas(wrap.clientWidth, wrap.clientHeight).parent(wrap);
  pixelDensity(Math.min(2, window.devicePixelRatio || 1));
  bindUI();
  loadPage();
}

function windowResized() {
  const wrap = document.getElementById('canvas-wrap');
  resizeCanvas(wrap.clientWidth, wrap.clientHeight);
  dirty = true; zenResetEcho();
}

function draw() {
  if (paused && !dirty) return;
  dirty = false;
  const dt = paused ? 0 : (deltaTime / 1000) * state.speed;
  time += dt;
  const t0 = performance.now();
  background(PAPER);
  if (Z) {
    const target = morphTarget();
    // While a morph target is still loading, show the drawing as it is ('still' isn't a mode).
    const mode = state.mode === 'morph' && !target ? 'still' : state.mode;
    zenDraw(drawingContext, Z, {
      mode, time, dt, amount: state.amount, order: state.order,
      noiseScale: state.noiseScale, octaves: state.octaves, seed,
      useOriginal: false, ink: INK, paper: PAPER, accent: INK,
      width, height, density: pixelDensity(),
      pointer: pointerInside ? { x: pointer.x, y: pointer.y, down: pointer.down } : null,
      magnetKind: state.magnetKind, radius: state.radius, spring: state.spring, ghost: true,
      lensRadius: state.lensRadius, morphTarget: target,
      glow: state.glow, glowAmt: state.glowAmt, echo: state.echo, echoAmt: state.echoAmt,
      kaleido: state.kaleido, wedges: state.wedges, grain: state.grain, grainAmt: state.grainAmt,
    });
  }
  perf.sum += performance.now() - t0; perf.n++;
  if (t0 - perf.last > 700) {
    ui.perf.textContent = `${(perf.sum / perf.n).toFixed(1)} ms/frame`;
    perf.sum = perf.n = 0; perf.last = t0;
  }
}

function keyPressed() {
  if (document.activeElement && /INPUT|SELECT/.test(document.activeElement.tagName)) return;
  if (keyCode === LEFT_ARROW) { go(-1); return false; }
  if (keyCode === RIGHT_ARROW) { go(1); return false; }
  if (keyCode === UP_ARROW || keyCode === DOWN_ARROW) {
    const i = MODE_ORDER.indexOf(state.mode), n = MODE_ORDER.length;
    setMode(MODE_ORDER[(i + (keyCode === DOWN_ARROW ? 1 : n - 1)) % n]);
    return false;
  }
  if (keyCode === ESCAPE) { location.href = 'index.html'; return false; }
  if (key >= '1' && key <= '9') setMode(MODE_ORDER[+key - 1]);
  else if (key === ' ') { togglePause(); return false; }
  else if (key === 'r' || key === 'R') { time = 0; dirty = true; }
  else if (key === 's' || key === 'S') newSeed();
  else if (key === 'g' || key === 'G') setOverlay('glow', !state.glow);
  else if (key === 'e' || key === 'E') setOverlay('echo', !state.echo);
  else if (key === 'k' || key === 'K') setOverlay('kaleido', !state.kaleido);
  else if (key === 'p' || key === 'P') setOverlay('grain', !state.grain);
}

/* ======================= Loading & navigation ======================= */

async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.text();
}

async function loadPage() {
  try {
    const data = JSON.parse(await fetchText('sketches.json'));
    list = data.sketches || [];
  } catch (e) {
    return fail(location.protocol === 'file:'
      ? 'Open this site through a web server (python3 -m http.server), not as a file.'
      : 'Could not load the sketch list (sketches.json). Run update_index.py.');
  }
  if (!list.length) return fail('No sketches yet.');
  const slug = new URLSearchParams(location.search).get('s');
  idx = Math.max(0, list.findIndex(s => s.slug === slug));
  const sk = list[idx];

  document.title = `${sk.title} · ${SITE.title || 'Zentangles'}`;
  ui.title.textContent = sk.title;
  ui.pos.textContent = `${idx + 1} / ${list.length}`;
  ui.prev.href = link(idx - 1); ui.next.href = link(idx + 1);
  if (list.length < 2) { ui.prev.hidden = ui.next.hidden = true; }
  buildMorphMenu();

  try {
    const t0 = performance.now();
    Z = zenParse(await fetchText(sk.file));
    parsedCache.set(sk.slug, Z);
    ui.loading.hidden = true;
    time = 0; dirty = true;
    console.info(`${sk.title}: ${Z.totalPoints} points, parsed in ${Math.round(performance.now() - t0)} ms`);
  } catch (e) {
    fail(`Couldn't open ${sk.file}: ${e.message}`);
  }
  prefetchNeighbours();
}

function fail(msg) { ui.loading.hidden = false; ui.loading.textContent = msg; }

function link(i) {
  const n = list.length;
  return `sketch.html?s=${encodeURIComponent(list[((i % n) + n) % n].slug)}`;
}
function go(step) { if (list.length > 1) { saveSettings(); location.href = link(idx + step); } }

// Warm the browser cache so Prev/Next open instantly.
function prefetchNeighbours() {
  if (list.length < 2) return;
  const n = list.length;
  [list[(idx + 1) % n], list[(idx - 1 + n) % n]].forEach(s => fetch(s.file).catch(() => {}));
}

/*
 * Morph target: another sketch from the collection (parsed on first use).
 * Defaults to the next sketch; a target the visitor picks is remembered while it exists.
 */
let morphSlug = null;
function buildMorphMenu() {
  const others = list.filter((_, i) => i !== idx);
  const sel = ui.morphSel;
  if (!others.length) { sel.innerHTML = '<option value="">(add more sketches)</option>'; morphSlug = null; return; }
  sel.innerHTML = others.map(s => `<option value="${s.slug}">${s.title.replace(/</g, '&lt;')}</option>`).join('');
  const picked = others.find(s => s.slug === state.morphSlug);
  morphSlug = (picked || list[(idx + 1) % list.length]).slug;
  sel.value = morphSlug;
}
let morphLoading = null;
function morphTarget() {
  if (state.mode !== 'morph' || !morphSlug) return null;
  const Zt = parsedCache.get(morphSlug);
  if (Zt) return Zt;
  if (!morphLoading) {
    const s = list.find(x => x.slug === morphSlug);
    if (s) morphLoading = fetchText(s.file).then(t => { parsedCache.set(s.slug, zenParse(t)); time = 0; })
      .catch(() => {}).finally(() => { morphLoading = null; dirty = true; });
  }
  return null;
}

/* ======================= Controls ======================= */

function setMode(m) {
  state.mode = m; time = 0; dirty = true;
  document.querySelectorAll('#modes button, #modes2 button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
  ui.hint.textContent = HINTS[m] || '';
  ui.orderRow.hidden = !(m === 'draw' || m === 'redraw');
  ui.octRow.hidden = !(m === 'vertex' || m === 'melt');
  ['magnet', 'lens', 'morph'].forEach(k => (document.getElementById(k + '-opts').hidden = m !== k));
  if (Z) Z.mag = null;
  zenResetEcho(); saveSettings();
}

function setOverlay(name, on) {
  state[name] = on; dirty = true;
  document.getElementById(name).checked = on;
  document.getElementById(name + '-opts').hidden = !on;
  if (name === 'echo') zenResetEcho();
  saveSettings();
}

function togglePause() {
  paused = !paused; dirty = true;
  ui.pause.textContent = paused ? 'Play' : 'Pause';
}

function newSeed() { seed = (Math.random() * 2 ** 31) | 0; Perlin.seed(seed); dirty = true; }

function bindUI() {
  const $ = id => document.getElementById(id);
  Object.assign(ui, {
    title: $('sk-title'), pos: $('sk-pos'), prev: $('prev'), next: $('next'), loading: $('loading'),
    hint: $('mode-hint'), orderRow: $('order-row'), octRow: $('octaves-row'), pause: $('pause'),
    perf: $('perf'), morphSel: $('morph-target'),
  });
  ui.prev.addEventListener('click', e => { e.preventDefault(); go(-1); });
  ui.next.addEventListener('click', e => { e.preventDefault(); go(1); });
  document.querySelector('.home').addEventListener('click', saveSettings);

  document.querySelectorAll('#modes button, #modes2 button').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));

  const slider = (id, fmt) => {
    const el = $(id), out = $(id + '-v');
    el.value = state[id];
    const upd = () => { state[id] = parseFloat(el.value); out.textContent = fmt(state[id]); dirty = true; saveSettings(); };
    el.addEventListener('input', upd); upd();
  };
  slider('speed', v => v.toFixed(1) + '×');
  slider('amount', v => Math.round(v * 100) + '%');
  slider('noiseScale', v => v.toFixed(1));
  slider('octaves', v => String(v));
  slider('radius', v => Math.round(v * 100) + '%');
  slider('spring', v => (v < 0.35 ? 'putty' : v < 0.7 ? 'springy' : 'jelly'));
  slider('lensRadius', v => Math.round(v * 100) + '%');
  slider('glowAmt', v => Math.round(v * 100) + '%');
  slider('echoAmt', v => (v < 0.35 ? 'short' : v < 0.75 ? 'medium' : 'long'));
  slider('wedges', v => String(v));
  slider('grainAmt', v => Math.round(v * 100) + '%');

  $('order').value = state.order;
  $('order').addEventListener('change', e => { state.order = e.target.value; time = 0; dirty = true; saveSettings(); });
  document.querySelectorAll('#magnet-kind button').forEach(b => {
    b.classList.toggle('on', b.dataset.kind === state.magnetKind);
    b.addEventListener('click', () => {
      state.magnetKind = b.dataset.kind; saveSettings();
      document.querySelectorAll('#magnet-kind button').forEach(x => x.classList.toggle('on', x === b));
    });
  });
  ui.morphSel.addEventListener('change', e => { state.morphSlug = morphSlug = e.target.value; time = 0; dirty = true; saveSettings(); });
  ['glow', 'echo', 'kaleido', 'grain'].forEach(k => {
    $(k).addEventListener('change', e => setOverlay(k, e.target.checked));
    setOverlay(k, !!state[k]);
  });
  $('seed').addEventListener('click', newSeed);
  ui.pause.addEventListener('click', togglePause);
  $('restart').addEventListener('click', () => { time = 0; dirty = true; });
  if (SITE.allowDownloads) {
    $('png').hidden = false;
    $('png').addEventListener('click', () => saveCanvas((list[idx] || {}).slug || 'zentangle', 'png'));
  }

  // Mobile: the controls live in a drawer.
  const panel = $('panel'), tog = $('panel-toggle');
  tog.addEventListener('click', () => {
    const open = panel.classList.toggle('open');
    tog.setAttribute('aria-expanded', open); tog.textContent = open ? 'Close' : 'Play with it';
  });

  // Mouse / touch tracking (Magnet and Lens), measured against the canvas.
  const wrap = $('canvas-wrap');
  const track = e => {
    const r = wrap.getBoundingClientRect();
    pointer.x = e.clientX - r.left; pointer.y = e.clientY - r.top;
    pointerInside = pointer.x >= 0 && pointer.y >= 0 && pointer.x <= r.width && pointer.y <= r.height;
  };
  window.addEventListener('pointermove', track, { passive: true });
  window.addEventListener('pointerdown', e => { track(e); if (pointerInside) pointer.down = true; }, { passive: true });
  window.addEventListener('pointerup', e => { pointer.down = false; if (e.pointerType === 'touch') pointerInside = false; });
  window.addEventListener('pointercancel', () => { pointer.down = false; pointerInside = false; });
  document.documentElement.addEventListener('pointerleave', () => { pointerInside = false; pointer.down = false; });
  window.addEventListener('blur', () => { pointerInside = false; pointer.down = false; });
  wrap.style.touchAction = 'none';

  // Swipe left/right on the drawing (touch) to change sketch, except in modes that use the finger.
  let sx = null, sy = null;
  wrap.addEventListener('touchstart', e => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  wrap.addEventListener('touchend', e => {
    if (sx === null || state.mode === 'magnet' || state.mode === 'lens') return;
    const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dx) > 70 && Math.abs(dx) > 2 * Math.abs(dy)) go(dx < 0 ? 1 : -1);
    sx = null;
  }, { passive: true });

  setMode(state.mode);
}
