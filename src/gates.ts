// Concourse gates. Every side of a concourse can grow gates, by one predictable rule:
//
//   A side gets gates when a taxiway runs parallel to it, no farther out than its "reach"
//   (two stand depths). The gate size is the largest that fits the gap, up to the area's size.
//   Gates sit on a fixed grid along the side, so adding or extending a taxiway never shuffles them,
//   and each slot can be switched off or back on by the player.
//
// The ideal taxiway line for each side (one stand depth out) is exported as a guide for drawing and snapping.
import { Pt, Rect, add, sub, mul, dot, dist, norm, perpLeft, lerpPt, projT, rectsOverlap, rectSegDist, segDist, segsIntersect, inRect } from './geom';
import { APRON, CLASSES, Cls, SITE, TAXI_CLASSES } from './config';
import { roundOuter, Round } from './ways';
import type { World, Zone, Way, Apron, Gate, RunwayInfo } from './world';
import { zonePts, zoneParts, toWorld, dirWorld, polyClip, polyArea, polyBox, shaped, hallPts, arcOf, frameOf, inZone } from './shapes';
import { pointInPoly } from './geom';

/** n, e, s, w for a rectangle (of its own frame); `f0.`, `f1.` … for the facets of a round or polygonal hall (v0.18). */
export type SideKey = string;
export interface GateSlot {
  key: string; id: string; zone: Zone; side: SideKey; i: number; cls: Cls; on: boolean;
  door: Pt; stand: Pt; front: Pt; ang: number; outward: Pt; cell: Pt[];
}
export interface SideGuide {
  zone: Zone; side: SideKey; a: Pt; b: Pt; out: Pt; ideal: number; reach: number;
  served: boolean; d?: number; cls?: Cls; note?: string;
  /** v0.19: the side laid its own apron (no taxiway drawn alongside); or it is a landside face and gets none. */
  self?: boolean; land?: boolean;
  /** v0.20: a curved wall. No taxiway can run parallel to it, so there is no guide line to draw. */
  curved?: boolean;
}
/** A taxilane a concourse laid for itself, or (`link`) its connection to the airfield. Generated, never saved. */
export interface Lane { a: Pt; b: Pt; cls: Cls; zone: number; link?: boolean }
export interface GateOpts {
  /** Lay aprons on faces with no taxiway alongside (v0.19). Off for the first pass, which only finds what the forecourt must avoid. */
  self?: boolean;
  /** Roads and sidewalks, drawn and laid, as straight pieces: self-laid stands and taxilanes keep clear of them. */
  keep?: { a: Pt; b: Pt }[];
}

export const standDepth = (c: number) => CLASSES[c].length + 22;          // building face to taxiway centreline
/** Face to taxilane centreline for an apron a concourse lays itself: nose-in gap, aircraft, then the taxilane's clearance (see APRON). */
export const selfDepth = (c: number) => APRON.nose + CLASSES[c].length + APRON.laneClear[c];
export const sideReach = (c: number) => Math.max(150, 2 * standDepth(c) + 40); // farthest a taxiway can be and still count
export const SIDE_NAMES: Record<string, string> = { n: 'North', e: 'East', s: 'South', w: 'West' };
export const sideName = (s: SideKey) => SIDE_NAMES[s] ?? `Facet ${Number(s.slice(1)) + 1}`;
/** A round hall offers gates on twelve facets, a polygonal one on each of its sides. */
export const gateFacets = (z: Zone) => (!z.sides ? 4 : z.sides >= 24 ? 12 : z.sides);

const inset = (r: Rect, k: number): Rect => ({ x: r.x + k, y: r.y + k, w: Math.max(0, r.w - 2 * k), h: Math.max(0, r.h - 2 * k) });

/** A side of a building. `curve` (v0.20): the side is a long wall of a bent bar, at this y of its straight frame;
 *  a and b are then the ends of the wall and `out` only the way its middle faces. */
export interface Side { side: SideKey; a: Pt; b: Pt; out: Pt; curve?: number }
export function sidesOf(z: Zone): Side[] {
  if (arcOf(z)) {
    const F = frameOf(z); const P = (x: number, y: number) => toWorld(z, { x, y });
    const nw = P(F.x, F.y), ne = P(F.x + F.w, F.y), se = P(F.x + F.w, F.y + F.h), sw = P(F.x, F.y + F.h);
    const face = (a: Pt, b: Pt) => { const d = norm(sub(b, a)); return { x: d.y, y: -d.x }; };
    const mid = (y: number, dy: number) => norm(sub(P(F.x + F.w / 2, y + dy), P(F.x + F.w / 2, y)));
    return [
      { side: 'n', a: nw, b: ne, out: mid(F.y, -1), curve: F.y }, { side: 'e', a: ne, b: se, out: face(ne, se) },
      { side: 's', a: se, b: sw, out: mid(F.y + F.h, 1), curve: F.y + F.h }, { side: 'w', a: sw, b: nw, out: face(sw, nw) },
    ];
  }
  if (z.sides) {
    const pts = hallPts(z, 0, gateFacets(z));
    return pts.map((a, k) => { const b = pts[(k + 1) % pts.length]; const d = norm(sub(b, a)); return { side: `f${k}.` as SideKey, a, b, out: { x: d.y, y: -d.x } }; });
  }
  const sides = [
    { side: 'n' as SideKey, a: { x: z.x, y: z.y }, b: { x: z.x + z.w, y: z.y }, out: { x: 0, y: -1 } },
    { side: 'e' as SideKey, a: { x: z.x + z.w, y: z.y }, b: { x: z.x + z.w, y: z.y + z.h }, out: { x: 1, y: 0 } },
    { side: 's' as SideKey, a: { x: z.x + z.w, y: z.y + z.h }, b: { x: z.x, y: z.y + z.h }, out: { x: 0, y: 1 } },
    { side: 'w' as SideKey, a: { x: z.x, y: z.y + z.h }, b: { x: z.x, y: z.y }, out: { x: -1, y: 0 } },
  ];
  // v0.17: a turned zone keeps its side names (north is the north of its own frame); the geometry turns with it
  // v0.21: a tapered bar's walls are not parallel: each faces square off its own line
  if (z.taper) return sides.map(sd => { const a = toWorld(z, sd.a), b = toWorld(z, sd.b); const d = norm(sub(b, a)); return { side: sd.side, a, b, out: { x: d.y, y: -d.x } }; });
  return z.rot ? sides.map(sd => ({ side: sd.side, a: toWorld(z, sd.a), b: toWorld(z, sd.b), out: dirWorld(z, sd.out) })) : sides;
}

interface Pending { z: Zone; sd: Side; guide: SideGuide; zc: Cls; letter: string }
interface Count { k: number; n: number }

export function buildGateAreas(world: World, runways: RunwayInfo[], runwayWidth: (len: number) => number, opts: GateOpts = {}) {
  const gates: Gate[] = [], aprons: Apron[] = [], slots: GateSlot[] = [], guides: SideGuide[] = [];
  const pending: Pending[] = []; const counts = new Map<number, Count>();
  const letters = new Map<number, string>();
  const units = new Map<number, { max: number; count: number }>();
  const taxis = world.ways.filter(w => w.kind === 'taxi');
  let idx = 0;
  for (const z of world.zones.filter(q => q.type === 'concourse')) {
    const zc = (z.cls ?? 2) as Cls;
    const letter = idx < 26 ? String.fromCharCode(65 + idx) : `G${idx + 1}`; idx++;
    letters.set(z.id, letter);
    const off = new Set(z.off ?? []);
    let k = 0, nSlots = 0;
    for (const sd of sidesOf(z)) {
      const L = dist(sd.a, sd.b); const al = norm(sub(sd.b, sd.a));
      const guide: SideGuide = { zone: z, side: sd.side, a: sd.a, b: sd.b, out: sd.out, ideal: standDepth(zc), reach: sideReach(zc), served: false };
      guides.push(guide);
      // a curved wall has no taxiway parallel to it: it always lays its own apron
      if (sd.curve !== undefined) { guide.curved = true; pending.push({ z, sd, guide, zc, letter }); continue; }
      // nearest parallel taxiway within reach that overlaps this side
      let best: { w: Way; d: number; ov: number } | null = null;
      for (const w of taxis) {
        if (Math.abs(dot(norm(sub(w.b, w.a)), al)) < 0.985) continue;
        const d = (dot(sub(w.a, sd.a), sd.out) + dot(sub(w.b, sd.a), sd.out)) / 2;
        if (d < 8 || d > sideReach(zc)) continue;
        const s0 = dot(sub(w.a, sd.a), al), s1 = dot(sub(w.b, sd.a), al);
        const ov = Math.min(L, Math.max(s0, s1)) - Math.max(0, Math.min(s0, s1));
        if (ov < 20) continue;
        if (!best || d < best.d - 3 || (Math.abs(d - best.d) <= 3 && ov > best.ov)) best = { w, d, ov };
      }
      if (!best) { pending.push({ z, sd, guide, zc, letter }); continue; }
      guide.d = best.d;
      let cls = -1;
      for (let c = zc; c >= 0; c--) if (standDepth(c) <= best.d + 1) { cls = c; break; }
      if (cls < 0) { guide.note = `taxiway is ${Math.round(best.d)} m out; the smallest stands need ${standDepth(0)} m`; continue; }
      guide.cls = cls as Cls;
      if (cls < zc) guide.note = `taxiway is ${Math.round(best.d)} m out: fits ${CLASSES[cls].example}; ${CLASSES[zc].example} stands need ${standDepth(zc)} m`;
      const C = CLASSES[cls]; const sp = C.gateSpacing; const D = best.d;
      // stretches of the side where something else sits in the apron strip
      const strip: Rect = (() => {
        const p1 = sd.a, p2 = add(sd.b, mul(sd.out, D));
        return { x: Math.min(p1.x, p2.x), y: Math.min(p1.y, p2.y), w: Math.abs(p2.x - p1.x), h: Math.abs(p2.y - p1.y) };
      })();
      if (runways.some(r => rectSegDist(strip, r.rw.a, r.rw.b) < runwayWidth(r.length) / 2 + 40)) { guide.note = 'the apron would reach into the runway strip'; continue; }
      const blocked: [number, number][] = [];
      const proj = (pts: Pt[]) => { const s = pts.map(p => dot(sub(p, sd.a), al)); return [Math.min(...s), Math.max(...s)] as [number, number]; };
      // v0.17: where either building is turned, the test is on the true outlines, and only the part of the other
      // building that is actually in the strip blocks gates. That is what lets a pier run into a concourse and
      // keep gates on the rest of its length, and the concourse keep gates either side of the pier.
      const stripPts = [add(sd.a, add(mul(al, 1), mul(sd.out, 1))), add(sd.b, add(mul(al, -1), mul(sd.out, 1))), add(sd.b, add(mul(al, -1), mul(sd.out, D))), add(sd.a, add(mul(al, 1), mul(sd.out, D)))];
      const cut = (pts: Pt[]) => { const c = polyClip(pts, stripPts); if (c.length >= 3 && polyArea(c) > 2) blocked.push(proj(c)); };
      for (const o of world.zones) if (o.id !== z.id) {
        if (shaped(z) || shaped(o)) cut(zonePts(o));
        else if (rectsOverlap(inset(o, 1), strip)) blocked.push(proj([{ x: o.x, y: o.y }, { x: o.x + o.w, y: o.y + o.h }, { x: o.x + o.w, y: o.y }, { x: o.x, y: o.y + o.h }]));
      }
      for (const ap of aprons) {
        if (shaped(z) || shaped(ap.zone)) cut(ap.pts);
        else if (rectsOverlap(inset(ap.rect, 1), strip)) blocked.push(proj([{ x: ap.rect.x, y: ap.rect.y }, { x: ap.rect.x + ap.rect.w, y: ap.rect.y + ap.rect.h }, { x: ap.rect.x + ap.rect.w, y: ap.rect.y }, { x: ap.rect.x, y: ap.rect.y + ap.rect.h }]));
      }
      for (const w of world.ways) if (w.kind !== 'taxi' && rectSegDist(inset(strip, 2), w.a, w.b) === 0) blocked.push(proj([w.a, w.b]));
      const wn = perpLeft(norm(sub(best.w.b, best.w.a)));
      const meet = (p: Pt) => add(p, mul(sd.out, dot(sub(best!.w.a, p), wn) / dot(sd.out, wn)));
      const n = Math.floor(L / sp); const pad = (L - n * sp) / 2;
      let run: GateSlot[] = [];
      const flush = () => {
        if (!run.length) return;
        const first = run[0], last = run[run.length - 1];
        const pts = [...first.cell, ...last.cell];
        const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
        const rect = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
        const ap: Apron = { zone: z, rect, pts: [first.cell[0], last.cell[1], last.cell[2], first.cell[3]], outward: sd.out, laneA: first.front, laneB: last.front, mouth: lerpPt(first.front, last.front, 0.5), cls: cls as Cls, letter };
        aprons.push(ap);
        for (const sl of run) if (sl.on) {
          k++;
          gates.push({ id: sl.id, key: sl.key, num: `${letter}${k}`, zone: z, apron: ap, cls: sl.cls, door: sl.door, stand: sl.stand, front: sl.front, ang: sl.ang, outward: sl.outward, frontNode: -1, rwys: [new Set(), new Set(), new Set(), new Set()] });
        }
        run = [];
      };
      for (let i = 0; i < n; i++) {
        const s = pad + (i + 0.5) * sp;
        const ep = add(sd.a, mul(al, s));
        const front = meet(ep);
        const t = projT(front, best.w.a, best.w.b);
        const free = t >= -0.001 && t <= 1.001 && !blocked.some(([b0, b1]) => b1 > s - sp / 2 + 1 && b0 < s + sp / 2 - 1);
        if (!free) { flush(); continue; }
        const key = `${sd.side}${i}`;
        const h = mul(al, sp / 2);
        const cell = [sub(ep, h), add(ep, h), add(add(ep, h), mul(sd.out, D)), add(sub(ep, h), mul(sd.out, D))];
        const sl: GateSlot = {
          key, id: `${z.id}-${key}`, zone: z, side: sd.side, i, cls: cls as Cls, on: !off.has(key),
          door: add(ep, mul(sd.out, -7)), stand: add(ep, mul(sd.out, C.length / 2 + 8)), front, ang: Math.atan2(-sd.out.y, -sd.out.x), outward: sd.out, cell,
        };
        slots.push(sl); nSlots++; guide.served = true;
        run.push(sl);
      }
      flush();
    }
    counts.set(z.id, { k, n: nSlots });
  }
  // v0.19: every other open face lays its own apron, taxilane and link to the airfield.
  const laid = opts.self && APRON.self ? selfAprons(world, runways, runwayWidth, pending, aprons, gates, slots, counts, opts.keep ?? []) : { lanes: [], pads: [] };
  for (const [id, c] of counts) units.set(id, { max: c.n, count: c.k });
  return { gates, aprons, slots, guides, letters, units, lanes: laid.lanes, pads: laid.pads };
}

// ------------------------------------------------------------ self-laid aprons (v0.19)
//
//   A concourse face with no taxiway alongside lays its own apron: stands on the same grid and with the same keys as
//   a drawn one (so switching to a drawn taxiway later keeps the player's switched-off gates), one stand depth deep,
//   and a taxilane along their tails. Faces are taken in order, first come first served: a stand needs its whole
//   cell clear of other buildings, of aprons already laid, of roads and sidewalks, and its taxilane clear of
//   buildings by the ICAO distance. A face a processing module stands against (security, a hall) is landside
//   and gets none.
//
//   Then the taxilanes are joined up. Lanes on neighbouring faces meet at the corner. Each loose end runs straight
//   on, or straight out from the building, to the nearest taxiway, taxilane or (at a cost) runway within
//   `APRON.reach`. A ring with no loose end (round a hub, or all four sides of a satellite) takes the shortest way
//   out it can find. Nothing here is saved; it is rebuilt on every derive.
/** Net refs of generated taxilanes: -(LANE_REF + index). */
export const LANE_REF = 2400000;
const LANDSIDE = new Set(['security', 'checkin', 'claim', 'passport']);
const cross = (a: Pt, b: Pt) => a.x * b.y - a.y * b.x;
/** How far along the ray from p (unit direction u) segment ab is met, or -1. */
function rayHit(p: Pt, u: Pt, a: Pt, b: Pt): number {
  const v = sub(b, a); const den = cross(u, v); if (Math.abs(den) < 1e-6) return -1;
  const w = sub(a, p); const t = cross(w, v) / den, q = cross(w, u) / den;
  return t >= -0.01 && q >= -0.002 && q <= 1.002 ? Math.max(0, t) : -1;
}
/** Distance from a point to a polygon's outline. */
const edgeDist = (p: Pt, poly: Pt[]) => { let m = Infinity; for (let i = 0; i < poly.length; i++) m = Math.min(m, segDist(p, poly[i], poly[(i + 1) % poly.length])); return m; };
/** Distance from a point to a polygon: 0 inside it. */
const polyDist = (p: Pt, poly: Pt[]) => (pointInPoly(p, poly) ? 0 : edgeDist(p, poly));
/** Inside a polygon by more than `m` metres (so a point on its edge is not inside). */
const within = (p: Pt, poly: Pt[], m: number) => pointInPoly(p, poly) && edgeDist(p, poly) > m;
const fat = (a: Pt, b: Pt, hw: number): Pt[] => { const n = mul(perpLeft(norm(sub(b, a))), hw); return [add(a, n), add(b, n), sub(b, n), sub(a, n)]; };

/** A run of stands and the taxilane along their tails: `pts` is the lane (two points, or a polyline round a curve),
 *  `outs` the way the stands face at each end and in the middle, `corner` the apron's corners at each end (at the wall, at the lane). */
interface Run { pts: Pt[]; cls: Cls; zone: number; outs: [Pt, Pt, Pt]; corner: [[Pt, Pt], [Pt, Pt]]; ap: Apron; ext: [number, number]; joined: [boolean, boolean]; T: number }
type LaneR = Lane & { run?: Run };

function selfAprons(world: World, runways: RunwayInfo[], runwayWidth: (len: number) => number, pending: Pending[],
  aprons: Apron[], gates: Gate[], slots: GateSlot[], counts: Map<number, Count>, keep: { a: Pt; b: Pt }[]): { lanes: Lane[]; pads: Pt[][] } {
  const taxis = world.ways.filter(w => w.kind === 'taxi');
  const outlines = world.zones.map(z => { const pts = zonePts(z); return { z, pts, box: polyBox(pts) }; });
  // most things are nowhere near most other things: a box test first keeps this cheap enough to run every frame of a drag
  const nearBox = (p: Pt, r: Rect, m: number) => p.x >= r.x - m && p.x <= r.x + r.w + m && p.y >= r.y - m && p.y <= r.y + r.h + m;
  const onSite = (p: Pt) => inRect(p, SITE.buildable) && !pointInPoly(p, SITE.lake);
  const nearRunway = (p: Pt) => runways.some(r => segDist(p, r.rw.a, r.rw.b) < runwayWidth(r.length) / 2 + 40);
  const runs: Run[] = [];
  for (const { z, sd, guide, zc, letter } of pending) {
    const L = dist(sd.a, sd.b); const al = norm(sub(sd.b, sd.a));
    const C = CLASSES[zc]; const sp = C.gateSpacing; const D = selfDepth(zc); const clear = APRON.laneClear[zc];
    const cnt = counts.get(z.id)!;
    // ---- where the stands of this side would go: wall point, the way it faces, the way the wall runs, its cell
    interface Cand { i: number; ep: Pt; out: Pt; tan: Pt; cell: Pt[]; front: Pt; free: boolean }
    const cands: Cand[] = [];
    const A = sd.curve !== undefined ? arcOf(z) : null;
    const roundBox = (rd: Round) => { const R = roundOuter(rd) + 4; return [{ x: rd.x - R, y: rd.y - R }, { x: rd.x + R, y: rd.y - R }, { x: rd.x + R, y: rd.y + R }, { x: rd.x - R, y: rd.y + R }]; };
    if (A) {
      // a curved wall (v0.20). Stands are square to the wall, so on the outside of the bend they fan out and can
      // stand closer along the wall; on the inside they close up, and need more wall each. The spacing is set
      // where the wings are (half an aircraft out from the nose), and on the inside also where the tails meet.
      const F = frameOf(z); const yw = sd.curve!; const dir = yw === F.y ? -1 : 1;
      const rw = A.R + A.sg * (yw - (F.y + F.h / 2));          // the wall's radius (half way along, if the bar tapers)
      const grow = A.sg * dir;                                   // +1: the outside of the bend, -1: the inside
      const rWing = rw + grow * (APRON.nose + C.length / 2), rLane = rw + grow * D;
      if (rLane < 30) { guide.note = 'the bend is too tight for stands on its inside'; continue; }
      const dphi = Math.max(sp / rWing, grow < 0 ? (0.45 * sp) / rLane : 0);
      const du = dphi * A.R; const n = Math.floor(F.w / du); const pad = (F.w - n * du) / 2;
      // a point `d` metres out from the wall, square off it (on a tapered bar the wall is not at one radius, so this
      // is taken from the wall itself, not from the frame)
      const wallAt = (u: number) => toWorld(z, { x: u, y: yw });
      const P = (u: number, d: number) => {
        const p0 = wallAt(u); if (!z.taper) return toWorld(z, { x: u, y: yw + dir * d });
        const t = norm(sub(wallAt(u + 0.5), wallAt(u - 0.5))); let nx = t.y, ny = -t.x; const o = sub(toWorld(z, { x: u, y: yw + dir }), p0);
        if (nx * o.x + ny * o.y < 0) { nx = -nx; ny = -ny; }
        return { x: p0.x + nx * d, y: p0.y + ny * d };
      };
      const fwd = sd.side === 'n' ? 1 : -1;                      // sides run clockwise: north west to east, south east to west
      const u0 = sd.side === 'n' ? F.x : F.x + F.w;
      // landside: a processing module stands against this wall
      const against = (o: { z: Zone; pts: Pt[] }) => { for (let k = 0; k <= 12; k++) { const p = P(F.x + (F.w * k) / 12, 3); if (pointInPoly(p, o.pts)) return true; } return false; };
      if (outlines.some(o => o.z.id !== z.id && LANDSIDE.has(o.z.type) && against(o))) { guide.land = true; continue; }
      for (let i = 0; i < n; i++) {
        const u = u0 + fwd * (pad + (i + 0.5) * du), h = (fwd * du) / 2;
        const ep = P(u, 0), front = P(u, D); const out = norm(sub(front, ep));
        const cell = [P(u - h, 0.5), P(u + h, 0.5), P(u + h, D), P(u - h, D)];
        const tan = norm(sub(cell[2], cell[3]));
        const cb = polyBox(cell); const hitsBox = (r: Rect, m = 0) => r.x - m <= cb.x + cb.w && r.x + r.w + m >= cb.x && r.y - m <= cb.y + cb.h && r.y + r.h + m >= cb.y;
        const over = (pts: Pt[]) => { const c = polyClip(pts, cell); return c.length >= 3 && polyArea(c) > 3; };
        // its own building is tested exactly (by `inZone`), at points through the cell beyond the wall: the outline is
        // only chords of the true wall, and clipping against it would find the wall itself in the way
        const own = () => { for (const d of [6, D / 3, (2 * D) / 3, D]) for (const k of [-0.5, 0, 0.5]) if (inZone(P(u + 2 * k * h * 0.96, d), z)) return true; return false; };
        const free = [cell[2], cell[3], front].every(p => onSite(p) && !nearRunway(p))
          && !outlines.some(o => o.z.id !== z.id && hitsBox(o.box) && zoneParts(o.z).some(over))
          && !own()                                              // a tight horseshoe: its own other arm is in the way
          && !aprons.some(ap => hitsBox(ap.rect) && over(ap.pts))
          && !keep.some(k => hitsBox({ x: Math.min(k.a.x, k.b.x), y: Math.min(k.a.y, k.b.y), w: Math.abs(k.b.x - k.a.x), h: Math.abs(k.b.y - k.a.y) }, 8) && over(fat(k.a, k.b, 8)))
          && !taxis.some(w => over(fat(w.a, w.b, (w.cls >= 3 ? TAXI_CLASSES[1].width : TAXI_CLASSES[0].width) / 2 + 4)))
          && !(world.rounds ?? []).some(rd => over(roundBox(rd)))
          && !outlines.some(o => nearBox(front, o.box, clear) && polyDist(front, o.pts) < clear - 0.5)
          && !keep.some(k => segDist(front, k.a, k.b) < 12);
        cands.push({ i, ep, out, tan, cell, front, free });
      }
    } else {
      const out = sd.out;
      const quad = (d0: number, d1: number) => [add(sd.a, add(mul(al, 1), mul(out, d0))), add(sd.b, add(mul(al, -1), mul(out, d0))), add(sd.b, add(mul(al, -1), mul(out, d1))), add(sd.a, add(mul(al, 1), mul(out, d1)))];
      if (L < sp) continue;
      // a processing module stands against this face: it is the landside of the building
      const thin = quad(0.5, 6);
      if (outlines.some(o => o.z.id !== z.id && LANDSIDE.has(o.z.type) && polyArea(polyClip(o.pts, thin)) > 2)) { guide.land = true; continue; }
      const strip = quad(1, D);
      const blocked: [number, number][] = [];
      const cut = (pts: Pt[]) => {
        const c = polyClip(pts, strip); if (c.length < 3 || polyArea(c) <= 2) return;
        const t = c.map(p => dot(sub(p, sd.a), al)); blocked.push([Math.min(...t), Math.max(...t)]);
      };
      for (const o of outlines) if (o.z.id !== z.id) cut(o.pts);
      for (const ap of aprons) cut(ap.pts);
      for (const k of keep) cut(fat(k.a, k.b, 8));
      for (const w of taxis) cut(fat(w.a, w.b, (w.cls >= 3 ? TAXI_CLASSES[1].width : TAXI_CLASSES[0].width) / 2 + 4));
      for (const rd of world.rounds ?? []) cut(roundBox(rd));
      const n = Math.floor(L / sp); const pad = (L - n * sp) / 2;
      for (let i = 0; i < n; i++) {
        const s = pad + (i + 0.5) * sp; const ep = add(sd.a, mul(al, s)); const front = add(ep, mul(out, D));
        const h = mul(al, sp / 2);
        const cell = [sub(ep, h), add(ep, h), add(add(ep, h), mul(out, D)), add(sub(ep, h), mul(out, D))];
        const free = !blocked.some(([b0, b1]) => b1 > s - sp / 2 + 1 && b0 < s + sp / 2 - 1)
          && [cell[2], cell[3], front].every(p => onSite(p) && !nearRunway(p))
          && !outlines.some(o => o.z.id !== z.id && nearBox(front, o.box, clear) && polyDist(front, o.pts) < clear - 0.5)
          && !keep.some(k => segDist(front, k.a, k.b) < 12);
        cands.push({ i, ep, out, tan: al, cell, front, free });
      }
    }
    // ---- runs of free stands become aprons, each with a taxilane along its tails
    let run: (GateSlot & { tan: Pt })[] = [];
    const flush = () => {
      if (!run.length) return;
      const first = run[0], last = run[run.length - 1];
      const pts = A ? [first.cell[0], ...run.map(q => q.cell[1]), ...[...run].reverse().map(q => q.cell[2]), first.cell[3]] : [first.cell[0], last.cell[1], last.cell[2], first.cell[3]];
      const rect = polyBox(pts); const midOut = run[Math.floor(run.length / 2)].outward;
      const ap: Apron = { zone: z, rect, pts, outward: midOut, laneA: first.front, laneB: last.front, mouth: run[Math.floor(run.length / 2)].front, cls: zc, letter, self: true };
      aprons.push(ap);
      for (const sl of run) if (sl.on) {
        cnt.k++;
        gates.push({ id: sl.id, key: sl.key, num: `${letter}${cnt.k}`, zone: z, apron: ap, cls: sl.cls, door: sl.door, stand: sl.stand, front: sl.front, ang: sl.ang, outward: sl.outward, frontNode: -1, rwys: [new Set(), new Set(), new Set(), new Set()] });
      }
      // the taxilane runs half a stand past each end where there is room, so the end stands can push back
      const room = (p: Pt) => onSite(p) && !outlines.some(o => o.z.id !== z.id && nearBox(p, o.box, 10) && polyDist(p, o.pts) < 10) && !aprons.some(o => o !== ap && nearBox(p, o.rect, 0) && within(p, o.pts, 1)) && !keep.some(k => segDist(p, k.a, k.b) < 10);
      const e0 = room(add(first.front, mul(first.tan, -sp / 2))) ? sp / 2 : 2, e1 = room(add(last.front, mul(last.tan, sp / 2))) ? sp / 2 : 2;
      const lane = [add(first.front, mul(first.tan, -e0)), ...(A ? run.map(q => q.front) : []), add(last.front, mul(last.tan, e1))];
      runs.push({ pts: lane, cls: zc, zone: z.id, outs: [first.outward, last.outward, midOut], corner: [[first.cell[0], first.cell[3]], [last.cell[1], last.cell[2]]], ap, ext: [e0, e1], joined: [false, false], T: D + sp });
      run = [];
    };
    for (const c of cands) {
      if (!c.free) { flush(); continue; }
      const key = `${sd.side}${c.i}`;
      const sl = {
        key, id: `${z.id}-${key}`, zone: z, side: sd.side, i: c.i, cls: zc, on: !(z.off ?? []).includes(key),
        door: add(c.ep, mul(c.out, -7)), stand: add(c.ep, mul(c.out, C.length / 2 + APRON.nose)), front: c.front, ang: Math.atan2(-c.out.y, -c.out.x), outward: c.out, cell: c.cell, tan: c.tan,
      };
      slots.push(sl); cnt.n++; guide.served = true; guide.self = true; guide.d = D; guide.cls = zc;
      run.push(sl);
    }
    flush();
  }
  if (!runs.length) return { lanes: [], pads: [] };
  const pads: Pt[][] = [];

  // ---- a clear line for a taxilane: on the site, off buildings, aprons, roads and sidewalks
  const clearLine = (a: Pt, b: Pt) => {
    if (keep.some(k => segsIntersect(a, b, k.a, k.b))) return false;
    const L = dist(a, b); const u = norm(sub(b, a));
    const lb: Rect = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
    const hits = (r: Rect, m: number) => r.x - m <= lb.x + lb.w && r.x + r.w + m >= lb.x && r.y - m <= lb.y + lb.h && r.y + r.h + m >= lb.y;
    const os = outlines.filter(o => hits(o.box, 10)), as = aprons.filter(o => hits(o.rect, 0));
    for (let s = 5; s < L - 1; s += 5) {
      const p = add(a, mul(u, s));
      if (!onSite(p) || os.some(o => nearBox(p, o.box, 10) && polyDist(p, o.pts) < 10) || as.some(o => nearBox(p, o.rect, 0) && within(p, o.pts, 1.5))) return false;
    }
    for (const rd of world.rounds ?? []) if (segDist(rd, a, b) < roundOuter(rd) + 10) return false;
    return true;
  };
  const endPt = (r: Run, e: 0 | 1) => (e ? r.pts[r.pts.length - 1] : r.pts[0]);
  const endDir = (r: Run, e: 0 | 1) => (e ? norm(sub(r.pts[r.pts.length - 1], r.pts[r.pts.length - 2])) : norm(sub(r.pts[0], r.pts[1])));

  // ---- lanes on neighbouring faces meet at the corner
  const joins: { i: number; j: number; ei: 0 | 1; ej: 0 | 1; X: Pt; cost: number }[] = [];
  for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length; j++) for (const ei of [0, 1] as const) for (const ej of [0, 1] as const) {
    const A = runs[i], B = runs[j]; const ua = endDir(A, ei), ub = endDir(B, ej); const den = cross(ua, ub);
    if (Math.abs(den) < 0.2) continue;
    const W = sub(endPt(B, ej), endPt(A, ei)); const ta = cross(W, ub) / den, tb = cross(W, ua) / den;
    if (ta < -A.ext[ei] - 0.5 || tb < -B.ext[ej] - 0.5 || ta > A.T || tb > B.T) continue;
    joins.push({ i, j, ei, ej, X: add(endPt(A, ei), mul(ua, ta)), cost: Math.max(0, ta) + Math.max(0, tb) });
  }
  joins.sort((p, q) => p.cost - q.cost || p.i - q.i || p.j - q.j);
  const setEnd = (r: Run, e: 0 | 1, X: Pt) => { if (e) r.pts[r.pts.length - 1] = X; else r.pts[0] = X; r.joined[e] = true; };
  for (const J of joins) {
    const A = runs[J.i], B = runs[J.j];
    if (A.joined[J.ei] || B.joined[J.ej]) continue;
    if (!clearLine(endPt(A, J.ei), J.X) || !clearLine(endPt(B, J.ej), J.X)) continue;
    setEnd(A, J.ei, J.X); setEnd(B, J.ej, J.X);
    // pave the corner between the two aprons
    pads.push([A.corner[J.ei][0], A.corner[J.ei][1], J.X, B.corner[J.ej][1], B.corner[J.ej][0]]);
  }

  // ---- lanes on opposite sides of a building whose end has no stand (it is narrower than one stand) meet round that end
  const round: Lane[] = [];
  for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length; j++) {
    const A = runs[i], B = runs[j];
    if (A.zone !== B.zone) continue;
    for (const ei of [0, 1] as const) for (const ej of [0, 1] as const) {
      if (A.joined[ei] || B.joined[ej] || dot(A.outs[ei], B.outs[ej]) > -0.9) continue;
      const u = endDir(A, ei); if (dot(u, endDir(B, ej)) < 0.9) continue;
      const sa = dot(endPt(A, ei), u), sb = dot(endPt(B, ej), u);
      if (Math.abs(sa - sb) > A.T) continue;          // the two sides end at very different places: not one building end
      for (const d of [30, 45, 60]) {
        const s = Math.max(sa, sb) + d;
        const pa = add(endPt(A, ei), mul(u, s - sa)), pb = add(endPt(B, ej), mul(endDir(B, ej), s - sb));
        if (!clearLine(endPt(A, ei), pa) || !clearLine(endPt(B, ej), pb) || !clearLine(pa, pb)) continue;
        setEnd(A, ei, pa); setEnd(B, ej, pb);
        round.push({ a: pa, b: pb, cls: A.cls, zone: A.zone });
        break;
      }
    }
  }

  // ---- loose ends reach for the airfield
  const lanes: LaneR[] = [];
  for (const r of runs) for (let i = 1; i < r.pts.length; i++) lanes.push({ a: r.pts[i - 1], b: r.pts[i], cls: r.cls, zone: r.zone, run: r });
  lanes.push(...round);
  /** The nearest taxiway, runway or taxilane a ray meets within reach. `ok` limits taxilanes to those already joined to the airfield. */
  const rayTo = (from: Pt, u: Pt, self: Run | null, ok?: boolean[]) => {
    let best: { t: number; rwy: boolean } | null = null;
    const tryHit = (a: Pt, b: Pt, rwy: boolean) => { const t = rayHit(from, u, a, b); if (t >= 0 && t <= APRON.reach && (!best || t < best.t)) best = { t, rwy }; };
    for (const w of taxis) tryHit(w.a, w.b, false);
    for (const r of runways) tryHit(r.rw.a, r.rw.b, true);
    lanes.forEach((l, k) => { if ((!self || l.run !== self) && (!ok || ok[k])) tryHit(l.a, l.b, false); });
    return best as { t: number; rwy: boolean } | null;
  };
  interface Way2 { pts: Pt[]; cost: number }
  /** The ways out from a point: straight along `u`, or along `u` a little way and then off to one side. */
  const waysOut = (from: Pt, u: Pt, sides: Pt[], self: Run | null, ok?: boolean[]): Way2 | null => {
    let best: Way2 | null = null;
    const take = (pts: Pt[], cost: number) => { if (!best || cost < best.cost) best = { pts, cost }; };
    const leg = (p: Pt, dir: Pt, lead: Pt[], extra: number, k: number) => {
      const h = rayTo(p, dir, self, ok); if (!h) return;
      const to = add(p, mul(dir, h.t));
      if (h.t >= 1 && !clearLine(p, to)) return;
      take([...lead, p, to], (extra + h.t * (h.rwy ? APRON.runwayCost : 1)) * k + (lead.length ? 20 : 0));
    };
    leg(from, u, [], 0, 1);
    for (const sd of sides) leg(from, sd, [], 10, 1.25);
    for (const d of [30, 60, 100]) {
      const p = add(from, mul(u, d)); if (!clearLine(from, add(p, mul(u, 6)))) break;
      for (const sd of sides) leg(p, sd, [from], d, 1.25);
    }
    return best as Way2 | null;
  };
  const lay = (w: Way2, r: Run) => { for (let i = 1; i < w.pts.length; i++) if (dist(w.pts[i - 1], w.pts[i]) >= 1) lanes.push({ a: w.pts[i - 1], b: w.pts[i], cls: r.cls, zone: r.zone, link: true }); };
  for (const r of runs) for (const e of [0, 1] as const) {
    if (r.joined[e]) continue;
    // straight on, straight out from the building, or on a little and then out or round the end of the building
    const w = waysOut(endPt(r, e), endDir(r, e), [r.outs[e], mul(r.outs[e], -1)], r);
    if (w) lay(w, r);
  }

  // ---- anything still cut off (a ring has no loose end) takes the shortest clear way out to the airfield proper
  const anchors = [...taxis.map(w => ({ a: w.a, b: w.b })), ...runways.map(r => ({ a: r.rw.a, b: r.rw.b }))];
  const touch = (p: { a: Pt; b: Pt }, q: { a: Pt; b: Pt }) => segsIntersect(p.a, p.b, q.a, q.b) || segDist(p.a, q.a, q.b) < 4 || segDist(p.b, q.a, q.b) < 4 || segDist(q.a, p.a, p.b) < 4 || segDist(q.b, p.a, p.b) < 4;
  for (let pass = 0; pass < 200; pass++) {   // one link a pass, until every apron is joined or nothing more can be
    // which lanes reach the drawn airfield, through each other
    const ok = lanes.map(l => anchors.some(a => touch(l, a)));
    for (let grew = true; grew;) { grew = false; for (let i = 0; i < lanes.length; i++) if (!ok[i] && lanes.some((l, j) => ok[j] && touch(lanes[i], l))) { ok[i] = grew = true; } }
    if (ok.every(Boolean)) break;
    let best: { w: Way2; r: Run } | null = null;
    for (const r of runs) {
      if (lanes.some((l, k) => l.run === r && ok[k])) continue;
      const cands: (Way2 | null)[] = [];
      for (const e of [0, 1] as const) if (!r.joined[e]) cands.push(waysOut(endPt(r, e), endDir(r, e), [r.outs[e], mul(r.outs[e], -1)], r, ok));
      const mid = r.pts.length > 2 ? r.pts[Math.floor(r.pts.length / 2)] : lerpPt(r.pts[0], r.pts[1], 0.5);
      for (const [from, out] of [[r.pts[0], r.outs[0]], [r.pts[r.pts.length - 1], r.outs[1]], [mid, r.outs[2]]] as const) cands.push(waysOut(from, out, [], r, ok));
      for (const w of cands) if (w && (!best || w.cost < best.w.cost)) best = { w, r };
    }
    if (!best) break;
    const B = best as { w: Way2; r: Run };
    lay(B.w, B.r);
  }
  return { lanes: lanes.map(l => ({ a: l.a, b: l.b, cls: l.cls, zone: l.zone, link: l.link })), pads };
}

/** Which slot (on or off) is under a point, if any. */
export function slotAt(slots: GateSlot[], p: Pt): GateSlot | undefined {
  return slots.find(s => pointInPoly(p, s.cell));
}
