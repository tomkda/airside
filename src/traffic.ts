// Traffic as you see it (v0.12). Pure: reads the sim's cars and returns where to draw each one.
//
//   The sim moves a car along the centreline of its route and slows it by how full each road is; that is all the
//   numbers need. This module turns that into something that reads as traffic: each car keeps to its lane on the
//   right, corners are driven as curves, and cars on the same stretch hold a gap behind the one in front, so a slow
//   road shows as a queue with brake lights instead of cars passing through each other.
//
// Lane positions follow the road widths in roads.ts: 3.5 m lanes either side of the centre line or median.
// The gap is a car length plus about two metres, the usual standstill spacing in queue models.
import { Pt, dist, along, polyLen } from './geom';
import type { Sim, Car } from './sim';
import type { Edge } from './net';
import { isRingRef, RING_REF, roundDef } from './ways';

/** `up`: 0 on the ground, 1 at deck level, for a car on a ramp or an upper deck (v0.13). */
export interface Pose { x: number; y: number; ang: number; brake: boolean; moving: boolean; up: number }
export const CAR_COLS = ['#3A352D', '#8C8576', '#E9E4DA', '#B0472B', '#2F4E78', '#6E7F86', '#CFC6B4', '#5E7A55', '#1F1C18'];
export const CAR_GAP = 6.8;

interface Lane { pts: Pt[]; len: number; ratio: number }
const laneCache = new WeakMap<Pt[], Lane>();
let memo: { sim: Sim; t: number; n: number; d: unknown; out: Map<Car, Pose> } | null = null;

/** How far right of the centreline a car drives on this edge. */
function laneOffset(sim: Sim, e: Edge | undefined, id: number, forward: boolean): number {
  if (!e) return 0;
  if (e.kind === 'hwy') return [4.4, 8][id % 2];
  if (isRingRef(e.ref)) {
    const r = sim.d.rounds.find(q => q.id === -e.ref - RING_REF); const def = r ? roundDef(r) : undefined;
    return def && def.lanes > 1 ? (id % 2 ? 2.3 : -2.3) : 0;
  }
  if (e.ow && e.lanes <= 1) return 0;   // v0.28: a ramp's single speed-change lane
  if (e.ow) {
    const slots = e.lanes >= 4 ? [-6, -2, 2, 6] : [-2.25, 2.25];
    return slots[id % slots.length] * (forward ? 1 : -1);
  }
  return e.lanes >= 4 ? [2.9, 6.1][id % 2] : 2.25;
}

/** The car's route as the line it actually drives: offset into its lane, with every corner rounded. */
function laneOf(sim: Sim, c: Car): Lane {
  const hit = laneCache.get(c.pts); if (hit) return hit;
  const P = c.pts; const E = sim.d.road.edges; const N = sim.d.road.nodes;
  const segs: { a: Pt; b: Pt }[] = [];
  for (let i = 0; i + 1 < P.length; i++) {
    const a = P[i], b = P[i + 1]; const l = dist(a, b); if (l < 0.01) continue;
    const e = c.eids[i] >= 0 ? E[c.eids[i]] : undefined;
    const fwd = !e || dist(N[e.u], a) <= dist(N[e.v], a);
    const k = laneOffset(sim, e, c.id, fwd); const nx = -(b.y - a.y) / l, ny = (b.x - a.x) / l;
    segs.push({ a: { x: a.x + nx * k, y: a.y + ny * k }, b: { x: b.x + nx * k, y: b.y + ny * k } });
  }
  // join the offset pieces: where two meet, cut the corner with a short curve
  const pts: Pt[] = [];
  const push = (p: Pt) => { const q = pts[pts.length - 1]; if (!q || dist(p, q) > 0.05) pts.push(p); };
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]; const l = dist(s.a, s.b);
    const prev = segs[i - 1], next = segs[i + 1];
    const cut = (o: { a: Pt; b: Pt } | undefined) => (o ? Math.min(7, l * 0.42, dist(o.a, o.b) * 0.42) : 0);
    const c0 = cut(prev), c1 = cut(next);
    const at = (d0: number): Pt => ({ x: s.a.x + ((s.b.x - s.a.x) * d0) / l, y: s.a.y + ((s.b.y - s.a.y) * d0) / l });
    const p0 = at(c0), p1 = at(l - c1);
    if (prev) {
      // quadratic from the end of the last piece to the start of this one, bending through where their lines meet
      const q0 = pts[pts.length - 1]; const m = meet(prev, s) ?? { x: (prev.b.x + s.a.x) / 2, y: (prev.b.y + s.a.y) / 2 };
      for (let k = 1; k <= 4; k++) { const t = k / 4, u = 1 - t; push({ x: u * u * q0.x + 2 * u * t * m.x + t * t * p0.x, y: u * u * q0.y + 2 * u * t * m.y + t * t * p0.y }); }
    } else push(p0);
    push(p1);
  }
  if (pts.length < 2) { pts.length = 0; pts.push(P[0], P[P.length - 1] ?? P[0]); }
  const len = polyLen(pts);
  const lane = { pts, len, ratio: c.len > 0 ? len / c.len : 1 };
  laneCache.set(c.pts, lane);
  return lane;
}

function meet(p: { a: Pt; b: Pt }, q: { a: Pt; b: Pt }): Pt | null {
  const rx = p.b.x - p.a.x, ry = p.b.y - p.a.y, sx = q.b.x - q.a.x, sy = q.b.y - q.a.y;
  const den = rx * sy - ry * sx; if (Math.abs(den) < 1e-6) return null;
  const t = ((q.a.x - p.a.x) * sy - (q.a.y - p.a.y) * sx) / den;
  const m = { x: p.a.x + rx * t, y: p.a.y + ry * t };
  // a near-parallel pair meets far away: not a corner worth bending through
  return dist(m, p.b) > 30 || dist(m, q.a) > 30 ? null : m;
}

/** Where to draw every car this frame. Shared by the plan and the 3D view. */
export function carPoses(sim: Sim): Map<Car, Pose> {
  if (memo && memo.sim === sim && memo.t === sim.t && memo.n === sim.cars.length && memo.d === sim.d) return memo.out;
  const out = new Map<Car, Pose>();
  // moving cars, grouped by the stretch of road and the lane they are on
  const groups = new Map<string, { c: Car; rem: number; lane: Lane }[]>();
  for (const c of sim.cars) {
    if (c.stage === 'gone') continue;
    if (c.stage === 'in' || c.stage === 'out' || c.stage === 'park') {
      const lane = laneOf(sim, c); const e = c.eids[c.si];
      const rem = (c.cum[Math.min(c.si + 1, c.cum.length - 1)] ?? c.len) - c.d;
      const a = c.pts[c.si], b = c.pts[Math.min(c.si + 1, c.pts.length - 1)];
      const key = e >= 0 ? `${e}:${a.x < b.x || (a.x === b.x && a.y < b.y) ? 1 : 0}:${laneKey(sim, c, e)}` : `x${c.id}`;
      let g = groups.get(key); if (!g) groups.set(key, g = []);
      g.push({ c, rem, lane });
    } else {
      // waiting for a bay, or stopped in one: the sim has placed it; a waiting car sits in the kerb lane
      const k = c.stage === 'queue' ? 2.25 : 0;
      out.set(c, { x: c.x - Math.sin(c.ang) * k, y: c.y + Math.cos(c.ang) * k, ang: c.ang, brake: c.stage === 'queue', moving: false, up: c.curb?.zone.level === 1 ? 1 : 0 });
    }
  }
  for (const g of groups.values()) {
    g.sort((p, q) => p.rem - q.rem || p.c.id - q.c.id);
    let lead = -Infinity;
    for (const it of g) {
      const rem = Math.max(it.rem, lead + CAR_GAP); lead = rem;
      const held = rem - it.rem;
      const d = Math.max(0, it.c.d - held) * it.lane.ratio;
      const a = along(it.lane.pts, Math.min(d, it.lane.len));
      const e = it.c.eids[it.c.si];
      out.set(it.c, { x: a.p.x, y: a.p.y, ang: a.ang, brake: held > 1.5 || (e >= 0 && sim.congestion(e) < 0.55), moving: true, up: deckHeight(sim, it.c, a.p) });
    }
  }
  memo = { sim, t: sim.t, n: sim.cars.length, d: sim.d, out };
  return out;
}

/** How high a car bound for (or leaving) a departures deck is: it climbs with the ramp it is on. */
function deckHeight(sim: Sim, c: Car, p: Pt): number {
  const tag = c.curb?.zone.auto; if (!tag || tag.deck !== 'dep') return 0;
  const dk = sim.d.decks.find(q => q.road === tag.road); if (!dk) return 0;
  let best = 0, bd = 9;
  for (let i = 1; i < dk.pts.length; i++) {
    const a = dk.pts[i - 1], b = dk.pts[i]; const dx = b.x - a.x, dy = b.y - a.y; const l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    const dd = Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t);
    if (dd < bd) { bd = dd; best = dk.zs[i - 1] + (dk.zs[i] - dk.zs[i - 1]) * t; }
  }
  return best;
}

function laneKey(sim: Sim, c: Car, eid: number): number {
  const e = sim.d.road.edges[eid]; if (!e) return 0;
  return Math.round(laneOffset(sim, e, c.id, true) * 10);
}
