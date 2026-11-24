// Frontage: how roads and terminals adapt to each other (v0.8). Pure logic, no DOM.
//
//   A road that runs alongside a terminal's landside face grows a curb in the gap between them, as long as the
//   building face is long enough and the gap is a sensible curb depth. Nothing has to be placed exactly:
//   anything from FRONTAGE.minGap to FRONTAGE.maxGap works, and the road tool snaps to the ideal line.
//
//   Where departures (check-in on Level 1) sit over arrivals (baggage claim on Ground) along the same road,
//   that stretch becomes a two-level frontage road: an upper deck with the departures curb at Level 1 and the
//   arrivals curb below. Drop-offs use the upper deck, pickups the lower one (ACRP Report 40 describes the split
//   departures / arrivals curb as the usual arrangement once a terminal is busy enough for two levels).
//
// Generated curbs are ordinary Zone objects with negative ids and an `auto` tag. They are rebuilt on every
// derive and never saved, so moving a road or a module moves its curb with it.
import { Pt, Rect, sub, dot, dist, norm, lerpPt, rectsOverlap, polyLen, segDist } from './geom';
import { FRONTAGE, Level, ZoneType } from './config';
import type { World, Zone, Way, RampGeo } from './world';
import { sidesOf } from './gates';
import { waySegs, wayPts, roundDef } from './ways';
import { zonesOverlap, shaped, zonePts, inZone, Shaped, arcOf, curved, frameOf, toWorld, toLocal } from './shapes';

export type Deck = 'dep' | 'arr' | 'both';
export interface AutoTag { road: number; module: number; deck: Deck; gap: number; /** v0.34: a piece of a curb along a curved wall: which wall, and where along it */ chain?: string; k?: number }
/** An elevated stretch of road, drawn as an upper deck over the ground-level road. */
export interface DeckSpan {
  /** v0.64: a second ramp joining the deck at an end that already has one (a trumpet's way down): drawn like a deck, counted as none */
  branch?: boolean;
  road: number; a: Pt; b: Pt; width: number;
  /** v0.34: along a curved face, every chord of the road the deck runs over */
  roads?: number[];
  /** v0.13: the deck's centreline from where it leaves the ground to where it lands again, with the height
   *  (0 on the ground, 1 at deck level) and the width at each point. A ramp may curve away from the ground road. */
  pts: Pt[]; zs: number[]; ws: number[];
  /** v0.28: at each point, which edge (-1 left, 1 right, 0 neither) is the edge of the road the ramp runs alongside;
   *  the painted gore between the ramp and the road where they part; and the line between the road's outer lane and
   *  the speed-change lane, which is broken, not solid. */
  abut: number[]; gores: Pt[][]; seams: Pt[][]; arrows: { p: Pt; ang: number }[];
}
/** Where a road would ideally run to front a module: the guide the road tool shows and snaps to. */
export interface FrontGuide { zone: Zone; a: Pt; b: Pt; out: Pt; /** v0.39: a piece of a curved wall: which wall, and where along it */ chain?: string; k?: number }

const FRONT_TYPES = new Set<ZoneType>(['checkin', 'claim', 'security']);
const roadWidth = (lanes: number) => (lanes >= 4 ? 16 : 9);

interface Cand { m: Zone; road: Way; level: Level; a: Pt; b: Pt; out: Pt; gap: number; t0: number; t1: number; line: number; chain?: string; k?: number; sag?: number }
/** v0.34: a face of a module. A curved wall (a bent hall's) is cut into straight pieces about `FACE_PIECE` m long, each
 *  a face of its own; `chain` names the wall and `k` is the piece's place along it. */
interface Face { a: Pt; b: Pt; out: Pt; chain?: string; k?: number; sag?: number }
const FACE_PIECE = 40;
export function facesOf(m: Zone): Face[] {
  return sidesOf(m).flatMap((sd): Face[] => {
    if (sd.curve === undefined || !curved(m)) return [sd];
    const F = frameOf(m); const at = (x: number) => toWorld(m, { x, y: sd.curve! });
    const [x0, x1] = dist(at(F.x), sd.a) < dist(at(F.x + F.w), sd.a) ? [F.x, F.x + F.w] : [F.x + F.w, F.x];
    // (as many pieces as this wall's own length holds: the inside wall of a bend is shorter than its centreline)
    let wl = 0; for (let i = 1; i <= 32; i++) wl += dist(at(x0 + ((x1 - x0) * (i - 1)) / 32), at(x0 + ((x1 - x0) * i) / 32));
    const n = Math.max(1, Math.floor(wl / FACE_PIECE));
    const pts = Array.from({ length: n + 1 }, (_, i) => at(x0 + ((x1 - x0) * i) / n));
    // which way is out: away from the building's middle, in its own straight frame (the north wall's out is -y)
    const sgn = sd.curve! <= F.y + F.h / 2 ? -1 : 1;
    return pts.slice(0, -1).map((a, k) => {
      const b = pts[k + 1]; const d = norm(sub(b, a)); let out = { x: -d.y, y: d.x }; const mid = lerpPt(a, b, 0.5);
      const xm = x0 + ((x1 - x0) * (k + 0.5)) / n; const wm = at(xm);
      const off = toLocal(m, { x: wm.x + out.x, y: wm.y + out.y }).y - toLocal(m, wm).y; if (off * sgn < 0) out = { x: -out.x, y: -out.y };
      // (and how far the wall stands off the chord at its middle: a curb must reach that far in to meet it)
      return { a, b, out, chain: `${m.id}:${sd.side}`, k, sag: dist(mid, wm) };
    });
  });
}

/** Curbs and decks for every road that runs along a terminal's landside face. */
export function autoFrontage(world: World, extra: Way[] = []): { curbs: Zone[]; decks: DeckSpan[]; guides: FrontGuide[] } {
  // (v0.39: a curved road the player drew counts too, piece by piece: see `opposite`)
  const roads = [...world.ways.filter(w => w.kind === 'road'), ...extra.filter(w => w.fore === 'face')];
  const memo = new Map<string, Way | null>(), realOf = new Map<Way, Way>();
  const mods = world.zones.filter(z => FRONT_TYPES.has(z.type));
  const cands: Cand[] = [];
  const guides: FrontGuide[] = [];
  for (const m of mods) for (const sd of facesOf(m)) {
    const L = dist(sd.a, sd.b); const al = norm(sub(sd.b, sd.a));
    // a face that touches another module on the same level is interior, not frontage
    const probe = faceBox(lerpPt(sd.a, sd.b, 0.1), lerpPt(sd.a, sd.b, 0.9), sd.out, 1.5);
    const inner = world.zones.some(o => o.id !== m.id && o.level === m.level && TERMINAL_SET.has(o.type) && hits(probe, o));
    if (inner || L < FRONTAGE.minLen) continue;
    guides.push({ zone: m, a: sd.a, b: sd.b, out: sd.out, ...(sd.chain ? { chain: sd.chain, k: sd.k } : {}) });
    for (const r0 of roads) {
      const r = opposite(r0, sd, L, al, memo); if (!r) continue; if (r !== r0) realOf.set(r, r0);
      // (v0.34: a piece of a curved wall takes a curb from two thirds of the usual run: on the inside of a tight bend
      //  the road's chords are shorter than the wall's)
      const f = fronts(r, sd, L, al, sd.chain ? FRONTAGE.minLen * 2 / 3 : FRONTAGE.minLen); if (!f) continue;
      const { gap, t0, t1 } = f;
      const line = Math.round(dot(sd.a, sd.out));   // which building line this face sits on
      const cd: Cand = { m, road: r, level: m.level, a: sd.a, b: sd.b, out: sd.out, gap, t0, t1, line, ...(sd.chain ? { chain: sd.chain, k: sd.k, sag: sd.sag } : {}) };
      // (v0.34: a piece of a curved wall may front two chords of a road that follows the curve: it takes the one it
      //  shares the most with)
      if (sd.chain) { const i = cands.findIndex(o => o.m === m && o.chain === sd.chain && o.k === sd.k); if (i >= 0) { if (t1 - t0 > cands[i].t1 - cands[i].t0 + 1e-6) cands[i] = cd; continue; } }
      cands.push(cd);
    }
  }

  const curbs: Zone[] = [];
  const decks: DeckSpan[] = [];
  // (v0.39: the two levels match by the road itself: a curved road's stretch opposite each face is an object of its own)
  const real = (r: Way) => realOf.get(r) ?? r;
  const ground = (c: Cand) => cands.filter(o => o !== c && o.level === 0 && real(o.road) === real(c.road) && o.line === c.line && o.out.x === c.out.x && o.out.y === c.out.y && o.t1 > c.t0 && o.t0 < c.t1);
  const pushCurb = (c: Cand, level: Level, deck: Deck, t0: number, t1: number) => {
    const al = norm(sub(c.b, c.a));
    const p0 = { x: c.a.x + al.x * t0, y: c.a.y + al.y * t0 }, p1 = { x: c.a.x + al.x * t1, y: c.a.y + al.y * t1 };
    // (v0.29: off a turned face the curb is turned too, and reaches half a metre into the building, so that the two
    //  overlap and are joined on foot as turned shapes are)
    // (v0.34: a piece of a curved wall reaches in as far as the wall stands off its chord, so it meets the wall)
    const r = c.chain ? quad(p0, p1, c.out, c.gap + (c.sag ?? 0), -(0.5 + (c.sag ?? 0))) : tilted(c.out) ? quad(p0, p1, c.out, c.gap, -0.5) : boxOf(p0, p1, c.out, c.gap - 0.5, 0);
    // never on top of something the player built on that level
    if (world.zones.some(o => o.level === level && o.id !== c.m.id && hits(shrink(r, 0.6), o))) return;
    // (each piece of a curved wall a curb of its own, though several may front one straight road)
    const id = c.chain ? -(1e13 + (c.road.id * 100000 + c.m.id * 2 + level) * 64 + c.k!) : -(c.road.id * 100000 + c.m.id * 2 + level);
    if (curbs.some(z => z.id === id)) return;
    curbs.push({ id, type: 'curb', level, ...r, tier: 0, auto: { road: c.road.id, module: c.m.id, deck, gap: c.gap, ...(c.chain ? { chain: c.chain, k: c.k } : {}) } });
  };
  for (const c of cands) {
    if (c.level === 1) {
      const below = ground(c).filter(o => o.m.type === 'claim' || o.m.type === 'checkin');
      if (below.length && (c.m.type === 'checkin' || c.m.type === 'security')) {
        // departures over arrivals: the road splits into two decks along the departures face
        pushCurb(c, 1, 'dep', c.t0, c.t1);
        // (v0.34: along a curved wall, every piece has its own curbs, and one deck runs the length of them all, built
        //  with the first)
        const group = c.chain ? cands.filter(o => o.chain === c.chain && o.level === 1 && ground(o).some(q => q.m.type === 'claim' || q.m.type === 'checkin')).sort((p, q) => p.k! - q.k!) : [c];
        if (group[0] !== c) continue;
        const last = group[group.length - 1];
        const al = norm(sub(c.b, c.a));
        const off = c.gap + roadWidth(c.road.lanes) / 2;
        const at = (t: number) => ({ x: c.a.x + al.x * t + c.out.x * off, y: c.a.y + al.y * t + c.out.y * off });
        const W = roadWidth(c.road.lanes);
        // each end: a ramp that splits off the approach road and curves up onto the deck (a forecourt has these),
        // or else a straight ramp along the frontage road itself
        // (a curved face's ramps belong to its whole forecourt: any chord of it, whichever the ramp is tied to)
        const fcOf = (rid: number) => (rid >= FACE_ID ? Math.floor((rid - FACE_ID) / 32) : -1 - rid);
        const curves = extra.filter(w => w.fore === 'ramp' && w.face !== undefined && group.some(o => o.road.id === w.face || fcOf(o.road.id) === fcOf(w.face!)) && w.rg);
        const atOf = (o: Cand, t: number) => { const a2 = norm(sub(o.b, o.a)); const k2 = o.gap + roadWidth(o.road.lanes) / 2; return { x: o.a.x + a2.x * t + o.out.x * k2, y: o.a.y + a2.y * t + o.out.y * k2 }; };
        const La = at(c.t0), Lb = atOf(last, last.t1);
        let mids = group.slice(0, -1).map(o => atOf(o, o.t1));   // (where one piece's curb meets the next)
        // (v0.39: over a curved road along a straight face, the deck follows the road between the curb's ends)
        const rw = realOf.get(c.road);
        if (!c.chain && rw?.c) { const k = curveOf(rw); const sa = k.sOf(La), sb = k.sOf(Lb); const dir = sb > sa ? 1 : -1; mids = k.cum.filter(s => (s - sa) * dir > 2 && (sb - s) * dir > 2).sort((u, v) => (u - v) * dir).map(k.ptAt); }
        // the ramp that lands nearer this end of the curb, laid out from the ground up to where it lands on the deck
        const used: Way[] = [];
        const end = (p: Pt, other: Pt): RampLine | null => {
          const r = curves.filter(w => dist(w.rg!.D, p) < dist(w.rg!.D, other)).sort((v, w) => dist(v.rg!.D, p) - dist(w.rg!.D, p))[0];
          if (r) used.push(r);
          return r ? rampLine(r.rg!, W) : null;
        };
        // with no ramp of its own (a hand-drawn frontage road), the deck comes down straight along the road it is over
        const straight = (p: Pt): RampLine => ({ pts: [p], zs: [0], ws: [W], nIn: [null], gore: null, seam: null, arrows: [] });
        // (v0.39: over a curved road the player drew, the deck comes down along the curve, not straight on)
        const bendEnd = (o: Cand, p: Pt, other: Pt): RampLine | null => {
          const w = realOf.get(o.road); if (!w?.c) return null; const k = curveOf(w);
          const sp = k.sOf(p), dir = sp < k.sOf(other) ? -1 : 1, s1 = Math.max(0, Math.min(k.total, sp + dir * FRONTAGE.ramp));
          const run = Math.abs(s1 - sp); if (run < 2) return null;
          // from where it leaves the ground, through every joint of the road between, to just short of the curb
          const ss = [s1, ...k.cum.filter(s => (s - s1) * dir < 0 && (s - sp) * dir > 2).sort((u, v) => (u - v) * -dir)];
          return { pts: ss.map(k.ptAt), zs: ss.map(s => 1 - Math.abs(s - sp) / run), ws: ss.map(() => W), nIn: ss.map(() => null), gore: null, seam: null, arrows: [] };
        };
        // (a straight ramp lands on the road it is over, however short that road is)
        const ts = [c.road.a, c.road.b].map(p => dot(sub(p, c.a), al)); const tLo = Math.min(...ts), tHi = Math.max(...ts);
        const lal = norm(sub(last.b, last.a)); const ts2 = [last.road.a, last.road.b].map(p => dot(sub(p, last.a), lal)); const tHi2 = Math.max(...ts2);
        const U = end(La, Lb) ?? bendEnd(c, La, Lb) ?? straight(at(Math.max(c.t0 - FRONTAGE.ramp, Math.min(tLo, c.t0 - 1)))), Dn = end(Lb, La) ?? bendEnd(last, Lb, La) ?? straight(atOf(last, Math.min(last.t1 + FRONTAGE.ramp, Math.max(tHi2, last.t1 + 1))));
        const rev = <T,>(x: T[]) => [...x].reverse();
        const pts = [...U.pts, La, ...mids, Lb, ...rev(Dn.pts)];
        const zs = [...U.zs, 1, ...mids.map(() => 1), 1, ...rev(Dn.zs)], ws = [...U.ws, W, ...mids.map(() => W), W, ...rev(Dn.ws)];
        const nIn = [...U.nIn, null, ...mids.map(() => null), null, ...rev(Dn.nIn)];
        if (U.pts.length === 1) { zs[0] = 0; } if (Dn.pts.length === 1) zs[zs.length - 1] = 0;
        // which edge of the drawn deck is the road's own edge, where the ramp runs alongside it (-1 left, 1 right)
        const abut = pts.map((p, i) => {
          const m = nIn[i]; if (!m) return 0;
          const p0 = pts[Math.max(0, i - 1)], p1 = pts[Math.min(pts.length - 1, i + 1)];
          const d0 = i > 0 ? norm(sub(p, p0)) : norm(sub(p1, p)), d1 = i < pts.length - 1 ? norm(sub(p1, p)) : d0;
          return -(d0.y + d1.y) * m.x + (d0.x + d1.x) * m.y > 0 ? -1 : 1;
        });
        const arrows = [...U.arrows, ...Dn.arrows];
        const gores = [U.gore, Dn.gore].filter((q): q is Pt[] => !!q), seams = [U.seam, Dn.seam].filter((q): q is Pt[] => !!q);
        decks.push({ road: c.road.id, ...(c.chain ? { roads: group.map(o => o.road.id) } : {}), a: at(c.t0 - FRONTAGE.ramp), b: atOf(last, last.t1 + FRONTAGE.ramp), width: W, pts, zs, ws, abut, gores, seams, arrows });
        // v0.64: a second ramp at the same end (a trumpet's way down) is a branch of the deck: its own line up to where it lands
        for (const r of curves) if (!used.includes(r)) { const B = rampLine(r.rg!, W);
          const ab = B.pts.map((p, i) => { const m = B.nIn[i]; if (!m) return 0; const p0 = B.pts[Math.max(0, i - 1)], p1 = B.pts[Math.min(B.pts.length - 1, i + 1)]; const dd = norm(sub(p1, p0)); return -dd.y * m.x + dd.x * m.y > 0 ? -1 : 1; });
          decks.push({ road: c.road.id, a: B.pts[0], b: B.pts[B.pts.length - 1], width: W, pts: B.pts, zs: B.zs, ws: B.ws, abut: ab, gores: B.gore ? [B.gore] : [], seams: B.seam ? [B.seam] : [], arrows: B.arrows, branch: true }); }
      } else if (!ground(c).length) pushCurb(c, 0, 'both', c.t0, c.t1);   // a single-level road reaches the face through a frontage core
    } else {
      const above = cands.some(o => o.level === 1 && real(o.road) === real(c.road) && o.line === c.line && o.out.x === c.out.x && o.out.y === c.out.y && o.t1 > c.t0 && o.t0 < c.t1 && (o.m.type === 'checkin' || o.m.type === 'security'));
      pushCurb(c, 0, above ? 'arr' : 'both', c.t0, c.t1);
    }
  }
  return { curbs, decks, guides };
}

/** v0.39: the stretch of a road opposite a face, as one straight road `fronts` can test: a straight road is itself; a
 *  curved one is the longest run of its chords between the face's two ends, as a straight line from where it comes
 *  abreast of the face to where it leaves, if the curve stays within 3 m of that line (so it follows the face rather
 *  than swinging across it). Along a bent hall, each piece of its wall finds its own stretch of the curve. `memo` keeps
 *  one object per road and face, so the two levels of a hall share it. */
export function opposite(r: Way, sd: { a: Pt; b: Pt }, L: number, al: Pt, memo?: Map<string, Way | null>): Way | null {
  if (!r.c) return r;
  const key = `${r.id}:${sd.a.x},${sd.a.y},${sd.b.x},${sd.b.y}`; const hit = memo?.get(key); if (hit !== undefined) return hit;
  const pts = wayPts(r); const ts = pts.map(p => dot(sub(p, sd.a), al)); const inT = (t: number) => t >= 0 && t <= L;
  const runs: Pt[][] = []; let cur: Pt[] = inT(ts[0]) ? [pts[0]] : [];
  for (let i = 1; i < pts.length; i++) {
    const t0 = ts[i - 1], t1 = ts[i]; let inside = inT(t0);
    const ks = [0, L].map(e => (e - t0) / ((t1 - t0) || 1e-9)).filter(k => k > 0 && k < 1).sort((u, v) => u - v);
    for (const k of ks) { const q = lerpPt(pts[i - 1], pts[i], k); if (inside) { cur.push(q); runs.push(cur); cur = []; } else cur = [q]; inside = !inside; }
    if (inT(t1)) cur.push(pts[i]);
  }
  if (cur.length) runs.push(cur);
  let best: Pt[] | null = null, bl = 0;
  for (const q of runs) { if (q.length < 2) continue; const l = Math.abs(dot(sub(q[q.length - 1], q[0]), al)); if (l > bl) { bl = l; best = q; } }
  let out: Way | null = null;
  if (best && bl > 1) {
    const a = best[0], b = best[best.length - 1];
    if (best.every(p => segDist(p, a, b) <= 3)) { out = { ...r, a, b }; delete out.c; }
  }
  memo?.set(key, out);
  return out;
}

/** v0.39: a curved road as a polyline with its running length: where a point is along it, and the point at a length. */
function curveOf(w: Way) {
  const pl = wayPts(w); const cum = [0]; for (let i = 1; i < pl.length; i++) cum.push(cum[i - 1] + dist(pl[i - 1], pl[i]));
  const sOf = (q: Pt) => { let bs = 0, bd = Infinity; for (let i = 1; i < pl.length; i++) { const d = sub(pl[i], pl[i - 1]); const L2 = dot(d, d) || 1; const k = Math.max(0, Math.min(1, dot(sub(q, pl[i - 1]), d) / L2)); const e = dist(q, lerpPt(pl[i - 1], pl[i], k)); if (e < bd) { bd = e; bs = cum[i - 1] + k * Math.sqrt(L2); } } return bs; };
  const ptAt = (s: number) => { for (let i = 1; i < pl.length; i++) if (s <= cum[i] || i === pl.length - 1) return lerpPt(pl[i - 1], pl[i], Math.max(0, Math.min(1, (s - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1)))); return pl[pl.length - 1]; };
  return { pl, cum, total: cum[cum.length - 1], sOf, ptAt };
}

/** Does this straight road run along this building face closely enough to grow a curb? */
function fronts(r: Way, sd: { a: Pt; b: Pt; out: Pt }, L: number, al: Pt, min: number = FRONTAGE.minLen): { gap: number; t0: number; t1: number } | null {
  if (Math.abs(dot(norm(sub(r.b, r.a)), al)) < 0.985) return null;
  const d = (dot(sub(r.a, sd.a), sd.out) + dot(sub(r.b, sd.a), sd.out)) / 2;
  const gap = d - roadWidth(r.lanes) / 2;
  if (gap < FRONTAGE.minGap || gap > FRONTAGE.maxGap) return null;
  const s0 = dot(sub(r.a, sd.a), al), s1 = dot(sub(r.b, sd.a), al);
  const t0 = Math.max(0, Math.min(s0, s1)), t1 = Math.min(L, Math.max(s0, s1));
  return t1 - t0 < min ? null : { gap, t0, t1 };
}

/**
 * v0.12: a terminal hall lays its own forecourt. If no road the player drew already runs along one of its faces,
 * and some road (or the highway) is within FRONTAGE.reach, the hall generates a four-lane frontage road at the
 * ideal distance from its best landside face, and a link from each end of it to that road. autoFrontage then grows
 * the curbs on it like on any other road, and splits it into an upper departures deck and a lower arrivals road
 * where check-in sits over baggage claim. Generated, never saved; ids are above FORE.
 */
export const FORE = 800000;
export const RAMP_ID = 1600000;
/** v0.34: the chords of a frontage road that follows a curved face. */
export const FACE_ID = 2400000;
/** How far down the link a ramp leaves it, and how far along the frontage it lands (m). About 5% up to the deck. */
const RAMP = {
  nose: 120,      // the nose of the gore, this far down the approach road from the frontage corner
  along: 72,      // where the ramp meets the frontage road, this far along it from the corner
  // v0.28: the speed-change lane and its taper, of the order of AASHTO's parallel-type ramp terminals for a road of
  // 50–60 km/h (Green Book ch. 10: deceleration and acceleration lanes of roughly 50–100 m, tapers of 50–90 m).
  // These are from memory of the tables, not checked against the book. Short approach roads get shorter ones, down
  // to a 20 m lane and taper and a nose 45 m from the corner (a steep, short ramp, as the old one was); the taper ends
  // `clear` short of the far end of the link (and of a roundabout's outer kerb there).
  lane: 75, taper: 55, minNose: 45, minLane: 20, minTaper: 20, clear: 30,
  leave: 0.35, arrive: 0.5,   // the curve's handles, as a share of the run along the road and along the frontage
} as const;
/** v0.28: where the gore ends and grass begins between the ramp and the road (m apart), and the gap at which the ramp
 *  starts to climb: it stays at grade until it is clear of the road. */
const GORE = { len: 9, climb: 2 };
/** v0.64: a flyover ramp. It parts from the approach road on the side away from the terminal, climbs beside it for
 *  `climb` m (9 m of rise at about 8%: AASHTO's Green Book allows ramp grades of 6–8% at these speeds; from memory, not
 *  checked) drawing `out` m further off it, then turns over the road on a `radius` m curve to land on the deck. */
const FLY = { climb: 110, out: 7, radius: 70, least: 0.7 };
/** v0.64: a loop flyover. The deck runs on past the corner, `over` m beyond the approach road it crosses, turns down
 *  alongside it on a `radius` m curve (a loop ramp's usual 40–50 m at 30–40 km/h) and swings back to the road's far
 *  edge over `back` m, coming down all the way (9 m in about 150 m: 6%). */
const EAR = { over: 24, radius: 42, back: 120 };
export const EAR_ID = 4800000;
/** v0.64: the ways a hall's forecourt reaches its departures deck, chosen by what the site allows. */
export const FORECOURTS = {
  flyover: { name: 'Flyovers', why: 'both approach roads are long enough for a ramp to climb beside them and cross over the corner, so traffic passes the doors with the kerb on its right' },
  corner: { name: 'Corner ramps', why: 'the approach roads are too short for a flyover (or its far side is built on), so each ramp leaves its road near the corner and cuts inside it' },
  trumpet: { name: 'Trumpet', why: 'only one road reaches the hall, so both ramps hang on it: one up inside the corner, one down over it' },
  none: { name: 'Straight ramps', why: 'no approach road meets the frontage square, so the deck comes down along its own road at each end' },
};
/** v0.28: the radius the ground road takes round a forecourt corner. 35 m is a comfortable kerb radius for buses and
 *  coaches at low speed (a 12 m bus needs about 12–13 m to its outer wheel; AASHTO's 30 km/h minimum curve is about 30 m). */
export const CORNER = { radius: 35, min: 12 };
/** A ramp's widths: one lane at grade, two once it is clear of the road, then the deck's own width as it lands. The
 *  usual 3.6 m lane with shoulders (AASHTO Green Book: 3.6 m lanes; a two-lane ramp about 7.5–8 m between barriers). */
export const DECK = { lane: 3.8, two: 7.8 };
/** Where the line through `a` along `da` meets the line through `b` along `db` (null if they are parallel). */
function meet(a: Pt, da: Pt, b: Pt, db: Pt): Pt | null {
  const den = da.x * db.y - da.y * db.x; if (Math.abs(den) < 1e-6) return null;
  const t = ((b.x - a.x) * db.y - (b.y - a.y) * db.x) / den; return { x: a.x + da.x * t, y: a.y + da.y * t };
}
interface RampLine { pts: Pt[]; zs: number[]; ws: number[]; nIn: (Pt | null)[]; gore: Pt[] | null; seam: Pt[] | null; arrows: { p: Pt; ang: number }[] }
/** v0.28: a ramp from the ground up, as drawn: the taper (from nothing at T to a full lane at P) and the speed-change
 *  lane (P to the nose N) run along the road's edge; then the curve parts from the road, stays at grade until it is
 *  `GORE.climb` clear of it, and climbs to deck level `W` wide at D. `nIn` says, at each point that runs along the road,
 *  which way the ramp lies from the road. The gore is the painted area between the ramp and the road edge from the
 *  nose until they are `GORE.len` apart. */
function rampLine(rg: RampGeo, W: number): RampLine {
  const { T, P, N, C, M: Mid, C2, D, u, n, h } = rg; const wl = DECK.lane;
  const along = (s: number, k: number): Pt => ({ x: T.x - u.x * s + n.x * k, y: T.y - u.y * s + n.y * k });
  const Lt = dot(sub(T, P), u), Lp = dot(sub(P, N), u);
  const pts: Pt[] = [], ws: number[] = [], zs: number[] = [], nIn: (Pt | null)[] = [];
  for (let k = 0; k <= 6; k++) { const w = (wl * k) / 6; pts.push(along((Lt * k) / 6, h + w / 2)); ws.push(w); zs.push(0); nIn.push(n); }
  for (let k = 1; k <= 4; k++) { pts.push(along(Lt + (Lp * k) / 4, h + wl / 2)); ws.push(wl); zs.push(0); nIn.push(n); }
  // the curve, with its arc length; then where the gore opens enough for the ramp to start climbing
  const M = rg.path ? rg.path.length - 1 : 40; const cv: Pt[] = []; const cum = [0];
  const quad = (a: Pt, c: Pt, b: Pt, t: number): Pt => { const v = 1 - t; return { x: v * v * a.x + 2 * v * t * c.x + t * t * b.x, y: v * v * a.y + 2 * v * t * c.y + t * t * b.y }; };
  for (let i = 1; i <= M; i++) { const t = (2 * i) / M; cv.push(rg.path ? rg.path[i] : t <= 1 ? quad(N, C, Mid, t) : quad(Mid, C2, D, t - 1)); cum.push(cum[i - 1] + dist(i > 1 ? cv[i - 2] : N, cv[i - 1])); }
  const lat = (p: Pt) => dot(sub(p, T), n);
  let s0 = cum[M]; for (let i = 1; i <= M; i++) if (lat(cv[i - 1]) - wl / 2 - h >= GORE.climb) { s0 = cum[i]; break; }
  const sMid = cum[Math.floor(M / 2)];   // (a flyover is at full height by M, where it turns over the road)
  const ease = (x: number) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
  const gore: Pt[] = [], edge: Pt[] = []; let goreOpen = true;
  gore.push(along(Lt + Lp, h)); edge.push(along(Lt + Lp, h));
  for (let i = 1; i <= M; i++) {
    const p = cv[i - 1], s = cum[i];
    const zk = rg.path ? ease((s - s0) / Math.max(1, cum[rg.top ?? M] - s0)) : rg.fly ? ease((s - s0) / Math.max(1, sMid - s0)) : ease((s - s0) / Math.max(1, cum[M] - s0));
    const w = rg.path ? Math.max(Math.min(wl + (DECK.two - wl) * ease((s - s0 - 6) / 25), Math.max(wl, 2 * (lat(p) - h))), s > cum[M] - 45 ? DECK.two + (W - DECK.two) * ease((s - (cum[M] - 45)) / 40) : 0)
      : rg.fly ? (s > sMid ? DECK.two + (W - DECK.two) * ease((s - sMid) / Math.max(1, cum[M] - sMid) * 1.6 - 0.6) : wl + (DECK.two - wl) * ease((s - s0 - 6) / 25))
      : zk >= 0.6 ? DECK.two + (W - DECK.two) * ease((zk - 0.6) / 0.4) : wl + (DECK.two - wl) * ease((s - s0 - 6) / 25);
    pts.push(p); ws.push(w); zs.push(i === M ? 1 : zk);
    const gap = lat(p) - w / 2 - h; nIn.push(gap < 0.3 && !(rg.fly && (s > sMid || (!!rg.path && s > 30))) ? n : null);
    if (goreOpen) {
      // the ramp's edge nearer the road, and the road edge abreast of it
      const q = i < M ? cv[i] : D; const tg = norm(sub(q, i > 1 ? cv[i - 2] : N)); let pr = { x: -tg.y, y: tg.x }; if (dot(pr, n) > 0) pr = { x: -pr.x, y: -pr.y };
      const inner = { x: p.x + pr.x * w / 2, y: p.y + pr.y * w / 2 };
      if (lat(inner) - h > GORE.len || zk > 0.3 || (rg.fly && (s > sMid || (!!rg.path && s > 60)))) goreOpen = false;
      else { gore.push(inner); const sl = -dot(sub(inner, T), u); edge.push(along(sl, h)); }
    }
  }
  // an arrow in the speed-change lane, pointing the way the ramp is driven (up: towards the frontage)
  const fw = rg.up ? { x: -u.x, y: -u.y } : u; const ang = Math.atan2(fw.y, fw.x);
  const arrows = [0.3, 0.75].map(f => ({ p: along(Lt + Lp * f, h + wl / 2), ang }));
  return { pts, zs, ws, nIn, gore: gore.length > 3 ? [...gore, ...edge.reverse()] : null, seam: [along(0, h - 0.5), along(Lt + Lp, h - 0.5)], arrows };
}
export function autoForecourt(world: World, aprons: Rect[], highwayY: number, siteW: number): Way[] {
  const out: Way[] = [];
  const drawn = world.ways.filter(w => w.kind === 'road');
  const chords = [...drawn.flatMap(w => waySegs(w).map(([a, b]) => ({ a, b }))), { a: { x: 0, y: highwayY }, b: { x: siteW, y: highwayY } }];
  const blocked = blocker(world, world.zones, aprons);
  const over = (a: Zone, b: Zone) => rectsOverlap(shrink(a, 1), b);
  const halls = world.zones.filter(z => z.type === 'checkin' || (z.type === 'claim' && !world.zones.some(o => o.type === 'checkin' && over(z, o)))).sort((p, q) => p.id - q.id);
  const half = roadWidth(4) / 2; const off = FRONTAGE.ideal + half; const ext = FRONTAGE.ramp + 24;
  for (const m of halls) {
    // the hall and whatever is stacked with it (claim under check-in) count as one building
    const fam = world.zones.filter(z => z === m || ((z.type === 'checkin' || z.type === 'claim') && over(z, m)));
    const sides = fam.flatMap(z => facesOf(z).map(sd => ({ z, sd, L: dist(sd.a, sd.b), al: norm(sub(sd.b, sd.a)) })));   // (v0.34: a curved wall piece by piece)
    // the player drew its frontage (v0.39: a curved road too, along a curved face or a straight one)
    if (sides.some(q => q.L >= FRONTAGE.minLen && drawn.some(r => { const rr = opposite(r, q.sd, q.L, q.al); return !!rr && !!fronts(rr, q.sd, q.L, q.al); }))) continue;
    if (out.some(w => w.fore === 'face' && sides.some(q => q.L >= FRONTAGE.minLen && fronts(w, q.sd, q.L, q.al)))) continue;   // a neighbour's forecourt already serves it
    let best: { a: Pt; b: Pt; legs: { a: Pt; b: Pt }[]; cost: number; ramps: RampGeo[]; chain?: Pt[]; scheme: NonNullable<Way['scheme']> } | null = null;
    // the faces a forecourt might front: each straight side, and (v0.34) each curved wall, whose frontage road follows
    // it as a chain of chords
    type FC = { a: Pt; b: Pt; ends: [Pt, Pt, Pt][]; chain?: Pt[] };
    const fcs: FC[] = [];
    for (const { sd, L, al } of sidesOf(m).map(sd => ({ sd, L: dist(sd.a, sd.b), al: norm(sub(sd.b, sd.a)) }))) {
      if (L < FRONTAGE.minLen) continue;
      if (sd.curve !== undefined && curved(m)) {
        // (every piece long enough for a curb; and not a face that is all interior. A piece that meets security is
        //  left without a curb, and the road must still get past it: `blocked` below says whether it does)
        const pcs = facesOf(m).filter(f => f.chain === `${m.id}:${sd.side}`); if (!pcs.length || pcs.some(f => dist(f.a, f.b) < FRONTAGE.minLen)) continue;
        if (pcs.every(f => { const pr = faceBox(lerpPt(f.a, f.b, 0.1), lerpPt(f.a, f.b, 0.9), f.out, 1.5); return world.zones.some(o => !fam.includes(o) && TERMINAL_SET.has(o.type) && hits(pr, o)); })) continue;
        // the road: each joint of the wall carried out along the wall's normal there, and straight on past each end
        const nAt = (i: number) => norm(i === 0 ? pcs[0].out : i === pcs.length ? pcs[pcs.length - 1].out : { x: pcs[i - 1].out.x + pcs[i].out.x, y: pcs[i - 1].out.y + pcs[i].out.y });
        const wall = [...pcs.map(f => f.a), pcs[pcs.length - 1].b];
        const mid = wall.map((p, i) => ({ x: p.x + nAt(i).x * off, y: p.y + nAt(i).y * off }));
        const t0 = norm(sub(pcs[0].b, pcs[0].a)), t1 = norm(sub(pcs[pcs.length - 1].b, pcs[pcs.length - 1].a));
        const chain = [{ x: mid[0].x - t0.x * ext, y: mid[0].y - t0.y * ext }, ...mid, { x: mid[mid.length - 1].x + t1.x * ext, y: mid[mid.length - 1].y + t1.y * ext }];
        // (each chord, and its inner edge: the chord moved in by half the road, square to the piece of wall it fronts)
        const nOf = (c: number) => pcs[Math.max(0, Math.min(pcs.length - 1, c - 2))].out;
        const edge = (c: number, q: Pt) => ({ x: q.x - nOf(c).x * half, y: q.y - nOf(c).y * half });
        if (chain.some((q, c) => c > 0 && (blocked(chain[c - 1], q, fam) || blocked(edge(c, chain[c - 1]), edge(c, q), fam)))) continue;
        if (pcs.some(f => { const lot = faceBox(f.a, f.b, f.out, off + half); return world.zones.some(o => o.level === 0 && !fam.includes(o) && hits(shrink(lot, 1), o)); })) continue;
        fcs.push({ a: chain[0], b: chain[chain.length - 1], chain, ends: [[chain[0], { x: -t0.x, y: -t0.y }, pcs[0].out], [chain[chain.length - 1], t1, pcs[pcs.length - 1].out]] });
        continue;
      }
      const probe = faceBox(lerpPt(sd.a, sd.b, 0.1), lerpPt(sd.a, sd.b, 0.9), sd.out, 1.5);
      if (world.zones.some(o => !fam.includes(o) && TERMINAL_SET.has(o.type) && hits(probe, o))) continue;   // an interior face
      const at = (t: number, k: number): Pt => ({ x: sd.a.x + al.x * t + sd.out.x * k, y: sd.a.y + al.y * t + sd.out.y * k });
      const a = at(-ext, off), b = at(L + ext, off);
      if (blocked(a, b, fam) || blocked(at(-ext, off - half), at(L + ext, off - half), fam)) continue;
      // the curb's own ground must be clear too
      const lot = faceBox(sd.a, sd.b, sd.out, off + half);
      if (world.zones.some(o => o.level === 0 && !fam.includes(o) && hits(shrink(lot, 1), o))) continue;
      fcs.push({ a, b, ends: [[a, { x: -al.x, y: -al.y }, sd.out], [b, al, sd.out]] });
    }
    for (const fc of fcs) {
      const { a, b } = fc;
      const legs: { a: Pt; b: Pt }[] = []; let cost = 0; let rampsHere: RampGeo[] = []; const flies: (RampGeo | null)[] = [], corners0: (RampGeo | null)[] = [], hasLeg: boolean[] = [];
      for (const [E, away, oE] of fc.ends) {
        // straight out from the building first, else straight on along the frontage
        let leg: { a: Pt; b: Pt; d: number; via?: Pt } | null = null;
        for (const [dir, pen] of [[oE, 0], [away, 40]] as const) {
          const q = rayHit(E, dir, FRONTAGE.reach, chords); if (!q) continue;
          const d = dist(E, q) + pen;
          if (d - pen < 6 || blocked(E, q, fam)) continue;
          if (!leg || d < leg.d) leg = { a: E, b: q, d };
        }
        // v0.29: or straight to the nearest point of a road, if that is not far off straight out (a turned hall's
        // straight out can miss a road that a link at a slight angle reaches)
        if (tilted(oE) && (!leg || leg.d > 40 + FRONTAGE.reach * 0.5)) for (const c of chords) {
          const q = lerpPt(c.a, c.b, Math.max(0, Math.min(1, dot(sub(E, c.a), sub(c.b, c.a)) / (dot(sub(c.b, c.a), sub(c.b, c.a)) || 1))));
          const dd = dist(E, q); if (dd < 6 || dd > FRONTAGE.reach * 1.25 || dot(norm(sub(q, E)), oE) < 0.7 || blocked(E, q, fam)) continue;
          if (!leg || dd + 25 < leg.d) leg = { a: E, b: q, d: dd + 25 };
        }
        if (!leg) {
          // v0.14: nothing straight ahead. Come straight out, then turn once towards the nearest road: this is what
          // reaches a road that stops short of the terminal, or one that runs past off to one side.
          let near: { q: Pt; d: number } | null = null;
          for (const c of chords) { const q = lerpPt(c.a, c.b, Math.max(0, Math.min(1, dot(sub(E, c.a), sub(c.b, c.a)) / (dot(sub(c.b, c.a), sub(c.b, c.a)) || 1)))); const d = dist(E, q); if (!near || d < near.d) near = { q, d }; }
          if (near && near.d <= FRONTAGE.reach) {
            const o = dot(sub(near.q, E), oE); const via = { x: E.x + oE.x * o, y: E.y + oE.y * o };
            if (o >= 30 && dist(via, near.q) >= 12 && !blocked(E, via, fam) && !blocked(via, near.q, fam)) leg = { a: E, b: via, d: o + dist(via, near.q) + 60, via: near.q };
          }
        }
        if (leg) { legs.push({ a: leg.a, b: leg.b }); if (leg.via) legs.push({ a: leg.b, b: leg.via }); cost += leg.d; } else cost += 700;
        // v0.13: where the link comes straight out to the frontage, the upper deck gets its own ramp: it leaves the
        // link before the corner and sweeps round inside it, so the road visibly divides and comes back together
        // (v0.29: a link that comes out at an angle gets one too, laid along the link itself)
        const run = leg ? dist(leg.a, leg.b) : 0; const square = leg && dot(norm(sub(leg.b, leg.a)), oE) > 0.7;
        // v0.28: and it is laid out as a ramp is built (a parallel-type ramp terminal). Going away from the frontage
        // along the approach road: the ramp's curve comes down beside the road and runs on beside it as an extra lane
        // (the speed-change lane: deceleration for the way up, acceleration for the way down) up to the nose of the
        // gore at N, alongside to P, and the lane then tapers into the road edge by T. It is on the side of the road
        // nearer the terminal; with traffic on the right that is the right of inbound traffic at one end (the way up)
        // and the right of outbound traffic at the other (the way down), so each ramp is one-way.
        if (leg && square) {
          // u along the link; n across it, on the side towards the middle of the frontage (and the deck lands at D,
          // along the frontage road itself, whatever angle the link meets it at)
          const u = norm(sub(leg.b, leg.a)), inside = { x: -away.x, y: -away.y }; const side = u.x * inside.y - u.y * inside.x >= 0 ? 1 : -1;
          const n = { x: -u.y * side, y: u.x * side }; const h = roadWidth(4) / 2, o = h + DECK.lane / 2;
          // the taper must merge well before whatever the link ends at: `RAMP.clear` short of its end, and short of the
          // outer kerb of a roundabout there (the network cuts the link back to the ring)
          const ring = (world.rounds ?? []).filter(r => dist({ x: r.x, y: r.y }, leg.b) < roundDef(r).icd / 2 + 2).reduce((m, r) => Math.max(m, roundDef(r).icd / 2), 0);
          let g: number = RAMP.nose, Lp: number = RAMP.lane, Lt: number = RAMP.taper; const avail = run - RAMP.clear - ring;
          if (g + Lp + Lt > avail) { const k = avail / (g + Lp + Lt); Lp = Math.max(RAMP.minLane, Lp * k); Lt = Math.max(RAMP.minTaper, Lt * k); g = Math.min(RAMP.nose, avail - Lp - Lt); }
          const at = (t: number, k: number): Pt => ({ x: E.x + u.x * t + n.x * k, y: E.y + u.y * t + n.y * k });
          const T = at(g + Lp + Lt, 0), P = at(g + Lp, o), N = at(g, o), D = { x: E.x + inside.x * RAMP.along, y: E.y + inside.y * RAMP.along };
          // the curve from the nose to the frontage: a cubic that leaves along the road and arrives along the frontage,
          // with its handles short at the nose so the ramp gets clear of the road soon after it parts (about 3.5 m
          // clear 30 m on, 13 m by 60 m), carried as two quadratics that meet at its middle M
          const P1 = at(g * (1 - RAMP.leave), o), P2 = { x: D.x - inside.x * RAMP.arrive * (RAMP.along - o), y: D.y - inside.y * RAMP.arrive * (RAMP.along - o) };
          const cub = (t: number): Pt => { const v = 1 - t; return { x: v * v * v * N.x + 3 * v * v * t * P1.x + 3 * v * t * t * P2.x + t * t * t * D.x, y: v * v * v * N.y + 3 * v * v * t * P1.y + 3 * v * t * t * P2.y + t * t * t * D.y }; };
          const M = cub(0.5), tm = norm(sub(cub(0.52), cub(0.48)));
          const C = meet(N, { x: -u.x, y: -u.y }, M, tm) ?? lerpPt(N, M, 0.5), C2 = meet(M, tm, D, inside) ?? lerpPt(M, D, 0.5);
          const up = u.y * n.x - u.x * n.y > 0;   // the ramp is on the right of traffic coming in towards the terminal
          const cornerR = g >= RAMP.minNose && !blocked(N, D, fam) && !blocked(P, N, fam) ? { T, P, N, C, M, C2, D, u, n, h, up } : null;
          // v0.64: or a flyover on the road's far side: taper and lane as before, a climb beside the road drawing a
          // little off it, then a turn over the road and the corner beneath to land on the deck from outside
          let flyR: RampGeo | null = null, earR: RampGeo | null = null;
          // (a far-side ramp is low for most of its length: it may not cross or crowd any road that is drawn or already
          //  laid for another hall, a roundabout, or a building on the upper level. Its own link it runs beside.)
          const others = [...chords, ...out.flatMap(q => waySegs(q).map(([a2, b2]) => ({ a: a2, b: b2 })))];
          const crowded = (p: Pt, q: Pt, low: boolean) => { const nS = Math.max(1, Math.ceil(dist(p, q) / 6));
            for (let i2 = 0; i2 <= nS; i2++) { const x = lerpPt(p, q, i2 / nS);
              if (low && others.some(c => segDist(x, c.a, c.b) < 12)) return true;
              if ((world.rounds ?? []).some(r => dist(x, { x: r.x, y: r.y }) < roundDef(r).icd / 2 + 10)) return true;
              if (world.zones.some(z => z.level === 1 && !fam.includes(z) && inZone(x, z, 2))) return true; }
            return false; };
          { const nO = { x: -n.x, y: -n.y }; let Lc: number = FLY.climb, Lp2: number = RAMP.lane, Lt2: number = RAMP.taper; const sM = FLY.radius;
            const k = Math.min(1, (avail - sM) / (Lc + Lp2 + Lt2));
            if (k >= FLY.least) { Lc *= k; Lp2 *= k; Lt2 *= k;
              const atO = (t: number, q: number): Pt => ({ x: E.x + u.x * t + nO.x * q, y: E.y + u.y * t + nO.y * q });
              const Tf = atO(sM + Lc + Lp2 + Lt2, 0), Pf = atO(sM + Lc + Lp2, o), Nf = atO(sM + Lc, o), Mf = atO(sM, o + FLY.out);
              const X = meet(Mf, { x: -u.x, y: -u.y }, E, inside);
              if (X) { const Df = { x: X.x + inside.x * dist(X, Mf), y: X.y + inside.y * dist(X, Mf) };
                // (clear ground under its climb, and nothing but road under its turn)
                if (dot(sub(Df, E), inside) > CORNER.radius + 4 && dot(sub(Df, E), inside) < ext - 6 && !blocked(Pf, Mf, fam) && !blocked(atO(sM + Lc, o + 9), atO(sM, o + FLY.out + 9), fam) && !blocked(Mf, X, fam) && !blocked(Mf, Df, fam) && !crowded(Pf, Mf, true) && !crowded(Mf, X, false) && !crowded(X, Df, false))
                  flyR = { T: Tf, P: Pf, N: Nf, C: lerpPt(Nf, Mf, 0.5), M: Mf, C2: X, D: Df, u, n: nO, h, up: u.y * nO.x - u.x * nO.y > 0, fly: true }; } } }
          // or, where the ground beyond the corner is open and the road comes square to the frontage, a loop: the deck
          // crosses over the road, turns down beside it and swings back to its far edge
          if (Math.abs(dot(u, inside)) < 0.02) { const nO = { x: -n.x, y: -n.y }; let Ls: number = EAR.back, Lp3: number = RAMP.lane, Lt3: number = RAMP.taper; const R1 = EAR.radius, a = EAR.over;
            const k = Math.min(1, (avail - R1) / (Ls + Lp3 + Lt3));
            if (k >= FLY.least) { Ls *= k; Lp3 *= k; Lt3 *= k; const sN = R1 + Ls;
              const pt = (q: number, s: number): Pt => ({ x: E.x + nO.x * q + u.x * s, y: E.y + nO.y * q + u.y * s });   // q m out from the road's centreline, s m down it
              const path: Pt[] = []; const far = a + R1;
              for (let j = 0; j <= 12; j++) { const t = j / 12, v = 1 - t; const q = v * v * v * o + 3 * v * v * t * o + 3 * v * t * t * far + t * t * t * far, s = v * v * v * sN + 3 * v * v * t * (sN - Ls * 0.5) + 3 * v * t * t * (R1 + Ls * 0.5) + t * t * t * R1; path.push(pt(q, s)); }
              for (let j = 1; j <= 8; j++) { const th = (j / 8) * Math.PI / 2; path.push(pt(a + R1 * Math.cos(th), R1 - R1 * Math.sin(th))); }
              const dIn = CORNER.radius + 8; for (const q of [a * 0.5, 0, -dIn * 0.5, -dIn]) path.push(pt(q, 0));
              const clear = path.every((q, j) => j === 0 || !blocked(path[j - 1], q, fam)) && !blocked(pt(far + 8, R1 + Ls * 0.6), pt(far + 8, R1 * 0.4), fam);
              if (clear && !crowded(pt(o, sN + Lp3), path[0], true) && path.every((q, j) => j === 0 || !crowded(path[j - 1], q, j <= 16))) earR = { T: pt(0, sN + Lp3 + Lt3), P: pt(o, sN + Lp3), N: path[0], C: path[0], M: path[12], C2: path[20], D: path[path.length - 1], u, n: nO, h, up: u.y * nO.x - u.x * nO.y > 0, fly: true, path, top: 16 }; } }   // (at full height half way round the turn, well before it crosses the road)
          corners0.push(cornerR); flies.push(earR ?? flyR);
        } else { corners0.push(null); flies.push(null); }
        hasLeg.push(!!leg);
      }
      if (!legs.length) continue;
      // v0.64: which way up suits the site. Two long approach roads: a flyover on each (traffic then passes the doors
      // with the kerb on its right). One road only: both ramps on it, one inside the corner and one over it. Else a
      // ramp inside each corner, as before.
      const one = hasLeg.filter(Boolean).length === 1 ? hasLeg.indexOf(true) : -1;
      let scheme: NonNullable<Way['scheme']> = 'none';
      if (flies.length === 2 && flies[0] && flies[1]) { rampsHere = [flies[0], flies[1]]; scheme = 'flyover'; }
      else if (one >= 0 && corners0[one] && flies[one]) { rampsHere = [corners0[one]!, flies[one]!]; scheme = 'trumpet'; }
      else { rampsHere = corners0.filter((q): q is RampGeo => !!q); if (rampsHere.length) scheme = 'corner'; }
      if (!best || cost < best.cost) best = { a, b, legs, cost, ramps: rampsHere, scheme, ...(fc.chain ? { chain: fc.chain } : {}) };
    }
    if (!best) continue;
    const id = FORE + m.id * 4;
    // v0.28: where a link comes square out of an end of the frontage road, the ground road sweeps round the corner
    // on a curve of its own (a generated `corner` way) instead of turning it square: the frontage road and the link
    // are each cut back by the radius. The deck's ramp still lands further along the frontage, inside the curve.
    const face = { a: best.a, b: best.b }; const fdir = norm(sub(best.b, best.a)); const corners: { a: Pt; b: Pt; c: Pt }[] = [];
    const chain = best.chain?.map(q => ({ ...q })); const span = chain ? polyLen(chain) : dist(best.a, best.b);
    const legs = best.legs.map(l => ({ ...l }));
    for (const end of ['a', 'b'] as const) {
      // (v0.34: along a curved face, the frontage road's direction at that end)
      const fd = chain ? (end === 'a' ? norm(sub(chain[1], chain[0])) : norm(sub(chain[chain.length - 1], chain[chain.length - 2]))) : fdir;
      const E = best[end]; const inward = end === 'a' ? fd : { x: -fd.x, y: -fd.y };
      const l = legs.find(q => dist(q.a, E) < 0.5); if (!l) continue;
      const ld = norm(sub(l.b, l.a)); const len = dist(l.a, l.b); if (Math.abs(dot(ld, fd)) > 0.7) continue;   // (v0.29: at an angle too)
      const R = Math.min(CORNER.radius, len - 24, span / 2 - FRONTAGE.minLen); if (R < CORNER.min) continue;
      const p = { x: E.x + inward.x * R, y: E.y + inward.y * R }, q = { x: E.x + ld.x * R, y: E.y + ld.y * R };
      face[end] = p; l.a = q; corners.push({ a: p, b: q, c: E });
      if (chain) chain[end === 'a' ? 0 : chain.length - 1] = p;
    }
    // v0.34: a curved face's frontage road is a chain of chords, each a face road of its own (ids from FACE_ID)
    const faceIds: number[] = [];
    if (chain) chain.slice(1).forEach((q, c) => { const fid = FACE_ID + m.id * 32 + c; faceIds.push(fid); out.push({ id: fid, kind: 'road', a: chain[c], b: q, cls: 0, lanes: 4, fore: 'face', scheme: best!.scheme }); });
    else out.push({ id, kind: 'road', a: face.a, b: face.b, cls: 0, lanes: 4, fore: 'face', scheme: best.scheme });
    // (a ramp belongs to the chord nearest where it lands, of those that front the hall: not the straight run past an end)
    const faceNear = (p: Pt) => { if (!chain) return id; let bi = 1; for (let c = 1; c < chain.length - 2; c++) if (segDist(p, chain[c], chain[c + 1]) < segDist(p, chain[bi], chain[bi + 1])) bi = c; return faceIds[Math.min(bi, faceIds.length - 1)]; };
    legs.forEach((l, i) => out.push({ id: id + 1 + i, kind: 'road', a: l.a, b: l.b, cls: 0, lanes: 4, fore: 'link' }));
    corners.forEach((k, i) => out.push({ id: RAMP_ID + m.id * 16 + 12 + i, kind: 'road', a: k.a, b: k.b, c: k.c, cls: 0, lanes: 4, fore: 'corner' }));
    // each ramp: the taper and the speed-change lane one lane wide, the curve two; all one-way in the ramp's direction
    best.ramps.forEach((rg, i) => {
      if (rg.path) {
        // a loop: its taper and lane as ever, then its line chord by chord, one bridge from the nose to the deck
        const P = rg.path; const grp = EAR_ID + m.id * 64 + i * 32; const one = (p: Pt, q: Pt) => (rg.up ? [p, q] : [q, p]);
        const base = { kind: 'road' as const, cls: 0, oneway: true, fore: 'ramp' as const, face: faceNear(rg.D) };
        { const [a, b] = one(rg.T, rg.P); out.push({ ...base, id: RAMP_ID + m.id * 16 + i * 4, a, b, lanes: 1, part: 'taper' }); }
        { const [a, b] = one(rg.P, rg.N); out.push({ ...base, id: RAMP_ID + m.id * 16 + i * 4 + 1, a, b, lanes: 1, part: 'lane' }); }
        for (let j = 0; j + 1 < P.length; j++) { const [a, b] = one(P[j], P[j + 1]); out.push({ ...base, id: grp + j, a, b, lanes: 2, part: j === 0 ? 'curve' : 'climb', ...(j === 0 ? { rg } : {}), bridge: grp }); }
        return;
      }
      const parts: [Pt, Pt, Pt | undefined, 'taper' | 'lane' | 'curve' | 'climb', number][] = [[rg.T, rg.P, undefined, 'taper', 1], [rg.P, rg.N, undefined, 'lane', 1], [rg.N, rg.M, rg.C, 'curve', 2], [rg.M, rg.D, rg.C2, 'climb', 2]];
      parts.forEach(([p, q, c, part, lanes], k) => {
        const [a, b] = rg.up ? [p, q] : [q, p];
        out.push({ id: RAMP_ID + m.id * 16 + i * 4 + k, kind: 'road', a, b, ...(c && !(rg.fly && part === 'curve') ? { c } : {}), cls: 0, lanes, oneway: true, fore: 'ramp', face: faceNear(rg.D), part, ...(part === 'curve' ? { rg } : {}), ...(rg.fly && part === 'climb' ? { bridge: RAMP_ID + m.id * 16 + i * 4 + k } : {}) });
      });
    });
  }
  return out;
}
/** First point where a ray from p meets a road. */
function rayHit(p: Pt, dir: Pt, reach: number, chords: { a: Pt; b: Pt }[]): Pt | null {
  let best: Pt | null = null, bd = reach;
  for (const c of chords) {
    const sx = c.b.x - c.a.x, sy = c.b.y - c.a.y; const den = dir.x * sy - dir.y * sx; if (Math.abs(den) < 1e-9) continue;
    const t = ((c.a.x - p.x) * sy - (c.a.y - p.y) * sx) / den, u = ((c.a.x - p.x) * dir.y - (c.a.y - p.y) * dir.x) / den;
    if (t > 0 && t < bd && u >= 0 && u <= 1) { bd = t; best = { x: p.x + dir.x * t, y: p.y + dir.y * t }; }
  }
  return best;
}

/** Rectangle spanning p0–p1 and reaching `depth` outward (`from` metres off the face). */
function boxOf(p0: Pt, p1: Pt, out: Pt, depth: number, from = 0): Rect {
  const q0 = { x: p0.x + out.x * from, y: p0.y + out.y * from }, q1 = { x: p1.x + out.x * (from + depth), y: p1.y + out.y * (from + depth) };
  const xs = [q0.x, q1.x, p0.x + out.x * (from + depth), p1.x + out.x * from], ys = [q0.y, q1.y, p0.y + out.y * (from + depth), p1.y + out.y * from];
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
const shrink = <T extends Rect>(r: T, k: number): T => ({ ...r, x: r.x + k, y: r.y + k, w: Math.max(0, r.w - 2 * k), h: Math.max(0, r.h - 2 * k) });
/** v0.29: is a face turned (not along the axes)? Then the boxes off it are turned rectangles, not bounding boxes. */
const tilted = (out: Pt) => Math.abs(out.x) > 1e-6 && Math.abs(out.y) > 1e-6;
/** The turned rectangle off a face from p0 to p1, `from` to `from + depth` out along `out`. */
function quad(p0: Pt, p1: Pt, out: Pt, depth: number, from = 0): Shaped & Rect {
  const al = norm(sub(p1, p0)); const L = dist(p0, p1); const k = from + depth / 2;
  const c = { x: (p0.x + p1.x) / 2 + out.x * k, y: (p0.y + p1.y) / 2 + out.y * k };
  return { x: c.x - L / 2, y: c.y - depth / 2, w: L, h: depth, rot: Math.atan2(al.y, al.x) };
}
/** Does a box off a face overlap a zone? (turned faces and turned zones by their true outlines) */
const hits = (box: Rect & Shaped, o: Zone) => (box.rot || shaped(o) ? zonesOverlap(box, o) : rectsOverlap(box, o));
/** The box off a face, turned with it when the face is. */
const faceBox = (p0: Pt, p1: Pt, out: Pt, depth: number, from = 0): Rect & Shaped => (tilted(out) ? quad(p0, p1, out, depth, from) : boxOf(p0, p1, out, depth, from));

/** Points along each road where generated curbs begin and end, so the road network can be split there. */
export function curbCuts(curbs: Zone[], roads: Way[]): Map<number, Pt[]> {
  const out = new Map<number, Pt[]>();
  for (const z of curbs) {
    const r = roads.find(w => w.id === z.auto?.road); if (!r) continue;
    const al = norm(sub(r.b, r.a)); const L = dist(r.a, r.b);
    const corners = z.rot ? (() => { const ts = zonePts(z).map(p => dot(sub(p, r.a), al)); const t0 = Math.min(...ts), t1 = Math.max(...ts); return [t0, t1].map(t => ({ x: r.a.x + al.x * t, y: r.a.y + al.y * t })); })() : [{ x: z.x, y: z.y }, { x: z.x + z.w, y: z.y + z.h }];
    for (const p of corners) {
      const t = dot(sub(p, r.a), al);
      if (t > 2 && t < L - 2) out.set(r.id, [...(out.get(r.id) ?? []), { x: r.a.x + al.x * t, y: r.a.y + al.y * t }]);
    }
  }
  return out;
}

/** Landside facilities that connect themselves: each wants a road (except stations) and a way in on foot. */
export const SELF_CONNECT = new Set<ZoneType>(['parking', 'rideshare', 'rental', 'bus', 'hotel', 'train']);
const NEEDS_ROAD = new Set<ZoneType>(['parking', 'rideshare', 'rental', 'bus', 'hotel']);
const TERMINAL_SET = new Set<ZoneType>(['checkin', 'security', 'concourse', 'claim', 'passport']);

const nearRect = (p: Pt, r: Rect, k: number) => p.x >= r.x - k && p.x <= r.x + r.w + k && p.y >= r.y - k && p.y <= r.y + r.h + k;
const clamp2 = (p: Pt, r: Rect): Pt => ({ x: Math.min(r.x + r.w, Math.max(r.x, p.x)), y: Math.min(r.y + r.h, Math.max(r.y, p.y)) });
const ctr = (r: Rect): Pt => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const rectGap = (a: Rect, b: Rect) => Math.hypot(Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w)), Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h)));
function blocker(world: World, zones: Zone[], aprons: Rect[]) {
  return (a: Pt, b: Pt, ends: Rect[]) => {
    const segHits = (r: Rect) => { for (let i = 1; i < 24; i++) { const t = i / 24; const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; if (p.x > r.x + 1 && p.x < r.x + r.w - 1 && p.y > r.y + 1 && p.y < r.y + r.h - 1) return true; } return false; };
    // (v0.29: a turned one by its true outline)
    const segIn = (z: Zone) => { for (let i = 1; i < 24; i++) { const t = i / 24; if (inZone({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, z, -1)) return true; } return false; };
    if (zones.some(z => z.level === 0 && !ends.includes(z) && (shaped(z) ? segIn(z) : segHits(z)))) return true;   // (v0.34: a bent one too)
    if (aprons.some(segHits)) return true;
    if (world.ways.some(w => w.kind === 'taxi' && segsCross(a, b, w.a, w.b))) return true;
    return world.runways.some(r => segsCross(a, b, r.a, r.b));
  };
}

/**
 * A landside facility that no sidewalk reaches lays its own (v0.9 for lots; v0.10 for rideshare, rental cars, bus
 * stations, hotels and AirTrain stations). It goes to the nearest way in: a ground-level curb (the arrivals one if
 * there is a choice), a ground-level terminal hall, or an AirTrain station. Straight if it can, or round one
 * corner; never through a building, an apron or the airfield. Generated, never saved.
 */
export function autoWalks(world: World, zones: Zone[], aprons: Rect[]): Way[] {
  const out: Way[] = [];
  const walks = world.ways.filter(w => w.kind === 'walk');
  const blocked = blocker(world, zones, aprons);
  const curbs = zones.filter(z => z.level === 0 && z.type === 'curb');
  const arr = curbs.some(c => c.auto?.deck !== 'dep') ? curbs.filter(c => c.auto?.deck !== 'dep') : curbs;
  const halls = zones.filter(z => z.level === 0 && (z.type === 'claim' || z.type === 'checkin'));
  const stations = zones.filter(z => z.type === 'train');
  for (const fac of zones.filter(z => SELF_CONNECT.has(z.type))) {
    if (walks.some(w => nearRect(w.a, fac, 3) || nearRect(w.b, fac, 3))) continue;
    const targets = [...(arr.length ? arr : halls), ...stations.filter(s => s !== fac)];
    // a station only reaches for the terminal if it is close; a far one serves whatever walks to it
    const reach = fac.type === 'train' ? 260 : 900;
    const tgt = targets.filter(t => !rectsOverlap(fac, t) && rectGap(fac, t) <= reach).sort((p, q) => rectGap(fac, p) - rectGap(fac, q) || p.id - q.id)[0];
    if (!tgt) continue;
    if (rectGap(fac, tgt) < 1.5) continue;   // already touching: doors do the job
    const a = clamp2(ctr(tgt), fac), b = clamp2(a, tgt);
    const id = -(500000 + fac.id);
    const ends = [fac, tgt];
    // square routes read as paths; a diagonal is the last resort
    const straight = Math.abs(a.x - b.x) < 1 || Math.abs(a.y - b.y) < 1;
    if (straight && !blocked(a, b, ends)) { out.push({ id, kind: 'walk', a, b, cls: 0, lanes: 0 }); continue; }
    let done = false;
    for (const c of [{ x: a.x, y: b.y }, { x: b.x, y: a.y }]) if (!blocked(a, c, ends) && !blocked(c, b, ends)) {
      out.push({ id, kind: 'walk', a, b: c, cls: 0, lanes: 0 }, { id: id - 250000, kind: 'walk', a: c, b, cls: 0, lanes: 0 }); done = true; break;
    }
    if (!done && !blocked(a, b, ends)) out.push({ id, kind: 'walk', a, b, cls: 0, lanes: 0 });
  }
  return out;
}

/**
 * v0.10: a lot, garage, rideshare lot, rental centre, bus station or hotel with no road at its edge lays its own
 * access drive to the nearest road (or the highway) within GROWTH.autoRoadReach. Generated, never saved.
 */
export function autoRoads(world: World, zones: Zone[], aprons: Rect[], highwayY: number, siteW: number, reach: number, extra: Way[] = []): Way[] {
  const out: Way[] = [];
  // a curved road is a run of straight chords here: a drive can meet any of them
  // (v0.28: never a deck ramp: a ramp is one-way, has no junctions along it, and its speed-change lane runs right
  //  beside the approach road, nearer than the road itself to anything on that side)
  const roads = [...[...world.ways.filter(w => w.kind === 'road'), ...extra.filter(w => w.fore !== 'ramp')].flatMap(w => waySegs(w).map(([a, b]) => ({ ...w, a, b, c: undefined }))), { id: -1, kind: 'road' as const, a: { x: 0, y: highwayY }, b: { x: siteW, y: highwayY }, cls: 0, lanes: 6 }];
  const blocked = blocker(world, zones, aprons);
  const onSeg = (p: Pt, a: Pt, b: Pt): Pt => { const dx = b.x - a.x, dy = b.y - a.y; const L2 = dx * dx + dy * dy || 1; const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)); return { x: a.x + dx * t, y: a.y + dy * t }; };
  for (const fac of zones.filter(z => NEEDS_ROAD.has(z.type))) {
    if (roads.some(r => { const q = onSeg(ctr(fac), r.a, r.b); const q2 = onSeg(clamp2(q, fac), r.a, r.b); return nearRect(q2, fac, 3) || nearRect(r.a, fac, 3) || nearRect(r.b, fac, 3); })) continue;
    let best: { p: Pt; q: Pt; d: number; r: { a: Pt; b: Pt } } | null = null;
    let bent: { p: Pt; c: Pt; q: Pt; d: number } | null = null;
    for (const r of roads) {
      let q = onSeg(ctr(fac), r.a, r.b); let p = clamp2(q, fac); q = onSeg(p, r.a, r.b); p = clamp2(q, fac);
      const d = dist(p, q);
      if (d < 1) continue;
      const square = Math.abs(p.x - q.x) < 0.5 || Math.abs(p.y - q.y) < 0.5;
      if (d <= reach && square && !blocked(p, q, [fac])) { if (!best || d < best.d) best = { p, q, d, r }; continue; }
      // not straight ahead: leave square from the edge and turn one corner
      for (const c of [{ x: p.x, y: q.y }, { x: q.x, y: p.y }]) {
        const p2 = clamp2(c, fac); const len = dist(p2, c) + dist(c, q);
        if (len > reach * 1.8 || dist(p2, c) < 4 || dist(c, q) < 4) continue;
        if (Math.abs(p2.x - c.x) > 0.5 && Math.abs(p2.y - c.y) > 0.5) continue;
        if (blocked(p2, c, [fac]) || blocked(c, q, [fac])) continue;
        if (!bent || len < bent.d) bent = { p: p2, c, q, d: len };
      }
    }
    const id = -(700000 + fac.id);
    if (best) {
      // car parks, garages and rental centres get separate IN and OUT drives where the frontage allows
      const dv = norm(sub(best.q, best.p)); const al = { x: -dv.y, y: dv.x };
      const half = (Math.abs(al.x) > 0.5 ? fac.w : fac.h) / 2; const off = Math.min(32, half * 0.55);
      const twin = (fac.type === 'parking' || fac.type === 'rental') && off >= 14 ? [-1, 1].map(k => {
        const c0 = ctr(fac); const base = clamp2({ x: c0.x + dv.x * 1e4, y: c0.y + dv.y * 1e4 }, fac);
        const p2 = { x: base.x + al.x * k * off, y: base.y + al.y * k * off }; const q2 = onSeg({ x: p2.x + dv.x * best!.d, y: p2.y + dv.y * best!.d }, best!.r.a, best!.r.b);
        const ok = Math.abs((q2.x - p2.x) * al.x + (q2.y - p2.y) * al.y) < 0.5 && !blocked(p2, q2, [fac]) && dist(q2, best!.r.a) > 6 && dist(q2, best!.r.b) > 6;
        return ok ? { p: p2, q: q2 } : null;
      }) : [];
      if (twin.length === 2 && twin[0] && twin[1]) {
        out.push({ id, kind: 'road', a: twin[0].p, b: twin[0].q, cls: 0, lanes: 2 }, { id: id - 250000, kind: 'road', a: twin[1].p, b: twin[1].q, cls: 0, lanes: 2 });
      } else out.push({ id, kind: 'road', a: best.p, b: best.q, cls: 0, lanes: 2 });
    } else if (bent) out.push({ id, kind: 'road', a: bent.p, b: bent.c, cls: 0, lanes: 2 }, { id: id - 120000, kind: 'road', a: bent.c, b: bent.q, cls: 0, lanes: 2 });
  }
  return out;
}

/** AirTrain: stations link themselves into one line, the shortest that joins them all (a minimum spanning tree). */
export function trainLinks(zones: Zone[]): { a: Zone; b: Zone }[] {
  const st = zones.filter(z => z.type === 'train').sort((p, q) => p.id - q.id);
  if (st.length < 2) return [];
  const inTree = new Set<Zone>([st[0]]); const out: { a: Zone; b: Zone }[] = [];
  while (inTree.size < st.length) {
    let best: { a: Zone; b: Zone; d: number } | null = null;
    for (const a of inTree) for (const b of st) if (!inTree.has(b)) { const d = dist(ctr(a), ctr(b)); if (!best || d < best.d) best = { a, b, d }; }
    if (!best) break; inTree.add(best.b); out.push({ a: best.a, b: best.b });
  }
  return out;
}
const segsCross = (a: Pt, b: Pt, c: Pt, d: Pt) => {
  const o = (p: Pt, q: Pt, r: Pt) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
};
