// Road geometry (v0.10). Pure: turns the road graph into what a road drawing needs, for both renderers.
//
//   Every junction gets curved kerbs (a turning path between each pair of legs), stop bars and turn arrows on the
//   approaches, and markings that stop short of the junction. Four-lane roads carry a planted median between
//   junctions. v0.11: curved roads are one smooth path, one-way roads carry lane arrows, and a roundabout gets flared
//   entries, splitter islands and yield lines. Where a road meets State Route 12 it gets a pair of slip ramps. Where a road reaches a car park,
//   garage or rental centre there is a gate plaza with IN and OUT lanes.
//
// Dimensions are ordinary highway practice (AASHTO Green Book orders of magnitude): 3.5 m lanes, 9–15 m kerb radii
// at junctions for cars and buses, a 1.8 m raised median, stop bars set back from the crossing kerb line.
import { Pt, add, sub, mul, norm, dist, polyLen, sliceLine } from './geom';
import type { Derived, Zone } from './world';
import { isRingRef, roundR, roundDef, RING_REF } from './ways';

export interface RoadSeg { a: Pt; b: Pt; w: number; lanes: number; hwy: boolean; ref: number; eid: number; trimA: number; trimB: number }
/** v0.11: a run of road between junctions, as one polyline, so curves draw smooth and dashes keep their rhythm. */
export interface RoadPath { pts: Pt[]; len: number; w: number; lanes: number; hwy: boolean; ow: boolean; ref: number; trimA: number; trimB: number }
export interface Turn { p1: Pt; c: Pt; p2: Pt; w: number }
export interface Arrow { p: Pt; ang: number; kind: 'ahead' | 'left' | 'right' }
export interface Gate { p: Pt; dir: Pt; zone: Zone; twin: boolean }
/** A roundabout as drawn: `r` is the centreline radius of the ring, `w` its width; entries are where roads join. */
export interface RoundPlan { id: number; c: Pt; r: number; w: number; lanes: number; entries: { ang: number; w: number }[] }
export interface RoadPlan {
  segs: RoadSeg[]; paths: RoadPath[]; turns: Turn[]; ramps: Turn[];
  stops: { a: Pt; b: Pt }[]; yields: { a: Pt; b: Pt }[]; arrows: Arrow[]; medians: Pt[][]; gates: Gate[];
  rounds: RoundPlan[]; islands: Pt[][];
}

const cache = new WeakMap<Derived, RoadPlan>();
const widthOf = (kind: string, lanes: number) => (kind === 'hwy' ? 24 : lanes >= 4 ? 16 : 9);
/** Right-hand side of a direction on screen (y runs down). Traffic keeps right. */
const right = (d: Pt): Pt => ({ x: -d.y, y: d.x });

export function roadPlan(d: Derived): RoadPlan {
  const hit = cache.get(d); if (hit) return hit;
  const net = d.road; const N = net.nodes.length;
  const segs: RoadSeg[] = []; const turns: Turn[] = []; const ramps: Turn[] = [];
  const stops: { a: Pt; b: Pt }[] = []; const yields: { a: Pt; b: Pt }[] = []; const arrows: Arrow[] = []; const medians: Pt[][] = [];
  const islands: Pt[][] = [];
  const rounds: RoundPlan[] = d.rounds.map(r => ({ id: r.id, c: { x: r.x, y: r.y }, r: roundR(r), w: roundDef(r).width, lanes: roundDef(r).lanes, entries: [] }));
  const ringAt = (n: number) => { for (const k of net.adj[n]) if (isRingRef(net.edges[k].ref)) return rounds.find(r => r.id === -net.edges[k].ref - RING_REF); return undefined; };
  // how far markings stand back from each node: the widest crossing leg's half width, plus the kerb radius
  const setback = new Float32Array(N);
  const deg = (n: number) => net.adj[n].length;
  for (let n = 0; n < N; n++) {
    const legs = net.adj[n].map(id => net.edges[id]);
    const ring = ringAt(n);
    if (ring) { setback[n] = ring.w / 2 + 9; continue; }
    if (legs.length < 3) { setback[n] = 0; continue; }
    setback[n] = Math.max(...legs.map(e => widthOf(e.kind, e.lanes))) / 2 + 5;
  }
  for (const e of net.edges) {
    if (isRingRef(e.ref)) continue;
    const a = net.nodes[e.u], b = net.nodes[e.v];
    segs.push({ a, b, w: widthOf(e.kind, e.lanes), lanes: e.kind === 'hwy' ? 6 : e.lanes, hwy: e.kind === 'hwy', ref: e.ref, eid: e.id, trimA: Math.min(setback[e.u], e.len * 0.45), trimB: Math.min(setback[e.v], e.len * 0.45) });
  }
  // ---- paths: chain edges of one road through the nodes where nothing else joins
  const through = (n: number) => { const a = net.adj[n]; return a.length === 2 && net.edges[a[0]].ref === net.edges[a[1]].ref && net.edges[a[0]].kind === net.edges[a[1]].kind && !isRingRef(net.edges[a[0]].ref); };
  const paths: RoadPath[] = []; const seen = new Uint8Array(net.edges.length);
  for (const e0 of net.edges) {
    if (seen[e0.id] || isRingRef(e0.ref)) continue;
    const walk = (from: number, eid: number) => {   // nodes after `from`, following the chain
      const out: number[] = []; let n = from, k = eid;
      for (let guard = 0; guard < 4000; guard++) {
        const e = net.edges[k]; seen[k] = 1; n = e.u === n ? e.v : e.u; out.push(n);
        if (!through(n)) break;
        const nx = net.adj[n][0] === k ? net.adj[n][1] : net.adj[n][0];
        if (seen[nx]) break; k = nx;
      }
      return out;
    };
    const fwd = walk(e0.u, e0.id);
    let back: number[] = [];
    if (through(e0.u)) { const k = net.adj[e0.u][0] === e0.id ? net.adj[e0.u][1] : net.adj[e0.u][0]; if (!seen[k]) back = walk(e0.u, k); }
    const ns = [...back.reverse(), e0.u, ...fwd];
    const pts = ns.map(n => net.nodes[n]); const len = polyLen(pts);
    const n0 = ns[0], n1 = ns[ns.length - 1];
    paths.push({ pts, len, w: widthOf(e0.kind, e0.lanes), lanes: e0.kind === 'hwy' ? 6 : e0.lanes, hwy: e0.kind === 'hwy', ow: e0.ow, ref: e0.ref, trimA: Math.min(setback[n0], len * 0.45), trimB: Math.min(setback[n1], len * 0.45) });
  }
  for (let n = 0; n < N; n++) {
    const P = net.nodes[n];
    const all = net.adj[n].map(id => { const e = net.edges[id]; return { e, d: norm(sub(net.nodes[e.u === n ? e.v : e.u], P)), w: widthOf(e.kind, e.lanes), inb: !e.ow || e.v === n, outb: !e.ow || e.u === n }; });
    const ring = ringAt(n);
    if (ring) {
      // a road joining a roundabout: flared entry and exit curves, a splitter island between them, a yield line
      const th = Math.atan2(P.y - ring.c.y, P.x - ring.c.x);
      for (const L of all) {
        if (isRingRef(L.e.ref)) continue;
        ring.entries.push({ ang: th, w: L.w });
        const dl = Math.min(0.8, (L.w / 2 + 8) / ring.r); const far = Math.min(L.w / 2 + 12, L.e.len * 0.9);
        const onRing = (a: number) => ({ x: ring.c.x + ring.r * Math.cos(a), y: ring.c.y + ring.r * Math.sin(a) });
        const fw = L.w >= 16 ? 8.5 : 5.2; const nr = right(L.d);
        // entering traffic bears right, towards falling angle; leaving traffic comes in from the other side
        if (L.inb) turns.push({ p1: add(add(P, mul(L.d, far)), mul(nr, -(L.w / 2 - fw / 2))), c: add(add(P, mul(L.d, 3)), mul(nr, -(L.w / 2 - fw / 2) * 1.2)), p2: onRing(th - dl), w: fw });
        if (L.outb) turns.push({ p1: add(add(P, mul(L.d, far)), mul(nr, L.w / 2 - fw / 2)), c: add(add(P, mul(L.d, 3)), mul(nr, (L.w / 2 - fw / 2) * 1.2)), p2: onRing(th + dl), w: fw });
        const edge = ring.w / 2 + 0.9;
        if (L.inb && L.outb && L.e.len > 14) {
          const tip = add(P, mul(L.d, Math.min(edge + 9, L.e.len * 0.8))); const hw = L.w >= 16 ? 2.2 : 1.5;
          islands.push([tip, add(add(P, mul(L.d, edge + 3)), mul(nr, hw * 0.8)), add(add(P, mul(L.d, edge)), mul(nr, hw)), add(add(P, mul(L.d, edge)), mul(nr, -hw)), add(add(P, mul(L.d, edge + 3)), mul(nr, -hw * 0.8))]);
        }
        if (L.inb) { const at = add(P, mul(L.d, edge + 0.4)); yields.push({ a: add(at, mul(nr, -(L.outb ? 1.7 : -L.w / 2 + 0.6))), b: add(at, mul(nr, -(L.w / 2 + 1.5))) }); }
      }
      continue;
    }
    const legs = all;
    if (legs.length < 2) continue;
    const hwyHere = legs.some(l => l.e.kind === 'hwy');
    for (let i = 0; i < legs.length; i++) for (let j = i + 1; j < legs.length; j++) {
      const A = legs[i], B = legs[j];
      const c = A.d.x * B.d.x + A.d.y * B.d.y;
      if (c < -0.985 || c > 0.86) continue;                 // straight through, or a hairpin
      if (legs.length === 2 && A.e.ref === B.e.ref && c < -0.9) continue;   // along a curve: the path itself is smooth
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
    // approaches: a stop bar across the inbound side, and arrows a little further back
    for (const L of legs) {
      if (L.e.kind === 'hwy' || !L.inb) continue;
      const sb = Math.min(setback[n], L.e.len * 0.45); if (L.e.len < 26) continue;
      const tr = mul(L.d, -1);                                // direction of inbound travel
      const nrm = right(tr);
      const at = add(P, mul(L.d, sb));
      stops.push({ a: add(at, mul(nrm, L.outb ? 0.3 : -L.w / 2 + 0.6)), b: add(at, mul(nrm, L.w / 2 - 0.6)) });
      if (L.e.len > 60) {
        const others = legs.filter(o => o !== L && o.outb);
        const back = add(P, mul(L.d, sb + 9)); const ang = Math.atan2(tr.y, tr.x);
        const turnsTo = (sgn: number) => others.some(o => { const cr = tr.x * o.d.y - tr.y * o.d.x; const dt = tr.x * o.d.x + tr.y * o.d.y; return Math.abs(dt) < 0.6 && Math.sign(cr) === sgn; });
        const ahead = others.some(o => tr.x * o.d.x + tr.y * o.d.y > 0.8);
        const lanesIn = (L.e.lanes >= 4 ? 2 : 1) * (L.outb ? 1 : 2);
        const span = L.outb ? L.w / 2 : L.w; const base = L.outb ? 0 : -L.w / 2;
        for (let k = 0; k < lanesIn; k++) {
          const off = base + span * ((k + 0.5) / lanesIn);
          // the lane nearest the centre line turns left, the kerb lane right
          const kind: Arrow['kind'] = lanesIn >= 2 ? (k === 0 ? (turnsTo(-1) ? 'left' : 'ahead') : k === lanesIn - 1 ? (turnsTo(1) ? 'right' : 'ahead') : 'ahead') : ahead ? 'ahead' : turnsTo(1) ? 'right' : 'left';
          arrows.push({ p: add(back, mul(nrm, off)), ang, kind });
        }
      }
    }
  }
  for (const s of paths) {
    const t0 = s.trimA + 6, t1 = s.len - s.trimB - 6;
    // planted medians on four-lane two-way roads, between the junction setbacks
    if (!s.hwy && !s.ow && s.lanes >= 4 && t1 - t0 > 14) medians.push(sliceLine(s.pts, t0, t1));
    // one-way roads: an arrow in every lane, every 50 m or so
    if (s.ow && t1 - t0 > 8) {
      const lanes = s.lanes >= 4 ? 4 : 2; const n = Math.max(1, Math.round((t1 - t0) / 50));
      for (let i = 0; i < n; i++) {
        const at = pointAt(s.pts, t0 + ((i + 0.5) / n) * (t1 - t0)); const nr = right(at.d);
        for (let k = 0; k < lanes; k++) arrows.push({ p: add(at.p, mul(nr, -s.w / 2 + s.w * ((k + 0.5) / lanes))), ang: Math.atan2(at.d.y, at.d.x), kind: 'ahead' });
      }
    }
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
  const out = { segs, paths, turns, ramps, stops, yields, arrows, medians, gates, rounds, islands };
  cache.set(d, out);
  return out;
}

function pointAt(pts: Pt[], dd: number): { p: Pt; d: Pt } {
  let s = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]; const l = dist(a, b);
    if (dd <= s + l || i === pts.length - 1) return { p: add(a, mul(sub(b, a), l > 0 ? Math.min(1, (dd - s) / l) : 0)), d: norm(sub(b, a)) };
    s += l;
  }
  return { p: pts[0], d: { x: 1, y: 0 } };
}
