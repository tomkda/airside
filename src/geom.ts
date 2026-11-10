// Small geometry toolkit. World units are metres; +x east, +y south (screen convention).

export interface Pt { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }

export const pt = (x: number, y: number): Pt => ({ x, y });
export const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: Pt, k: number): Pt => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Pt, b: Pt) => a.x * b.x + a.y * b.y;
export const len = (a: Pt) => Math.hypot(a.x, a.y);
export const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
export const norm = (a: Pt): Pt => { const l = len(a) || 1; return { x: a.x / l, y: a.y / l }; };
export const perpLeft = (d: Pt): Pt => ({ x: d.y, y: -d.x });
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const lerpPt = (a: Pt, b: Pt, t: number): Pt => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) });
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export const center = (r: Rect): Pt => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
export const area = (r: Rect) => r.w * r.h;
export const rectsOverlap = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
export const rectsTouch = (a: Rect, b: Rect, tol = 1) =>
  a.x <= b.x + b.w + tol && b.x <= a.x + a.w + tol && a.y <= b.y + b.h + tol && b.y <= a.y + a.h + tol;

export function intersectRect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  return x2 > x && y2 > y ? { x, y, w: x2 - x, h: y2 - y } : null;
}

export const inRect = (p: Pt, r: Rect, pad = 0) =>
  p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad;

/** Closest point on rect boundary/interior to p. */
export const clampToRect = (p: Pt, r: Rect, inset = 0): Pt => ({
  x: clamp(p.x, r.x + inset, r.x + r.w - inset),
  y: clamp(p.y, r.y + inset, r.y + r.h - inset),
});

/** Parameter of p projected on segment a-b (unclamped). */
export function projT(p: Pt, a: Pt, b: Pt) {
  const ab = sub(b, a); const l2 = dot(ab, ab) || 1;
  return dot(sub(p, a), ab) / l2;
}
export function segDist(p: Pt, a: Pt, b: Pt) {
  const t = clamp(projT(p, a, b), 0, 1);
  return dist(p, lerpPt(a, b, t));
}
function ccw(a: Pt, b: Pt, c: Pt) { return (c.y - a.y) * (b.x - a.x) - (b.y - a.y) * (c.x - a.x); }
export function segsIntersect(a: Pt, b: Pt, c: Pt, d: Pt) {
  const d1 = ccw(c, d, a), d2 = ccw(c, d, b), d3 = ccw(a, b, c), d4 = ccw(a, b, d);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}
export function segIntersection(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
  if (!segsIntersect(a, b, c, d)) return null;
  const r = sub(b, a), s = sub(d, c); const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / den;
  return add(a, mul(r, t));
}
export const rectCorners = (r: Rect): Pt[] =>
  [pt(r.x, r.y), pt(r.x + r.w, r.y), pt(r.x + r.w, r.y + r.h), pt(r.x, r.y + r.h)];

/** Minimum distance between a rectangle and a segment (0 if they touch). */
export function rectSegDist(r: Rect, a: Pt, b: Pt) {
  if (inRect(a, r) || inRect(b, r)) return 0;
  const c = rectCorners(r);
  for (let i = 0; i < 4; i++) if (segsIntersect(a, b, c[i], c[(i + 1) % 4])) return 0;
  let m = Infinity;
  for (const p of c) m = Math.min(m, segDist(p, a, b));
  for (let i = 0; i < 4; i++) { m = Math.min(m, segDist(a, c[i], c[(i + 1) % 4]), segDist(b, c[i], c[(i + 1) % 4])); }
  return m;
}

export function polyLen(pts: Pt[]) { let s = 0; for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]); return s; }

/** Point and heading (radians, screen) at distance d along a polyline. */
export function along(pts: Pt[], d: number): { p: Pt; ang: number } {
  if (pts.length === 1) return { p: pts[0], ang: 0 };
  let rem = Math.max(0, d);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]; const l = dist(a, b);
    if (rem <= l || i === pts.length - 1) {
      const t = l > 0 ? Math.min(1, rem / l) : 1;
      return { p: lerpPt(a, b, t), ang: Math.atan2(b.y - a.y, b.x - a.x) };
    }
    rem -= l;
  }
  const a = pts[pts.length - 2], b = pts[pts.length - 1];
  return { p: b, ang: Math.atan2(b.y - a.y, b.x - a.x) };
}

export function pointInPoly(p: Pt, poly: Pt[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5; let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const snap = (v: number, g: number) => Math.round(v / g) * g;
export const deg = (r: number) => (r * 180) / Math.PI;
export const rad = (d: number) => (d * Math.PI) / 180;

// ------------------------------------------------------------ curves and polylines (v0.11)
/** Points along a quadratic curve from a to b with control c: n chords, n + 1 points. */
export function bezPts(a: Pt, c: Pt, b: Pt, n: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) { const t = i / n, u = 1 - t; out.push({ x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y }); }
  return out;
}
/** Tightest radius along a quadratic curve. */
export function bezMinRadius(a: Pt, c: Pt, b: Pt) {
  let m = Infinity;
  const ddx = 2 * (a.x - 2 * c.x + b.x), ddy = 2 * (a.y - 2 * c.y + b.y);
  for (let i = 0; i <= 24; i++) {
    const t = i / 24; const dx = 2 * (1 - t) * (c.x - a.x) + 2 * t * (b.x - c.x), dy = 2 * (1 - t) * (c.y - a.y) + 2 * t * (b.y - c.y);
    const cr = Math.abs(dx * ddy - dy * ddx); const s = Math.hypot(dx, dy);
    if (cr > 1e-9) m = Math.min(m, (s * s * s) / cr);
  }
  return m;
}
/** A polyline moved sideways by k metres (positive = right of travel on screen), mitred at each vertex. */
export function offsetLine(pts: Pt[], k: number): Pt[] {
  if (!k) return pts;
  const out: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[Math.max(0, i - 1)], q = pts[Math.min(pts.length - 1, i + 1)];
    const d0 = i > 0 ? norm(sub(pts[i], p)) : norm(sub(q, pts[i])), d1 = i < pts.length - 1 ? norm(sub(q, pts[i])) : d0;
    const n = norm({ x: -(d0.y + d1.y), y: d0.x + d1.x });
    const cs = Math.max(0.5, -d0.y * n.x + d0.x * n.y);
    out.push({ x: pts[i].x + (n.x * k) / cs, y: pts[i].y + (n.y * k) / cs });
  }
  return out;
}
/** The part of a polyline between distances d0 and d1 along it. */
export function sliceLine(pts: Pt[], d0: number, d1: number): Pt[] {
  const out: Pt[] = []; let s = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]; const l = dist(a, b); if (l <= 0) continue;
    const e = s + l;
    if (e > d0 && s < d1) {
      if (!out.length) out.push(s >= d0 ? a : lerpPt(a, b, (d0 - s) / l));
      out.push(e <= d1 ? b : lerpPt(a, b, (d1 - s) / l));
    }
    s = e;
  }
  return out;
}
/** The outline of a strip along a polyline whose width changes from point to point. */
export function ribbon(pts: Pt[], ws: number[]): Pt[] {
  const L: Pt[] = [], R: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[Math.max(0, i - 1)], q = pts[Math.min(pts.length - 1, i + 1)];
    const d0 = i > 0 ? norm(sub(pts[i], p)) : norm(sub(q, pts[i])), d1 = i < pts.length - 1 ? norm(sub(q, pts[i])) : d0;
    const n = norm({ x: -(d0.y + d1.y), y: d0.x + d1.x }); const cs = Math.max(0.5, -d0.y * n.x + d0.x * n.y); const k = ws[i] / 2 / cs;
    L.push({ x: pts[i].x - n.x * k, y: pts[i].y - n.y * k }); R.push({ x: pts[i].x + n.x * k, y: pts[i].y + n.y * k });
  }
  return [...L, ...R.reverse()];
}
