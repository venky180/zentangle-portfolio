/*
 * zentangle-core.js  (v9)
 *
 * Turns an SVG into point contours once, then animates it with Perlin noise.
 *
 * Modes:    motion  – vertex, magnet, melt, shatter, lens, wind, morph
 *           reveal  – draw, ink, scan, grow, redraw
 * Overlays: trippy colour, glow, echo trails, kaleidoscope, paper grain & ink bleed
 *
 * Where the speed comes from:
 *  - SVG geometry is flattened by our own path parser (adaptive: curves get detail, straight
 *    lines stay light) into flat Float32Arrays. No slow getPointAtLength calls.
 *  - Each shape also keeps a cached Path2D built from its original curves.
 *  - Reveal modes and Shatter render the still drawing once and then only clip and move that image.
 *  - Consecutive stroke-only shapes with the same style are batched into one stroke() call.
 *  - No closePath(): Chrome slows down with every sub-path already in a Path2D.
 *  - With no overlays switched on, frames draw straight onto the canvas.
 */

/* ======================= Perlin noise (improved, 3D) ======================= */

const Perlin = (() => {
  const p = new Uint8Array(512);

  function seed(s) {
    let a = (s >>> 0) || 1;
    const rnd = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const perm = new Uint8Array(256);
    for (let i = 0; i < 256; i++) perm[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = (rnd() * (i + 1)) | 0;
      const tmp = perm[i]; perm[i] = perm[j]; perm[j] = tmp;
    }
    for (let i = 0; i < 512; i++) p[i] = perm[i & 255];
  }

  function grad(h, x, y, z) {
    switch (h & 15) {
      case 0: return x + y;   case 1: return -x + y;  case 2: return x - y;   case 3: return -x - y;
      case 4: return x + z;   case 5: return -x + z;  case 6: return x - z;   case 7: return -x - z;
      case 8: return y + z;   case 9: return -y + z;  case 10: return y - z;  case 11: return -y - z;
      case 12: return x + y;  case 13: return -x + y; case 14: return -y + z; default: return -y - z;
    }
  }

  /** Classic improved Perlin noise. Returns roughly -1..1 */
  function noise3(x, y, z) {
    let X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
    x -= X; y -= Y; z -= Z;
    X &= 255; Y &= 255; Z &= 255;
    const u = x * x * x * (x * (x * 6 - 15) + 10);
    const v = y * y * y * (y * (y * 6 - 15) + 10);
    const w = z * z * z * (z * (z * 6 - 15) + 10);
    const A = p[X] + Y, AA = p[A] + Z, AB = p[A + 1] + Z;
    const B = p[X + 1] + Y, BA = p[B] + Z, BB = p[B + 1] + Z;
    const x1 = x - 1, y1 = y - 1, z1 = z - 1;
    const l1 = grad(p[AA], x, y, z),  l2 = grad(p[BA], x1, y, z);
    const l3 = grad(p[AB], x, y1, z), l4 = grad(p[BB], x1, y1, z);
    const l5 = grad(p[AA + 1], x, y, z1),  l6 = grad(p[BA + 1], x1, y, z1);
    const l7 = grad(p[AB + 1], x, y1, z1), l8 = grad(p[BB + 1], x1, y1, z1);
    const a1 = l1 + u * (l2 - l1), a2 = l3 + u * (l4 - l3);
    const a3 = l5 + u * (l6 - l5), a4 = l7 + u * (l8 - l7);
    const b1 = a1 + v * (a2 - a1), b2 = a3 + v * (a4 - a3);
    return b1 + w * (b2 - b1);
  }

  /** Fractal (fBm) Perlin: sum of octaves, normalised to about -1..1 */
  function fbm(x, y, z, octaves) {
    let sum = 0, amp = 1, norm = 0, f = 1;
    for (let o = 0; o < octaves; o++) {
      sum += amp * noise3(x * f, y * f, z * f);
      norm += amp; amp *= 0.5; f *= 2;
    }
    return sum / norm;
  }

  seed(1);
  return { seed, noise3, fbm };
})();

const ZEN_MODES = ['draw', 'vertex', 'magnet', 'melt', 'shatter', 'lens', 'wind', 'morph', 'ink', 'scan', 'grow', 'redraw'];

/* ===================== SVG geometry → points (no getPointAtLength) ===================== */

/* Convert any basic shape element to path data. */
function _shapeToD(el) {
  const g = n => parseFloat(el.getAttribute(n)) || 0;
  switch (el.tagName.toLowerCase()) {
    case 'path': return el.getAttribute('d') || '';
    case 'circle': { const cx = g('cx'), cy = g('cy'), r = g('r'); if (r <= 0) return '';
      return `M${cx - r} ${cy}A${r} ${r} 0 1 0 ${cx + r} ${cy}A${r} ${r} 0 1 0 ${cx - r} ${cy}Z`; }
    case 'ellipse': { const cx = g('cx'), cy = g('cy'), rx = g('rx'), ry = g('ry'); if (rx <= 0 || ry <= 0) return '';
      return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`; }
    case 'rect': { const x = g('x'), y = g('y'), w = g('width'), h = g('height'); if (w <= 0 || h <= 0) return '';
      let rx = el.hasAttribute('rx') ? g('rx') : g('ry'), ry = el.hasAttribute('ry') ? g('ry') : rx;
      rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
      if (!rx || !ry) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
      return `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}` +
        `A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}` +
        `V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`; }
    case 'line': return `M${g('x1')} ${g('y1')}L${g('x2')} ${g('y2')}`;
    case 'polyline': case 'polygon': {
      const n = (el.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number);
      if (n.length < 4) return '';
      let d = `M${n[0]} ${n[1]}`;
      for (let i = 2; i + 1 < n.length; i += 2) d += `L${n[i]} ${n[i + 1]}`;
      return el.tagName.toLowerCase() === 'polygon' ? d + 'Z' : d; }
  }
  return '';
}

/*
 * Flatten SVG path data into point contours, in root coordinates.
 * m: element→root matrix. tol: max deviation from the true curve. maxSeg: longest allowed segment
 * (so straight lines still have points that can bend in Flow mode). Both in root units.
 */
function _flattenD(d, m, tol, maxSeg) {
  const toks = d.match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) || [];
  const contours = [];
  let cur = null, x = 0, y = 0, sx = 0, sy = 0, cmd = '', i = 0, lcx = 0, lcy = 0, lq = '';
  const out = [];                                  // flat [x,y,...] in element space
  const num = () => parseFloat(toks[i++]);
  const isNum = () => i < toks.length && !/^[A-Za-z]/.test(toks[i]);   // ^: "5.3e-4" is a number
  const T = (px, py) => [m.a * px + m.c * py + m.e, m.b * px + m.d * py + m.f];
  const push = (px, py) => { const p = T(px, py); cur.pts.push(p[0], p[1]); };
  const sc = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
  const segs = (len, n) => Math.max(1, Math.ceil(Math.max(n, (len * sc) / maxSeg)));
  const start = (px, py) => { cur = { pts: [], closed: false }; contours.push(cur); push(px, py); };
  const lineTo = (nx, ny) => {
    const n = segs(Math.hypot(nx - x, ny - y), 1);
    for (let k = 1; k <= n; k++) push(x + (nx - x) * k / n, y + (ny - y) * k / n);
    x = nx; y = ny;
  };
  const cubic = (x1, y1, x2, y2, x3, y3) => {
    const dd = Math.max(Math.hypot(x - 2 * x1 + x2, y - 2 * y1 + y2), Math.hypot(x1 - 2 * x2 + x3, y1 - 2 * y2 + y3)) * sc;
    const len = Math.hypot(x1 - x, y1 - y) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2);
    const n = segs(len, Math.sqrt((0.75 * dd) / tol));
    for (let k = 1; k <= n; k++) {
      const t = k / n, u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, e = t * t * t;
      push(a * x + b * x1 + c * x2 + e * x3, a * y + b * y1 + c * y2 + e * y3);
    }
    lcx = x2; lcy = y2; x = x3; y = y3;
  };
  const quad = (x1, y1, x2, y2) => {
    const dd = Math.hypot(x - 2 * x1 + x2, y - 2 * y1 + y2) * sc;
    const len = Math.hypot(x1 - x, y1 - y) + Math.hypot(x2 - x1, y2 - y1);
    const n = segs(len, Math.sqrt((0.25 * dd) / tol));
    for (let k = 1; k <= n; k++) {
      const t = k / n, u = 1 - t;
      push(u * u * x + 2 * u * t * x1 + t * t * x2, u * u * y + 2 * u * t * y1 + t * t * y2);
    }
    lcx = x1; lcy = y1; x = x2; y = y2;
  };
  const arc = (rx, ry, phi, large, sweep, x2, y2) => {
    if (!rx || !ry) return lineTo(x2, y2);
    rx = Math.abs(rx); ry = Math.abs(ry);
    const cp = Math.cos(phi), sp = Math.sin(phi);
    const dx = (x - x2) / 2, dy = (y - y2) / 2;
    const x1p = cp * dx + sp * dy, y1p = -sp * dx + cp * dy;
    const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }
    const num_ = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    let co = Math.sqrt(Math.max(0, num_ / den)); if (large === sweep) co = -co;
    const cxp = (co * rx * y1p) / ry, cyp = (-co * ry * x1p) / rx;
    const cx = cp * cxp - sp * cyp + (x + x2) / 2, cy = sp * cxp + cp * cyp + (y + y2) / 2;
    const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if (!sweep && dt > 0) dt -= 2 * Math.PI; else if (sweep && dt < 0) dt += 2 * Math.PI;
    const r = Math.max(rx, ry) * sc;
    const step = r > tol ? 2 * Math.acos(Math.max(-1, 1 - tol / r)) : Math.PI / 2;
    const n = segs(Math.abs(dt) * Math.max(rx, ry), Math.abs(dt) / step);
    for (let k = 1; k <= n; k++) {
      const a = t1 + (dt * k) / n, ca = Math.cos(a) * rx, sa = Math.sin(a) * ry;
      push(cp * ca - sp * sa + cx, sp * ca + cp * sa + cy);
    }
    x = x2; y = y2;
  };

  while (i < toks.length) {
    if (!isNum()) cmd = toks[i++];
    const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    if (C !== 'Z' && !isNum()) continue;
    switch (C) {
      case 'M': { x = num() + ox; y = num() + oy; sx = x; sy = y; start(x, y); cmd = rel ? 'l' : 'L'; break; }
      case 'L': { const nx = num() + ox, ny = num() + oy; if (!cur) start(x, y); lineTo(nx, ny); break; }
      case 'H': { if (!cur) start(x, y); lineTo(num() + ox, y); break; }
      case 'V': { if (!cur) start(x, y); lineTo(x, num() + oy); break; }
      case 'C': { if (!cur) start(x, y); cubic(num() + ox, num() + oy, num() + ox, num() + oy, num() + ox, num() + oy); break; }
      case 'S': { if (!cur) start(x, y); const rx1 = lq === 'C' ? 2 * x - lcx : x, ry1 = lq === 'C' ? 2 * y - lcy : y;
        cubic(rx1, ry1, num() + ox, num() + oy, num() + ox, num() + oy); break; }
      case 'Q': { if (!cur) start(x, y); quad(num() + ox, num() + oy, num() + ox, num() + oy); break; }
      case 'T': { if (!cur) start(x, y); const qx = lq === 'Q' ? 2 * x - lcx : x, qy = lq === 'Q' ? 2 * y - lcy : y;
        quad(qx, qy, num() + ox, num() + oy); break; }
      case 'A': { if (!cur) start(x, y); const rx = num(), ry = num(), ph = num() * Math.PI / 180, la = num() ? 1 : 0, sw = num() ? 1 : 0;
        arc(rx, ry, ph, la, sw, num() + ox, num() + oy); break; }
      case 'Z': { if (cur) { if (x !== sx || y !== sy) lineTo(sx, sy); cur.closed = true; }
        x = sx; y = sy; cur = null; break; }
      default: i++;
    }
    lq = C === 'C' || C === 'S' ? 'C' : C === 'Q' || C === 'T' ? 'Q' : '';
  }
  return contours.filter(c => c.pts.length >= 4);
}

/* ============ SVG path → vertex list (anchors + Bézier handles), for Vertex mode ============ */
/*
 * Everything becomes M / L / C / Z in root coordinates (Q, S, T, H, V and arcs are converted
 * exactly or to cubic Béziers; an affine transform keeps Béziers Béziers).
 * ops: 0=M 1=L 2=C 3=Z.  pts: M,L → 1 point; C → 3 points (handle1, handle2, anchor).
 */
function _toVertices(d, m) {
  const toks = d.match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) || [];
  const ops = [], pts = [];
  let x = 0, y = 0, sx = 0, sy = 0, cmd = '', i = 0, lcx = 0, lcy = 0, lq = '', open = false;
  const num = () => parseFloat(toks[i++]);
  const isNum = () => i < toks.length && !/^[A-Za-z]/.test(toks[i]);   // ^: "5.3e-4" is a number
  const P = (px, py) => pts.push(m.a * px + m.c * py + m.e, m.b * px + m.d * py + m.f);
  const ensure = () => { if (!open) { ops.push(0); P(x, y); open = true; } };
  const C = (x1, y1, x2, y2, x3, y3) => { ensure(); ops.push(2); P(x1, y1); P(x2, y2); P(x3, y3); lcx = x2; lcy = y2; x = x3; y = y3; };
  const Qd = (qx, qy, x3, y3) => {
    C(x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), x3 + (2 / 3) * (qx - x3), y3 + (2 / 3) * (qy - y3), x3, y3);
    lcx = qx; lcy = qy;
  };
  const A = (rx, ry, phi, large, sweep, x2, y2) => {
    if (!rx || !ry || (x === x2 && y === y2)) { ensure(); ops.push(1); P(x2, y2); x = x2; y = y2; return; }
    rx = Math.abs(rx); ry = Math.abs(ry);
    const cp = Math.cos(phi), sp = Math.sin(phi), dx = (x - x2) / 2, dy = (y - y2) / 2;
    const x1p = cp * dx + sp * dy, y1p = -sp * dx + cp * dy;
    const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }
    const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    let co = Math.sqrt(Math.max(0, (rx * rx * ry * ry - den) / den)); if (large === sweep) co = -co;
    const cxp = (co * rx * y1p) / ry, cyp = (-co * ry * x1p) / rx;
    const cx = cp * cxp - sp * cyp + (x + x2) / 2, cy = sp * cxp + cp * cyp + (y + y2) / 2;
    const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if (!sweep && dt > 0) dt -= 2 * Math.PI; else if (sweep && dt < 0) dt += 2 * Math.PI;
    const n = Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9), h = dt / n, k = (4 / 3) * Math.tan(h / 4);
    const pt = a => [cp * rx * Math.cos(a) - sp * ry * Math.sin(a) + cx, sp * rx * Math.cos(a) + cp * ry * Math.sin(a) + cy];
    const tg = a => [-cp * rx * Math.sin(a) - sp * ry * Math.cos(a), -sp * rx * Math.sin(a) + cp * ry * Math.cos(a)];
    for (let s = 0; s < n; s++) {
      const a0 = t1 + s * h, a1 = a0 + h, p0 = pt(a0), p1 = s === n - 1 ? [x2, y2] : pt(a1), d0 = tg(a0), d1 = tg(a1);
      C(p0[0] + k * d0[0], p0[1] + k * d0[1], p1[0] - k * d1[0], p1[1] - k * d1[1], p1[0], p1[1]);
    }
  };
  while (i < toks.length) {
    if (!isNum()) cmd = toks[i++];
    const rel = cmd === cmd.toLowerCase(), U = cmd.toUpperCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    if (U !== 'Z' && !isNum()) continue;
    switch (U) {
      case 'M': x = num() + ox; y = num() + oy; sx = x; sy = y; ops.push(0); P(x, y); open = true; cmd = rel ? 'l' : 'L'; break;
      case 'L': { const nx = num() + ox, ny = num() + oy; ensure(); ops.push(1); P(nx, ny); x = nx; y = ny; break; }
      case 'H': ensure(); x = num() + ox; ops.push(1); P(x, y); break;
      case 'V': ensure(); y = num() + oy; ops.push(1); P(x, y); break;
      case 'C': C(num() + ox, num() + oy, num() + ox, num() + oy, num() + ox, num() + oy); break;
      case 'S': { const a = lq === 'C' ? 2 * x - lcx : x, b = lq === 'C' ? 2 * y - lcy : y; C(a, b, num() + ox, num() + oy, num() + ox, num() + oy); break; }
      case 'Q': Qd(num() + ox, num() + oy, num() + ox, num() + oy); break;
      case 'T': { const a = lq === 'Q' ? 2 * x - lcx : x, b = lq === 'Q' ? 2 * y - lcy : y; Qd(a, b, num() + ox, num() + oy); break; }
      case 'A': { const rx = num(), ry = num(), ph = num() * Math.PI / 180, la = num() ? 1 : 0, sw = num() ? 1 : 0; A(rx, ry, ph, la, sw, num() + ox, num() + oy); break; }
      case 'Z': if (open) ops.push(3); open = false; x = sx; y = sy; break;
      default: i++;
    }
    lq = U === 'C' || U === 'S' ? 'C' : U === 'Q' || U === 'T' ? 'Q' : '';
  }
  return { vops: Uint8Array.from(ops), vpts: Float32Array.from(pts) };
}

/*
 * Vertex mode: every anchor moves by Perlin noise sampled at its own position, and its Bézier
 * handles travel with it, so curves stay smooth. Same position → same offset, so vertices shared
 * by neighbouring shapes (very common in traced art) move together and nothing tears apart.
 */
function _appendVertices(P, sh, amp, fq, z, oct) {
  // Note: no closePath(). In Chrome it slows down with every sub-path already in the Path2D
  // (137 ms vs 0.8 ms for a 2,000-piece traced drawing). Fills close shapes automatically,
  // and outlines are closed with an explicit line back to the start.
  const ops = sh.vops, p = sh.vpts, fbm = Perlin.fbm;
  let j = 0, dx = 0, dy = 0, sx = 0, sy = 0, lx = 0, ly = 0;
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    if (op === 3) { if (lx !== sx || ly !== sy) P.lineTo(sx, sy); continue; }
    const a = op === 2 ? j + 4 : j;                 // index of this command's anchor
    const nx = p[a] * fq, ny = p[a + 1] * fq;
    const ndx = amp * fbm(nx, ny, z, oct), ndy = amp * fbm(nx + 57.31, ny + 19.13, z + 3.7, oct);
    lx = p[a] + ndx; ly = p[a + 1] + ndy;
    if (op === 2) {
      // handle 1 follows the previous anchor, handle 2 and the end point follow the new one
      P.bezierCurveTo(p[j] + dx, p[j + 1] + dy, p[j + 2] + ndx, p[j + 3] + ndy, lx, ly);
      j += 6;
    } else if (op === 0) {
      P.moveTo(lx, ly); sx = lx; sy = ly; j += 2;
    } else {
      P.lineTo(lx, ly); j += 2;
    }
    dx = ndx; dy = ndy;
  }
}


/* ======================= Magnetic mouse: springy points ======================= */
/*
 * Every flattened point has its own spring: an offset (ox, oy) and a velocity (vx, vy).
 * Each frame the magnet sets a target offset for points near it (push away, pull in, or swirl),
 * wobbled by Perlin noise; the spring chases that target and overshoots a little, so things
 * wobble back into place when the magnet leaves. A point's motion depends only on its position,
 * so points shared by neighbouring shapes stay together.
 */
function _magState(Z) {
  let M = Z.mag;
  if (!M) {
    let n = 0;
    for (const sh of Z.shapes) { sh.mi = n; n += sh.npts; }
    M = Z.mag = { o: new Float32Array(n * 2), v: new Float32Array(n * 2), ghost: [0, 0] };
  }
  return M;
}

/** Physics step for all points. mag = {x, y} in drawing units, or null when there is no magnet. */
function _magStep(Z, o, mag, fq) {
  const M = _magState(Z), O = M.o, V = M.v;
  const { maxDim } = Z;
  const R = maxDim * (o.radius || 0.15), invR2 = 1 / (R * R), reach2 = 9 * R * R;
  const A = o.amount, t = o.time;
  const kind = mag && mag.flip ? (o.magnetKind === 'attract' ? 'repel' : 'attract') : (o.magnetKind || 'repel');
  // Spring: stiffness k, damping c. Low damping = bouncy jelly, high = calm putty.
  const k = 170, c = 3 + 22 * (1 - (o.spring ?? 0.6));
  const dt = Math.min(1 / 30, Math.max(0, o.dt || 0));
  const steps = dt > 1 / 90 ? 2 : 1, h = dt / steps;
  const rest = 1e-4 * maxDim;
  const strength = A * R * 0.9;

  for (const sh of Z.shapes) {
    const xy = sh.xy, base = sh.mi * 2;
    for (let i = 0, n = sh.npts * 2; i < n; i += 2) {
      const q = base + i, px = xy[i], py = xy[i + 1];
      let tx = 0, ty = 0;
      if (mag) {
        const dx = px - mag.x, dy = py - mag.y, d2 = dx * dx + dy * dy;
        if (d2 < reach2) {
          const d = Math.sqrt(d2) + 1e-6;
          const g = Math.exp(-d2 * invR2 * 1.4);                 // smooth falloff
          // Perlin wobble: bend the force direction and vary its strength.
          const nz = Perlin.noise3(px * fq * 2, py * fq * 2, t * 0.6);
          const ang = nz * 0.5, ca = Math.cos(ang), sa = Math.sin(ang);
          if (kind === 'swirl') {
            // Twirl: rotate around the cursor, keeping distance, so outlines never fold over.
            const th = A * 2.2 * g * (1 + 0.5 * nz), ct = Math.cos(th), st = Math.sin(th);
            tx = dx * ct - dy * st - dx; ty = dx * st + dy * ct - dy;
          } else {
            // Push (repel) or pull (attract) along the Perlin-bent direction.
            // Strength stays below the fold limit, so neighbouring points never cross.
            const ux = dx / d, uy = dy / d;
            const rx = ux * ca - uy * sa, ry = ux * sa + uy * ca;
            let m = strength * g * (1 + 0.1 * nz);
            if (kind === 'attract') m = -Math.min(m, d * 0.85);   // never pull past the cursor
            tx = rx * m; ty = ry * m;
          }
        }
      }
      let ox = O[q], oy = O[q + 1], vx = V[q], vy = V[q + 1];
      if (tx === 0 && ty === 0 && Math.abs(ox) + Math.abs(oy) < rest && Math.abs(vx) + Math.abs(vy) < rest) {
        if (ox || oy || vx || vy) { O[q] = O[q + 1] = V[q] = V[q + 1] = 0; }
        continue;                                               // at rest: skip the maths
      }
      for (let s = 0; s < steps; s++) {                         // semi-implicit Euler
        vx += (k * (tx - ox) - c * vx) * h; vy += (k * (ty - oy) - c * vy) * h;
        ox += vx * h; oy += vy * h;
      }
      O[q] = ox; O[q + 1] = oy; V[q] = vx; V[q + 1] = vy;
    }
  }
  return M;
}

/* Append a shape's points, each moved by its spring offset. */
function _appendMag(P, sh, O) {
  const xy = sh.xy, st = sh.starts, nc = st.length - 1, base = sh.mi * 2;
  for (let c = 0; c < nc; c++) {
    const a = st[c], b = st[c + 1];
    let sx = 0, sy = 0;
    for (let i = a; i < b; i++) {
      const x = xy[2 * i] + O[base + 2 * i], y = xy[2 * i + 1] + O[base + 2 * i + 1];
      if (i === a) { P.moveTo(x, y); sx = x; sy = y; } else P.lineTo(x, y);
    }
    if (sh.closed[c]) P.lineTo(sx, sy);
  }
}

/* ============================== Parsing ============================== */

function zenParse(svgText) {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const src = doc.querySelector('svg');
  if (!src || doc.querySelector('parsererror')) throw new Error("That file doesn't look like a valid SVG.");

  // Mounted off-screen (not visibility:hidden, which children would inherit) so the browser
  // resolves CSS, inherited styles and nested transforms for us. Geometry is our own maths.
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-100000px;top:0;opacity:0;pointer-events:none;';
  document.body.appendChild(host);
  const svg = document.importNode(src, true);
  host.appendChild(svg);

  try {
    let vb = svg.viewBox && svg.viewBox.baseVal;
    if (!vb || !vb.width || !vb.height) {
      const w = parseFloat(svg.getAttribute('width')), h = parseFloat(svg.getAttribute('height'));
      if (w && h) svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
      else { const bb = svg.getBBox(); svg.setAttribute('viewBox', `${bb.x} ${bb.y} ${bb.width || 100} ${bb.height || 100}`); }
      vb = svg.viewBox.baseVal;
    }
    svg.setAttribute('width', vb.width);
    svg.setAttribute('height', vb.height);
    const VB = { x: vb.x, y: vb.y, w: vb.width, h: vb.height };
    const maxDim = Math.max(VB.w, VB.h);
    const tol = maxDim / 2500;      // curve accuracy
    const maxSeg = maxDim / 140;    // longest straight segment (lets Flow bend long lines)
    const unit = maxDim / 700;

    const rootInv = svg.getScreenCTM().inverse();
    const els = [...svg.querySelectorAll('path,circle,ellipse,rect,line,polyline,polygon')]
      .filter(el => !el.closest('defs,clipPath,mask,symbol,marker,pattern'));

    const paint = v => (!v || v === 'none' || v === 'transparent' || /rgba\(.*,\s*0\)$/.test(v))
      ? null : (v.startsWith('url(') ? '#000000' : v);

    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    const shapes = [];

    els.forEach((el, idx) => {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      const d = _shapeToD(el);
      if (!d) return;
      const m = rootInv.multiply(el.getScreenCTM());
      const sc = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
      const contours = _flattenD(d, m, tol, maxSeg);
      if (!contours.length) return;

      let k = 0;
      for (const c of contours) k += c.pts.length / 2;
      const xy = new Float32Array(k * 2), starts = new Int32Array(contours.length + 1), closed = new Uint8Array(contours.length);
      let o = 0, sx = 0, sy = 0;
      contours.forEach((c, ci) => {
        starts[ci] = o / 2; closed[ci] = c.closed ? 1 : 0;
        for (let j = 0; j < c.pts.length; j += 2) {
          const x = c.pts[j], y = c.pts[j + 1];
          xy[o++] = x; xy[o++] = y; sx += x; sy += y;
          if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
        }
      });
      starts[contours.length] = k;
      const cx = sx / k, cy = sy / k;
      let r = 0;
      for (let j = 0; j < k; j++) r = Math.max(r, Math.hypot(xy[2 * j] - cx, xy[2 * j + 1] - cy));

      // Cached path uses the browser's own curves: exact and cheap to redraw every frame.
      let path;
      try { path = new Path2D(); path.addPath(new Path2D(d), new DOMMatrix([m.a, m.b, m.c, m.d, m.e, m.f])); }
      catch (e) { path = null; }

      const opacity = parseFloat(cs.opacity || 1);
      const stroke = paint(cs.stroke);
      const sh = {
        xy, starts, closed, path, npts: k, cx, cy, r: r || unit,
        ..._toVertices(d, m),
        fill: el.tagName.toLowerCase() === 'line' ? null : paint(cs.fill),
        // SVG's default is nonzero; traced art relies on it for overlapping sub-paths.
        rule: cs.fillRule === 'evenodd' ? 'evenodd' : 'nonzero',
        stroke,
        fillAlpha: opacity * parseFloat(cs.fillOpacity || 1),
        strokeAlpha: opacity * parseFloat(cs.strokeOpacity || 1),
        sw: stroke ? (parseFloat(cs.strokeWidth) || 1) * sc : 0,
        docIndex: idx,
      };
      if (!sh.path) { sh.path = new Path2D(); _append(sh.path, sh); }
      if (sh.fill || sh.stroke) shapes.push(sh);
    });

    if (!shapes.length) throw new Error('No drawable shapes found in that SVG.');

    const ccx = VB.x + VB.w / 2, ccy = VB.y + VB.h / 2;
    let maxD = 1e-9;
    for (const s of shapes) { s.dist = Math.hypot(s.cx - ccx, s.cy - ccy); maxD = Math.max(maxD, s.dist); }
    const N = Math.max(1, shapes.length - 1);
    shapes.forEach((s, i) => { s.d = s.dist / maxD; s.index = i; });
    [...shapes].sort((a, b) => a.dist - b.dist).forEach((s, i) => (s.rankCenter = i / N));
    shapes.forEach((s, i) => (s.rankDoc = i / N));

    const pad = maxDim * 0.03;
    return {
      shapes, vb: VB, unit, maxDim, center: [ccx, ccy],
      totalPoints: shapes.reduce((n, s) => n + s.npts, 0),
      bounds: { x0: bx0 - pad, y0: by0 - pad, size: Math.max(bx1 - bx0, by1 - by0) + 2 * pad },
      noiseRank: null,
    };
  } finally {
    host.remove();
  }
}

/* Append a shape's points to a Path2D, optionally only the first `limit` points (Draw mode). */
function _append(P, sh, limit = Infinity) {
  const xy = sh.xy, st = sh.starts, nc = st.length - 1;
  let rem = limit, sx0 = 0, sy0 = 0;
  for (let c = 0; c < nc; c++) {
    if (rem < 2) break;
    const a = st[c], len = st[c + 1] - a;
    const k = len < rem ? len : rem;
    rem -= len;
    for (let i = 0; i < k; i++) {
      const x = xy[2 * (a + i)], y = xy[2 * (a + i) + 1];
      if (i) P.lineTo(x, y); else { P.moveTo(x, y); sx0 = x; sy0 = y; }
    }
    if (k === len && sh.closed[c]) P.lineTo(sx0, sy0);   // not closePath(): see _appendVertices
  }
}

/* ============================== Colour ============================== */

const _rgbCache = new Map(), _mixCache = new Map();
function _rgb(c) {
  let v = _rgbCache.get(c);
  if (v) return v;
  const cv = _rgb.cv || (_rgb.cv = document.createElement('canvas').getContext('2d'));
  cv.fillStyle = '#000'; cv.fillStyle = c;
  const s = cv.fillStyle;
  if (s[0] === '#') v = [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
  else v = (s.match(/[\d.]+/g) || [0, 0, 0]).slice(0, 3).map(Number);
  _rgbCache.set(c, v);
  return v;
}
/* Mix quantised to 24 steps and cached, so no new colour strings are built per frame. */
function _mix(a, b, t) {
  const q = Math.round(t * 24);
  if (q <= 0) return a;
  const key = a + '|' + b + '|' + q;
  let s = _mixCache.get(key);
  if (!s) {
    const A = _rgb(a), B = _rgb(b), f = q / 24;
    s = `rgb(${(A[0] + (B[0] - A[0]) * f) | 0},${(A[1] + (B[1] - A[1]) * f) | 0},${(A[2] + (B[2] - A[2]) * f) | 0})`;
    _mixCache.set(key, s);
  }
  return s;
}

const _lightCache = new Map();
function _isLight(c) {
  let v = _lightCache.get(c);
  if (v === undefined) {
    const [r, g, b] = _rgb(c);
    v = 0.2126 * r + 0.7152 * g + 0.0722 * b > 150;
    _lightCache.set(c, v);
  }
  return v;
}

/* ============================== Drawing ============================== */

function _clamp(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function _ease(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

/**
 * Draw one frame.
 * o: { mode, time (s), amount 0..1, noiseScale (noise cells across the drawing), octaves 1..4,
 *      order 'center'|'doc'|'noise', useOriginal, ink, paper, accent, width, height, density, margin }
 */
function _drawFrame(ctx, Z, o) {
  const { shapes, vb, unit, maxDim } = Z;
  const [ccx, ccy] = Z.center;
  const margin = o.margin ?? 0.06, dpr = o.density || 1;
  const sc = Math.min(o.width / vb.w, o.height / vb.h) * (1 - margin * 2);
  const S = sc * dpr;
  const OX = ((o.width - vb.w * sc) / 2 - vb.x * sc) * dpr;
  const OY = ((o.height - vb.h * sc) / 2 - vb.y * sc) * dpr;
  const setM = (a, b, c, d, e, f) => ctx.setTransform(S * a, S * b, S * c, S * d, S * e + OX, S * f + OY);

  const t = o.time, A = o.amount, mode = o.mode;
  const fq = (o.noiseScale || 3) / maxDim;
  const oct = o.octaves || 2;
  // Ink mode: dark colours become ink, light ones (highlights in traced art) become paper.
  const col = c => (o.useOriginal ? c : _isLight(c) && o.paper ? o.paper : o.ink);

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  setM(1, 0, 0, 1, 0, 0);

  /* ---------- Magnet: points near the cursor are pushed, pulled or swirled, then spring back ---------- */
  if (mode === 'magnet') {
    // Cursor (CSS px) → drawing units. No cursor: a ghost magnet wanders on a Perlin path.
    let mag = null;
    if (o.pointer) {
      mag = { x: (o.pointer.x * dpr - OX) / S, y: (o.pointer.y * dpr - OY) / S, flip: o.pointer.down };
    } else if (o.ghost !== false) {
      mag = {
        x: vb.x + vb.w * (0.5 + 0.55 * Perlin.noise3(3.3, 0.5, t * 0.18)),
        y: vb.y + vb.h * (0.5 + 0.55 * Perlin.noise3(8.8, 4.1, t * 0.18)),
      };
    }
    const M = _magStep(Z, o, mag, fq);
    let batch = null, bStyle = '', bW = 0, bA = 1;
    const flush = () => {
      if (!batch) return;
      ctx.globalAlpha = bA; ctx.strokeStyle = bStyle; ctx.lineWidth = bW; ctx.stroke(batch);
      batch = null;
    };
    for (const sh of shapes) {
      if (sh.fill) {
        flush();
        const P = new Path2D();
        _appendMag(P, sh, M.o);
        ctx.globalAlpha = sh.fillAlpha; ctx.fillStyle = col(sh.fill); ctx.fill(P, sh.rule);
        if (sh.stroke) { ctx.globalAlpha = sh.strokeAlpha; ctx.strokeStyle = col(sh.stroke); ctx.lineWidth = sh.sw; ctx.stroke(P); }
      } else if (sh.stroke) {
        const style = col(sh.stroke);
        if (!batch || style !== bStyle || sh.sw !== bW || sh.strokeAlpha !== bA) {
          flush(); batch = new Path2D(); bStyle = style; bW = sh.sw; bA = sh.strokeAlpha;
        }
        _appendMag(batch, sh, M.o);
      }
    }
    flush();
    // A faint ring shows the magnet's reach while you're using the mouse.
    if (o.pointer && o.showRing !== false) {
      ctx.globalAlpha = 0.18; ctx.strokeStyle = o.ink; ctx.lineWidth = unit * 1.2;
      ctx.setLineDash([unit * 4, unit * 4]);
      ctx.beginPath(); ctx.arc(mag.x, mag.y, maxDim * (o.radius || 0.15), 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
    return;
  }

  /* ---------- Vertex: move the real SVG anchors (and their handles) with Perlin noise ---------- */
  if (mode === 'vertex') {
    // Vertices wobble locally: 4x the base noise frequency, amplitude a fraction of one noise wavelength.
    const vfq = fq * 4, amp = A * 0.3 / vfq, z = t * 0.8;
    let batch = null, bStyle = '', bW = 0, bA = 1;
    const flush = () => {
      if (!batch) return;
      ctx.globalAlpha = bA; ctx.strokeStyle = bStyle; ctx.lineWidth = bW; ctx.stroke(batch);
      batch = null;
    };
    for (const sh of shapes) {
      if (sh.fill) {
        flush();
        const P = new Path2D();
        _appendVertices(P, sh, amp, vfq, z, oct);
        ctx.globalAlpha = sh.fillAlpha; ctx.fillStyle = col(sh.fill); ctx.fill(P, sh.rule);
        if (sh.stroke) { ctx.globalAlpha = sh.strokeAlpha; ctx.strokeStyle = col(sh.stroke); ctx.lineWidth = sh.sw; ctx.stroke(P); }
      } else if (sh.stroke) {
        const style = col(sh.stroke);
        if (!batch || style !== bStyle || sh.sw !== bW || sh.strokeAlpha !== bA) {
          flush(); batch = new Path2D(); bStyle = style; bW = sh.sw; bA = sh.strokeAlpha;
        }
        _appendVertices(batch, sh, amp, vfq, z, oct);
      }
    }
    flush();
    ctx.restore();
    return;
  }

  /* ---------- Draw: pen trace; only in-progress shapes build new paths ---------- */
  if (mode === 'draw') {
    const T = _clamp((t % 9) / 7);              // draw for 7 s, hold for 2 s
    _penTrace(ctx, Z, o, T, col, fq);
    ctx.restore();
    return;
  }

  /* ======================= Motion modes: every point moves ======================= */

  /* ---------- Melt: ink slides down, faster lower down, in Perlin drips; then un-melts ---------- */
  if (mode === 'melt') {
    // 11 s loop: melt 5 s → hold 1 s → un-melt (the same motion in reverse) 4 s → rest 1 s
    const ph = t % 11, cyc = Math.floor(t / 11);
    const m = ph < 5 ? _ease(ph / 5) : ph < 6 ? 1 : ph < 10 ? 1 - _ease((ph - 6) / 4) : 0;
    const amp = A * m * maxDim * 0.2, top = vb.y, invH = 1 / vb.h, zc = 1.3 + cyc * 1.7;
    _renderDisp(ctx, shapes, col, (x, y, out) => {
      const yn = _clamp((y - top) * invH);
      // Drip strength varies across x (Perlin columns), fixed within one melt so drips stay put.
      const drip = 0.25 + 1.6 * Math.max(0, Perlin.fbm(x * fq * 3, 0.5, zc, oct));
      out[0] = x + amp * 0.06 * yn * Perlin.noise3(x * fq, y * fq, t * 0.4);
      out[1] = y + amp * yn * yn * drip;          // grows smoothly downward, so lines never fold
    });
    ctx.restore();
    return;
  }

  /* ---------- Lens: a bulging magnifier follows the mouse, or wanders on a Perlin path ---------- */
  if (mode === 'lens') {
    const L = _lensCenter(Z, o, t, dpr, S, OX, OY);
    const R = maxDim * (o.lensRadius || 0.2), R2 = R * R;
    const g = 1 / (1 + A * 1.6);                   // < 1 magnifies; r' = R (r/R)^g never folds
    _renderDisp(ctx, shapes, col, (x, y, out) => {
      const dx = x - L.x, dy = y - L.y, r2 = dx * dx + dy * dy;
      if (r2 >= R2 || r2 < 1e-12) { out[0] = x; out[1] = y; return; }
      const k = Math.pow(Math.sqrt(r2) / R, g - 1);
      out[0] = L.x + dx * k; out[1] = L.y + dy * k;
    });
    // A faint glassy rim.
    ctx.globalAlpha = 0.22; ctx.strokeStyle = o.ink; ctx.lineWidth = unit * 1.5;
    ctx.beginPath(); ctx.arc(L.x, L.y, R, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 0.12; ctx.lineWidth = unit * 5;
    ctx.beginPath(); ctx.arc(L.x, L.y, R * 0.93, Math.PI * 1.1, Math.PI * 1.45); ctx.stroke();
    ctx.restore();
    return;
  }

  /* ---------- Wind: gusts sweep across, bending lines one after another ---------- */
  if (mode === 'wind') {
    // Mostly left → right, with the direction itself drifting on Perlin noise.
    const th = 0.7 * Perlin.noise3(0.5, t * 0.05, 2.0);
    const ux = Math.cos(th), uy = Math.sin(th);
    const half = 0.5 * Math.hypot(vb.w, vb.h), Wd = maxDim * 0.13;
    const period = 3.2, span = 2 * half + 4 * Wd;
    const front = -half - 2 * Wd + span * ((t / period) % 1);
    const gust = A * maxDim * 0.09 * (0.8 + 0.4 * Perlin.noise3(Math.floor(t / period) * 0.9, 1.1, 0.3));
    const breeze = A * maxDim * 0.006;
    _renderDisp(ctx, shapes, col, (x, y, out) => {
      const s = (x - ccx) * ux + (y - ccy) * uy;
      const ds = s - front;
      // Lines bend quickly as the front arrives and recover slowly behind it.
      const q = ds > 0 ? ds / Wd : ds / (Wd * 2.5), g = Math.exp(-q * q);
      const n = Perlin.noise3(x * fq * 2, y * fq * 2, t * 0.8);
      const along = gust * g * (0.75 + 0.4 * n) + breeze * Perlin.noise3(x * fq, y * fq, t * 0.5);
      const across = gust * 0.3 * g * Perlin.noise3(x * fq * 2 + 50, y * fq * 2, t * 0.8);
      out[0] = x + ux * along - uy * across;
      out[1] = y + uy * along + ux * across;
    });
    ctx.restore();
    return;
  }

  /* ---------- Morph: blend into a second SVG and back, noise easing the in-between ---------- */
  if (mode === 'morph') {
    _morphDraw(ctx, Z, o, col, fq);
    ctx.restore();
    return;
  }

  /* ---------- Shatter: the drawing breaks along Perlin lines; fragments drift apart and rejoin ---------- */
  if (mode === 'shatter') {
    _shatterDraw(ctx, Z, o, col, S, OX, OY);
    ctx.restore();
    return;
  }

  /* ======================= Reveal modes: clip a cached render ======================= */

  /* ---------- Ink spread: ink soaks in from Perlin-placed blots ---------- */
  if (mode === 'ink') {
    // 11 s loop: soak in over ~8 s → hold → fade
    const ph = t % 11, cyc = Math.floor(t / 11);
    const fade = ph > 10 ? 1 - (ph - 10) : 1;
    const blots = _blots(Z, cyc, ph, 6, 6, 2.5, 0.7, 0.85);
    const img = _staticLayer(ctx, Z, o, col);
    ctx.globalAlpha = 0.28 * fade;                       // wet halo just beyond the edge
    _clipDraw(ctx, img, blots.map(b => ({ ...b, r: b.r * 1.07 })), setM);
    ctx.globalAlpha = fade;
    _clipDraw(ctx, img, blots, setM);
    ctx.restore();
    return;
  }

  /* ---------- Scan: a noisy scanline sweeps across, drawing everything it passes ---------- */
  if (mode === 'scan') {
    const ph = t % 7, cyc = Math.floor(t / 7);
    const fade = ph > 6.5 ? 1 - (ph - 6.5) * 2 : 1;
    const th = Math.PI * 2 * (0.5 + 0.5 * Perlin.noise3(cyc * 0.77, 3.1, 0.4)) * 1.5;
    const ux = Math.cos(th), uy = Math.sin(th);
    const half = 0.5 * Math.hypot(vb.w, vb.h), wob = maxDim * 0.05 * (0.5 + A);
    const pos = -half - wob + (2 * half + 2 * wob) * _ease(_clamp(ph / 5));
    const front = [];
    for (let i = 0; i <= 80; i++) {
      const u = -half + (2 * half * i) / 80;
      const f = pos + wob * Perlin.fbm(u * fq * 2, ph * 0.4, cyc + 0.5, 2);
      front.push(ccx + ux * f - uy * u, ccy + uy * f + ux * u);
    }
    const img = _staticLayer(ctx, Z, o, col);
    const P = new Path2D();
    P.moveTo(front[0], front[1]);
    for (let i = 2; i < front.length; i += 2) P.lineTo(front[i], front[i + 1]);
    const back = half * 3;
    P.lineTo(front[front.length - 2] - ux * back, front[front.length - 1] - uy * back);
    P.lineTo(front[0] - ux * back, front[1] - uy * back);
    ctx.save(); setM(1, 0, 0, 1, 0, 0); ctx.clip(P);
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = fade; ctx.drawImage(img, 0, 0); ctx.restore();
    if (ph < 5.2) {                                       // the glowing scanline itself
      const line = new Path2D();
      line.moveTo(front[0], front[1]);
      for (let i = 2; i < front.length; i += 2) line.lineTo(front[i], front[i + 1]);
      ctx.strokeStyle = o.accent || o.ink;
      ctx.globalAlpha = 0.15; ctx.lineWidth = unit * 8; ctx.stroke(line);
      ctx.globalAlpha = 0.85; ctx.lineWidth = unit * 1.6; ctx.stroke(line);
    }
    ctx.restore();
    return;
  }

  /* ---------- Grow: the drawing grows out from a seed with tendril-like Perlin edges ---------- */
  if (mode === 'grow') {
    const ph = t % 8, cyc = Math.floor(t / 8);
    const fade = ph > 7.5 ? 1 - (ph - 7.5) * 2 : 1;
    const sx = vb.x + vb.w * (0.5 + 0.35 * Perlin.noise3(cyc * 1.3, 0.2, 5.5));
    const sy = vb.y + vb.h * (0.5 + 0.35 * Perlin.noise3(cyc * 1.3, 7.7, 5.5));
    const reach = Math.hypot(Math.max(sx - vb.x, vb.x + vb.w - sx), Math.max(sy - vb.y, vb.y + vb.h - sy)) * 1.6;
    const R = reach * 0.8 * Math.pow(_clamp(ph / 6.5), 1.15);
    const blob = { x: sx, y: sy, r: R, rough: 0.45, oct: 4, key: cyc * 3.3, z: ph * 0.1, freq: 2.2 };
    const img = _staticLayer(ctx, Z, o, col);
    ctx.globalAlpha = fade;
    _clipDraw(ctx, img, [blob], setM);
    if (ph < 6.6 && R > 0) {                              // faint growing edge in the accent colour
      ctx.save(); setM(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 0.35; ctx.strokeStyle = o.accent || o.ink; ctx.lineWidth = unit * 1.2;
      ctx.stroke(_blobPath(blob)); ctx.restore();
    }
    ctx.restore();
    return;
  }

  /* ---------- Erase & redraw: pen draws, ink dissolves away along noise, pen draws again ---------- */
  if (mode === 'redraw') {
    // 12 s loop: draw 7 s → hold 1.5 s → dissolve 3 s → empty 0.5 s
    const ph = t % 12, cyc = Math.floor(t / 12);
    if (ph < 7) {
      _penTrace(ctx, Z, o, ph / 7, col, fq);
    } else if (ph < 11.5) {
      const img = _staticLayer(ctx, Z, o, col);
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(img, 0, 0); ctx.restore();
      if (ph > 8.5) {
        // Paper-coloured blots grow from Perlin-placed spots and swallow the ink.
        const blots = _blots(Z, cyc + 100, ph - 8.5, 7, 2.6, 0.6, 0.55, 1.0);
        setM(1, 0, 0, 1, 0, 0);
        const U = new Path2D(), U2 = new Path2D();
        for (const b of blots) { U.addPath(_blobPath(b)); U2.addPath(_blobPath({ ...b, r: b.r * 1.08 })); }
        ctx.fillStyle = o.paper || '#fff';
        ctx.globalAlpha = 0.45; ctx.fill(U2);
        ctx.globalAlpha = 1; ctx.fill(U);
      }
    }
    ctx.restore();
    return;
  }

  // Unknown mode: draw the drawing as it is.
  _renderBatched(ctx, shapes, col, (P, sh) => P.addPath(sh.path));
  ctx.restore();
}

/*
 * Shared renderer for modes that rebuild paths every frame.
 * Filled shapes are drawn one by one (each with its fill rule); consecutive stroke-only shapes
 * with the same style are merged into a single stroke() call.
 */
function _renderBatched(ctx, shapes, colorOf, append) {
  let batch = null, bStyle = '', bW = 0, bA = 1;
  const flush = () => {
    if (!batch) return;
    ctx.globalAlpha = bA; ctx.strokeStyle = bStyle; ctx.lineWidth = bW; ctx.stroke(batch);
    batch = null;
  };
  for (const sh of shapes) {
    if (sh.fill) {
      flush();
      const P = new Path2D();
      append(P, sh);
      ctx.globalAlpha = sh.fillAlpha; ctx.fillStyle = colorOf(sh.fill); ctx.fill(P, sh.rule);
      if (sh.stroke) { ctx.globalAlpha = sh.strokeAlpha; ctx.strokeStyle = colorOf(sh.stroke); ctx.lineWidth = sh.sw; ctx.stroke(P); }
    } else if (sh.stroke) {
      const style = colorOf(sh.stroke);
      if (!batch || style !== bStyle || sh.sw !== bW || sh.strokeAlpha !== bA) {
        flush(); batch = new Path2D(); bStyle = style; bW = sh.sw; bA = sh.strokeAlpha;
      }
      append(batch, sh);
    }
  }
  flush();
}

/* ============================== Shared helpers ============================== */

/* Canvas scale/offset that fits the drawing on screen (device pixels). */
function _view(Z, o) {
  const { vb } = Z, dpr = o.density || 1, margin = o.margin ?? 0.06;
  const sc = Math.min(o.width / vb.w, o.height / vb.h) * (1 - margin * 2);
  return {
    S: sc * dpr, dpr,
    OX: ((o.width - vb.w * sc) / 2 - vb.x * sc) * dpr,
    OY: ((o.height - vb.h * sc) / 2 - vb.y * sc) * dpr,
  };
}

/* Reusable off-screen canvases, by name. */
const _B = {};
function _buf(name, W, H) {
  let c = _B[name];
  if (!c) c = _B[name] = document.createElement('canvas');
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; c._fresh = true; }
  return c;
}

/* Pen trace used by Draw and Erase & redraw. T goes 0 → 1 over the drawing. */
function _penTrace(ctx, Z, o, T, col, fq) {
  const { shapes, unit } = Z, A = o.amount;
  // Time each shape takes to draw. With few shapes (a traced drawing is often just one) each one
  // gets a bigger share, so the pen still takes the whole drawing time.
  const w = Math.max(0.12 + 0.25 * (1 - A), Math.min(1, 1.5 / Math.sqrt(shapes.length)));
  if (o.order === 'noise') _ensureNoiseRank(Z, fq, o.seed);
  for (const sh of shapes) {
    const rank = o.order === 'doc' ? sh.rankDoc : o.order === 'noise' ? sh.rankNoise : sh.rankCenter;
    const f = _clamp((T - rank * (1 - w)) / w);
    if (f <= 0) continue;
    const done = f >= 1;
    const P = done ? sh.path : new Path2D();
    if (!done) _append(P, sh, Math.floor(sh.npts * _ease(f)));
    const fillA = _clamp((f - 0.75) / 0.25);
    if (sh.fill && fillA > 0) {
      ctx.globalAlpha = sh.fillAlpha * fillA; ctx.fillStyle = col(sh.fill);
      ctx.fill(fillA < 1 ? sh.path : P, sh.rule);
    }
    if (sh.stroke) {
      ctx.globalAlpha = sh.strokeAlpha; ctx.strokeStyle = col(sh.stroke); ctx.lineWidth = sh.sw; ctx.stroke(P);
    } else if (fillA < 1) {   // fill-only shapes (traced art): sketch the outline first
      ctx.globalAlpha = sh.fillAlpha * (1 - fillA); ctx.strokeStyle = col(sh.fill); ctx.lineWidth = unit * 1.2; ctx.stroke(P);
    }
  }
}

/* Draw every shape with each point moved by disp(x, y, out). */
function _renderDisp(ctx, shapes, col, disp) {
  const out = [0, 0];
  _renderBatched(ctx, shapes, col, (P, sh) => {
    const xy = sh.xy, st = sh.starts, nc = st.length - 1;
    for (let c = 0; c < nc; c++) {
      const a = st[c], b = st[c + 1];
      let sx = 0, sy = 0;
      for (let i = a; i < b; i++) {
        disp(xy[2 * i], xy[2 * i + 1], out);
        if (i === a) { P.moveTo(out[0], out[1]); sx = out[0]; sy = out[1]; } else P.lineTo(out[0], out[1]);
      }
      if (sh.closed[c]) P.lineTo(sx, sy);
    }
  });
}

/* Lens centre: the mouse if it's over the canvas, otherwise a slow Perlin wander. */
function _lensCenter(Z, o, t, dpr, S, OX, OY) {
  if (o.pointer) return { x: (o.pointer.x * dpr - OX) / S, y: (o.pointer.y * dpr - OY) / S };
  const { vb } = Z;
  return {
    x: vb.x + vb.w * (0.5 + 0.55 * Perlin.noise3(1.1, 0.3, t * 0.15)),
    y: vb.y + vb.h * (0.5 + 0.55 * Perlin.noise3(6.6, 2.9, t * 0.15)),
  };
}

/*
 * The still drawing, rendered once into a device-size canvas and reused every frame by the
 * reveal modes and Shatter. Re-rendered only when size or colours change.
 */
function _staticLayer(ctx, Z, o, col) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const { S, OX, OY } = _view(Z, o);
  const key = [W, H, S, OX, OY, o.ink, o.paper, o.useOriginal].join('|');
  let L = Z._static;
  if (L && L.key === key) return L.canvas;
  const c = (L && L.canvas) || document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.setTransform(S, 0, 0, S, OX, OY);
  g.lineJoin = 'round'; g.lineCap = 'round';
  for (const sh of Z.shapes) {
    if (sh.fill) { g.globalAlpha = sh.fillAlpha; g.fillStyle = col(sh.fill); g.fill(sh.path, sh.rule); }
    if (sh.stroke) { g.globalAlpha = sh.strokeAlpha; g.strokeStyle = col(sh.stroke); g.lineWidth = sh.sw; g.stroke(sh.path); }
  }
  Z._static = { key, canvas: c };
  return c;
}

/*
 * Organic blots: K centres placed by Perlin noise (new places each cycle), each starting a
 * little after the last and growing fast at first, then slower, like ink soaking into paper.
 */
function _blots(Z, cyc, ph, K, growDur, stagger, rScale = 0.7, curve = 0.8) {
  const { vb, maxDim } = Z, out = [];
  for (let i = 0; i < K; i++) {
    const ti = (i / K) * stagger;
    const g = _clamp((ph - ti) / growDur);
    if (g <= 0) continue;
    out.push({
      x: vb.x + vb.w * (0.5 + 0.6 * Perlin.noise3(i * 3.1 + cyc * 17.3, 0.5, 1.0)),
      y: vb.y + vb.h * (0.5 + 0.6 * Perlin.noise3(i * 3.1 + cyc * 17.3, 8.5, 1.0)),
      r: maxDim * rScale * Math.pow(g, curve),
      rough: 0.25, oct: 3, key: i * 7.1 + cyc, z: ph * 0.15, freq: 1.5,
    });
  }
  return out;
}

/* A blot outline: a circle whose radius is bent by fractal Perlin noise around its edge. */
function _blobPath(b) {
  const P = new Path2D(), n = 90;
  for (let k = 0; k <= n; k++) {
    const th = (k / n) * Math.PI * 2, c = Math.cos(th), s = Math.sin(th);
    const r = Math.max(0, b.r * (1 + b.rough * Perlin.fbm(c * b.freq + b.key, s * b.freq + b.key * 0.7, b.z, b.oct)));
    k ? P.lineTo(b.x + c * r, b.y + s * r) : P.moveTo(b.x + c * r, b.y + s * r);
  }
  return P;
}

/* Draw the cached image only inside the union of the blots. */
function _clipDraw(ctx, img, blots, setM) {
  if (!blots.length) return;
  const U = new Path2D();
  for (const b of blots) U.addPath(_blobPath(b));
  ctx.save();
  setM(1, 0, 0, 1, 0, 0);
  ctx.clip(U);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

/* ============================== Shatter ============================== */
/*
 * A grid whose corners are pushed around by Perlin noise cuts the drawing into irregular
 * fragments ("noise lines"). Each fragment is the cached render clipped to its cell, moved and
 * turned on its own. 7.5 s loop: whole → fly apart → float → rejoin.
 */
function _shatterDraw(ctx, Z, o, col, S, OX, OY) {
  const { vb, maxDim } = Z, t = o.time, A = o.amount;
  const ph = t % 7.5, cyc = Math.floor(t / 7.5);
  const env = ph < 1.5 ? 0 : ph < 3.5 ? _ease((ph - 1.5) / 2) : ph < 5 ? 1 : ph < 7 ? 1 - _ease((ph - 5) / 2) : 0;
  const img = _staticLayer(ctx, Z, o, col);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (env < 0.002) { ctx.drawImage(img, 0, 0); ctx.restore(); return; }

  const n = Math.max(3, Math.min(14, Math.round((o.noiseScale || 3) * 2)));   // fragments across
  const cs = Math.max(vb.w, vb.h) / n;
  const nx = Math.ceil((vb.w + cs) / cs), ny = Math.ceil((vb.h + cs) / cs);
  const x0 = vb.x - cs / 2, y0 = vb.y - cs / 2, J = cs * 0.38, zc = cyc * 3.1 + 0.5;
  const node = (i, j) => [
    S * (x0 + i * cs + J * Perlin.noise3(i * 0.71, j * 0.71, zc)) + OX,
    S * (y0 + j * cs + J * Perlin.noise3(i * 0.71 + 40, j * 0.71, zc)) + OY,
  ];
  const nodes = [];
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) nodes.push(node(i, j));
  const N = (i, j) => nodes[j * (nx + 1) + i];
  const cdx = S * Z.center[0] + OX, cdy = S * Z.center[1] + OY;

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const q = [N(i, j), N(i + 1, j), N(i + 1, j + 1), N(i, j + 1)];
      const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
      let ux = cx - cdx, uy = cy - cdy;
      const len = Math.hypot(ux, uy) || 1; ux /= len; uy /= len;
      const nn = Perlin.noise3(i * 0.53 + cyc, j * 0.53, 2.2);
      const dist = S * A * maxDim * 0.12 * env * (0.6 + 0.8 * Math.abs(nn));
      const drift = S * A * maxDim * 0.02 * env;
      const dx = ux * dist + drift * Perlin.noise3(i, j, t * 0.5), dy = uy * dist + drift * Perlin.noise3(i + 9, j, t * 0.5);
      const rot = A * 0.6 * env * Perlin.noise3(i * 0.9, j * 0.9, cyc + 7.7);
      const co = Math.cos(rot), si = Math.sin(rot);
      ctx.save();
      ctx.setTransform(co, si, -si, co, cx - (co * cx - si * cy) + dx, cy - (si * cx + co * cy) + dy);
      ctx.beginPath();
      ctx.moveTo(q[0][0], q[0][1]); ctx.lineTo(q[1][0], q[1][1]); ctx.lineTo(q[2][0], q[2][1]); ctx.lineTo(q[3][0], q[3][1]);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(img, 0, 0);
      ctx.restore();
    }
  }
  ctx.restore();
}

/* ============================== Morph ============================== */
/*
 * Setup (once per pair of drawings): every contour of both drawings is listed with its role
 * (solid, hole or line). Each contour of A is matched with the nearest similar-sized contour
 * of B with the same role; leftovers grow from, or shrink to, a point. Matched contours are
 * resampled to the same number of points, lined up (same start, same direction), so each frame
 * is a simple blend. Every contour gets a Perlin delay, so the morph ripples across the drawing.
 */
function _contoursOf(Z, map, swScale) {
  const out = [];
  for (const sh of Z.shapes) {
    const xy = sh.xy, st = sh.starts, nc = st.length - 1, list = [];
    let refA = 0, refS = 1;
    for (let c = 0; c < nc; c++) {
      const a = st[c], b = st[c + 1], n = b - a, pts = new Float32Array(n * 2);
      let sx = 0, sy = 0, area = 0;
      for (let i = 0; i < n; i++) {
        let x = xy[2 * (a + i)], y = xy[2 * (a + i) + 1];
        if (map) { const m = map(x, y); x = m[0]; y = m[1]; }
        pts[2 * i] = x; pts[2 * i + 1] = y; sx += x; sy += y;
      }
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        area += pts[2 * i] * pts[2 * j + 1] - pts[2 * j] * pts[2 * i + 1];
      }
      const cx = sx / n, cy = sy / n;
      let size = 0;
      for (let i = 0; i < n; i++) size = Math.max(size, Math.hypot(pts[2 * i] - cx, pts[2 * i + 1] - cy));
      list.push({ pts, closed: !!sh.closed[c], cx, cy, size, area, sh, sw: sh.sw * swScale });
      if (Math.abs(area) > refA) { refA = Math.abs(area); refS = Math.sign(area) || 1; }
    }
    for (const k of list) {
      k.role = !sh.fill ? 'line' : Math.sign(k.area) === refS ? 'solid' : 'hole';
      // Normalise direction: solids one way, holes the other, so all fills combine with "nonzero".
      const want = k.role === 'hole' ? -1 : 1;
      if (k.role !== 'line' && Math.sign(k.area) !== want) _reversePts(k.pts);
      out.push(k);
    }
  }
  return out;
}

function _reversePts(p) {
  for (let i = 0, j = p.length - 2; i < j; i += 2, j -= 2) {
    const x = p[i], y = p[i + 1]; p[i] = p[j]; p[i + 1] = p[j + 1]; p[j] = x; p[j + 1] = y;
  }
}

function _resample(pts, closed, N) {
  const n = pts.length / 2, out = new Float32Array(N * 2);
  if (n < 2) { for (let i = 0; i < N; i++) { out[2 * i] = pts[0]; out[2 * i + 1] = pts[1]; } return out; }
  const segs = closed ? n : n - 1, cum = new Float32Array(segs + 1);
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    cum[i + 1] = cum[i] + Math.hypot(pts[2 * j] - pts[2 * i], pts[2 * j + 1] - pts[2 * i + 1]);
  }
  const L = cum[segs] || 1;
  let s = 0;
  for (let k = 0; k < N; k++) {
    const d = (closed ? k / N : k / (N - 1)) * L;
    while (s < segs - 1 && cum[s + 1] < d) s++;
    const j = (s + 1) % n, f = (d - cum[s]) / ((cum[s + 1] - cum[s]) || 1);
    out[2 * k] = pts[2 * s] + (pts[2 * j] - pts[2 * s]) * f;
    out[2 * k + 1] = pts[2 * s + 1] + (pts[2 * j + 1] - pts[2 * s + 1]) * f;
  }
  return out;
}

function _morphSetup(Z, ZB) {
  if (Z.morph && Z.morph.target === ZB) return Z.morph;
  const a = Z.vb, b = ZB.vb;
  const s = Math.min(a.w / b.w, a.h / b.h);
  const ox = a.x + (a.w - b.w * s) / 2 - b.x * s, oy = a.y + (a.h - b.h * s) / 2 - b.y * s;
  const CA = _contoursOf(Z, null, 1), CB = _contoursOf(ZB, (x, y) => [x * s + ox, y * s + oy], s);
  const fq0 = 3 / Z.maxDim;
  CA.sort((p, q) => q.size - p.size);
  const used = new Uint8Array(CB.length), pairs = [];
  const point = k => ({ pts: new Float32Array([k.cx, k.cy]), closed: k.closed, cx: k.cx, cy: k.cy, size: 0, role: k.role, sh: null, sw: k.sw });
  for (const ka of CA) {
    let best = -1, bc = Infinity;
    for (let j = 0; j < CB.length; j++) {
      if (used[j]) continue;
      const kb = CB[j];
      if ((ka.role === 'hole') !== (kb.role === 'hole')) continue;
      const c = Math.hypot(ka.cx - kb.cx, ka.cy - kb.cy) + 0.7 * Math.abs(ka.size - kb.size);
      if (c < bc) { bc = c; best = j; }
    }
    if (best >= 0) { used[best] = 1; pairs.push([ka, CB[best]]); } else pairs.push([ka, point(ka)]);
  }
  CB.forEach((kb, j) => { if (!used[j]) pairs.push([point(kb), kb]); });

  const P = pairs.map(([ka, kb]) => {
    const closed = ka.closed || kb.closed;
    const N = Math.max(8, Math.min(240, Math.max(ka.pts.length, kb.pts.length) / 2 | 0));
    const A = _resample(ka.pts, closed, N);
    let B = _resample(kb.pts, closed, N);
    if (ka.size && kb.size) {
      if (closed) {                                 // start at the point of B nearest A's start
        let bi = 0, bd = Infinity;
        for (let i = 0; i < N; i++) { const d = (B[2 * i] - A[0]) ** 2 + (B[2 * i + 1] - A[1]) ** 2; if (d < bd) { bd = d; bi = i; } }
        if (bi) { const R = new Float32Array(N * 2); for (let i = 0; i < N; i++) { R[2 * i] = B[2 * ((i + bi) % N)]; R[2 * i + 1] = B[2 * ((i + bi) % N) + 1]; } B = R; }
      } else {                                      // open lines: run the same way
        const e = 2 * (N - 1);
        const same = Math.hypot(A[0] - B[0], A[1] - B[1]) + Math.hypot(A[e] - B[e], A[e + 1] - B[e + 1]);
        const flip = Math.hypot(A[0] - B[e], A[1] - B[e + 1]) + Math.hypot(A[e] - B[0], A[e + 1] - B[1]);
        if (flip < same) _reversePts(B);
      }
    }
    const cx = ka.size ? ka.cx : kb.cx, cy = ka.size ? ka.cy : kb.cy;
    return {
      A, B, N, closed,
      sa: ka.sh || kb.sh, sb: kb.sh || ka.sh, swa: ka.sh ? ka.sw : kb.sw, swb: kb.sh ? kb.sw : ka.sw,
      delay: 0.35 * (0.5 + 0.5 * Perlin.noise3(cx * fq0, cy * fq0, 4.4)),
    };
  });
  Z.morph = { target: ZB, pairs: P };
  return Z.morph;
}

let _demo2Z = null;
function _morphDraw(ctx, Z, o, col, fq) {
  const ZB = o.morphTarget || _demo2Z || (_demo2Z = zenParse(zenDemoSVG2()));
  const M = _morphSetup(Z, ZB);
  const t = o.time, A = o.amount, maxDim = Z.maxDim;
  // 12 s loop: A 1.5 s → morph 4.5 s → B 1.5 s → morph back 4.5 s
  const ph = t % 12;
  const m = ph < 1.5 ? 0 : ph < 6 ? (ph - 1.5) / 4.5 : ph < 7.5 ? 1 : 1 - (ph - 7.5) / 4.5;
  const amp = (0.3 + A) * maxDim * 0.04;
  const fills = new Map(), strokes = new Map();
  for (const p of M.pairs) {
    const u = _ease(_clamp((m - p.delay) / 0.65));
    const sh = u < 0.5 ? p.sa : p.sb;
    const wob = amp * Math.sin(Math.PI * u);
    let P;
    if (sh.fill) {
      const key = col(sh.fill);
      P = fills.get(key); if (!P) fills.set(key, (P = new Path2D()));
    } else {
      const sw = p.swa + (p.swb - p.swa) * u, key = col(sh.stroke) + '|' + sw.toFixed(3);
      P = strokes.get(key); if (!P) strokes.set(key, (P = new Path2D()));
    }
    const a = p.A, b = p.B;
    let sx = 0, sy = 0;
    for (let i = 0; i < p.N; i++) {
      let x = a[2 * i] + (b[2 * i] - a[2 * i]) * u, y = a[2 * i + 1] + (b[2 * i + 1] - a[2 * i + 1]) * u;
      if (wob) {                                    // noise ripples through the in-between shapes
        x += wob * Perlin.noise3(x * fq * 2, y * fq * 2, t * 0.5);
        y += wob * Perlin.noise3(x * fq * 2 + 31, y * fq * 2, t * 0.5);
      }
      if (i) P.lineTo(x, y); else { P.moveTo(x, y); sx = x; sy = y; }
    }
    if (p.closed) P.lineTo(sx, sy);
  }
  ctx.globalAlpha = 1;
  for (const [c, P] of fills) { ctx.fillStyle = c; ctx.fill(P, 'nonzero'); }
  for (const [k, P] of strokes) {
    const [c, w] = k.split('|');
    ctx.strokeStyle = c; ctx.lineWidth = +w; ctx.stroke(P);
  }
}

/* A second demo tile, used as the morph target until you load your own. */
function zenDemoSVG2() {
  const S = 400, c = S / 2, P = [];
  const f = n => n.toFixed(2);
  const inkW = w => `stroke="#111" stroke-width="${w}" fill="none"`;
  P.push(`<rect x="18" y="18" width="364" height="364" rx="40" ${inkW(2)}/>`);
  P.push(`<circle cx="${c}" cy="${c}" r="165" ${inkW(1.5)}/>`, `<circle cx="${c}" cy="${c}" r="150" ${inkW(1.2)}/>`);
  // golden-angle spiral of circles
  for (let i = 1; i < 90; i++) {
    const a = i * 2.39996, r = 9 * Math.sqrt(i) + 18, rr = 2 + i * 0.055;
    if (r > 140) break;
    P.push(`<circle cx="${f(c + r * Math.cos(a))}" cy="${f(c + r * Math.sin(a))}" r="${f(rr)}" ${i % 3 ? inkW(1.2) : 'fill="#111"'}/>`);
  }
  // eight-point star
  let d = '';
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2 - Math.PI / 2, r = i % 2 ? 16 : 38;
    d += (i ? 'L' : 'M') + f(c + r * Math.cos(a)) + ' ' + f(c + r * Math.sin(a));
  }
  P.push(`<path d="${d}Z" ${inkW(1.6)}/>`, `<circle cx="${c}" cy="${c}" r="7" fill="#111"/>`);
  // corner squares
  [[60, 60], [340, 60], [60, 340], [340, 340]].forEach(([x, y]) => {
    for (let k = 0; k < 4; k++) {
      const h = 22 - k * 5;
      P.push(`<rect x="${x - h}" y="${y - h}" width="${2 * h}" height="${2 * h}" transform="rotate(${k * 12} ${x} ${y})" ${inkW(1.2)}/>`);
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}">${P.join('')}</svg>`;
}

/* ============================== Overlays ============================== */

/* Kaleidoscope: N mirrored wedges around the drawing's centre; the source slowly turns on noise. */
function _kaleido(src, Z, o, W, H) {
  const out = _buf('kal', W, H), c = out.getContext('2d');
  const { S, OX, OY } = _view(Z, o);
  const cx = Z.center[0] * S + OX, cy = Z.center[1] * S + OY;
  const N = Math.max(2, (o.wedges | 0) || 8), a = (2 * Math.PI) / N;
  const phi = 0.9 * Perlin.noise3(0.3, o.time * 0.06, 7.7);
  const R = Math.hypot(W, H), beta = -Math.PI / 2;
  const c2 = Math.cos(2 * beta), s2 = Math.sin(2 * beta), deg = 180 / Math.PI;
  c.setTransform(1, 0, 0, 1, 0, 0); c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1;
  c.fillStyle = o.paper || '#fff'; c.fillRect(0, 0, W, H);
  for (let k = 0; k < N; k++) {
    const a0 = beta - a / 2 + k * a;
    c.save();
    c.beginPath(); c.moveTo(cx, cy); c.arc(cx, cy, R, a0 - 0.003, a0 + a + 0.003); c.closePath(); c.clip();
    // wedge k = rotate by k·a, mirroring every other wedge so the seams match up
    let m = new DOMMatrix().translate(cx, cy).rotate(k * a * deg);
    if (k % 2) m = m.multiply(new DOMMatrix([c2, s2, s2, -c2, 0, 0]));
    m = m.rotate(-phi * deg).translate(-cx, -cy);
    c.setTransform(m);
    c.drawImage(src, 0, 0);
    c.restore();
  }
  return out;
}

/* Paper texture tile: soft Perlin fibres plus fine speckle, centred on mid-grey for "overlay". */
let _grain = null;
function _grainTex() {
  if (_grain) return _grain;
  const n = 256, c = document.createElement('canvas'); c.width = c.height = n;
  const g = c.getContext('2d'), img = g.createImageData(n, n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    // tileable fibres: sample noise on a torus
    const u = (x / n) * Math.PI * 2, v = (y / n) * Math.PI * 2;
    const fib = Perlin.fbm(Math.cos(u) * 3, Math.sin(u) * 3 + Math.cos(v) * 9, Math.sin(v) * 9, 3);
    const val = 128 + 46 * fib + 34 * (Math.random() - 0.5);
    const q = 4 * (y * n + x);
    img.data[q] = img.data[q + 1] = img.data[q + 2] = val; img.data[q + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return (_grain = c);
}

/* Ink bleed (soft spread of the ink into the paper) + animated paper grain. */
function _bleedGrain(cv, o, W, H) {
  const c = cv.getContext('2d'), amt = o.grainAmt ?? 0.5, light = _isLight(o.paper || '#fff');
  const sw = Math.max(8, (W / 3) | 0), sh = Math.max(8, (H / 3) | 0);
  const sm = _buf('bleed', sw, sh), sc = sm.getContext('2d');
  sc.imageSmoothingEnabled = true; sc.imageSmoothingQuality = 'high';
  sc.drawImage(cv, 0, 0, sw, sh);
  c.save(); c.setTransform(1, 0, 0, 1, 0, 0);
  c.imageSmoothingEnabled = true;
  c.globalCompositeOperation = light ? 'darken' : 'lighten';
  c.globalAlpha = 0.65 * amt;
  c.drawImage(sm, 0, 0, W, H);
  // grain shifts 12 times a second, like film
  const f = Math.floor((o.time || 0) * 12), ox = (f * 97) % 256, oy = (f * 61) % 256;
  c.globalCompositeOperation = 'overlay'; c.globalAlpha = 0.85 * amt;
  c.fillStyle = c.createPattern(_grainTex(), 'repeat');
  c.translate(-ox, -oy); c.fillRect(ox, oy, W, H);
  c.restore();
}

/* Glow / bloom: two blurred copies (made by shrinking and re-enlarging) blended back in. */
function _glow(cv, o, W, H) {
  const c = cv.getContext('2d'), amt = o.glowAmt ?? 0.6, light = _isLight(o.paper || '#fff');
  const w1 = Math.max(8, (W / 4) | 0), h1 = Math.max(8, (H / 4) | 0);
  const w2 = Math.max(4, (W / 14) | 0), h2 = Math.max(4, (H / 14) | 0);
  const b1 = _buf('g1', w1, h1), b2 = _buf('g2', w2, h2);
  const g1 = b1.getContext('2d'), g2 = b2.getContext('2d');
  g1.imageSmoothingEnabled = g2.imageSmoothingEnabled = true;
  g1.imageSmoothingQuality = g2.imageSmoothingQuality = 'high';
  g1.drawImage(cv, 0, 0, w1, h1);
  g2.drawImage(b1, 0, 0, w2, h2);
  c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.imageSmoothingEnabled = true;
  // Light paper: a soft ink halo (darken). Dark paper: neon light (lighten, plus a screen boost).
  c.globalCompositeOperation = light ? 'darken' : 'lighten';
  c.globalAlpha = amt; c.drawImage(b1, 0, 0, W, H); c.drawImage(b2, 0, 0, W, H);
  if (!light) { c.globalCompositeOperation = 'screen'; c.globalAlpha = amt * 0.6; c.drawImage(b2, 0, 0, W, H); c.drawImage(b1, 0, 0, W, H); }
  c.restore();
}

/* Echo trails: blend in the previous frames, fading towards the paper colour each frame. */
function zenResetEcho() { if (_B.echo) _B.echo._fresh = true; }
function _echo(ctx, o, W, H) {
  const e = _buf('echo', W, H), ec = e.getContext('2d'), light = _isLight(o.paper || '#fff');
  ec.setTransform(1, 0, 0, 1, 0, 0);
  if (!e._fresh) {
    const keep = 0.6 + 0.37 * (o.echoAmt ?? 0.7);         // how long trails last
    ec.globalCompositeOperation = 'source-over';
    ec.globalAlpha = 1 - keep; ec.fillStyle = o.paper || '#fff'; ec.fillRect(0, 0, W, H);
    // 8-bit rounding stops that fade 1–2 shades short of the paper, which would leave a grey haze.
    // Nudge every pixel one more step towards the paper and clamp it there.
    ec.globalAlpha = 1;
    if (light) {
      ec.globalCompositeOperation = 'lighter'; ec.fillStyle = 'rgb(3,3,3)'; ec.fillRect(0, 0, W, H);
      ec.globalCompositeOperation = 'darken';
    } else {
      ec.fillStyle = 'rgba(0,0,0,0.05)'; ec.fillRect(0, 0, W, H);
      ec.globalCompositeOperation = 'lighten';
    }
    ec.fillStyle = o.paper || '#fff'; ec.fillRect(0, 0, W, H);
    ec.globalCompositeOperation = 'source-over';
    ctx.globalCompositeOperation = light ? 'darken' : 'lighten';
    ctx.globalAlpha = 1; ctx.drawImage(e, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
  }
  ec.globalAlpha = 1; ec.globalCompositeOperation = 'copy'; ec.drawImage(ctx.canvas, 0, 0);
  ec.globalCompositeOperation = 'source-over';
  e._fresh = false;
}
/* ===================== Trippy colour: Perlin colour field ===================== */
/*
 * Colour sources wander inside the drawing on Perlin noise. Each sends out rings of hue;
 * the rings interfere where they meet, and a Perlin domain-warp bends everything into swirls.
 * The field is computed at low resolution (~150 px on the long side) and smoothly scaled up,
 * then painted through the ink of the drawing, so it works on any SVG, even one giant path.
 */
const _T = { field: null, fctx: null, img: null };

function _trippyField(Z, o, W, H, S, OX, OY) {
  const res = 110;   // the field is smooth, so a small grid scaled up looks the same
  const fw = W >= H ? res : Math.max(8, Math.round((res * W) / H));
  const fh = W >= H ? Math.max(8, Math.round((res * H) / W)) : res;
  if (!_T.field) { _T.field = document.createElement('canvas'); _T.fctx = _T.field.getContext('2d'); }
  if (_T.field.width !== fw || _T.field.height !== fh) {
    _T.field.width = fw; _T.field.height = fh; _T.img = _T.fctx.createImageData(fw, fh);
  }
  const { vb, maxDim } = Z, t = o.time, data = _T.img.data;
  const N = Math.max(1, Math.min(8, o.sources | 0 || 4));
  const lam = maxDim * (o.ringSize || 0.08);           // ring spacing
  const k = (2 * Math.PI) / lam, falloff = 1 / (maxDim * 0.35);
  const wf = (o.noiseScale || 3) / maxDim, warp = lam * 1.6;

  // Sources drift around inside the drawing, each on its own Perlin path.
  const ex = new Float32Array(N), ey = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    ex[i] = vb.x + vb.w * (0.5 + 0.6 * Perlin.noise3(i * 7.31 + 1.7, 0.5, t * 0.12));
    ey[i] = vb.y + vb.h * (0.5 + 0.6 * Perlin.noise3(i * 7.31 + 1.7, 9.5, t * 0.12));
  }
  const sx = W / fw, sy = H / fh, sat = 0.95, lit = 0.5;
  let q = 0;
  for (let j = 0; j < fh; j++) {
    const y0 = ((j + 0.5) * sy - OY) / S;
    for (let i = 0; i < fw; i++, q += 4) {
      const x0 = ((i + 0.5) * sx - OX) / S;
      // Perlin domain warp: bend space before measuring distances
      const nx = x0 * wf, ny = y0 * wf;
      const x = x0 + warp * Perlin.noise3(nx, ny, t * 0.25);
      const y = y0 + warp * Perlin.noise3(nx + 31.4, ny + 47.2, t * 0.25);
      let ph = 0, wsum = 0;
      for (let e = 0; e < N; e++) {
        const d = Math.hypot(x - ex[e], y - ey[e]);
        const w = 1 / (1 + d * falloff);               // nearby sources dominate
        ph += w * Math.sin(d * k - t * 2.4 + e * 1.7);
        wsum += w;
      }
      let h = (t * 30 + 260 * (ph / wsum) + 120 * Perlin.noise3(nx * 0.5, ny * 0.5, t * 0.1 + 5)) / 60;
      h = ((h % 6) + 6) % 6;
      // HSL → RGB
      const c = (1 - Math.abs(2 * lit - 1)) * sat, xx = c * (1 - Math.abs((h % 2) - 1)), m = lit - c / 2;
      let r, g, b;
      if (h < 1) { r = c; g = xx; b = 0; } else if (h < 2) { r = xx; g = c; b = 0; }
      else if (h < 3) { r = 0; g = c; b = xx; } else if (h < 4) { r = 0; g = xx; b = c; }
      else if (h < 5) { r = xx; g = 0; b = c; } else { r = c; g = 0; b = xx; }
      data[q] = (r + m) * 255; data[q + 1] = (g + m) * 255; data[q + 2] = (b + m) * 255; data[q + 3] = 255;
    }
  }
  _T.fctx.putImageData(_T.img, 0, 0);
  return _T.field;
}

/*
 * Trippy colour into a canvas.
 * Light paper: black ink on white, SCREEN the colour field (ink takes its colour), MULTIPLY by paper.
 * Dark paper:  white ink on black, MULTIPLY the colour field (ink takes its colour), SCREEN the paper,
 *              so the colours glow on a dark background (great with Glow for a neon look).
 */
function _trippyInto(lc, Z, o, W, H) {
  const light = _isLight(o.paper || '#fff');
  const inkC = light ? '#000' : '#fff', bgC = light ? '#fff' : '#000';
  lc.setTransform(1, 0, 0, 1, 0, 0);
  lc.globalCompositeOperation = 'source-over'; lc.globalAlpha = 1;
  lc.fillStyle = bgC; lc.fillRect(0, 0, W, H);
  _drawFrame(lc, Z, { ...o, useOriginal: false, ink: inkC, paper: bgC, accent: inkC });
  const { S, OX, OY } = _view(Z, o);
  const F = _trippyField(Z, o, W, H, S, OX, OY);
  lc.imageSmoothingEnabled = true; lc.imageSmoothingQuality = 'high';
  lc.globalCompositeOperation = light ? 'screen' : 'multiply';
  lc.drawImage(F, 0, 0, W, H);
  lc.globalCompositeOperation = light ? 'multiply' : 'screen';
  lc.fillStyle = o.paper || '#fff'; lc.fillRect(0, 0, W, H);
  lc.globalCompositeOperation = 'source-over';
}

/**
 * Draw one frame.
 *
 * Pipeline: base frame (plain, or Trippy colour) → kaleidoscope → ink bleed + grain → glow
 *           → echo trails. With no overlays on, it draws straight onto the canvas (fastest).
 *
 * Options: mode, time, amount, noiseScale, octaves, order, seed, useOriginal, ink, paper, accent,
 *   width, height, density, pointer {x, y, down}, dt,
 *   magnet: magnetKind, radius, spring, ghost · lens: lensRadius · morph: morphTarget (a parsed Z)
 *   overlays: trippy (+ sources, ringSize), glow (+ glowAmt), echo (+ echoAmt),
 *             kaleido (+ wedges), grain (+ grainAmt)
 */
function zenDraw(ctx, Z, o) {
  const post = o.kaleido || o.glow || o.grain || o.echo;
  if (!o.trippy && !post) { _drawFrame(ctx, Z, o); return; }

  const W = ctx.canvas.width, H = ctx.canvas.height;
  const base = _buf('base', W, H), bc = base.getContext('2d');
  if (o.trippy) _trippyInto(bc, Z, o, W, H);
  else {
    bc.setTransform(1, 0, 0, 1, 0, 0); bc.globalCompositeOperation = 'source-over'; bc.globalAlpha = 1;
    bc.fillStyle = o.paper || '#fff'; bc.fillRect(0, 0, W, H);
    _drawFrame(bc, Z, o);
  }
  let cur = base;
  if (o.kaleido) cur = _kaleido(cur, Z, o, W, H);
  if (o.grain) _bleedGrain(cur, o, W, H);
  if (o.glow) _glow(cur, o, W, H);

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  ctx.drawImage(cur, 0, 0);
  if (o.echo) _echo(ctx, o, W, H);
  ctx.restore();
}

function _ensureNoiseRank(Z, fq, seed) {
  const key = fq + ':' + seed;
  if (Z.noiseRank === key) return;
  const vals = Z.shapes.map(s => [s, Perlin.fbm(s.cx * fq * 0.7, s.cy * fq * 0.7, 0.5, 2)]);
  vals.sort((p, q) => p[1] - q[1]);
  const N = Math.max(1, vals.length - 1);
  vals.forEach(([s], i) => (s.rankNoise = i / N));
  Z.noiseRank = key;
}

/* ================= Demo zentangle (works before you load a file) ================= */

function zenDemoSVG() {
  const S = 400, c = S / 2, P = [];
  const f = n => n.toFixed(2);
  const pol = (r, a) => [c + r * Math.cos(a), c + r * Math.sin(a)];
  const inkW = w => `stroke="#111" stroke-width="${w}" fill="none"`;
  const ink = inkW(1.4);

  P.push(`<rect x="18" y="18" width="364" height="364" rx="10" ${inkW(2)}/>`);
  [[18, 18], [382, 18], [18, 382], [382, 382]].forEach(([x, y], i) => {
    const sx = i % 2 ? -1 : 1, sy = i < 2 ? 1 : -1;
    for (let r = 14; r <= 74; r += 12) {
      P.push(`<path d="M${f(x + sx * r)} ${y} A${r} ${r} 0 0 ${sx * sy > 0 ? 1 : 0} ${x} ${f(y + sy * r)}" ${ink}/>`);
    }
    P.push(`<circle cx="${f(x + sx * 9)}" cy="${f(y + sy * 9)}" r="4" fill="#111"/>`);
  });
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * Math.PI * 2, [x1, y1] = pol(158, a), [x2, y2] = pol(i % 2 ? 166 : 172, a);
    P.push(`<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" ${ink}/>`);
  }
  P.push(`<circle cx="${c}" cy="${c}" r="154" ${inkW(1.8)}/>`);
  for (let i = 0; i < 18; i++) {
    const a0 = (i / 18) * Math.PI * 2, a1 = ((i + 1) / 18) * Math.PI * 2, am = (a0 + a1) / 2;
    const [x0, y0] = pol(120, a0), [x1, y1] = pol(120, a1), [qx, qy] = pol(162, am), [ix, iy] = pol(140, am);
    P.push(`<path d="M${f(x0)} ${f(y0)} Q${f(qx)} ${f(qy)} ${f(x1)} ${f(y1)}" ${ink}/>`);
    P.push(`<circle cx="${f(ix)}" cy="${f(iy)}" r="${i % 2 ? 3.5 : 5}" ${i % 2 ? 'fill="#111"' : ink}/>`);
  }
  P.push(`<circle cx="${c}" cy="${c}" r="120" ${ink}/>`, `<circle cx="${c}" cy="${c}" r="112" ${ink}/>`);
  for (let i = 0; i < 24; i++) {
    const [x, y] = pol(97, (i / 24) * Math.PI * 2);
    P.push(`<circle cx="${f(x)}" cy="${f(y)}" r="6.5" ${i % 2 ? 'fill="#111"' : ink}/>`);
    if (!(i % 2)) P.push(`<circle cx="${f(x)}" cy="${f(y)}" r="2.2" fill="#111"/>`);
  }
  P.push(`<circle cx="${c}" cy="${c}" r="84" ${ink}/>`);
  [[12, 78, 0, 0.26], [12, 52, Math.PI / 12, 0.32]].forEach(([n, R, off, wdt]) => {
    for (let i = 0; i < n; i++) {
      const a = off + (i / n) * Math.PI * 2;
      const [tx, ty] = pol(R, a), [l1x, l1y] = pol(R * 0.62, a - wdt), [r1x, r1y] = pol(R * 0.62, a + wdt);
      const [bx, by] = pol(20, a);
      P.push(`<path d="M${f(bx)} ${f(by)} Q${f(l1x)} ${f(l1y)} ${f(tx)} ${f(ty)} Q${f(r1x)} ${f(r1y)} ${f(bx)} ${f(by)}Z" ${ink}/>`);
      const [m1x, m1y] = pol(R * 0.45, a), [m2x, m2y] = pol(R * 0.85, a);
      P.push(`<line x1="${f(m1x)}" y1="${f(m1y)}" x2="${f(m2x)}" y2="${f(m2y)}" ${inkW(1)}/>`);
    }
  });
  P.push(`<circle cx="${c}" cy="${c}" r="20" ${ink}/>`, `<circle cx="${c}" cy="${c}" r="12" fill="#111"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}">${P.join('')}</svg>`;
}
