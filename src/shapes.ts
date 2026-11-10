// Shapes (v0.17): modules that are not upright rectangles. Pure logic, no DOM.
//
//   A zone is still stored as a rectangle (x, y, w, h). A zone with `rot` is that rectangle turned about its centre:
//   an angled pier. Everything that needs the real outline asks here: its corners, whether a point is inside it,
//   where it overlaps another zone. The rectangle is the zone's own frame, so interiors are still laid out as for an
//   upright building and then turned into place.
//
//   Shapes merge: two zones on the same level whose outlines overlap are one building, joined where they overlap.
//   That is what lets an angled pier be drawn straight into a concourse and become part of it.
import { Pt, Rect } from './geom';

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
