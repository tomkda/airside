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

/** `sides`: a regular polygon with that many sides, inscribed in the circle that fits the box (v0.18). 24 or more is drawn round.
 *  `bend` (v0.20): the rectangle is bent into an arc. Its ends stay where they are (x, y, w, h is the frame of the
 *  chord between them) and the middle of its centreline is pushed `bend` metres towards its own south (north if negative). */
export interface Shaped extends Rect { rot?: number; sides?: number; bend?: number }
/** Anything that is not an upright rectangle. */
export const shaped = (z: Shaped) => !!(z.rot || z.sides || z.bend);
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

// ------------------------------------------------------------ bent bars (v0.20)
//
//   A bent pier is a bar whose centreline is an arc of a circle through its two ends. Everything inside it is still
//   laid out as for a straight building, on a straight frame as long as the arc, and then carried onto the arc:
//   `toLocal` straightens a point (unbend, then unturn) and `toWorld` bends it back. So the rest of the game keeps
//   thinking in "along the building" and "across it".
export interface Arc { c: Pt; R: number; th: number; sg: 1 | -1; La: number }
/** The arc of a bent bar in its own unturned frame: circle centre, centreline radius, half angle, which way it bulges, arc length. */
export function arcOf(z: Shaped): Arc | null {
  const s = z.bend; if (!s || z.sides || Math.abs(s) < 0.5) return null;
  const half = z.w / 2, a = Math.min(Math.abs(s), half * 0.98);
  const R = (half * half + a * a) / (2 * a); const th = Math.asin(Math.min(1, half / R)); const sg = s > 0 ? 1 : -1;
  const c0 = centreOf(z);
  return { c: { x: c0.x, y: c0.y + sg * a - sg * R }, R, th, sg, La: 2 * R * th };
}
/** The straight frame a shape's interior is laid out on: the rectangle itself, or for a bent bar one as long as its arc. */
export function frameOf(z: Shaped): Rect {
  const A = arcOf(z); if (!A) return { x: z.x, y: z.y, w: z.w, h: z.h };
  return { x: z.x + z.w / 2 - A.La / 2, y: z.y, w: A.La, h: z.h };
}
/** The tightest a bar of this width may be bent: its inner wall keeps a radius people can walk and furniture can follow. */
export const minBendRadius = (h: number) => Math.max(1.5 * h, h / 2 + 30);
/** The largest bend a bar of this chord and width can take. */
export function maxBend(w: number, h: number): number {
  const half = w / 2, Rm = minBendRadius(h);
  return Math.max(0, Math.min(half * 0.85, Rm > half ? Rm - Math.sqrt(Rm * Rm - half * half) : half));
}
/** How many straight pieces a bent bar is drawn and tested with. */
/** (Set by how far a straight piece may stand off the true curve: 15 cm at the outer wall, whatever the radius.) */
const arcSteps = (A: Arc, h = 60) => Math.max(3, Math.min(96, Math.ceil((2 * A.th) / (2 * Math.acos(1 - 0.15 / (A.R + h / 2))))));
export function turn(p: Pt, c: Pt, ang: number): Pt {
  const cs = Math.cos(ang), sn = Math.sin(ang); const dx = p.x - c.x, dy = p.y - c.y;
  return { x: c.x + dx * cs - dy * sn, y: c.y + dx * sn + dy * cs };
}
/** A point in the zone's own straight, upright frame (`frameOf`), and back. */
export function toLocal(z: Shaped, p: Pt): Pt {
  const q = z.rot ? turn(p, centreOf(z), -z.rot) : p;
  const A = arcOf(z); if (!A) return q;
  const dx = q.x - A.c.x, dy = A.sg * (q.y - A.c.y); const r = Math.hypot(dx, dy), phi = Math.atan2(dx, dy);
  return { x: z.x + z.w / 2 + (phi / (2 * A.th)) * A.La, y: z.y + z.h / 2 + A.sg * (r - A.R) };
}
export function toWorld(z: Shaped, p: Pt): Pt {
  const A = arcOf(z); let q = p;
  if (A) {
    const phi = ((p.x - (z.x + z.w / 2)) / A.La) * 2 * A.th, r = A.R + A.sg * (p.y - (z.y + z.h / 2));
    q = { x: A.c.x + r * Math.sin(phi), y: A.c.y + A.sg * r * Math.cos(phi) };
  }
  return z.rot ? turn(q, centreOf(z), z.rot) : q;
}
/** The middle of the building itself. For a bent bar the centre of its box may lie outside it; this never does. */
export const heart = (z: Shaped): Pt => (arcOf(z) ? toWorld(z, centreOf(frameOf(z))) : centreOf(z));
/** A line or outline given in the zone's straight frame, carried into the world. On a bent bar long edges are cut
 *  into short ones first, so they follow the curve. */
export function bendPath(z: Shaped, pts: Pt[], closed = false): Pt[] {
  if (!arcOf(z)) return pts.map(p => toWorld(z, p));
  const out: Pt[] = []; const n = pts.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = pts[i], b = pts[(i + 1) % n]; const k = Math.max(1, Math.ceil(Math.abs(b.x - a.x) / 6));
    for (let j = 0; j < k; j++) out.push(toWorld(z, { x: a.x + ((b.x - a.x) * j) / k, y: a.y + ((b.y - a.y) * j) / k }));
  }
  if (!closed && n) out.push(toWorld(z, pts[n - 1]));
  return out;
}
/** A bent bar as a row of short turned rectangles, each standing on its own centre: what the 3D model is built from. */
export function barPieces(z: Shaped): Shaped[] {
  const A = arcOf(z); if (!A) return [z];
  // (the model can be coarser than the outline: a length every 7 degrees or so, and never shorter than the bar is wide if that can be helped)
  const n = Math.max(3, Math.min(48, Math.ceil((2 * A.th) / 0.12))); const F = frameOf(z); const out: Shaped[] = [];
  for (let i = 0; i < n; i++) {
    const u = F.x + ((i + 0.5) / n) * F.w; const m = toWorld(z, { x: u, y: F.y + F.h / 2 });
    const phi = (((i + 0.5) / n) - 0.5) * 2 * A.th; const w = ((A.R + z.h / 2) * 2 * A.th) / n + 0.4;
    out.push({ x: m.x - w / 2, y: m.y - z.h / 2, w, h: z.h, rot: (z.rot ?? 0) - A.sg * phi || 1e-6 });
  }
  return out;
}
/** A direction (not a position) turned out of the zone's frame. */
export const dirWorld = (z: Shaped, d: Pt): Pt => (z.rot ? turn(d, { x: 0, y: 0 }, z.rot) : d);

/** The zone's outline: its four corners in the order north-west, north-east, south-east, south-west of its own frame. */
export function zonePts(z: Shaped): Pt[] {
  if (z.sides) return hallPts(z);
  const A = arcOf(z);
  if (A) {
    // a bent bar: its north wall west to east, then its south wall back
    const n = arcSteps(A, z.h); const F = frameOf(z); const out: Pt[] = [];
    for (let i = 0; i <= n; i++) out.push(toWorld(z, { x: F.x + (i / n) * F.w, y: F.y }));
    for (let i = n; i >= 0; i--) out.push(toWorld(z, { x: F.x + (i / n) * F.w, y: F.y + F.h }));
    return out;
  }
  const c = [{ x: z.x, y: z.y }, { x: z.x + z.w, y: z.y }, { x: z.x + z.w, y: z.y + z.h }, { x: z.x, y: z.y + z.h }];
  return z.rot ? c.map(p => toWorld(z, p)) : c;
}
/** The zone's outline as convex pieces: itself, or for a bent bar (which is not convex) the wedges along its arc. */
export function zoneParts(z: Shaped): Pt[][] {
  const A = arcOf(z); if (!A) return [zonePts(z)];
  const pts = zonePts(z); const n = pts.length / 2 - 1; const out: Pt[][] = [];
  for (let i = 0; i < n; i++) out.push([pts[i], pts[i + 1], pts[pts.length - 2 - i], pts[pts.length - 1 - i]]);
  return out;
}
export function inZone(p: Pt, z: Shaped, pad = 0): boolean {
  if (z.sides) return inPoly(p, hallPts(z, pad));
  const q = toLocal(z, p); const F = frameOf(z);
  return q.x >= F.x - pad && q.x <= F.x + F.w + pad && q.y >= F.y - pad && q.y <= F.y + F.h + pad;
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
  const q = toLocal(z, p); const F = frameOf(z);
  return toWorld(z, { x: Math.min(F.x + F.w - margin, Math.max(F.x + margin, q.x)), y: Math.min(F.y + F.h - margin, Math.max(F.y + margin, q.y)) });
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
  const pa = zoneParts(a), pb = zoneParts(b);
  if (pa.length === 1 && pb.length === 1) { const c = polyClip(pa[0], pb[0]); return c.length >= 3 && polyArea(c) >= min ? c : null; }
  // a bent bar is tested wedge by wedge; the overlap handed back is the largest single piece of it
  let total = 0, best: Pt[] | null = null, ba = 0;
  for (const p of pa) for (const q of pb) { const c = polyClip(p, q); if (c.length < 3) continue; const ar = polyArea(c); total += ar; if (ar > ba) { ba = ar; best = c; } }
  return total >= min ? best : null;
}
/** Do two zones overlap at all (either turned)? */
export const zonesOverlap = (a: Shaped, b: Shaped, min = 1) => !!overlapOf(a, b, min);

// ------------------------------------------------------------ grips (v0.19): reshaping what is built
//
//   A built shape is reshaped by the handles on it, not by a dialog. A rectangle has one on each edge: drag it and
//   that edge moves while the opposite one stays where it is. A pier or satellite (anything that may turn) has one
//   on each end instead: the far end stays put and the near one follows the cursor, so the pier is stretched and
//   swung in one move. A hub has one on its rim: it sets the diameter, and turns a polygonal hub.
//   v0.20: a pier or satellite also has one in its middle (`m`): pull it sideways and the pier bends into an arc
//   while both ends stay where they are.
export type Grip = 'n' | 'e' | 's' | 'w' | 'a' | 'b' | 'r' | 'm';
export interface Geom { x: number; y: number; w: number; h: number; rot?: number; sides?: number; bend?: number; off?: string[] }
export const geomOf = (z: Geom): Geom => ({ x: z.x, y: z.y, w: z.w, h: z.h, rot: z.rot, sides: z.sides, bend: z.bend, off: z.off ? [...z.off] : undefined });
export function setGeom(z: Geom, g: Geom) {
  z.x = g.x; z.y = g.y; z.w = g.w; z.h = g.h;
  if (g.rot) z.rot = g.rot; else delete z.rot;
  if (g.bend) z.bend = g.bend; else delete z.bend;
  if (g.off && g.off.length) z.off = [...g.off]; else delete z.off;
}
/** Does the long axis of a pier run along its own x? (A turned one always does; an upright one may stand on end.) */
const alongX = (z: Geom) => !!z.rot || !!z.bend || z.w >= z.h;
/** A pier in the form the Pier tool draws them: long side along its own x. An upright one standing on end is turned a quarter. */
function asPier(z: Geom): Geom {
  if (alongX(z)) return geomOf(z);
  const c = centreOf(z);
  return { x: c.x - z.h / 2, y: c.y - z.w / 2, w: z.h, h: z.w, rot: Math.PI / 2, off: turnKeys(z.off, -1) };
}
const clampBend = (w: number, h: number, bend: number | undefined) => { const m = maxBend(w, h); const b = Math.max(-m, Math.min(m, bend ?? 0)); return Math.abs(b) < 4 ? undefined : b; };
export function gripsOf(z: Geom, turns: boolean): { grip: Grip; p: Pt }[] {
  const c = centreOf(z);
  if (z.sides) return [{ grip: 'r', p: z.sides >= 24 ? { x: c.x + Math.min(z.w, z.h) / 2, y: c.y } : hallPts(z)[0] }];
  const n = toWorld(z, { x: c.x, y: z.y }), e = toWorld(z, { x: z.x + z.w, y: c.y }), s = toWorld(z, { x: c.x, y: z.y + z.h }), w = toWorld(z, { x: z.x, y: c.y });
  if (!turns) return [{ grip: 'n', p: n }, { grip: 'e', p: e }, { grip: 's', p: s }, { grip: 'w', p: w }];
  if (arcOf(z)) {
    const F = frameOf(z); const fc = centreOf(F); const at = (x: number, y: number) => toWorld(z, { x, y });
    return [{ grip: 'a', p: at(F.x, fc.y) }, { grip: 'b', p: at(F.x + F.w, fc.y) }, { grip: 'n', p: at(fc.x, F.y) }, { grip: 's', p: at(fc.x, F.y + F.h) }, { grip: 'm', p: at(fc.x, fc.y) }];
  }
  return alongX(z) ? [{ grip: 'a', p: w }, { grip: 'b', p: e }, { grip: 'n', p: n }, { grip: 's', p: s }, { grip: 'm', p: c }]
    : [{ grip: 'a', p: n }, { grip: 'b', p: s }, { grip: 'e', p: e }, { grip: 'w', p: w }, { grip: 'm', p: c }];
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
  if (grip === 'm') {
    // bend: both ends stay put and the middle follows the cursor, square to the line between them
    const P = asPier(z0); const c = centreOf(P);
    const q = P.rot ? turn(p, c, -P.rot) : p;
    const bend = clampBend(P.w, P.h, snap(q.y - c.y, 5));
    if (!bend) return z0.bend ? { ...P, bend: undefined } : geomOf(z0);   // pulled straight again: as it was
    return { ...P, bend };
  }
  if (z0.bend && (grip === 'n' || grip === 's')) {
    // a bent bar widens about its centreline, so the curve of its spine stays where it is
    const F = frameOf(z0); const d = Math.abs(toLocal(z0, p).y - (F.y + F.h / 2));
    const h = Math.min(Math.max(z0.h, lim.maxWide), Math.max(Math.min(z0.h, lim.minWide), snap(2 * d, 5))); const c = centreOf(z0);
    return { ...geomOf(z0), y: c.y - h / 2, h, bend: clampBend(z0.w, h, z0.bend) };
  }
  if (grip === 'a' || grip === 'b') {
    // stretch and swing: the far end is fixed, the near end follows the cursor
    const ax = alongX(z0); const W = ax ? z0.h : z0.w;
    const F0 = frameOf(z0);   // (a bent bar's ends are the ends of its straight frame, carried onto the arc)
    const endA = toWorld(z0, ax ? { x: F0.x, y: c0.y } : { x: c0.x, y: z0.y }), endB = toWorld(z0, ax ? { x: F0.x + F0.w, y: c0.y } : { x: c0.x, y: z0.y + z0.h });
    const F = grip === 'b' ? endA : endB;
    const L0 = ax ? z0.w : z0.h;
    const L = Math.max(Math.min(lim.minLen, L0), snap(Math.hypot(p.x - F.x, p.y - F.y), 5));   // a limit never shrinks or grows what is already built
    const th = Math.round(Math.atan2(p.y - F.y, p.x - F.x) / step) * step;
    const c = { x: F.x + (Math.cos(th) * L) / 2, y: F.y + (Math.sin(th) * L) / 2 };
    let dir = grip === 'b' ? th : th + Math.PI;          // which way the axis runs from end a to end b
    dir = Math.atan2(Math.sin(dir), Math.cos(dir));
    const level = Math.abs(Math.sin(dir)) < 1e-6 && Math.cos(dir) > 0, plumb = Math.abs(Math.cos(dir)) < 1e-6 && Math.sin(dir) > 0;
    // still square to the grid the way it started: it stays an upright rectangle, and keeps its shared walls
    if (!z0.rot && !z0.bend && ax && level) return { ...geomOf(z0), x: c.x - L / 2, y: c.y - W / 2, w: L, h: W };
    if (!z0.rot && !z0.bend && !ax && plumb) return { ...geomOf(z0), x: c.x - W / 2, y: c.y - L / 2, w: W, h: L };
    // otherwise it is a turned rectangle, long side along its own x, with its north kept roughly up (as the Pier tool draws them)
    // (end a to end b is the frame's own west to east; if keeping north up turns the frame over, the side names swap)
    let quarters = !z0.rot && !ax ? -1 : 0;
    let rot = dir;
    if (rot > Math.PI / 2 + 1e-6) { rot -= Math.PI; quarters += 2; } else if (rot <= -Math.PI / 2 + 1e-6) { rot += Math.PI; quarters += 2; }
    if (Math.abs(Math.sin(2 * rot)) < 1e-6) rot += 1e-4;
    // a bend keeps its depth (as far as the new length allows); if the frame turned over, it now bulges the other way in that frame
    const bend = clampBend(L, W, z0.bend && (quarters % 4 === 2 || quarters % 4 === -2 || quarters === 1 ? -z0.bend : z0.bend));
    return { x: c.x - L / 2, y: c.y - W / 2, w: L, h: W, rot, sides: undefined, bend, off: turnKeys(z0.off, quarters) };
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
