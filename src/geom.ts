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
