// Road geometry (v0.10). Pure: turns the road graph into what a road drawing needs, for both renderers.
//
//   Every junction gets curved kerbs (a turning path between each pair of legs), stop bars and turn arrows on the
//   approaches, and markings that stop short of the junction. Four-lane roads carry a planted median between
//   junctions. Where a road meets State Route 12 it gets a pair of slip ramps. Where a road reaches a car park,
//   garage or rental centre there is a gate plaza with IN and OUT lanes.
//
// Dimensions are ordinary highway practice (AASHTO Green Book orders of magnitude): 3.5 m lanes, 9–15 m kerb radii
// at junctions for cars and buses, a 1.8 m raised median, stop bars set back from the crossing kerb line.
import { Pt, add, sub, mul, norm, dist } from './geom';
import type { Derived, Zone } from './world';

export interface RoadSeg { a: Pt; b: Pt; w: number; lanes: number; hwy: boolean; ref: number; eid: number; trimA: number; trimB: number }
export interface Turn { p1: Pt; c: Pt; p2: Pt; w: number }
export interface Arrow { p: Pt; ang: number; kind: 'ahead' | 'left' | 'right' }
export interface Gate { p: Pt; dir: Pt; zone: Zone; twin: boolean }
export interface RoadPlan {
  segs: RoadSeg[]; turns: Turn[]; ramps: Turn[];
  stops: { a: Pt; b: Pt }[]; arrows: Arrow[]; medians: { a: Pt; b: Pt }[]; gates: Gate[];
}

const cache = new WeakMap<Derived, RoadPlan>();
const widthOf = (kind: string, lanes: number) => (kind === 'hwy' ? 24 : lanes >= 4 ? 16 : 9);

export function roadPlan(d: Derived): RoadPlan {
  const hit = cache.get(d); if (hit) return hit;
  const net = d.road; const N = net.nodes.length;
  const segs: RoadSeg[] = []; const turns: Turn[] = []; const ramps: Turn[] = [];
  const stops: { a: Pt; b: Pt }[] = []; const arrows: Arrow[] = []; const medians: { a: Pt; b: Pt }[] = [];
  // how far markings stand back from each node: the widest crossing leg's half width, plus the kerb radius
  const setback = new Float32Array(N);
  const deg = (n: number) => net.adj[n].length;
  for (let n = 0; n < N; n++) {
    const legs = net.adj[n].map(id => net.edges[id]);
    if (legs.length < 3) { setback[n] = 0; continue; }
    setback[n] = Math.max(...legs.map(e => widthOf(e.kind, e.lanes))) / 2 + 5;
  }
  for (const e of net.edges) {
    const a = net.nodes[e.u], b = net.nodes[e.v];
    segs.push({ a, b, w: widthOf(e.kind, e.lanes), lanes: e.kind === 'hwy' ? 6 : e.lanes, hwy: e.kind === 'hwy', ref: e.ref, eid: e.id, trimA: Math.min(setback[e.u], e.len * 0.45), trimB: Math.min(setback[e.v], e.len * 0.45) });
  }
  for (let n = 0; n < N; n++) {
    const P = net.nodes[n];
    const legs = net.adj[n].map(id => { const e = net.edges[id]; return { e, d: norm(sub(net.nodes[e.u === n ? e.v : e.u], P)), w: widthOf(e.kind, e.lanes) }; });
    if (legs.length < 2) continue;
    const hwyHere = legs.some(l => l.e.kind === 'hwy');
    for (let i = 0; i < legs.length; i++) for (let j = i + 1; j < legs.length; j++) {
      const A = legs[i], B = legs[j];
      const c = A.d.x * B.d.x + A.d.y * B.d.y;
      if (c < -0.985 || c > 0.86) continue;                 // straight through, or a hairpin
      if (A.e.kind === 'hwy' && B.e.kind === 'hwy') continue;
      const w = Math.min(A.w, B.w);
      if (hwyHere && (A.e.kind === 'hwy' || B.e.kind === 'hwy')) {
        // slip ramps: leave the highway early and join the side road well up it
        const side = A.e.kind === 'hwy' ? B : A, hw = A.e.kind === 'hwy' ? A : B;
        const up = Math.min(70, side.e.len * 0.8), out = Math.min(110, hw.e.len * 0.8);
        ramps.push({ p1: add(P, mul(side.d, up)), c: add(add(P, mul(side.d, up * 0.15)), mul(hw.d, out * 0.25)), p2: add(P, mul(hw.d, out)), w: 6.5 });
      }
      const R = Math.min(w * 0.5 + (legs.length > 2 ? 11 : 16) * (1.1 - 0.4 * c), A.e.len * 0.45, B.e.len * 0.45);
      turns.push({ p1: add(P, mul(A.d, R)), c: P, p2: add(P, mul(B.d, R)), w });
    }
    if (legs.length < 3) continue;
    // approaches: a stop bar across the inbound half, and arrows a little further back
    for (const L of legs) {
      if (L.e.kind === 'hwy') continue;
      const sb = Math.min(setback[n], L.e.len * 0.45); if (L.e.len < 26) continue;
      const nrm = { x: -L.d.y, y: L.d.x };                    // left of the outbound direction = inbound traffic's side
      const at = add(P, mul(L.d, sb));
      stops.push({ a: add(at, mul(nrm, 0.3)), b: add(at, mul(nrm, L.w / 2 - 0.6)) });
      if (L.e.len > 60) {
        const others = legs.filter(o => o !== L);
        const back = add(P, mul(L.d, sb + 9)); const ang = Math.atan2(-L.d.y, -L.d.x);
        const turnsTo = (sgn: number) => others.some(o => { const cr = (-L.d.x) * o.d.y - (-L.d.y) * o.d.x; const dt = (-L.d.x) * o.d.x + (-L.d.y) * o.d.y; return Math.abs(dt) < 0.6 && Math.sign(cr) === sgn; });
        const ahead = others.some(o => (-L.d.x) * o.d.x + (-L.d.y) * o.d.y > 0.8);
        const lanesIn = L.e.lanes >= 4 ? 2 : 1;
        for (let k = 0; k < lanesIn; k++) {
          const off = (L.w / 2) * ((k + 0.5) / lanesIn);
          const kind: Arrow['kind'] = lanesIn === 2 ? (k === 0 ? (turnsTo(-1) ? 'left' : 'ahead') : (turnsTo(1) ? 'right' : 'ahead')) : ahead ? 'ahead' : turnsTo(1) ? 'right' : 'left';
          arrows.push({ p: add(back, mul(nrm, off)), ang, kind });
        }
      }
    }
  }
  // planted medians on four-lane roads, between the junction setbacks
  for (const s of segs) {
    if (s.hwy || s.lanes < 4) continue;
    const L = dist(s.a, s.b); const dv = norm(sub(s.b, s.a)); const t0 = s.trimA + 6, t1 = L - s.trimB - 6;
    if (t1 - t0 > 14) medians.push({ a: add(s.a, mul(dv, t0)), b: add(s.a, mul(dv, t1)) });
  }
  // gate plazas where a road reaches a car park, garage or rental centre
  const gates: Gate[] = [];
  for (const z of d.zones) if (z.type === 'parking' || z.type === 'rental') {
    const ns = (d.attach.get(z.id) ?? []).filter(n => deg(n) >= 1);
    for (const n of ns) {
      const p = net.nodes[n]; const e = net.edges[net.adj[n][0]]; if (!e) continue;
      const o = net.nodes[e.u === n ? e.v : e.u];
      // only where the road arrives square-on at the edge
      const inside = { x: Math.min(z.x + z.w, Math.max(z.x, p.x)), y: Math.min(z.y + z.h, Math.max(z.y, p.y)) };
      if (dist(inside, p) > 3.5) continue;
      gates.push({ p: inside, dir: norm(sub(p, o)), zone: z, twin: ns.length > 1 });
    }
  }
  const out = { segs, turns, ramps, stops, arrows, medians, gates };
  cache.set(d, out);
  return out;
}
