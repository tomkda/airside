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
import { Pt, Rect, sub, dot, dist, norm, lerpPt, rectsOverlap } from './geom';
import { FRONTAGE, Level, ZoneType } from './config';
import type { World, Zone, Way } from './world';
import { sidesOf } from './gates';

export type Deck = 'dep' | 'arr' | 'both';
export interface AutoTag { road: number; module: number; deck: Deck; gap: number }
/** An elevated stretch of road, drawn as an upper deck over the ground-level road. */
export interface DeckSpan { road: number; a: Pt; b: Pt; width: number }
/** Where a road would ideally run to front a module: the guide the road tool shows and snaps to. */
export interface FrontGuide { zone: Zone; a: Pt; b: Pt; out: Pt }

const FRONT_TYPES = new Set<ZoneType>(['checkin', 'claim', 'security']);
const roadWidth = (lanes: number) => (lanes >= 4 ? 16 : 9);

interface Cand { m: Zone; road: Way; level: Level; a: Pt; b: Pt; out: Pt; gap: number; t0: number; t1: number; line: number }

/** Curbs and decks for every road that runs along a terminal's landside face. */
export function autoFrontage(world: World): { curbs: Zone[]; decks: DeckSpan[]; guides: FrontGuide[] } {
  const roads = world.ways.filter(w => w.kind === 'road');
  const mods = world.zones.filter(z => FRONT_TYPES.has(z.type));
  const cands: Cand[] = [];
  const guides: FrontGuide[] = [];
  for (const m of mods) for (const sd of sidesOf(m)) {
    const L = dist(sd.a, sd.b); const al = norm(sub(sd.b, sd.a));
    // a face that touches another module on the same level is interior, not frontage
    const probe: Rect = boxOf(lerpPt(sd.a, sd.b, 0.1), lerpPt(sd.a, sd.b, 0.9), sd.out, 1.5);
    const inner = world.zones.some(o => o.id !== m.id && o.level === m.level && o.type !== 'curb' && o.type !== 'parking' && rectsOverlap(probe, o));
    if (inner || L < FRONTAGE.minLen) continue;
    guides.push({ zone: m, a: sd.a, b: sd.b, out: sd.out });
    for (const r of roads) {
      if (Math.abs(dot(norm(sub(r.b, r.a)), al)) < 0.985) continue;
      const d = (dot(sub(r.a, sd.a), sd.out) + dot(sub(r.b, sd.a), sd.out)) / 2;
      const gap = d - roadWidth(r.lanes) / 2;
      if (gap < FRONTAGE.minGap || gap > FRONTAGE.maxGap) continue;
      const s0 = dot(sub(r.a, sd.a), al), s1 = dot(sub(r.b, sd.a), al);
      const t0 = Math.max(0, Math.min(s0, s1)), t1 = Math.min(L, Math.max(s0, s1));
      if (t1 - t0 < FRONTAGE.minLen) continue;
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
        decks.push({ road: c.road.id, a: at(c.t0 - FRONTAGE.ramp), b: at(c.t1 + FRONTAGE.ramp), width: roadWidth(c.road.lanes) });
      } else if (!ground(c).length) pushCurb(c, 0, 'both', c.t0, c.t1);   // a single-level road reaches the face through a frontage core
    } else {
      const above = cands.some(o => o.level === 1 && o.road === c.road && o.line === c.line && o.out.x === c.out.x && o.out.y === c.out.y && o.t1 > c.t0 && o.t0 < c.t1 && (o.m.type === 'checkin' || o.m.type === 'security'));
      pushCurb(c, 0, above ? 'arr' : 'both', c.t0, c.t1);
    }
  }
  return { curbs, decks, guides };
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

/**
 * v0.9: a parking lot that no sidewalk reaches lays its own, to the nearest ground-level curb (an arrivals curb
 * if there is one) or, failing that, the nearest ground-level terminal module. It goes straight if it can, or
 * round one corner, and never through a building, an apron or the airfield. Generated, never saved.
 */
export function autoWalks(world: World, zones: Zone[], aprons: Rect[]): Way[] {
  const out: Way[] = [];
  const walks = world.ways.filter(w => w.kind === 'walk');
  const near = (p: Pt, r: Rect, k: number) => p.x >= r.x - k && p.x <= r.x + r.w + k && p.y >= r.y - k && p.y <= r.y + r.h + k;
  const clamp2 = (p: Pt, r: Rect): Pt => ({ x: Math.min(r.x + r.w, Math.max(r.x, p.x)), y: Math.min(r.y + r.h, Math.max(r.y, p.y)) });
  const ctr = (r: Rect): Pt => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
  const blocked = (a: Pt, b: Pt, ends: Rect[]) => {
    const segHits = (r: Rect) => { for (let i = 1; i < 20; i++) { const t = i / 20; const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; if (p.x > r.x + 1 && p.x < r.x + r.w - 1 && p.y > r.y + 1 && p.y < r.y + r.h - 1) return true; } return false; };
    if (zones.some(z => z.level === 0 && !ends.includes(z) && segHits(z))) return true;
    if (aprons.some(segHits)) return true;
    if (world.ways.some(w => w.kind === 'taxi' && segsCross(a, b, w.a, w.b))) return true;
    return world.runways.some(r => segsCross(a, b, r.a, r.b));
  };
  for (const lot of zones.filter(z => z.type === 'parking')) {
    if (walks.some(w => near(w.a, lot, 3) || near(w.b, lot, 3))) continue;
    const cands = zones.filter(z => z.level === 0 && z.type === 'curb');
    const pool = cands.some(c => c.auto?.deck !== 'dep') ? cands.filter(c => c.auto?.deck !== 'dep') : cands;
    const targets = pool.length ? pool : zones.filter(z => z.level === 0 && (z.type === 'claim' || z.type === 'checkin'));
    const tgt = [...targets].sort((p, q) => dist(ctr(p), ctr(lot)) - dist(ctr(q), ctr(lot)))[0];
    if (!tgt || rectsOverlap(lot, tgt) || dist(ctr(tgt), ctr(lot)) > 900) continue;
    const a = clamp2(ctr(tgt), lot), b = clamp2(a, tgt);
    const id = -(500000 + lot.id);
    const ends = [lot, tgt];
    if (dist(a, b) < 2) continue;
    if (!blocked(a, b, ends)) { out.push({ id, kind: 'walk', a, b, cls: 0, lanes: 0 }); continue; }
    for (const c of [{ x: a.x, y: b.y }, { x: b.x, y: a.y }]) if (!blocked(a, c, ends) && !blocked(c, b, ends)) {
      out.push({ id, kind: 'walk', a, b: c, cls: 0, lanes: 0 }, { id: id - 250000, kind: 'walk', a: c, b, cls: 0, lanes: 0 }); break;
    }
  }
  return out;
}
const segsCross = (a: Pt, b: Pt, c: Pt, d: Pt) => {
  const o = (p: Pt, q: Pt, r: Pt) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
};
