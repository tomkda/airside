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
export interface Shaped extends Rect { rot?: number; sides?: number; bend?: number;
  /** v0.41: an S-curve. The centreline crosses the middle of the chord (pushed `bend` off it) at this angle to the chord,
   *  in radians, and runs as two arcs, one either side of the middle, that meet there without a kink. */
  twist?: number;
  /** v0.21: the bar tapers. `h` is its width half way along; its east end is `taper` metres wider than its west end
   *  (narrower if negative). Both walls move, so the centreline stays where it is. */
  taper?: number;
  /** v0.32: a free-drawn area: its outline, any simple polygon. x, y, w, h are its bounding box. */
  poly?: Pt[] }
/** Anything that is not an upright rectangle. */
export const shaped = (z: Shaped) => !!(z.rot || z.sides || z.bend || z.taper || z.poly || z.twist);

// ------------------------------------------------------------ free-drawn outlines (v0.32)
/** How far a point is from a polygon's outline. */
export function edgeDist(p: Pt, poly: Pt[]): number {
  let m = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]; const dx = b.x - a.x, dy = b.y - a.y; const L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0; m = Math.min(m, Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t));
  }
  return m;
}
const signedArea = (r: Pt[]) => { let a = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p.x * q.y - q.x * p.y; } return a / 2; };
/** A simple polygon cut into triangles (ear clipping), so anything that wants convex pieces can have them. */
export function triangulate(poly: Pt[]): Pt[][] {
  const pts = signedArea(poly) < 0 ? [...poly].reverse() : [...poly]; const idx = pts.map((_, i) => i); const out: Pt[][] = [];
  const cross = (a: Pt, b: Pt, c: Pt) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const inTri = (p: Pt, a: Pt, b: Pt, c: Pt) => cross(a, b, p) >= -1e-9 && cross(b, c, p) >= -1e-9 && cross(c, a, p) >= -1e-9;
  let guard = 0;
  while (idx.length > 3 && guard++ < 5000) {
    let cut = false;
    for (let k = 0; k < idx.length; k++) {
      const i0 = idx[(k + idx.length - 1) % idx.length], i1 = idx[k], i2 = idx[(k + 1) % idx.length]; const a = pts[i0], b = pts[i1], c = pts[i2];
      if (cross(a, b, c) <= 1e-9) continue;   // a reflex corner is not an ear
      if (idx.some(j => j !== i0 && j !== i1 && j !== i2 && inTri(pts[j], a, b, c))) continue;
      out.push([a, b, c]); idx.splice(k, 1); cut = true; break;
    }
    if (!cut) break;   // (not simple: give up on the rest)
  }
  if (idx.length === 3) out.push(idx.map(i => pts[i]));
  return out;
}
const tris = new WeakMap<Pt[], Pt[][]>(), poles = new WeakMap<Pt[], Pt>();
/** A point well inside a polygon (the most inland of a grid of samples): for labels, and to walk towards. */
export function poleOf(poly: Pt[]): Pt {
  const hit = poles.get(poly); if (hit) return hit;
  const b = polyBox(poly); let best = polyCentre(poly), bd = inPoly(best, poly) ? edgeDist(best, poly) : -1;
  for (let i = 1; i < 16; i++) for (let j = 1; j < 16; j++) {
    const p = { x: b.x + (b.w * i) / 16, y: b.y + (b.h * j) / 16 }; if (!inPoly(p, poly)) continue;
    const d = edgeDist(p, poly); if (d > bd) { bd = d; best = p; }
  }
  // (a thin shape the grid misses: the middle of its largest triangle, which is always inside)
  if (bd < 0) { const t = triangulate(poly).reduce((m, q) => (Math.abs(signedArea(q)) > Math.abs(signedArea(m)) ? q : m)); best = { x: (t[0].x + t[1].x + t[2].x) / 3, y: (t[0].y + t[1].y + t[2].y) / 3 }; }
  poles.set(poly, best); return best;
}
/** Is a polygon simple (no edge crossing another)? */
export function simplePoly(poly: Pt[]): boolean {
  const n = poly.length; if (n < 3) return false;
  const x = (a: Pt, b: Pt, c: Pt, d: Pt) => { const d1 = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x), d2 = (b.x - a.x) * (d.y - a.y) - (b.y - a.y) * (d.x - a.x), d3 = (d.x - c.x) * (a.y - c.y) - (d.y - c.y) * (a.x - c.x), d4 = (d.x - c.x) * (b.y - c.y) - (d.y - c.y) * (b.x - c.x); return d1 * d2 < 0 && d3 * d4 < 0; };
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) { if (i === 0 && j === n - 1) continue; if (x(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) return false; }
  return Math.abs(signedArea(poly)) > 1;
}
/** The width of a bar at each end, and how much wider or narrower than its middle it is a fraction `t` of the way along. */
export const endWidths = (z: Shaped): [number, number] => [z.h - (z.taper ?? 0) / 2, z.h + (z.taper ?? 0) / 2];
const widthK = (z: Shaped, t: number) => (z.taper && !z.sides ? 1 + (z.taper / z.h) * (t - 0.5) : 1);
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
  const s = z.bend; if (!s || z.sides || z.twist || Math.abs(s) < 0.5) return null;
  const half = z.w / 2, a = Math.min(Math.abs(s), half * 0.98);
  const R = (half * half + a * a) / (2 * a); const th = Math.asin(Math.min(1, half / R)); const sg = s > 0 ? 1 : -1;
  const c0 = centreOf(z);
  return { c: { x: c0.x, y: c0.y + sg * a - sg * R }, R, th, sg, La: 2 * R * th };
}
// ------------------------------------------------------------ S-curves (v0.41)
//
//   A twisted bar's centreline runs from the west end of its chord to the middle M (its chord's middle, pushed `bend`
//   to the south), and on to the east end, as two arcs that meet at M at the angle `twist` to the chord. Each half is
//   an ordinary bent bar on its own half-chord (from the end to M), bent so that its tangent at M is that angle: an arc
//   through two points with a given tangent at one of them is the only one there is. With no twist the two halves are
//   one arc, the plain bend; with no bend they turn opposite ways, an S. The straight frame is the two halves' frames
//   end to end, and a point is carried onto whichever half its place along the frame falls in.
export interface Halves { h1: Shaped; h2: Shaped; L1: number; L2: number; La: number; F1: Rect; F2: Rect }
/** The two halves of a twisted bar, in its own unturned frame. */
// (kept by shape: derive asks for them thousands of times a frame while a twisted hall is dragged)
const halvesMemo = new Map<string, Halves>();
export function halvesOf(z: Shaped): Halves | null {
  if (!z.twist || z.sides || z.poly) return null;
  const key = `${z.x},${z.y},${z.w},${z.h},${z.bend ?? 0},${z.twist}`; const hit = halvesMemo.get(key); if (hit) return hit;
  const c0 = centreOf(z); const A = { x: c0.x - z.w / 2, y: c0.y }, B = { x: c0.x + z.w / 2, y: c0.y }, M = { x: c0.x, y: c0.y + (z.bend ?? 0) };
  const half = (P: Pt, Q: Pt, th: number): Shaped => {
    // (a bar on the chord P to Q, its middle pushed off that chord by the sagitta that turns it through `th` each side)
    const L = Math.hypot(Q.x - P.x, Q.y - P.y), d = Math.atan2(Q.y - P.y, Q.x - P.x); const m = { x: (P.x + Q.x) / 2, y: (P.y + Q.y) / 2 };
    const sag = (L / 2) * Math.tan(th / 2);
    return { x: m.x - L / 2, y: m.y - z.h / 2, w: L, h: z.h, rot: d || 1e-9, bend: Math.abs(sag) >= 0.5 ? sag : undefined };
  };
  const d1 = Math.atan2(M.y - A.y, M.x - A.x), d2 = Math.atan2(B.y - M.y, B.x - M.x);
  // (a bar bent south, along its chord, leaves its west end turned south of the chord and reaches its east end turned
  //  north of it: the first half ends at M turned `d1 - th1`, the second starts there turned `d2 + th2`)
  const h1 = half(A, M, d1 - z.twist), h2 = half(M, B, z.twist - d2);
  const F1 = frameOf(h1), F2 = frameOf(h2);
  const out = { h1, h2, L1: F1.w, L2: F2.w, La: F1.w + F2.w, F1, F2 };
  if (halvesMemo.size > 512) halvesMemo.clear(); halvesMemo.set(key, out);
  return out;
}
/** Is the bar curved: bent into one arc, or twisted into two? */
export const curved = (z: Shaped) => !!arcOf(z) || !!halvesOf(z);
/** The most a hall may be twisted, radians (about 40 degrees): beyond it the S is more knot than curve. */
export const TWIST_MAX = 0.7;
/** The largest twist a bar of this chord, width and bend can take: neither half tighter than `minBendRadius`. */
export function maxTwist(w: number, h: number, bend = 0): number {
  const ok = (t: number) => { const H = halvesOf({ x: 0, y: 0, w, h, bend: bend || undefined, twist: t }); return !!H && [H.h1, H.h2].every(q => Math.abs(q.bend ?? 0) <= maxBend(q.w, h) + 1e-6); };
  let lo = 0, hi = TWIST_MAX; if (ok(hi) && ok(-hi)) return hi;
  for (let i = 0; i < 24; i++) { const m = (lo + hi) / 2; if (ok(m) && ok(-m)) lo = m; else hi = m; }
  return lo;
}
/** The straight frame a shape's interior is laid out on: the rectangle itself, or for a bent bar one as long as its arc. */
export function frameOf(z: Shaped): Rect {
  const H = halvesOf(z); if (H) { const c = centreOf(z); return { x: c.x - H.La / 2, y: z.y, w: H.La, h: z.h }; }
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
  let q = z.rot ? turn(p, centreOf(z), -z.rot) : p;
  const H = halvesOf(z);
  if (H) {
    // (straightened in each half; it belongs to the first if it falls before the joint there)
    const Fx = z.x + z.w / 2 - H.La / 2, F1 = H.F1, F2 = H.F2; const q1 = toLocal(H.h1, q);
    if (q1.x <= F1.x + F1.w) return { x: Fx + (q1.x - F1.x), y: z.y + (q1.y - H.h1.y) };
    const q2 = toLocal(H.h2, q); return { x: Fx + H.L1 + (q2.x - F2.x), y: z.y + (q2.y - H.h2.y) };
  }
  const A = arcOf(z);
  if (A) {
    const dx = q.x - A.c.x, dy = A.sg * (q.y - A.c.y); const r = Math.hypot(dx, dy), phi = Math.atan2(dx, dy);
    q = { x: z.x + z.w / 2 + (phi / (2 * A.th)) * A.La, y: z.y + z.h / 2 + A.sg * (r - A.R) };
  }
  if (!z.taper || z.sides) return q;
  // a tapered bar: across the building, the frame is as wide as its middle everywhere
  const F = frameOf(z); const k = Math.max(0.05, widthK(z, (q.x - F.x) / F.w)); const mid = z.y + z.h / 2;
  return { x: q.x, y: mid + (q.y - mid) / k };
}
export function toWorld(z: Shaped, p: Pt): Pt {
  const H = halvesOf(z);
  if (H) {
    const u = p.x - (z.x + z.w / 2 - H.La / 2); let q: Pt;
    if (u <= H.L1) q = toWorld(H.h1, { x: H.F1.x + u, y: H.h1.y + (p.y - z.y) });
    else q = toWorld(H.h2, { x: H.F2.x + (u - H.L1), y: H.h2.y + (p.y - z.y) });
    return z.rot ? turn(q, centreOf(z), z.rot) : q;
  }
  const A = arcOf(z); let q = p;
  if (z.taper && !z.sides) { const F = frameOf(z); const k = Math.max(0.05, widthK(z, (p.x - F.x) / F.w)); const mid = z.y + z.h / 2; q = { x: p.x, y: mid + (p.y - mid) * k }; }
  if (A) {
    const phi = ((q.x - (z.x + z.w / 2)) / A.La) * 2 * A.th, r = A.R + A.sg * (q.y - (z.y + z.h / 2));
    q = { x: A.c.x + r * Math.sin(phi), y: A.c.y + A.sg * r * Math.cos(phi) };
  }
  return z.rot ? turn(q, centreOf(z), z.rot) : q;
}
/** The middle of the building itself. For a bent bar the centre of its box may lie outside it; this never does. */
export const heart = (z: Shaped): Pt => (z.poly ? poleOf(z.poly) : curved(z) ? toWorld(z, centreOf(frameOf(z))) : centreOf(z));
/** The widest and narrowest an end of a tapered bar may be. */
export const END_WIDTH = { min: 24, max: 160 };
/** A line or outline given in the zone's straight frame, carried into the world. On a bent bar long edges are cut
 *  into short ones first, so they follow the curve. */
export function bendPath(z: Shaped, pts: Pt[], closed = false): Pt[] {
  if (!curved(z)) return pts.map(p => toWorld(z, p));
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
  if (halvesOf(z)) {
    // (v0.41: an S-curve, a length every 7 degrees or so of its turning, as a bend is, each turned to the centreline's
    //  tangent there and as long as the longer of its two walls)
    const H = halvesOf(z)!; const turnBy = [H.h1, H.h2].reduce((t, q) => t + 4 * Math.abs(Math.atan((2 * (q.bend ?? 0)) / q.w)), 0);
    const F = frameOf(z); const n = Math.max(4, Math.min(48, Math.ceil(turnBy / 0.12))); const out: Shaped[] = []; const mid = F.y + F.h / 2;
    for (let i = 0; i < n; i++) {
      const u0 = F.x + (i / n) * F.w, u1 = F.x + ((i + 1) / n) * F.w; const m = toWorld(z, { x: (u0 + u1) / 2, y: mid });
      const a = toWorld(z, { x: u0, y: mid }), b = toWorld(z, { x: u1, y: mid });
      const w = Math.max(...[F.y, F.y + F.h].map(y => Math.hypot(toWorld(z, { x: u1, y }).x - toWorld(z, { x: u0, y }).x, toWorld(z, { x: u1, y }).y - toWorld(z, { x: u0, y }).y))) + 0.4;
      out.push({ x: m.x - w / 2, y: m.y - z.h / 2, w, h: z.h, rot: Math.atan2(b.y - a.y, b.x - a.x) || 1e-6 });
    }
    return out;
  }
  const A = arcOf(z); if (!A && !z.taper) return [z];
  // (the model can be coarser than the outline: a length every 7 degrees or so; a taper steps by a metre and a half at most)
  const n = Math.max(A ? 3 : 1, Math.min(48, Math.max(A ? Math.ceil((2 * A.th) / 0.12) : 0, Math.ceil(Math.abs(z.taper ?? 0) / 1.5)))); const F = frameOf(z); const out: Shaped[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n; const u = F.x + t * F.w; const m = toWorld(z, { x: u, y: F.y + F.h / 2 }); const h = z.h * widthK(z, t);
    const phi = A ? (t - 0.5) * 2 * A.th : 0; const w = (A ? ((A.R + h / 2) * 2 * A.th) / n : F.w / n) + 0.4;
    out.push({ x: m.x - w / 2, y: m.y - h / 2, w, h, rot: (z.rot ?? 0) - (A ? A.sg * phi : 0) || 1e-6 });
  }
  return out;
}
/** A direction (not a position) turned out of the zone's frame. */
export const dirWorld = (z: Shaped, d: Pt): Pt => (z.rot ? turn(d, { x: 0, y: 0 }, z.rot) : d);

/** The zone's outline: its four corners in the order north-west, north-east, south-east, south-west of its own frame. */
export function zonePts(z: Shaped): Pt[] {
  if (z.poly) return z.poly.map(p => ({ x: p.x, y: p.y }));
  if (z.sides) return hallPts(z);
  if (halvesOf(z)) {
    // (v0.41: an S-curve: its north wall west to east, then its south wall back, each half in as many steps as a bend
    //  of its own would take, with a point on the joint between them)
    const H = halvesOf(z)!; const F = frameOf(z); const st = (q: Shaped) => { const A = arcOf(q); return A ? arcSteps(A, z.h) : 1; };
    const n1 = st(H.h1), n2 = st(H.h2); const xs: number[] = [];
    for (let i = 0; i <= n1; i++) xs.push(F.x + (i / n1) * H.L1);
    for (let i = 1; i <= n2; i++) xs.push(F.x + H.L1 + (i / n2) * H.L2);
    const out: Pt[] = [];
    for (const x of xs) out.push(toWorld(z, { x, y: F.y }));
    for (let i = xs.length - 1; i >= 0; i--) out.push(toWorld(z, { x: xs[i], y: F.y + F.h }));
    return out;
  }
  const A = arcOf(z);
  if (A) {
    // a bent bar: its north wall west to east, then its south wall back
    const n = arcSteps(A, z.h); const F = frameOf(z); const out: Pt[] = [];
    for (let i = 0; i <= n; i++) out.push(toWorld(z, { x: F.x + (i / n) * F.w, y: F.y }));
    for (let i = n; i >= 0; i--) out.push(toWorld(z, { x: F.x + (i / n) * F.w, y: F.y + F.h }));
    return out;
  }
  const c = [{ x: z.x, y: z.y }, { x: z.x + z.w, y: z.y }, { x: z.x + z.w, y: z.y + z.h }, { x: z.x, y: z.y + z.h }];
  return z.rot || z.taper ? c.map(p => toWorld(z, p)) : c;
}
/** The zone's outline as convex pieces: itself, or for a bent bar (which is not convex) the wedges along its arc. */
export function zoneParts(z: Shaped): Pt[][] {
  if (z.poly) { let t = tris.get(z.poly); if (!t) { t = triangulate(z.poly); tris.set(z.poly, t); } return t; }   // (v0.32: a free area, as triangles)
  if (!curved(z)) return [zonePts(z)];
  const pts = zonePts(z); const n = pts.length / 2 - 1; const out: Pt[][] = [];
  for (let i = 0; i < n; i++) out.push([pts[i], pts[i + 1], pts[pts.length - 2 - i], pts[pts.length - 1 - i]]);
  return out;
}
export function inZone(p: Pt, z: Shaped, pad = 0): boolean {
  if (z.poly) { const ins = inPoly(p, z.poly); if (!pad) return ins; const d = edgeDist(p, z.poly); return pad > 0 ? ins || d <= pad : ins && d >= -pad; }
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
  if (z.poly) {
    const ok = (q: Pt) => inPoly(q, z.poly!) && edgeDist(q, z.poly!) >= margin; if (ok(p)) return p;
    const h = poleOf(z.poly); for (let k = 1; k <= 24; k++) { const q = { x: p.x + ((h.x - p.x) * k) / 24, y: p.y + ((h.y - p.y) * k) / 24 }; if (ok(q)) return q; }
    return h;
  }
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
//   v0.21: and one on a corner of each end (`ta`, `tb`): it sets the width of that end alone, so the pier tapers.
export type Grip = 'n' | 'e' | 's' | 'w' | 'a' | 'b' | 'r' | 'm' | 'ta' | 'tb' | 't' | 'k' | `v${number}`;
export interface Geom { x: number; y: number; w: number; h: number; rot?: number; sides?: number; bend?: number; taper?: number; off?: string[]; poly?: Pt[]; twist?: number }
export const geomOf = (z: Geom): Geom => ({ x: z.x, y: z.y, w: z.w, h: z.h, rot: z.rot, sides: z.sides, bend: z.bend, taper: z.taper, twist: z.twist, poly: z.poly ? z.poly.map(p => ({ ...p })) : undefined, off: z.off ? [...z.off] : undefined });
export function setGeom(z: Geom, g: Geom) {
  // v0.32: a free area's outline goes where its box is put (so moving the box moves the outline)
  if (g.poly) { const b = polyBox(g.poly); const dx = g.x - b.x, dy = g.y - b.y; z.poly = g.poly.map(p => ({ x: p.x + dx, y: p.y + dy })); z.x = g.x; z.y = g.y; z.w = b.w; z.h = b.h; }
  else { delete z.poly; z.x = g.x; z.y = g.y; z.w = g.w; z.h = g.h; }
  if (g.rot) z.rot = g.rot; else delete z.rot;
  if (g.bend) z.bend = g.bend; else delete z.bend;
  if (g.taper) z.taper = g.taper; else delete z.taper;
  if (g.twist) z.twist = g.twist; else delete z.twist;
  if (g.off && g.off.length) z.off = [...g.off]; else delete z.off;
}
/** Does the long axis of a pier run along its own x? (A turned one always does; an upright one may stand on end.) */
const alongX = (z: Geom) => !!z.rot || !!z.bend || !!z.taper || !!z.twist || z.w >= z.h;
/** A pier in the form the Pier tool draws them: long side along its own x. An upright one standing on end is turned a quarter. */
function asPier(z: Geom): Geom {
  if (alongX(z)) return geomOf(z);
  const c = centreOf(z);
  return { x: c.x - z.h / 2, y: c.y - z.w / 2, w: z.h, h: z.w, rot: Math.PI / 2, off: turnKeys(z.off, -1) };
}
/** A width and taper that keep both ends within `END_WIDTH`. */
function fitEnds(wa: number, wb: number, keep: 'a' | 'b', lim: GripLimits, was: number): { h: number; taper: number | undefined } {
  const c = (v: number) => Math.min(END_WIDTH.max, Math.max(END_WIDTH.min, v)); const a = c(wa), b = c(wb);
  if (Math.abs(b - a) >= 2) return { h: (a + b) / 2, taper: b - a };
  // no taper left: it is a plain pier as wide as the end that was not touched, within what a plain pier may be
  const h = keep === 'a' ? a : b;
  return { h: Math.min(Math.max(was, lim.maxWide), Math.max(Math.min(was, lim.minWide), h)), taper: undefined };
}
/** A twist that fits (v0.41), or none if it is too slight to see. */
const clampTwist = (w: number, h: number, bend: number | undefined, tw: number | undefined) => { if (!tw) return undefined; const m = maxTwist(w, h, bend); const t = Math.max(-m, Math.min(m, tw)); return Math.abs(t) < 0.03 ? undefined : t; };
const clampBend = (w: number, h: number, bend: number | undefined) => { const m = maxBend(w, h); const b = Math.max(-m, Math.min(m, bend ?? 0)); return Math.abs(b) < 4 ? undefined : b; };
export function gripsOf(z: Geom, turns: boolean): { grip: Grip; p: Pt }[] {
  if (z.poly) return z.poly.map((p, i) => ({ grip: `v${i}` as Grip, p }));   // (v0.32: a free area's corners)
  const c = centreOf(z);
  if (z.sides) return [{ grip: 'r', p: z.sides >= 24 ? { x: c.x + Math.min(z.w, z.h) / 2, y: c.y } : hallPts(z)[0] }];
  const n = toWorld(z, { x: c.x, y: z.y }), e = toWorld(z, { x: z.x + z.w, y: c.y }), s = toWorld(z, { x: c.x, y: z.y + z.h }), w = toWorld(z, { x: z.x, y: c.y });
  if (!turns) return [{ grip: 'n', p: n }, { grip: 'e', p: e }, { grip: 's', p: s }, { grip: 'w', p: w }];
  if (curved(z)) {
    const F = frameOf(z); const fc = centreOf(F); const at = (x: number, y: number) => toWorld(z, { x, y });
    return [{ grip: 'a', p: at(F.x, fc.y) }, { grip: 'b', p: at(F.x + F.w, fc.y) }, { grip: 'n', p: at(fc.x, F.y) }, { grip: 's', p: at(fc.x, F.y + F.h) }, { grip: 'm', p: at(fc.x, fc.y) }, { grip: 'ta', p: at(F.x, F.y) }, { grip: 'tb', p: at(F.x + F.w, F.y) }];
  }
  if (alongX(z)) { const nw = toWorld(z, { x: z.x, y: z.y }), ne = toWorld(z, { x: z.x + z.w, y: z.y }); return [{ grip: 'a', p: w }, { grip: 'b', p: e }, { grip: 'n', p: n }, { grip: 's', p: s }, { grip: 'm', p: c }, { grip: 'ta', p: nw }, { grip: 'tb', p: ne }]; }
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
  if (z0.poly && grip[0] === 'v') {
    // v0.32: a corner of a free area moves to the cursor (to the metre); the rest stays where it is
    const i = Number(grip.slice(1)); const poly = z0.poly.map((q, k) => (k === i ? { x: snap(p.x, 1), y: snap(p.y, 1) } : { ...q })); const b = polyBox(poly);
    return { ...geomOf(z0), x: b.x, y: b.y, w: b.w, h: b.h, poly };
  }
  if (z0.sides) {
    const dia = Math.min(lim.maxDia, Math.max(lim.minDia, snap(2 * Math.hypot(p.x - c0.x, p.y - c0.y), 10)));
    const g: Geom = { ...geomOf(z0), x: c0.x - dia / 2, y: c0.y - dia / 2, w: dia, h: dia };
    // the grip of a polygon is its first corner, which sits half a facet anticlockwise of straight up
    if (z0.sides < 24) g.rot = Math.round((Math.atan2(p.y - c0.y, p.x - c0.x) + Math.PI / 2 + Math.PI / facetsOf(z0)) / step) * step || 1e-4;
    return g;
  }
  if (grip === 't') {
    // v0.29: turn about the centre, in snapped steps; square to the grid again, it is an upright rectangle again
    // (so it keeps the shared walls an upright module joins its neighbours by)
    const base = alongX(z0) ? 0 : Math.PI / 2;   // the turn handle sits off the end of the long axis
    const th = Math.round((Math.atan2(p.y - c0.y, p.x - c0.x) - base) / step) * step + (z0.rot ?? 0) * 0;
    const L = alongX(z0) ? z0.w : z0.h, W = alongX(z0) ? z0.h : z0.w;
    let rot = Math.atan2(Math.sin(th), Math.cos(th)); if (rot > Math.PI / 2 + 1e-6) rot -= Math.PI; else if (rot <= -Math.PI / 2 + 1e-6) rot += Math.PI;
    if (Math.abs(rot) < 1e-6) return { ...geomOf(z0), x: c0.x - L / 2, y: c0.y - W / 2, w: L, h: W, rot: undefined };
    // (a bent one always keeps its length along its own x: that is the frame its bend is measured in)
    if (Math.abs(Math.abs(rot) - Math.PI / 2) < 1e-6 && !z0.bend && !z0.twist) return { ...geomOf(z0), x: c0.x - W / 2, y: c0.y - L / 2, w: W, h: L, rot: undefined };
    return { ...geomOf(z0), x: c0.x - L / 2, y: c0.y - W / 2, w: L, h: W, rot };
  }
  if (grip === 'm') {
    // bend: both ends stay put and the middle follows the cursor, square to the line between them
    const P = asPier(z0); const c = centreOf(P);
    const q = P.rot ? turn(p, c, -P.rot) : p;
    const bend = clampBend(P.w, P.h + Math.abs(P.taper ?? 0) / 2, snap(q.y - c.y, 5));
    if (!bend) {
      if (z0.twist) return { ...P, bend: undefined, twist: clampTwist(P.w, P.h, undefined, P.twist) };   // (v0.41: still an S)
      if (!z0.bend && !z0.taper) return geomOf(z0);   // pulled straight again: as it was
      // (v0.34: a hall pulled straight and square to the grid is an upright rectangle again, so it keeps shared walls)
      if (!turns && (!P.rot || Math.abs(Math.sin(2 * P.rot)) < 1e-3)) { const v = !!P.rot && Math.abs(Math.cos(P.rot)) < 0.5; return { ...P, bend: undefined, rot: undefined, x: c.x - (v ? P.h : P.w) / 2, y: c.y - (v ? P.w : P.h) / 2, w: v ? P.h : P.w, h: v ? P.w : P.h }; }
      return { ...P, bend: undefined };
    }
    return { ...P, bend, twist: clampTwist(P.w, P.h, bend, P.twist) };
  }
  if (grip === 'k') {
    // v0.41: the S-curve. The grip stands on the centreline a quarter of the way along; dragged sideways it twists the
    // middle until the centreline passes the cursor there (both ends and the middle stay where they are). Back near
    // the line it was on, the twist goes.
    const P = asPier(z0); const c = centreOf(P); const q = P.rot ? turn(p, c, -P.rot) : p;
    const flat: Geom = { ...P, rot: undefined }; const m = maxTwist(P.w, P.h, P.bend);
    const at = (t: number) => { const g = { ...flat, twist: t || undefined }; const F = frameOf(g); return toWorld(g, { x: F.x + F.w / 4, y: F.y + F.h / 2 }).y; };
    // (the quarter point moves north as the twist grows: find the twist that puts it level with the cursor)
    let lo = -m, hi = m;
    if (q.y >= at(lo)) hi = lo; else if (q.y <= at(hi)) lo = hi;
    else for (let i = 0; i < 30; i++) { const t = (lo + hi) / 2; if (at(t) > q.y) lo = t; else hi = t; }
    const tw = Math.round(((lo + hi) / 2) * 100) / 100;
    const twist = clampTwist(P.w, P.h, P.bend, tw);
    if (!twist && !P.bend && !z0.twist) return geomOf(z0);
    if (!twist && !P.bend && !turns && (!P.rot || Math.abs(Math.sin(2 * P.rot)) < 1e-3)) { const v = !!P.rot && Math.abs(Math.cos(P.rot)) < 0.5; return { ...P, twist: undefined, rot: undefined, x: c.x - (v ? P.h : P.w) / 2, y: c.y - (v ? P.w : P.h) / 2, w: v ? P.h : P.w, h: v ? P.w : P.h }; }
    return { ...P, twist };
  }
  if (grip === 'ta' || grip === 'tb') {
    // one end's width alone: both its corners move, about the centreline
    const P = asPier(z0); const F = frameOf(P); const [wa, wb] = endWidths(P);
    // (measured square off the centreline at that end; a bend does not change which way that is in the frame)
    const flat = { ...P, taper: undefined }; const d = Math.abs(toLocal(flat, p).y - (F.y + F.h / 2));
    const wNew = snap(2 * d, 2); const fit = grip === 'ta' ? fitEnds(wNew, wb, 'b', lim, P.h) : fitEnds(wa, wNew, 'a', lim, P.h); const c = centreOf(P);
    if (!fit.taper && !z0.taper && !P.bend && Math.abs(fit.h - z0.h) < 1e-9 && alongX(z0)) return geomOf(z0);
    return { ...P, y: c.y - fit.h / 2, h: fit.h, taper: fit.taper, bend: clampBend(P.w, Math.max(fit.h + Math.abs(fit.taper ?? 0) / 2, fit.h), P.bend) };
  }
  if ((z0.bend || z0.taper || z0.twist) && (grip === 'n' || grip === 's')) {
    // a bent bar widens about its centreline, so the curve of its spine stays where it is
    const F = frameOf(z0); const d = Math.abs(toLocal({ ...z0, taper: undefined }, p).y - (F.y + F.h / 2));
    let h = Math.min(Math.max(z0.h, lim.maxWide), Math.max(Math.min(z0.h, lim.minWide), snap(2 * d, 5))); const c = centreOf(z0);
    // the taper is kept: both ends widen by the same amount, within what an end may be
    const t = z0.taper ?? 0; h = Math.min(END_WIDTH.max - Math.abs(t) / 2, Math.max(END_WIDTH.min + Math.abs(t) / 2, h));
    const bend = clampBend(z0.w, h + Math.abs(t) / 2, z0.bend);
    return { ...geomOf(z0), y: c.y - h / 2, h, bend, twist: clampTwist(z0.w, h, bend, z0.twist) };
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
    if (!z0.rot && !z0.bend && !z0.taper && !z0.twist && ax && level) return { ...geomOf(z0), x: c.x - L / 2, y: c.y - W / 2, w: L, h: W };
    if (!z0.rot && !z0.bend && !z0.taper && !z0.twist && !ax && plumb) return { ...geomOf(z0), x: c.x - W / 2, y: c.y - L / 2, w: W, h: L };
    // otherwise it is a turned rectangle, long side along its own x, with its north kept roughly up (as the Pier tool draws them)
    // (end a to end b is the frame's own west to east; if keeping north up turns the frame over, the side names swap)
    let quarters = !z0.rot && !ax ? -1 : 0;
    let rot = dir;
    if (rot > Math.PI / 2 + 1e-6) { rot -= Math.PI; quarters += 2; } else if (rot <= -Math.PI / 2 + 1e-6) { rot += Math.PI; quarters += 2; }
    if (Math.abs(Math.sin(2 * rot)) < 1e-6) rot += 1e-4;
    // a bend keeps its depth (as far as the new length allows); if the frame turned over, it now bulges the other way in that frame
    const bend = clampBend(L, W + Math.abs(z0.taper ?? 0) / 2, z0.bend && (quarters % 4 === 2 || quarters % 4 === -2 || quarters === 1 ? -z0.bend : z0.bend));
    // (and a taper turns round with the frame: the wide end stays the wide end)
    const flip = quarters % 4 === 2 || quarters % 4 === -2 || quarters === 1;
    // (v0.41: and an S keeps its twist, as far as the new length allows: turned end for end it is the same S)
    return { x: c.x - L / 2, y: c.y - W / 2, w: L, h: W, rot, sides: undefined, bend, taper: z0.taper ? (flip ? -z0.taper : z0.taper) : undefined, twist: clampTwist(L, W, bend, z0.twist), off: turnKeys(z0.off, quarters) };
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
