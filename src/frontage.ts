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
import { Pt, Rect, sub, dot, dist, norm, lerpPt, rectsOverlap, polyLen } from './geom';
import { FRONTAGE, Level, ZoneType } from './config';
import type { World, Zone, Way } from './world';
import { sidesOf } from './gates';
import { waySegs, wayPts } from './ways';

export type Deck = 'dep' | 'arr' | 'both';
export interface AutoTag { road: number; module: number; deck: Deck; gap: number }
/** An elevated stretch of road, drawn as an upper deck over the ground-level road. */
export interface DeckSpan {
  road: number; a: Pt; b: Pt; width: number;
  /** v0.13: the deck's centreline from where it leaves the ground to where it lands again, with the height
   *  (0 on the ground, 1 at deck level) and the width at each point. A ramp may curve away from the ground road. */
  pts: Pt[]; zs: number[]; ws: number[];
}
/** Where a road would ideally run to front a module: the guide the road tool shows and snaps to. */
export interface FrontGuide { zone: Zone; a: Pt; b: Pt; out: Pt }

const FRONT_TYPES = new Set<ZoneType>(['checkin', 'claim', 'security']);
const roadWidth = (lanes: number) => (lanes >= 4 ? 16 : 9);

interface Cand { m: Zone; road: Way; level: Level; a: Pt; b: Pt; out: Pt; gap: number; t0: number; t1: number; line: number }

/** Curbs and decks for every road that runs along a terminal's landside face. */
export function autoFrontage(world: World, extra: Way[] = []): { curbs: Zone[]; decks: DeckSpan[]; guides: FrontGuide[] } {
  const roads = [...world.ways.filter(w => w.kind === 'road' && !w.c), ...extra.filter(w => w.fore === 'face')];   // curbs grow along straight roads
  const mods = world.zones.filter(z => FRONT_TYPES.has(z.type));
  const cands: Cand[] = [];
  const guides: FrontGuide[] = [];
  for (const m of mods) for (const sd of sidesOf(m)) {
    const L = dist(sd.a, sd.b); const al = norm(sub(sd.b, sd.a));
    // a face that touches another module on the same level is interior, not frontage
    const probe: Rect = boxOf(lerpPt(sd.a, sd.b, 0.1), lerpPt(sd.a, sd.b, 0.9), sd.out, 1.5);
    const inner = world.zones.some(o => o.id !== m.id && o.level === m.level && TERMINAL_SET.has(o.type) && rectsOverlap(probe, o));
    if (inner || L < FRONTAGE.minLen) continue;
    guides.push({ zone: m, a: sd.a, b: sd.b, out: sd.out });
    for (const r of roads) {
      const f = fronts(r, sd, L, al); if (!f) continue;
      const { gap, t0, t1 } = f;
      const line = Math.round(dot(sd.a, sd.out));   // which building line this face sits on
      cands.push({ m, road: r, level: m.level, a: sd.a, b: sd.b, out: sd.out, gap, t0, t1, line });
    }
  }

  const curbs: Zone[] = [];
  const decks: DeckSpan[] = [];
  const ground = (c: Cand) => cands.filter(o => o !== c && o.level === 0 && o.road === c.road && o.line === c.line && o.out.x === c.out.x && o.out.y === c.out.y && o.t1 > c.t0 && o.t0 < c.t1);
  const pushCurb = (c: Cand, level: Level, deck: Deck, t0: number, t1: number) => {
    const al = norm(sub(c.b, c.a));
    const p0 = { x: c.a.x + al.x * t0, y: c.a.y + al.y * t0 }, p1 = { x: c.a.x + al.x * t1, y: c.a.y + al.y * t1 };
    const r = boxOf(p0, p1, c.out, c.gap - 0.5, 0);
    // never on top of something the player built on that level
    if (world.zones.some(o => o.level === level && o.id !== c.m.id && rectsOverlap(shrink(r, 0.6), o))) return;
    const id = -(c.road.id * 100000 + c.m.id * 2 + level);
    if (curbs.some(z => z.id === id)) return;
    curbs.push({ id, type: 'curb', level, ...r, tier: 0, auto: { road: c.road.id, module: c.m.id, deck, gap: c.gap } });
  };
  for (const c of cands) {
    if (c.level === 1) {
      const below = ground(c).filter(o => o.m.type === 'claim' || o.m.type === 'checkin');
      if (below.length && (c.m.type === 'checkin' || c.m.type === 'security')) {
        // departures over arrivals: the road splits into two decks along the departures face
        pushCurb(c, 1, 'dep', c.t0, c.t1);
        const al = norm(sub(c.b, c.a));
        const off = c.gap + roadWidth(c.road.lanes) / 2;
        const at = (t: number) => ({ x: c.a.x + al.x * t + c.out.x * off, y: c.a.y + al.y * t + c.out.y * off });
        const W = roadWidth(c.road.lanes);
        // each end: a ramp that splits off the approach road and curves up onto the deck (a forecourt has these),
        // or else a straight ramp along the frontage road itself
        const ramps = extra.filter(w => w.fore === 'ramp' && w.face === c.road.id);
        const end = (p: Pt, straight: Pt): Pt[] => { const r = ramps.filter(w => dist(w.b, p) < dist(w.b, p === La ? Lb : La)).sort((u, v) => dist(u.b, p) - dist(v.b, p))[0]; return r ? wayPts(r) : [straight]; };
        const La = at(c.t0), Lb = at(c.t1);
        const up = end(La, at(c.t0 - FRONTAGE.ramp)), down = end(Lb, at(c.t1 + FRONTAGE.ramp)).reverse();
        const pts = [...up, La, Lb, ...down];
        const zs: number[] = [], ws: number[] = [];
        const lenUp = polyLen([...up, La]), lenDown = polyLen([Lb, ...down]); let run = 0;
        pts.forEach((p, i) => {
          if (i) run += dist(pts[i - 1], p);
          const k = i <= up.length ? run / (lenUp || 1) : 1 - (run - lenUp - dist(La, Lb)) / (lenDown || 1);
          const zk = Math.max(0, Math.min(1, k)); zs.push(zk); ws.push(up.length > 1 || down.length > 1 ? 10 + (W - 10) * Math.min(1, zk * 1.6) : W);
        });
        decks.push({ road: c.road.id, a: at(c.t0 - FRONTAGE.ramp), b: at(c.t1 + FRONTAGE.ramp), width: W, pts, zs, ws });
      } else if (!ground(c).length) pushCurb(c, 0, 'both', c.t0, c.t1);   // a single-level road reaches the face through a frontage core
    } else {
      const above = cands.some(o => o.level === 1 && o.road === c.road && o.line === c.line && o.out.x === c.out.x && o.out.y === c.out.y && o.t1 > c.t0 && o.t0 < c.t1 && (o.m.type === 'checkin' || o.m.type === 'security'));
      pushCurb(c, 0, above ? 'arr' : 'both', c.t0, c.t1);
    }
  }
  return { curbs, decks, guides };
}

/** Does this straight road run along this building face closely enough to grow a curb? */
function fronts(r: Way, sd: { a: Pt; b: Pt; out: Pt }, L: number, al: Pt): { gap: number; t0: number; t1: number } | null {
  if (Math.abs(dot(norm(sub(r.b, r.a)), al)) < 0.985) return null;
  const d = (dot(sub(r.a, sd.a), sd.out) + dot(sub(r.b, sd.a), sd.out)) / 2;
  const gap = d - roadWidth(r.lanes) / 2;
  if (gap < FRONTAGE.minGap || gap > FRONTAGE.maxGap) return null;
  const s0 = dot(sub(r.a, sd.a), al), s1 = dot(sub(r.b, sd.a), al);
  const t0 = Math.max(0, Math.min(s0, s1)), t1 = Math.min(L, Math.max(s0, s1));
  return t1 - t0 < FRONTAGE.minLen ? null : { gap, t0, t1 };
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
/** How far down the link a ramp leaves it, and how far along the frontage it lands (m). About 5% up to the deck. */
const RAMP = { out: 120, along: 72 };
export function autoForecourt(world: World, aprons: Rect[], highwayY: number, siteW: number): Way[] {
  const out: Way[] = [];
  const drawn = world.ways.filter(w => w.kind === 'road');
  const chords = [...drawn.flatMap(w => waySegs(w).map(([a, b]) => ({ a, b }))), { a: { x: 0, y: highwayY }, b: { x: siteW, y: highwayY } }];
  const straight = drawn.filter(w => !w.c);
  const blocked = blocker(world, world.zones, aprons);
  const over = (a: Zone, b: Zone) => rectsOverlap(shrink(a, 1), b);
  const halls = world.zones.filter(z => z.type === 'checkin' || (z.type === 'claim' && !world.zones.some(o => o.type === 'checkin' && over(z, o)))).sort((p, q) => p.id - q.id);
  const half = roadWidth(4) / 2; const off = FRONTAGE.ideal + half; const ext = FRONTAGE.ramp + 24;
  for (const m of halls) {
    // the hall and whatever is stacked with it (claim under check-in) count as one building
    const fam = world.zones.filter(z => z === m || ((z.type === 'checkin' || z.type === 'claim') && over(z, m)));
    const sides = fam.flatMap(z => sidesOf(z).map(sd => ({ z, sd, L: dist(sd.a, sd.b), al: norm(sub(sd.b, sd.a)) })));
    if (sides.some(q => q.L >= FRONTAGE.minLen && straight.some(r => fronts(r, q.sd, q.L, q.al)))) continue;   // the player drew its frontage
    if (out.some(w => w.fore === 'face' && sides.some(q => q.L >= FRONTAGE.minLen && fronts(w, q.sd, q.L, q.al)))) continue;   // a neighbour's forecourt already serves it
    let best: { a: Pt; b: Pt; legs: { a: Pt; b: Pt }[]; cost: number; ramps: { a: Pt; b: Pt; c: Pt }[] } | null = null;
    for (const { sd, L, al } of sidesOf(m).map(sd => ({ sd, L: dist(sd.a, sd.b), al: norm(sub(sd.b, sd.a)) }))) {
      if (L < FRONTAGE.minLen) continue;
      const probe: Rect = boxOf(lerpPt(sd.a, sd.b, 0.1), lerpPt(sd.a, sd.b, 0.9), sd.out, 1.5);
      if (world.zones.some(o => !fam.includes(o) && TERMINAL_SET.has(o.type) && rectsOverlap(probe, o))) continue;   // an interior face
      const at = (t: number, k: number): Pt => ({ x: sd.a.x + al.x * t + sd.out.x * k, y: sd.a.y + al.y * t + sd.out.y * k });
      const a = at(-ext, off), b = at(L + ext, off);
      if (blocked(a, b, fam) || blocked(at(-ext, off - half), at(L + ext, off - half), fam)) continue;
      // the curb's own ground must be clear too
      const lot = boxOf(sd.a, sd.b, sd.out, off + half);
      if (world.zones.some(o => o.level === 0 && !fam.includes(o) && rectsOverlap(shrink(lot, 1), o))) continue;
      const legs: { a: Pt; b: Pt }[] = []; let cost = 0; const rampsHere: { a: Pt; b: Pt; c: Pt }[] = [];
      for (const [E, away] of [[a, { x: -al.x, y: -al.y }], [b, al]] as const) {
        // straight out from the building first, else straight on along the frontage
        let leg: { a: Pt; b: Pt; d: number; via?: Pt } | null = null;
        for (const [dir, pen] of [[sd.out, 0], [away, 40]] as const) {
          const q = rayHit(E, dir, FRONTAGE.reach, chords); if (!q) continue;
          const d = dist(E, q) + pen;
          if (d - pen < 6 || blocked(E, q, fam)) continue;
          if (!leg || d < leg.d) leg = { a: E, b: q, d };
        }
        if (!leg) {
          // v0.14: nothing straight ahead. Come straight out, then turn once towards the nearest road: this is what
          // reaches a road that stops short of the terminal, or one that runs past off to one side.
          let near: { q: Pt; d: number } | null = null;
          for (const c of chords) { const q = lerpPt(c.a, c.b, Math.max(0, Math.min(1, dot(sub(E, c.a), sub(c.b, c.a)) / (dot(sub(c.b, c.a), sub(c.b, c.a)) || 1)))); const d = dist(E, q); if (!near || d < near.d) near = { q, d }; }
          if (near && near.d <= FRONTAGE.reach) {
            const o = dot(sub(near.q, E), sd.out); const via = { x: E.x + sd.out.x * o, y: E.y + sd.out.y * o };
            if (o >= 30 && dist(via, near.q) >= 12 && !blocked(E, via, fam) && !blocked(via, near.q, fam)) leg = { a: E, b: via, d: o + dist(via, near.q) + 60, via: near.q };
          }
        }
        if (leg) { legs.push({ a: leg.a, b: leg.b }); if (leg.via) legs.push({ a: leg.b, b: leg.via }); cost += leg.d; } else cost += 700;
        // v0.13: where the link comes straight out to the frontage, the upper deck gets its own ramp: it leaves the
        // link before the corner and sweeps round inside it, so the road visibly divides and comes back together
        const run = leg ? dist(leg.a, leg.b) : 0; const square = leg && Math.abs(dot(norm(sub(leg.b, leg.a)), sd.out)) > 0.99;
        if (leg && square && run >= 45) {
          const S = { x: E.x + sd.out.x * Math.min(RAMP.out, run - 12), y: E.y + sd.out.y * Math.min(RAMP.out, run - 12) };
          const D = { x: E.x - away.x * RAMP.along, y: E.y - away.y * RAMP.along };
          if (!blocked(S, D, fam)) rampsHere.push({ a: S, b: D, c: E });
        }
      }
      if (!legs.length) continue;
      if (!best || cost < best.cost) best = { a, b, legs, cost, ramps: rampsHere };
    }
    if (!best) continue;
    const id = FORE + m.id * 4;
    out.push({ id, kind: 'road', a: best.a, b: best.b, cls: 0, lanes: 4, fore: 'face' });
    best.legs.forEach((l, i) => out.push({ id: id + 1 + i, kind: 'road', a: l.a, b: l.b, cls: 0, lanes: 4, fore: 'link' }));
    best.ramps.forEach((r, i) => out.push({ id: RAMP_ID + m.id * 4 + i, kind: 'road', a: r.a, b: r.b, c: r.c, cls: 0, lanes: 2, fore: 'ramp', face: id }));
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
const shrink = (r: Rect, k: number): Rect => ({ x: r.x + k, y: r.y + k, w: Math.max(0, r.w - 2 * k), h: Math.max(0, r.h - 2 * k) });

/** Points along each road where generated curbs begin and end, so the road network can be split there. */
export function curbCuts(curbs: Zone[], roads: Way[]): Map<number, Pt[]> {
  const out = new Map<number, Pt[]>();
  for (const z of curbs) {
    const r = roads.find(w => w.id === z.auto?.road); if (!r) continue;
    const al = norm(sub(r.b, r.a)); const L = dist(r.a, r.b);
    const corners = [{ x: z.x, y: z.y }, { x: z.x + z.w, y: z.y + z.h }];
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
    if (zones.some(z => z.level === 0 && !ends.includes(z) && segHits(z))) return true;
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
  const roads = [...[...world.ways.filter(w => w.kind === 'road'), ...extra].flatMap(w => waySegs(w).map(([a, b]) => ({ ...w, a, b, c: undefined }))), { id: -1, kind: 'road' as const, a: { x: 0, y: highwayY }, b: { x: siteW, y: highwayY }, cls: 0, lanes: 6 }];
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
