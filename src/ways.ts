// Road geometry the player draws (v0.11): curved roads, one-way roads and roundabouts. Pure logic, no DOM.
//
//   A road is a straight line, or a curve with one control point (`c`). A curve is cut into short chords for the
//   network, so cars, routing and tree planting see ordinary straight pieces.
//
//   A roundabout is a circle dropped anywhere. Every road that reaches it is cut back to the circle and joins the
//   ring there, so it can be placed on a crossroads, at a road's end or in the middle of a road, and it just works.
//   The ring is one-way, anticlockwise (traffic keeps right).
import { Pt, bezPts, bezMinRadius, dist, dot, norm, sub, segDist, polyLen, clamp } from './geom';
import { ROUNDS, ROADS } from './config';

export interface Curved { a: Pt; b: Pt; c?: Pt }
/** A roundabout. `size` indexes ROUNDS. */
export interface Round { id: number; x: number; y: number; size: number }
/** A straight piece of road as the network sees it. `ring` is the roundabout a ring piece belongs to. */
export interface Piece { a: Pt; b: Pt; ref: number; lanes: number; ow?: boolean; ring?: number }

export const RING_REF = 5000000;   // clear of the ids of generated drives and sidewalks
export const ringRef = (id: number) => -(RING_REF + id);
export const isRingRef = (ref: number) => ref <= -RING_REF;
export const roundDef = (r: Round) => ROUNDS[r.size] ?? ROUNDS[0];
/** Centreline radius of the circulating roadway. */
export const roundR = (r: Round) => roundDef(r).icd / 2 - roundDef(r).width / 2;
/** Outer kerb radius (half the inscribed circle diameter). */
export const roundOuter = (r: Round) => roundDef(r).icd / 2;

/** The road as a polyline: two points if straight, short chords along a curve. */
export function wayPts(w: Curved): Pt[] {
  if (!w.c) return [w.a, w.b];
  const L = dist(w.a, w.c) + dist(w.c, w.b);
  const turn = Math.acos(clamp(dot(norm(sub(w.c, w.a)), norm(sub(w.b, w.c))), -1, 1));
  const n = clamp(Math.ceil(Math.max(turn / 0.1, L / 16)), 2, Math.max(2, Math.floor((L * 0.8) / ROADS.minChord)));
  return bezPts(w.a, w.c, w.b, n);
}
export const wayLen = (w: Curved) => (w.c ? polyLen(wayPts(w)) : dist(w.a, w.b));
export function wayDist(p: Pt, w: Curved) {
  if (!w.c) return segDist(p, w.a, w.b);
  const pts = wayPts(w); let m = Infinity;
  for (let i = 1; i < pts.length; i++) m = Math.min(m, segDist(p, pts[i - 1], pts[i]));
  return m;
}
/** The straight chords of a way. */
export function waySegs(w: Curved): [Pt, Pt][] {
  const pts = wayPts(w); const out: [Pt, Pt][] = [];
  for (let i = 1; i < pts.length; i++) out.push([pts[i - 1], pts[i]]);
  return out;
}
/** Midpoint of the road, on the curve: where its bend handle sits. */
export const wayMid = (w: Curved): Pt => (w.c
  ? { x: 0.25 * w.a.x + 0.5 * w.c.x + 0.25 * w.b.x, y: 0.25 * w.a.y + 0.5 * w.c.y + 0.25 * w.b.y }
  : { x: (w.a.x + w.b.x) / 2, y: (w.a.y + w.b.y) / 2 });
/** The control point that makes the curve pass through m at its middle. Undefined when m is on the straight line. */
export function bendThrough(a: Pt, b: Pt, m: Pt): Pt | undefined {
  const c = { x: 2 * m.x - (a.x + b.x) / 2, y: 2 * m.y - (a.y + b.y) / 2 };
  return segDist(c, a, b) < ROADS.straighten ? undefined : c;
}
/** Is the curve gentle enough to drive? */
export const curveOK = (w: Curved) => !w.c || bezMinRadius(w.a, w.c, w.b) >= ROADS.minRadius;

/**
 * Every road as straight pieces: curves in chords, straight roads split at `cuts` (where curbs begin and end),
 * everything cut back to the ring of any roundabout it reaches, and the rings themselves.
 */
export function roadPieces(roads: { id: number; a: Pt; b: Pt; c?: Pt; lanes: number; oneway?: boolean }[], rounds: Round[], cuts: Map<number, Pt[]>): Piece[] {
  const out: Piece[] = [];
  const entries = rounds.map(() => [] as { ang: number; piece: Piece; end: 'a' | 'b' }[]);
  for (const w of roads) {
    let pts = wayPts(w);
    if (!w.c) {
      const al = norm(sub(w.b, w.a));
      pts = [w.a, ...[...(cuts.get(w.id) ?? [])].sort((p, q) => dot(sub(p, w.a), al) - dot(sub(q, w.a), al)), w.b];
    }
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1]; const L = dist(a, b); if (L <= 1) continue;
      // the stretches of this chord inside a roundabout's ring are removed
      const holes: { t0: number; t1: number; ri: number }[] = [];
      rounds.forEach((r, ri) => {
        const R = roundR(r); const dx = b.x - a.x, dy = b.y - a.y, fx = a.x - r.x, fy = a.y - r.y;
        const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - R * R;
        const D = B * B - 4 * A * C; if (D <= 0) return;
        const q = Math.sqrt(D); const t0 = (-B - q) / (2 * A), t1 = (-B + q) / (2 * A);
        if (t1 <= 0 || t0 >= 1) return;
        holes.push({ t0, t1, ri });
      });
      if (!holes.length) { out.push({ a, b, ref: w.id, lanes: w.lanes, ow: w.oneway }); continue; }
      holes.sort((p, q) => p.t0 - q.t0);
      const at = (t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      let t = 0; let from: { ri: number } | null = null;
      const emit = (t0: number, t1: number, r0: number | null, r1: number | null) => {
        if ((t1 - t0) * L < 0.5) return;
        const pc: Piece = { a: at(t0), b: at(t1), ref: w.id, lanes: w.lanes, ow: w.oneway };
        out.push(pc);
        if (r0 !== null) entries[r0].push({ ang: Math.atan2(pc.a.y - rounds[r0].y, pc.a.x - rounds[r0].x), piece: pc, end: 'a' });
        if (r1 !== null) entries[r1].push({ ang: Math.atan2(pc.b.y - rounds[r1].y, pc.b.x - rounds[r1].x), piece: pc, end: 'b' });
      };
      for (const h of holes) {
        if (h.t0 > t) emit(t, h.t0, from ? from.ri : null, h.ri);
        if (h.t1 > t) { t = h.t1; from = { ri: h.ri }; }
      }
      if (t < 1) emit(t, 1, from ? from.ri : null, null);
    }
  }
  // the rings: a vertex at every entry (entries closer than a chord share one), and evenly round the rest
  rounds.forEach((r, ri) => {
    const R = roundR(r); const minA = (ROADS.minChord + 0.5) / R;
    const gap = (p: number, q: number) => { const d = Math.abs(p - q) % (Math.PI * 2); return Math.min(d, Math.PI * 2 - d); };
    const angs: number[] = [];
    for (const e of entries[ri].sort((p, q) => p.ang - q.ang)) {
      let k = angs.find(x => gap(x, e.ang) < minA);
      if (k === undefined) { k = e.ang; angs.push(k); }
      e.piece[e.end] = { x: r.x + R * Math.cos(k), y: r.y + R * Math.sin(k) };
    }
    const N = Math.max(8, Math.round((Math.PI * 2 * R) / 6.5));
    for (let i = 0; i < N; i++) { const x = -Math.PI + (i / N) * Math.PI * 2; if (!angs.some(k => gap(k, x) < minA)) angs.push(x); }
    angs.sort((p, q) => q - p);   // falling angle: anticlockwise on screen, where y runs down
    for (let i = 0; i < angs.length; i++) {
      const p = angs[i], q = angs[(i + 1) % angs.length];
      out.push({ a: { x: r.x + R * Math.cos(p), y: r.y + R * Math.sin(p) }, b: { x: r.x + R * Math.cos(q), y: r.y + R * Math.sin(q) }, ref: ringRef(r.id), lanes: 2, ow: true, ring: r.id });
    }
  });
  return out;
}
