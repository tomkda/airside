// Shapes (v0.17): modules that are not upright rectangles. Pure logic, no DOM.
//
//   A zone is still stored as a rectangle (x, y, w, h). A zone with `rot` is that rectangle turned about its centre:
//   an angled pier. Everything that needs the real outline asks here: its corners, whether a point is inside it,
//   where it overlaps another zone. The rectangle is the zone's own frame, so interiors are still laid out as for an
//   upright building and then turned into place.
//
//   Shapes merge: two zones on the same level whose outlines overlap are one building, joined where they overlap.
//   That is what lets an angled pier be drawn straight into a concourse and become part of it.
import { Pt, Rect, snap } from './geom';

/** `sides`: a regular polygon with that many sides, inscribed in the circle that fits the box (v0.18). 24 or more is drawn round. */
export interface Shaped extends Rect { rot?: number; sides?: number }
/** Anything that is not an upright rectangle. */
export const shaped = (z: Shaped) => !!(z.rot || z.sides);
/** How many straight facets a hall's outline has: a round one is drawn with 32. */
export const facetsOf = (z: Shaped) => (!z.sides ? 4 : z.sides >= 24 ? 32 : Math.max(3, Math.round(z.sides)));
/** A hall's outline, `grow` metres outside (or inside, if negative) the real one, with `n` facets. Clockwise on screen, first facet at the top. */
export function hallPts(z: Shaped, grow = 0, n = facetsOf(z)): Pt[] {
  const c = centreOf(z); const R = Math.max(1, Math.min(z.w, z.h) / 2 + grow); const out: Pt[] = [];
  for (let k = 0; k < n; k++) { const a = (z.rot ?? 0) - Math.PI / 2 - Math.PI / n + (k / n) * Math.PI * 2; out.push({ x: c.x + R * Math.cos(a), y: c.y + R * Math.sin(a) }); }
  return out;
}
function inPoly(p: Pt, poly: Pt[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export const centreOf = (z: Rect): Pt => ({ x: z.x + z.w / 2, y: z.y + z.h / 2 });
export function turn(p: Pt, c: Pt, ang: number): Pt {
  const cs = Math.cos(ang), sn = Math.sin(ang); const dx = p.x - c.x, dy = p.y - c.y;
  return { x: c.x + dx * cs - dy * sn, y: c.y + dx * sn + dy * cs };
}
/** A point in the zone's own (upright) frame, and back. */
export const toLocal = (z: Shaped, p: Pt): Pt => (z.rot ? turn(p, centreOf(z), -z.rot) : p);
export const toWorld = (z: Shaped, p: Pt): Pt => (z.rot ? turn(p, centreOf(z), z.rot) : p);
/** A direction (not a position) turned out of the zone's frame. */
export const dirWorld = (z: Shaped, d: Pt): Pt => (z.rot ? turn(d, { x: 0, y: 0 }, z.rot) : d);

/** The zone's outline: its four corners in the order north-west, north-east, south-east, south-west of its own frame. */
export function zonePts(z: Shaped): Pt[] {
  if (z.sides) return hallPts(z);
  const c = [{ x: z.x, y: z.y }, { x: z.x + z.w, y: z.y }, { x: z.x + z.w, y: z.y + z.h }, { x: z.x, y: z.y + z.h }];
  return z.rot ? c.map(p => toWorld(z, p)) : c;
}
export function inZone(p: Pt, z: Shaped, pad = 0): boolean {
  if (z.sides) return inPoly(p, hallPts(z, pad));
  const q = toLocal(z, p);
  return q.x >= z.x - pad && q.x <= z.x + z.w + pad && q.y >= z.y - pad && q.y <= z.y + z.h + pad;
}
/** The upright box that contains the zone. */
export function zoneBox(z: Shaped): Rect {
  if (!shaped(z)) return { x: z.x, y: z.y, w: z.w, h: z.h };
  return polyBox(zonePts(z));
}
/** The nearest point to p that is at least `margin` inside the zone. */
export function clampInto(z: Shaped, p: Pt, margin = 3): Pt {
  if (z.sides) {
    if (inPoly(p, hallPts(z, -margin))) return p;
    const c = centreOf(z); const n = facetsOf(z); const apo = (Math.min(z.w, z.h) / 2) * Math.cos(Math.PI / n) - margin - 0.5;
    const d = Math.hypot(p.x - c.x, p.y - c.y) || 1; const k = Math.max(0, apo) / d;
    return k >= 1 ? p : { x: c.x + (p.x - c.x) * k, y: c.y + (p.y - c.y) * k };
  }
  const q = toLocal(z, p);
  return toWorld(z, { x: Math.min(z.x + z.w - margin, Math.max(z.x + margin, q.x)), y: Math.min(z.y + z.h - margin, Math.max(z.y + margin, q.y)) });
}
export function polyBox(pts: Pt[]): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The part of convex polygon `subject` inside convex polygon `clip` (Sutherland–Hodgman). Empty if they miss. */
export function polyClip(subject: Pt[], clip: Pt[]): Pt[] {
  let out = subject;
  // which way round the clip polygon runs decides which side is inside
  let area = 0; for (let i = 0; i < clip.length; i++) { const a = clip[i], b = clip[(i + 1) % clip.length]; area += a.x * b.y - b.x * a.y; }
  const sgn = area >= 0 ? 1 : -1;
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i], b = clip[(i + 1) % clip.length];
    const side = (p: Pt) => sgn * ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x));
    const inp = out; out = [];
    for (let j = 0; j < inp.length; j++) {
      const p = inp[j], q = inp[(j + 1) % inp.length]; const sp = side(p), sq = side(q);
      if (sp >= 0) out.push(p);
      if ((sp >= 0) !== (sq >= 0)) { const t = sp / (sp - sq); out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t }); }
    }
  }
  return out;
}
export function polyArea(pts: Pt[]): number {
  let a = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p.x * q.y - q.x * p.y; }
  return Math.abs(a) / 2;
}
export function polyCentre(pts: Pt[]): Pt {
  let x = 0, y = 0; for (const p of pts) { x += p.x; y += p.y; }
  return { x: x / (pts.length || 1), y: y / (pts.length || 1) };
}
/** Where two zones overlap: the shared region, or null if it is less than `min` square metres. */
export function overlapOf(a: Shaped, b: Shaped, min = 24): Pt[] | null {
  const c = polyClip(zonePts(a), zonePts(b));
  return c.length >= 3 && polyArea(c) >= min ? c : null;
}
/** Do two zones overlap at all (either turned)? */
export const zonesOverlap = (a: Shaped, b: Shaped, min = 1) => !!overlapOf(a, b, min);

// ------------------------------------------------------------ grips (v0.19): reshaping what is built
//
//   A built shape is reshaped by the handles on it, not by a dialog. A rectangle has one on each edge: drag it and
//   that edge moves while the opposite one stays where it is. A pier or satellite (anything that may turn) has one
//   on each end instead: the far end stays put and the near one follows the cursor, so the pier is stretched and
//   swung in one move. A hub has one on its rim: it sets the diameter, and turns a polygonal hub.
export type Grip = 'n' | 'e' | 's' | 'w' | 'a' | 'b' | 'r';
export interface Geom { x: number; y: number; w: number; h: number; rot?: number; sides?: number; off?: string[] }
export const geomOf = (z: Geom): Geom => ({ x: z.x, y: z.y, w: z.w, h: z.h, rot: z.rot, sides: z.sides, off: z.off ? [...z.off] : undefined });
export function setGeom(z: Geom, g: Geom) {
  z.x = g.x; z.y = g.y; z.w = g.w; z.h = g.h;
  if (g.rot) z.rot = g.rot; else delete z.rot;
  if (g.off && g.off.length) z.off = [...g.off]; else delete z.off;
}
/** Does the long axis of a pier run along its own x? (A turned one always does; an upright one may stand on end.) */
const alongX = (z: Geom) => !!z.rot || z.w >= z.h;
export function gripsOf(z: Geom, turns: boolean): { grip: Grip; p: Pt }[] {
  const c = centreOf(z);
  if (z.sides) return [{ grip: 'r', p: z.sides >= 24 ? { x: c.x + Math.min(z.w, z.h) / 2, y: c.y } : hallPts(z)[0] }];
  const n = toWorld(z, { x: c.x, y: z.y }), e = toWorld(z, { x: z.x + z.w, y: c.y }), s = toWorld(z, { x: c.x, y: z.y + z.h }), w = toWorld(z, { x: z.x, y: c.y });
  if (!turns) return [{ grip: 'n', p: n }, { grip: 'e', p: e }, { grip: 's', p: s }, { grip: 'w', p: w }];
  return alongX(z) ? [{ grip: 'a', p: w }, { grip: 'b', p: e }, { grip: 'n', p: n }, { grip: 's', p: s }]
    : [{ grip: 'a', p: n }, { grip: 'b', p: s }, { grip: 'e', p: e }, { grip: 'w', p: w }];
}
const SIDES4 = 'nesw';
/** Switched-off gate keys when a rectangle's frame turns by quarter turns: `n3` on the old north side is `e3` after one. */
const turnKeys = (off: string[] | undefined, quarters: number) =>
  off?.map(k => { const i = SIDES4.indexOf(k[0]); return i < 0 || k[1] === undefined || k[0] === 'f' ? k : SIDES4[(((i + quarters) % 4) + 4) % 4] + k.slice(1); });

export interface GripLimits { minLen: number; minWide: number; maxWide: number; minDia: number; maxDia: number; snapDeg: number }
/** The shape `z0` becomes when `grip` is dragged to `p`. `z0` is the shape as it was when the drag began. */
export function regrip(z0: Geom, grip: Grip, p: Pt, turns: boolean, lim: GripLimits): Geom {
  const c0 = centreOf(z0); const step = (lim.snapDeg * Math.PI) / 180;
  if (z0.sides) {
    const dia = Math.min(lim.maxDia, Math.max(lim.minDia, snap(2 * Math.hypot(p.x - c0.x, p.y - c0.y), 10)));
    const g: Geom = { ...geomOf(z0), x: c0.x - dia / 2, y: c0.y - dia / 2, w: dia, h: dia };
    // the grip of a polygon is its first corner, which sits half a facet anticlockwise of straight up
    if (z0.sides < 24) g.rot = Math.round((Math.atan2(p.y - c0.y, p.x - c0.x) + Math.PI / 2 + Math.PI / facetsOf(z0)) / step) * step || 1e-4;
    return g;
  }
  if (grip === 'a' || grip === 'b') {
    // stretch and swing: the far end is fixed, the near end follows the cursor
    const ax = alongX(z0); const W = ax ? z0.h : z0.w;
    const endA = toWorld(z0, ax ? { x: z0.x, y: c0.y } : { x: c0.x, y: z0.y }), endB = toWorld(z0, ax ? { x: z0.x + z0.w, y: c0.y } : { x: c0.x, y: z0.y + z0.h });
    const F = grip === 'b' ? endA : endB;
    const L0 = ax ? z0.w : z0.h;
    const L = Math.max(Math.min(lim.minLen, L0), snap(Math.hypot(p.x - F.x, p.y - F.y), 5));   // a limit never shrinks or grows what is already built
    const th = Math.round(Math.atan2(p.y - F.y, p.x - F.x) / step) * step;
    const c = { x: F.x + (Math.cos(th) * L) / 2, y: F.y + (Math.sin(th) * L) / 2 };
    let dir = grip === 'b' ? th : th + Math.PI;          // which way the axis runs from end a to end b
    dir = Math.atan2(Math.sin(dir), Math.cos(dir));
    const level = Math.abs(Math.sin(dir)) < 1e-6 && Math.cos(dir) > 0, plumb = Math.abs(Math.cos(dir)) < 1e-6 && Math.sin(dir) > 0;
    // still square to the grid the way it started: it stays an upright rectangle, and keeps its shared walls
    if (!z0.rot && ax && level) return { ...geomOf(z0), x: c.x - L / 2, y: c.y - W / 2, w: L, h: W };
    if (!z0.rot && !ax && plumb) return { ...geomOf(z0), x: c.x - W / 2, y: c.y - L / 2, w: W, h: L };
    // otherwise it is a turned rectangle, long side along its own x, with its north kept roughly up (as the Pier tool draws them)
    // (end a to end b is the frame's own west to east; if keeping north up turns the frame over, the side names swap)
    let quarters = !z0.rot && !ax ? -1 : 0;
    let rot = dir;
    if (rot > Math.PI / 2 + 1e-6) { rot -= Math.PI; quarters += 2; } else if (rot <= -Math.PI / 2 + 1e-6) { rot += Math.PI; quarters += 2; }
    if (Math.abs(Math.sin(2 * rot)) < 1e-6) rot += 1e-4;
    return { x: c.x - L / 2, y: c.y - W / 2, w: L, h: W, rot, sides: undefined, off: turnKeys(z0.off, quarters) };
  }
  // an edge: it moves square to itself, in the shape's own frame, and the opposite edge stays where it is
  const q = toLocal(z0, p); let x0 = z0.x, y0 = z0.y, x1 = z0.x + z0.w, y1 = z0.y + z0.h;
  const longX = alongX(z0);
  const size = (v: number, along: boolean) => {
    if (!turns) return Math.max(10, snap(v, 5));
    const cur = (grip === 'e' || grip === 'w') ? z0.w : z0.h;   // the limits apply to the drag, never to what is already built
    const lo = Math.min(cur, along ? lim.minLen : lim.minWide), hi = along ? Infinity : Math.max(cur, lim.maxWide);
    return Math.min(hi, Math.max(lo, snap(v, 5)));
  };
  if (grip === 'e') x1 = x0 + size(q.x - x0, longX); else if (grip === 'w') x0 = x1 - size(x1 - q.x, longX);
  else if (grip === 's') y1 = y0 + size(q.y - y0, !longX); else if (grip === 'n') y0 = y1 - size(y1 - q.y, !longX);
  const c = toWorld(z0, { x: (x0 + x1) / 2, y: (y0 + y1) / 2 });
  return { ...geomOf(z0), x: c.x - (x1 - x0) / 2, y: c.y - (y1 - y0) / 2, w: x1 - x0, h: y1 - y0 };
}
