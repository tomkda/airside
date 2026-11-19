// World model (what the player builds) and the layout the game derives from it:
// runway designators and classes, aprons and gates, the taxiway / road / sidewalk networks,
// vertical cores, pedestrian routing, fit-out frames and the design check.
import {
  Pt, Rect, add, sub, mul, dot, dist, norm, perpLeft, lerpPt, clamp, projT, center, area,
  rectsOverlap, intersectRect, inRect, rectSegDist, rectCorners, clampToRect, segIntersection, segsIntersect, pointInPoly, deg, segDist,
} from './geom';
import { ZONES, ZoneType, Level, SITE, TUNE, MOVER, PIER, HALL, CLASSES, Cls, rwyClass, TAXI_CLASSES, ROAD_LANES, WALK, ROADS, FRONTAGE, ShopType, TenantId, SITES, GROWTH, APRON, AREA, COMMERCE as SC, CURVE_MIN } from './config';
import { autoFrontage, autoForecourt, curbCuts, autoWalks, autoRoads, trainLinks, SELF_CONNECT, AutoTag, DeckSpan, FrontGuide } from './frontage';
import { NSeg, Net, buildNet, dijkstra, allPairs, nearestNode } from './net';
import { Round, Piece, roadPieces, isRingRef, RING_REF, wayDist, waySegs, wayLen, wayMid, curveOK, roundOuter, roundDef, chordWays } from './ways';
export type { Round, Piece } from './ways';
import { gripsOf, Grip, maxTwist, curved, widthK, simplePoly, zonePts, inZone, toLocal, toWorld, overlapOf, polyCentre, zonesOverlap, centreOf, zoneBox, shaped, polyBox, polyClip, polyArea, arcOf, frameOf, bendPath, heart, maxBend, zoneParts, END_WIDTH } from './shapes';
import { buildGateAreas, GateSlot, SideGuide, SIDE_NAMES, sideName, LANE_REF, selfDepth } from './gates';
import { layoutZone, LItem } from './layout';
import { carveConcourse, carveHub, carveFree, freeRing, Budget } from './bands';
import { letLots } from './commerce';
import { Shell, Cut, shellsOf, Junction, junctionsOf, inJunction, junctionGap, outsideRuns, counters, JUNCTION } from './shell';

export interface Zone {
  id: number; type: ZoneType; level: Level; x: number; y: number; w: number; h: number; tier: 0 | 1; units?: number; cls?: Cls; leased?: number; off?: string[];
  /** v0.32: a free-drawn area (a concourse piece): its outline. x, y, w, h are its bounding box. */
  poly?: Pt[];
  /** Concourses (v0.7): walk-through duty free at the security exit, who holds each lot, and the running footfall count. */
  dutyFree?: boolean; tenants?: Record<string, TenantId>; flow?: Flow;
  /** v0.10: parking decks (1 = surface lot), and a mezzanine floor over a concourse's spine. */
  floors?: number; mezz?: boolean;
  /** v0.8: the terminal site this module belongs to. */
  site?: number;
  /** Generated, never saved: a curb grown by a road running along this terminal face (frontage.ts). */
  auto?: AutoTag;
  /** v0.17: turned about its centre by this many radians (an angled pier). x, y, w, h are its own upright frame. */
  rot?: number;
  /** v0.20: the bar is bent into an arc: its ends stay, its middle moves this far to its own south (north if negative). See shapes.ts. */
  bend?: number;
  /** v0.41: a hall, security or passport module twisted into an S (shapes.ts `halvesOf`): the angle, radians, its centreline crosses its middle at. */
  twist?: number;
  /** v0.21: the bar tapers: its east end is this much wider than its west end; `h` is the width half way along. See shapes.ts. */
  taper?: number;
  /** v0.18: a round or polygonal hall: a regular polygon of this many sides in the circle that fits the box (24+ is round). */
  sides?: number;
  /** v0.12: the id of the module stacked with this one (check-in over baggage claim): they move and go together. */
  pair?: number;
}
/** A terminal site (v0.8): land allocated with New Terminal before its modules are laid out inside it. */
export interface Site { id: number; x: number; y: number; w: number; h: number }
/** Footfall along a concourse's long axis, one entry per COMMERCE.binM: weighted passers, raw passers, and spare minutes summed. */
export interface Flow { w: number[]; n: number[]; s: number[] }
export interface Runway { id: number; a: Pt; b: Pt }
export type WayKind = 'taxi' | 'road' | 'walk';
/** v0.11: a road may curve (`c` is the control point of a quadratic curve) and may be one-way, from a to b. */
export interface Way { id: number; kind: WayKind; a: Pt; b: Pt; cls: number; lanes: number; c?: Pt; oneway?: boolean;
  /** v0.46: one of the straight chords a curved taxiway or sidewalk is used as (derived, never saved) */
  chord?: boolean;
  /** Generated, never saved (v0.12): part of a hall's own forecourt, along its face or linking it to a road. */
  fore?: 'face' | 'link' | 'ramp' | 'corner';
  /** For a ramp: the id of the frontage road whose upper deck it climbs to. */
  face?: number;
  /** v0.28: a generated deck ramp is three one-way ways in a row: the `taper` where the road widens, the speed-change
   *  `lane` that runs beside it, and the `curve` and `climb` that leave it and rise to the deck. The curve carries the
   *  ramp's shape (`rg`). */
  part?: 'taper' | 'lane' | 'curve' | 'climb'; rg?: RampGeo }
/** v0.28: one deck ramp's geometry, all on its approach road's frame. `u` runs along the approach road away from the
 *  frontage and `n` across it towards the side the ramp is on; `h` is the road's half width. T (on the road's
 *  centreline) is where the taper starts, P where the full lane begins, N the nose of the gore, where the ramp parts
 *  from the road; the curve runs from N through M to D (on the frontage road) as two quadratic pieces with control
 *  points C and C2 (v0.28: so it leaves the road soon after the nose instead of hugging it). `up`: traffic climbs it. */
export interface RampGeo { T: Pt; P: Pt; N: Pt; C: Pt; M: Pt; C2: Pt; D: Pt; u: Pt; n: Pt; h: number; up: boolean }
export interface World { zones: Zone[]; runways: Runway[]; ways: Way[]; nextId: number; sites?: Site[]; rounds?: Round[];
  /** v0.32: cut-outs: polygons taken away from the buildings they are drawn over. */
  cuts?: Cut[] }

export const newWorld = (): World => ({ zones: [], runways: [], ways: [], nextId: 1, sites: [], rounds: [], cuts: [] });

/** Bring older saves up to date. */
/** v0.36: how far a walk keeps off the edge of a cut-out, and how far out the corners it turns at are (m). */
const SKIRT = { clear: -0.5, off: 3 };   // (clear: the walls a walk may not cross are the cut-out's own, half a metre in)
export function migrateWorld(w: World): World {
  // v0.32: free-drawn areas and cut-outs. An outline that is not a simple polygon is dropped (an area becomes its box).
  w.cuts = (w.cuts ?? []).filter(k => Array.isArray(k.pts) && k.pts.length >= 3 && simplePoly(k.pts));
  for (const z of w.zones) if (z.poly && !(z.type === 'concourse' && z.poly.length >= 3 && simplePoly(z.poly))) delete z.poly;
  // v0.6: separate gate areas and concourses become one concourse type.
  for (const z of w.zones) if ((z.type as string) === 'gates') { z.type = 'concourse'; z.leased = undefined; }
  // v0.7: concourses gain tenants, footfall and a duty-free toggle. Older saves start with none; tenants then bid
  // from the plan's structure until footfall builds up. Drop anything malformed.
  for (const z of w.zones) {
    if (z.type !== 'concourse') { delete z.dutyFree; delete z.tenants; delete z.flow; continue; }
    z.dutyFree = !!z.dutyFree;
    if (z.tenants && typeof z.tenants !== 'object') delete z.tenants;
    const f = z.flow;
    if (f && !(Array.isArray(f.w) && Array.isArray(f.n) && Array.isArray(f.s) && f.w.length === f.n.length && f.n.length === f.s.length)) delete z.flow;
  }
  // v0.12: a hall's two halves point at each other; drop a pointer whose other half is gone.
  for (const z of w.zones) if (z.rot !== undefined && !(z.type === 'concourse' && isFinite(z.rot))) delete z.rot;   // v0.17: only concourses turn
  for (const z of w.zones) if (z.sides !== undefined && !(z.type === 'concourse' && z.sides >= 3 && z.sides <= 64)) delete z.sides;   // v0.18: or are round
  for (const z of w.zones) if (z.taper !== undefined) {   // v0.21: or taper, with both ends a width an end may be
    if (z.type !== 'concourse' || z.sides || !isFinite(z.taper)) { delete z.taper; continue; }
    const m = Math.max(0, 2 * Math.min(z.h - END_WIDTH.min, END_WIDTH.max - z.h)); z.taper = Math.max(-m, Math.min(m, z.taper)); if (Math.abs(z.taper) < 2) delete z.taper;
  }
  for (const z of w.zones) if (z.bend !== undefined) {   // v0.20: or bend, and only as far as their width allows
    if (!(z.type === 'concourse' || BENDS.has(z.type)) || z.sides || !isFinite(z.bend)) { delete z.bend; continue; }   // (v0.34: halls bend too)
    const m = maxBend(z.w, z.h + Math.abs(z.taper ?? 0) / 2); z.bend = Math.max(-m, Math.min(m, z.bend)); if (Math.abs(z.bend) < 4) delete z.bend;
  }
  for (const z of w.zones) if (z.twist !== undefined) {   // v0.41: halls, security and passport control twist into an S, as far as they can
    if (!BENDS.has(z.type) || z.sides || z.taper || z.poly || !isFinite(z.twist) || (!z.rot && !z.bend && z.h > z.w)) { delete z.twist; continue; }   // (and along its length: one standing on end is turned first)
    const m = maxTwist(z.w, z.h, z.bend); z.twist = Math.max(-m, Math.min(m, z.twist)); if (Math.abs(z.twist) < 0.03) delete z.twist;
  }

  for (const z of w.zones) if (z.pair !== undefined && !w.zones.some(q => q.id === z.pair && q.pair === z.id)) delete z.pair;
  // v0.11: roundabouts, and roads that may curve or run one way. Drop anything malformed.
  w.rounds = (Array.isArray(w.rounds) ? w.rounds : []).filter(r => r && isFinite(r.x) && isFinite(r.y) && (r.size === 0 || r.size === 1));
  for (const y of w.ways) {
    if (y.c && !(isFinite(y.c.x) && isFinite(y.c.y))) delete y.c;   // (v0.46: a taxiway or sidewalk keeps its curve too)
    if (y.oneway && y.kind !== 'road') delete y.oneway;
  }
  // v0.8: terminals live on sites. Older saves get one site around each group of touching terminal modules.
  w.zones = w.zones.filter(z => z.id > 0);
  for (const z of w.zones) delete z.auto;
  if (!Array.isArray(w.sites)) {
    w.sites = [];
    for (const g of groupModules(w.zones)) {
      const id = w.nextId++;
      w.sites.push({ id, ...padRect(bboxOf(g), SITES.pad) });
      for (const z of g) z.site = id;
    }
  }
  w.sites = w.sites.filter(st => st && isFinite(st.x) && isFinite(st.w) && st.w > 0 && st.h > 0);
  for (const z of w.zones) if (z.site !== undefined && !w.sites.some(st => st.id === z.site)) delete z.site;
  return w;
}

const TERMINAL_TYPES = new Set<ZoneType>(['checkin', 'security', 'concourse', 'claim', 'passport']);
export const isTerminalModule = (z: Zone) => TERMINAL_TYPES.has(z.type);
export const bboxOf = (zs: Rect[]): Rect => {
  const x0 = Math.min(...zs.map(z => z.x)), y0 = Math.min(...zs.map(z => z.y));
  return { x: x0, y: y0, w: Math.max(...zs.map(z => z.x + z.w)) - x0, h: Math.max(...zs.map(z => z.y + z.h)) - y0 };
};
export const padRect = (r: Rect, k: number): Rect => ({ x: r.x - k, y: r.y - k, w: r.w + 2 * k, h: r.h + 2 * k });
/** Terminal modules that touch or overlap (on any level) form one building. */
function groupModules(zones: Zone[]): Zone[][] {
  const ms = zones.filter(isTerminalModule);
  const par = ms.map((_, i) => i);
  const root = (i: number): number => (par[i] === i ? i : (par[i] = root(par[i])));
  for (let i = 0; i < ms.length; i++) for (let j = i + 1; j < ms.length; j++)
    if (rectsOverlap(padRect(ms[i], 1.5), ms[j])) par[root(i)] = root(j);
  const g = new Map<number, Zone[]>();
  ms.forEach((z, i) => g.set(root(i), [...(g.get(root(i)) ?? []), z]));
  return [...g.values()];
}

/** The site a module belongs to: its own, else the one it sits in. */
export function siteOf(world: World, z: Rect & { site?: number }): Site | undefined {
  const own = z.site !== undefined ? world.sites?.find(st => st.id === z.site) : undefined;
  if (own) return own;
  const c = center(z);
  return world.sites?.find(st => inRect(c, st));
}
/** Grow a site so it keeps SITES.pad of margin around everything assigned to it. */
export function fitSite(world: World, st: Site) {
  const mine = world.zones.filter(z => z.site === st.id);
  if (!mine.length) return;
  const r = padRect(bboxOf([st, ...mine.map(z => padRect(shaped(z) ? zoneBox(z) : z, SITES.pad))]), 0);
  st.x = r.x; st.y = r.y; st.w = r.w; st.h = r.h;
}

export interface RunwayInfo {
  rw: Runway; length: number; dir: Pt; normal: Pt; heading: number; labels: [string, string];
  cls: Cls | -1; width: number; nodes: { n: number; s: number }[]; nodeA: number; nodeB: number;
}
/** `rect` is the apron's upright bounding box; `pts` its true outline (they differ beside a turned concourse). */
/** `self`: laid by the concourse itself, with no taxiway drawn alongside (v0.19). It gives way to anything the player builds on it. */
export interface Apron { zone: Zone; rect: Rect; pts: Pt[]; outward: Pt; laneA: Pt; laneB: Pt; mouth: Pt; cls: Cls; letter: string; self?: boolean }
export interface Gate {
  id: string; key: string; num: string; zone: Zone; apron: Apron; cls: Cls; door: Pt; stand: Pt; front: Pt; ang: number;
  /** The way this stand faces away from the building. On a curved wall each stand has its own (v0.20). */
  outward: Pt;
  frontNode: number; rwys: Set<number>[];          // runways that reach this gate, per aircraft class
}
export interface Core { x: number; y: number; frontage: boolean }
export interface Issue { level: 'error' | 'warn' | 'info'; text: string; zoneId?: number; runwayId?: number }
export interface MissingLink { a: Pt; b: Pt; text: string }
export interface Units { max: number; count: number; /** v0.31: food-court counters of a concourse, let in step with its own lots */ courts?: number }
/** Orientation of a zone's fit-out: the entry edge faces the upstream module. */
export interface Frame { a: Pt; b: Pt; along: Pt; inward: Pt; edgeLen: number; depth: number; slots: Pt[]; items: LItem[] }
export interface PNode { p: Pt; level: Level; zones: number[] }
export interface Route { pts: Pt[]; lvs: Level[]; len: number }
export interface Crosswalk { p: Pt; ang: number; width: number }
export interface TaxiLabel { text: string; p: Pt; ang: number }
/** A commercial lot carved from a concourse: what it is, how big, and how many customers it holds. */
export interface Shop {
  zone: Zone; i: number; pts: Pt[]; door: Pt; type: ShopType; kind: string; area: number; cap: number; window: boolean; rank: number;
  /** key: stable within the concourse while the lot keeps its place (side + frontage). id: zone id + key, unique overall. */
  key: string; id: string;
  side: 'A' | 'B' | 'E'; u0: number; u1: number; depth: number; frontage: number;
  tenant: TenantId;
  /** v0.26: the lot fronts a space the building keeps for itself (within `COMMERCE.plazaReach` of it). */
  plaza?: 'hall' | 'food' | 'garden';
  /** v0.31: a counter round a food court or hall (not a lot of the piece's own plan): it serves the space's shared seating. */
  court?: boolean;
  // scores, 0–1 unless noted
  vis: number;              // how much of the spine sees the shopfront
  near: number;             // closeness to the security exit
  far: number;              // distance along the pier from the security exit
  gates: number;            // seats of the gates within reach (raw; normalised per concourse into gateScore)
  gateScore: number;
  prior: number;            // structural footfall estimate: passengers a day whose way to the gate passes the lot
  foot: number;             // weighted passers a day (measured once the sim has counted, else the prior)
  dwell: number;            // average spare minutes of those passers
  measured: boolean;
  footScore: number; dwellScore: number;
  bids: Partial<Record<TenantId, number>>; bid: number; rent: number;   // rent: minimum guarantee, $ per day
}
export interface Terminal {
  id: number; name: string; zones: Zone[]; active: boolean; problems: string[]; bbox: Rect;
  gateAreas: number; gates: number; shops: number;
  site?: Site;
  /** v0.10: has passport control between a concourse and bag claim, so it can take international flights. */
  intl: boolean;
}

export interface Derived {
  runways: RunwayInfo[]; aprons: Apron[]; gates: Gate[];
  /** v0.23: each building's airside as one rounded outline (shell.ts), and which shell a concourse piece belongs to. */
  shells: Shell[]; shellOf: Map<number, Shell>;
  /** v0.25: the spaces a building of several pieces keeps for itself (halls, food courts, gardens, courtyards). */
  junctions: Junction[];
  /** v0.19: paving in the corners where self-laid aprons on neighbouring faces meet. */
  pads: Pt[][];
  air: Net; airExtra: { a: Pt; b: Pt; cls: number }[]; taxiLabels: TaxiLabel[]; taxiLetter: Map<number, string>;
  hotspots: Pt[]; cores: Core[]; ped: PNode[];
  road: Net; hwyEnds: number[]; attach: Map<number, number[]>; roadOK: Set<number>; crosswalks: Crosswalk[];
  units: Map<number, Units>; frames: Map<number, Frame>; issues: Issue[]; links: MissingLink[];
  shops: Map<number, Shop[]>; terminals: Terminal[]; termOf: Map<number, Terminal>; gateLetter: Map<number, string>;
  gateSlots: GateSlot[]; gateGuides: SideGuide[];
  lease: Map<number, Units>; budgets: Map<number, Budget>;
  longest: number; maxCls: number; coverage: number;
  /** v0.8: every zone, including curbs grown along roads; upper road decks; road guides along terminal faces. */
  zones: Zone[]; decks: DeckSpan[]; frontGuides: FrontGuide[];
  /** v0.9: sidewalks parking lots laid for themselves (generated, never saved). */
  autoWalks: Way[];
  /** v0.10: access drives facilities laid for themselves; the AirTrain's guideway; facilities that work (road and a way in on foot). */
  /** v0.11: every road as straight pieces (curves in chords, roundabout rings included), and the roundabouts. */
  roadPieces: Piece[]; rounds: Round[];
  /** v0.13: road ids that are ramps up to a departures deck. Only cars bound for or leaving that deck use them. */
  rampRefs: Set<number>;
  /** `apm`: an airside people mover between two concourses (v0.16), with the ids of the zones it joins. */
  /** v0.44: `land`: a landside people mover, from a remote building's security to a check-in hall. v0.45: `line`, the
   *  line it is part of (movers sharing stations), how many `stations` that line has, and whether it is a `loop`. */
  /** v0.46: every taxiway and sidewalk drawn, curved ones as their chords: what the renderers draw them from. */
  wayPieces: Way[];
  autoRoads: Way[]; trainLinks: { a: Pt; b: Pt; apm?: boolean; land?: boolean; from?: number; to?: number; line?: number; stations?: number; loop?: boolean }[]; served: Set<number>;
  isTrainNode(p: Pt): boolean;
  zoneAt(p: Pt, lv: Level): Zone | undefined;
  pedRoute(p: Pt, lv: Level, q: Pt, lvq: Level): Route | null;
  /** v0.36: is this point inside a cut-out that takes floor from a building, on this level? */
  inCut(p: Pt, lv: Level): boolean;
  zoneReach(a: number, b: number): boolean;
  gateUsable(g: Gate, c: number): boolean;
}

// ------------------------------------------------------------ naming, sizes, costs
export const headingOf = (a: Pt, b: Pt) => (deg(Math.atan2(b.x - a.x, -(b.y - a.y))) + 360) % 360;
const num = (h: number) => String(((Math.round(h / 10) + 35) % 36) + 1).padStart(2, '0');
export const designators = (a: Pt, b: Pt) => { const h = headingOf(a, b); return `${num(h)}/${num(h + 180)}`; };

export const runwayWidth = (len: number) => { const c = rwyClass(len); return c >= 0 ? CLASSES[c].rwyWidth : 30; };
export const runwayCost = (a: Pt, b: Pt) => { const L = dist(a, b); return L * runwayWidth(L) * TUNE.runwayCostPerM2; };
export const wayWidth = (kind: WayKind, cls: number, lanes: number) =>
  kind === 'taxi' ? (cls >= 3 ? TAXI_CLASSES[1].width : TAXI_CLASSES[0].width)
    : kind === 'road' ? (lanes >= 4 ? ROAD_LANES[1].width : ROAD_LANES[0].width) : WALK.width;
export const wayCostPerM = (kind: WayKind, cls: number, lanes: number) =>
  kind === 'taxi' ? (cls >= 3 ? TAXI_CLASSES[1].costPerM : TAXI_CLASSES[0].costPerM)
    : kind === 'road' ? (lanes >= 4 ? ROAD_LANES[1].costPerM : ROAD_LANES[0].costPerM) : WALK.costPerM;
export const wayName = (k: WayKind) => (k === 'taxi' ? 'Taxiway' : k === 'road' ? 'Road' : 'Sidewalk');
export const zoneCls = (z: Zone): Cls => (z.cls ?? 2) as Cls;
export const rwyClassLabel = (len: number) => { const c = rwyClass(len); return c < 0 ? 'too short for airline service' : `up to ${CLASSES[c].example}`; };

function runwayInfos(world: World): RunwayInfo[] {
  const infos: RunwayInfo[] = world.runways.map(rw => {
    const d = sub(rw.b, rw.a); const length = Math.hypot(d.x, d.y); const dir = norm(d);
    const heading = headingOf(rw.a, rw.b);
    return {
      rw, length, dir, normal: perpLeft(dir), heading, labels: [num(heading), num(heading + 180)] as [string, string],
      cls: rwyClass(length), width: runwayWidth(length), nodes: [], nodeA: -1, nodeB: -1,
    };
  });
  // Parallel suffixes L / C / R, by offset to the left of the a->b direction.
  const groups = new Map<string, RunwayInfo[]>();
  for (const r of infos) { const key = [r.labels[0], r.labels[1]].sort().join('/'); groups.set(key, [...(groups.get(key) ?? []), r]); }
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const ref = g[0];
    const sorted = [...g].sort((p, q) => dot(lerpPt(q.rw.a, q.rw.b, .5), ref.normal) - dot(lerpPt(p.rw.a, p.rw.b, .5), ref.normal));
    const suf = g.length === 2 ? ['L', 'R'] : g.length === 3 ? ['L', 'C', 'R'] : sorted.map((_, i) => String(i + 1));
    sorted.forEach((r, i) => {
      const flip = dot(r.dir, ref.dir) < 0;
      const sa = flip ? suf[sorted.length - 1 - i] : suf[i];
      const sb = suf[sorted.length - 1 - suf.indexOf(sa)];
      r.labels = [r.labels[0] + sa, r.labels[1] + sb];
    });
  }
  return infos;
}

// ------------------------------------------------------------ unit counts (procedural fit-out)
export function maxUnits(z: Zone, gatesOnZone = 0): number {
  const a = area(z);
  switch (z.type) {
    case 'checkin': return Math.max(1, Math.floor(a / ZONES.checkin.m2PerUnit));
    case 'security': return Math.max(1, Math.floor(a / ZONES.security.m2PerUnit));
    case 'claim': return Math.max(1, Math.floor(a / ZONES.claim.m2PerUnit));
    case 'parking': return Math.max(1, Math.floor(a / ZONES.parking.m2PerUnit)) * clamp(z.floors ?? 1, 1, GROWTH.maxDecks);
    case 'passport': return Math.max(1, Math.floor(a / ZONES.passport.m2PerUnit));
    case 'rideshare': return Math.max(2, Math.floor(a / ZONES.rideshare.m2PerUnit));
    case 'rental': return Math.max(4, Math.floor(a / ZONES.rental.m2PerUnit));
    case 'bus': return Math.max(1, Math.floor(Math.max(z.w, z.h) / 14));
    case 'hotel': return Math.floor((a * GROWTH.hotelFloors) / GROWTH.roomM2 * (z.tier ? 1.15 : 1));
    case 'train': return z.tier ? 4 : 2;
    case 'curb': return Math.max(2, Math.floor(Math.max(z.w, z.h) / 9) * 2);
    case 'concourse': return gatesOnZone;
  }
}

// ------------------------------------------------------------ placement rules
export interface PlaceCheck { ok: boolean; reason?: string }
const inset = (r: Rect, k: number): Rect => ({ x: r.x + k, y: r.y + k, w: Math.max(0, r.w - 2 * k), h: Math.max(0, r.h - 2 * k) });

export function inBuildable(r: Rect): boolean {
  const b = SITE.buildable;
  if (r.x < b.x || r.y < b.y || r.x + r.w > b.x + b.w || r.y + r.h > b.y + b.h) return false;
  const pts = [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x, y: r.y + r.h }, { x: r.x + r.w, y: r.y + r.h }, center(r)];
  return !pts.some(p => pointInPoly(p, SITE.lake));
}
function segOnLand(a: Pt, b: Pt, box: Rect) {
  for (let i = 0; i <= 10; i++) {
    const p = lerpPt(a, b, i / 10);
    if (!inRect(p, box) || pointInPoly(p, SITE.lake)) return false;
  }
  return true;
}

export function canPlaceZone(world: World, r: Rect, type: ZoneType, level: Level, ignoreId = -1, aprons: Apron[] = []): PlaceCheck {
  const def = ZONES[type];
  if (def.groundOnly && level !== 0) return { ok: false, reason: `${def.short} must be on Ground` };
  if (r.w < def.minW && r.h < def.minW) return { ok: false, reason: `Too small: at least ${def.minW} m on one side` };
  if (Math.min(r.w, r.h) < Math.min(def.minH, def.minW)) return { ok: false, reason: `Too narrow: at least ${Math.min(def.minH, def.minW)} m` };
  if (!inBuildable(r)) return { ok: false, reason: 'Outside the site boundary or in the lake' };
  for (const rw of world.runways) if (rectSegDist(r, rw.a, rw.b) < TUNE.runwayClear) return { ok: false, reason: 'Inside the runway safety strip (150 m)' };
  for (const z of world.zones) {
    if (z.id === ignoreId || !(shaped(z) ? zonesOverlap(r, z) : rectsOverlap(r, z))) continue;
    if (z.level === level) return { ok: false, reason: `Overlaps ${ZONES[z.type].short} on this level` };
    if (level === 1 && z.type === 'parking') return { ok: false, reason: 'Cannot build over a surface lot' };
  }
  for (const a of aprons) if (!a.self && a.zone.id !== ignoreId && rectsOverlap(r, a.rect)) return { ok: false, reason: 'Overlaps an apron' };
  const ins = inset(r, 2);
  for (const w of world.ways) {
    if (w.kind !== 'taxi' && level === 1) continue;                    // upper floors can bridge roads and sidewalks
    if (waySegs(w).some(([a, b]) => rectSegDist(ins, a, b) === 0)) return { ok: false, reason: `Crosses a ${wayName(w.kind).toLowerCase()}` };
  }
  if (level === 0) for (const rd of world.rounds ?? []) if (rectSegDist(r, rd, rd) < roundOuter(rd) - 1) return { ok: false, reason: 'Overlaps a roundabout' };
  return { ok: true };
}

export function canPlaceRunway(world: World, a: Pt, b: Pt, ignoreId = -1): PlaceCheck {
  const L = dist(a, b);
  if (L < TUNE.minRunway) return { ok: false, reason: `Runway too short (min ${TUNE.minRunway.toLocaleString()} m)` };
  for (const p of [a, b]) if (!inRect(p, SITE.buildable, -40) || pointInPoly(p, SITE.lake)) return { ok: false, reason: 'Runway ends must be on the site, out of the lake' };
  for (const z of world.zones) if (rectSegDist(zoneBox(z), a, b) < TUNE.runwayClear) return { ok: false, reason: `Too close to ${ZONES[z.type].short} (150 m strip)` };
  const half = runwayWidth(L) / 2 + 60;
  for (const w of world.ways) if (w.kind !== 'taxi' && waySegs(w).some(([p, q]) => segsIntersect(a, b, p, q) || segDist(p, a, b) < half || segDist(q, a, b) < half))
    return { ok: false, reason: `A ${wayName(w.kind).toLowerCase()} is in the runway strip` };
  const d = norm(sub(b, a));
  for (const rw of world.runways) {
    if (rw.id === ignoreId) continue;
    const d2 = norm(sub(rw.b, rw.a));
    if (Math.abs(dot(d, d2)) > 0.996) {
      const sep = Math.abs(dot(sub(a, rw.a), perpLeft(d2)));
      if (sep < 210) return { ok: false, reason: `Parallel runways need 210 m+ spacing (now ${Math.round(sep)} m)` };
    }
  }
  return { ok: true };
}

/** v0.46: a taxiway or sidewalk `w` has just been bent from `old` (its ends fixed): the ends of the others of its kind
 *  that joined it part way along (a taxiway's exits) move to the nearest point of the new curve, so they still join. */
export function followBend(world: World, w: Way, old: { a: Pt; b: Pt; c?: Pt }, roads = false) {
  if (w.kind === 'road' && !roads) return;   // (v0.52: a road moved whole takes the roads that meet it part way along)
  const segs = waySegs(w);
  for (const o of world.ways) if (o !== w && o.kind === w.kind) for (const end of ['a', 'b'] as const) {
    const e = o[end]; if (!(wayDist(e, old) < 4 && dist(e, old.a) > 4 && dist(e, old.b) > 4)) continue;
    let best = e, bd = Infinity;
    for (const [p, q] of segs) { const t = clamp(projT(e, p, q), 0, 1); const x = lerpPt(p, q, t); const d0 = dist(x, e); if (d0 < bd) { bd = d0; best = x; } }
    o[end] = best;
  }
}
export function canPlaceWay(world: World, kind: WayKind, a: Pt, b: Pt, aprons: Apron[], c?: Pt, cls = 2): PlaceCheck {
  if (dist(a, b) < 10) return { ok: false, reason: 'Too short' };
  if (!c) return placeSeg(world, kind, a, b, aprons);
  const minR = kind === 'taxi' ? CURVE_MIN.taxi[cls] ?? CURVE_MIN.taxi[2] : kind === 'walk' ? CURVE_MIN.walk : ROADS.minRadius;
  if (!curveOK({ a, b, c }, minR)) return { ok: false, reason: `Curve too tight: ${minR} m radius at least` };
  for (const [p, q] of waySegs({ a, b, c })) { const r = placeSeg(world, kind, p, q, aprons); if (!r.ok) return r; }
  return { ok: true };
}
/**
 * v0.17: can a pier (a concourse at any angle) go here? It may overlap other concourses: that is how it joins a
 * building. It may not overlap anything else on its level, cross a taxiway, or reach into a runway strip.
 */
export function canPlacePier(world: World, z: { x: number; y: number; w: number; h: number; rot?: number; sides?: number; bend?: number; taper?: number; poly?: Pt[]; level: Level }, ignoreId = -1): PlaceCheck {
  if (z.sides && Math.min(z.w, z.h) < HALL.minDia) return { ok: false, reason: `Too small: a hall needs ${HALL.minDia} m across at least` };
  // (v0.32: a free area needs a true outline and some floor; it is not a bar, so it has no length rule)
  if (z.poly && !simplePoly(z.poly)) return { ok: false, reason: 'Its edges cross: an outline cannot cross itself' };
  if (z.poly && polyArea(z.poly) < AREA.min) return { ok: false, reason: `Too small: a free area needs ${AREA.min} m² at least` };
  if (!z.poly && Math.max(z.w, z.h) < PIER.minLen) return { ok: false, reason: `Too short: a pier needs ${PIER.minLen} m at least` };
  const pts = zonePts(z); const edges = pts.map((p, i) => [p, pts[(i + 1) % pts.length]] as const);
  for (const p of pts) if (!inRect(p, SITE.buildable) || pointInPoly(p, SITE.lake)) return { ok: false, reason: 'Outside the site boundary or in the lake' };
  for (const rw of world.runways) for (const [a, b] of edges)
    if (segsIntersect(a, b, rw.a, rw.b) || segDist(a, rw.a, rw.b) < TUNE.runwayClear || segDist(rw.a, a, b) < TUNE.runwayClear || segDist(rw.b, a, b) < TUNE.runwayClear) return { ok: false, reason: 'Inside the runway safety strip (150 m)' };
  for (const o of world.zones) {
    if (o.id === ignoreId || !zonesOverlap(z, o, 4)) continue;
    if (o.level === z.level && o.type !== 'concourse' && !(z.sides && o.type === 'security')) return { ok: false, reason: `Overlaps ${ZONES[o.type].short}: ${z.sides ? 'a hall joins concourses and security' : 'a pier joins a concourse'}, not ${ZONES[o.type].short.toLowerCase()}` };
    if (o.level !== z.level && o.type === 'parking') return { ok: false, reason: 'Cannot build over a surface lot' };
  }
  for (const w of chordWays(world.ways)) if (w.kind === 'taxi' && (inZone(w.a, z) || inZone(w.b, z) || edges.some(([a, b]) => segsIntersect(a, b, w.a, w.b)))) return { ok: false, reason: 'Crosses a taxiway' };
  for (const rd of world.rounds ?? []) if (inZone(rd, z, roundOuter(rd)) && z.level === 0) return { ok: false, reason: 'Overlaps a roundabout' };
  return { ok: true };
}
/** Does a segment pass through a turned zone (2 m inside its outline)? */
function segInZone(z: Zone, a: Pt, b: Pt): boolean {
  if (z.sides || z.bend || z.taper || z.poly || z.twist) { const pts = zonePts(z); return inZone(a, z, -2) || inZone(b, z, -2) || pts.some((p, i) => segsIntersect(a, b, p, pts[(i + 1) % pts.length])); }
  const la = toLocal(z, a), lb = toLocal(z, b);
  return rectSegDist(inset(z, 2), la, lb) === 0;
}
/** A roundabout needs clear ground: no building, apron, taxiway or runway strip under it. */
export function canPlaceRound(world: World, p: Pt, size: number, aprons: Apron[], ignoreId = -1): PlaceCheck {
  const R = roundOuter({ id: 0, x: p.x, y: p.y, size });
  const box = { x: p.x - R, y: p.y - R, w: 2 * R, h: 2 * R };
  for (const q of rectCorners(box)) if (!segOnLand(p, q, { x: 0, y: 0, w: SITE.width, h: SITE.height })) return { ok: false, reason: 'Must stay on land' };
  if (Math.abs(p.y - SITE.highwayY) < R + 14) return { ok: false, reason: 'Too close to State Route 12' };
  for (const z of world.zones) if (z.level === 0 && rectSegDist(z, p, p) < R - 1) return { ok: false, reason: `Overlaps the ${ZONES[z.type].short.toLowerCase()}` };
  for (const ap of aprons) if (!ap.self && rectSegDist(ap.rect, p, p) < R) return { ok: false, reason: 'Overlaps an apron' };
  for (const rw of world.runways) if (segDist(p, rw.a, rw.b) < runwayWidth(dist(rw.a, rw.b)) / 2 + 60 + R) return { ok: false, reason: 'Inside the runway strip' };
  for (const w of chordWays(world.ways)) if (w.kind === 'taxi' && segDist(p, w.a, w.b) < R + 10) return { ok: false, reason: 'Too close to a taxiway' };
  for (const o of world.rounds ?? []) if (o.id !== ignoreId && dist(o, p) < R + roundOuter(o) + 6) return { ok: false, reason: 'Too close to another roundabout' };
  // (v0.54: sidewalks go round a roundabout, not through it, whichever is built first)
  for (const w of chordWays(world.ways)) if (w.kind === 'walk' && segDist(p, w.a, w.b) < R - 2) return { ok: false, reason: 'A sidewalk runs through it' };
  return { ok: true };
}
function placeSeg(world: World, kind: WayKind, a: Pt, b: Pt, aprons: Apron[]): PlaceCheck {
  const box = kind === 'taxi' ? SITE.buildable : { x: 0, y: 0, w: SITE.width, h: SITE.height };
  if (!segOnLand(a, b, box)) return { ok: false, reason: kind === 'taxi' ? 'Taxiways must stay on the airport site' : 'Must stay on land' };
  if (kind === 'taxi') {
    for (const z of world.zones) if (shaped(z) ? segInZone(z, a, b) : rectSegDist(inset(z, 2), a, b) === 0) return { ok: false, reason: `Taxiways can't cross the ${ZONES[z.type].short.toLowerCase()}` };
    for (const w of world.ways) if (w.kind !== 'taxi' && waySegs(w).some(([p, q]) => segsIntersect(a, b, p, q))) return { ok: false, reason: `Taxiways can't cross a ${wayName(w.kind).toLowerCase()}` };
    for (const rd of world.rounds ?? []) if (segDist(rd, a, b) < roundOuter(rd) + 10) return { ok: false, reason: "Taxiways can't cross a roundabout" };
    return { ok: true };
  }
  const name = wayName(kind);
  for (const rw of world.runways) {
    const half = runwayWidth(dist(rw.a, rw.b)) / 2 + 60;
    if (segsIntersect(a, b, rw.a, rw.b) || segDist(a, rw.a, rw.b) < half || segDist(b, rw.a, rw.b) < half) return { ok: false, reason: `${name}s can't enter the runway strip` };
  }
  for (const w of chordWays(world.ways)) if (w.kind === 'taxi' && segsIntersect(a, b, w.a, w.b)) return { ok: false, reason: `${name}s can't cross a taxiway` };
  if (kind === 'walk') for (const rd of world.rounds ?? []) if (segDist(rd, a, b) < roundOuter(rd) - 2) return { ok: false, reason: "Sidewalks go round a roundabout, not through it" };
  for (const ap of aprons) if (!ap.self && rectSegDist(inset(ap.rect, 2), a, b) === 0) return { ok: false, reason: `${name}s can't cross an apron` };
  for (const z of world.zones) if (z.level === 0 && rectSegDist(inset(z, 2), a, b) === 0)
    return { ok: false, reason: `${name}s end at the edge of the ${ZONES[z.type].short.toLowerCase()}; they can't run through it` };
  return { ok: true };
}

/** v0.19: can this shape be swung round by its ends? A pier or satellite can: a concourse that belongs to no site. */
export const canTurn = (z: Zone) => z.type === 'concourse' && !z.sides && (z.site === undefined || !!z.rot || !!z.bend || !!z.taper);
/** v0.29: the landside modules that turn: a hall (check-in over claim), security and passport control. They keep their
 *  four edge grips (in their own frame when turned) and have a turn handle off one end, which turns them about their
 *  centre; turned back square they are upright rectangles again. */
export const TURNABLE = new Set<ZoneType>(['checkin', 'claim', 'security', 'passport']);
/** The grips a zone shows (a turned hall has no bend grip). */
export const gripsFor = (z: Zone): { grip: Grip; p: Pt }[] => {
  if (!TURNABLE.has(z.type)) return gripsOf(z, canTurn(z));
  const c = centreOf(z); const ax = z.w >= z.h; const off = 16;
  // (off the end of a bent hall's chord, where the turn measures its angle from: not a point on its arc)
  const turn = { grip: 't' as Grip, p: z.bend || z.twist ? { x: c.x + Math.cos(z.rot ?? 0) * (z.w / 2 + off), y: c.y + Math.sin(z.rot ?? 0) * (z.w / 2 + off) } : toWorld(z, ax ? { x: z.x + z.w + off, y: c.y } : { x: c.x, y: z.y + z.h + off }) };
  // v0.34: a hall (check-in over claim) also bends, by a grip in its middle, as a pier does; bent, it has a pier's
  // grips (its ends, its two long walls and its middle) but never tapers
  if (!BENDS.has(z.type)) return [...gripsOf(z, false), turn];
  // v0.41: and twists into an S, by a grip on its centreline a quarter of the way along
  const F = frameOf(z); const kq = curved(z) ? toWorld(z, { x: F.x + F.w / 4, y: F.y + F.h / 2 }) : z.rot ? toWorld(z, { x: z.x + z.w / 4, y: c.y }) : ax ? { x: z.x + z.w / 4, y: c.y } : { x: c.x, y: z.y + z.h / 4 };
  const k = { grip: 'k' as Grip, p: kq };
  if (z.bend || z.twist) return [...gripsOf(z, true).filter(g => g.grip !== 'ta' && g.grip !== 'tb'), k, turn];
  return [...gripsOf(z, false), { grip: 'm', p: c }, k, turn];
};
/** v0.34: the landside modules that bend: a hall, check-in over claim; v0.35: security and passport control too. */
export const BENDS = new Set<ZoneType>(['checkin', 'claim', 'security', 'passport']);
/** v0.29: can a turned hall, security or passport module take this shape? Like a pier, it may overlap the other
 *  terminal modules on its level (it joins them where they overlap), but not a road, a curb, a lot or another hall. */
export function canPlaceTurned(world: World, z: { x: number; y: number; w: number; h: number; rot?: number; bend?: number; twist?: number; level: Level }, type: ZoneType, ignore: number[] = [], aprons: Apron[] = []): PlaceCheck {
  const def = ZONES[type];
  if (z.w < def.minW && z.h < def.minW) return { ok: false, reason: `Too small: at least ${def.minW} m on one side` };
  if (Math.min(z.w, z.h) < def.minH) return { ok: false, reason: `Too narrow: at least ${def.minH} m deep` };
  const pts = zonePts(z); const edges = pts.map((p, i) => [p, pts[(i + 1) % pts.length]] as const);
  for (const p of pts) if (!inRect(p, SITE.buildable) || pointInPoly(p, SITE.lake)) return { ok: false, reason: 'Outside the site boundary or in the lake' };
  for (const rw of world.runways) for (const [a, b] of edges)
    if (segsIntersect(a, b, rw.a, rw.b) || segDist(a, rw.a, rw.b) < TUNE.runwayClear || segDist(rw.a, a, b) < TUNE.runwayClear || segDist(rw.b, a, b) < TUNE.runwayClear) return { ok: false, reason: 'Inside the runway safety strip' };
  for (const o of world.zones) {
    if (ignore.includes(o.id) || !zonesOverlap(z, o, 2)) continue;
    if (o.level === z.level && !TERMINAL_TYPES.has(o.type)) return { ok: false, reason: `Overlaps ${ZONES[o.type].short}` };
    if (o.level === z.level && (o.type === 'checkin' || o.type === 'claim') && (type === 'checkin' || type === 'claim')) return { ok: false, reason: 'Overlaps another hall' };
    if (o.level !== z.level && o.type === 'parking') return { ok: false, reason: 'Cannot build over a surface lot' };
  }
  // taxiways on any level, roads and roundabouts under a ground-level one
  for (const w of world.ways) if ((w.kind === 'taxi' || (w.kind === 'road' && z.level === 0)) && waySegs(w).some(([a, b]) => segInZone(z as Zone, a, b))) return { ok: false, reason: `Crosses a ${w.kind === 'taxi' ? 'taxiway' : 'road'}` };
  if (z.level === 0) for (const rd of world.rounds ?? []) if (inZone(rd, z, roundOuter(rd))) return { ok: false, reason: 'Overlaps a roundabout' };
  for (const ap of aprons) if (!ap.self && (ap.pts.some(p => inZone(p, z)) || pts.some(p => pointInPoly(p, ap.pts)) || edges.some(([a, b]) => ap.pts.some((p, i) => segsIntersect(a, b, p, ap.pts[(i + 1) % ap.pts.length]))))) return { ok: false, reason: 'Overlaps an apron' };
  return { ok: true };
}

// ------------------------------------------------------------ wind
export interface Wind { from: number; kt: number }
export function crosswind(heading: number, w: Wind) { return Math.abs(Math.sin(((w.from - heading) * Math.PI) / 180)) * w.kt; }
export function windSamples(): Wind[] {
  const out: Wind[] = [];
  for (let i = 0; i < 24; i++) for (let j = 0; j < 9; j++) {
    const from = SITE.windFrom + SITE.windSpread * Math.sin((i / 24) * Math.PI * 2) + (j - 4) * 14;
    const kt = Math.max(2, SITE.windSpeed + 9 * Math.sin((i / 24) * Math.PI * 2 + 1.3) + (j % 3 - 1) * 6);
    out.push({ from: (from + 360) % 360, kt });
  }
  return out;
}
export const runwayUsable = (r: RunwayInfo, w: Wind) => crosswind(r.heading, w) <= TUNE.crosswindLimit;

// ------------------------------------------------------------ derive the generated layout
export function derive(drawn: World): Derived {
  // (v0.46: a curved taxiway or sidewalk is its chords to everything below)
  const source: World = { ...drawn, ways: chordWays(drawn.ways) };
  // Curbs grow where roads run along terminal faces (frontage.ts). Everything below sees them as ordinary zones.
  // v0.12: first, a hall with no road along its face lays its own forecourt to the nearest road.
  const runways = runwayInfos(source);
  const fore = autoForecourt(source, buildGateAreas(source, runways, runwayWidth).aprons.map(a => a.rect), SITE.highwayY, SITE.width);
  const FR = autoFrontage(source, fore);
  const world: World = { ...source, zones: [...source.zones, ...FR.curbs] };
  const units = new Map<number, Units>();
  const issues: Issue[] = [];
  const links: MissingLink[] = [];
  const aprons: Apron[] = [];
  const gates: Gate[] = [];

  // ---- Concourse gates (see gates.ts): every side facing a parallel taxiway within reach grows gates.
  //      v0.19: and every other open face lays its own apron and taxilane, clear of the roads and sidewalks drawn or laid so far.
  //      The sidewalks and drives that lots and facilities lay for themselves are laid first, against the aprons of
  //      drawn taxiways only (as before v0.19), so the landside claims its ground and no taxilane is laid across it.
  const rects1 = buildGateAreas(world, runways, runwayWidth).aprons.map(a => a.rect);
  const laid = autoWalks(world, world.zones, rects1);
  const laidDrives = autoRoads(world, world.zones, rects1, SITE.highwayY, SITE.width, GROWTH.autoRoadReach, fore);
  const keep: { a: Pt; b: Pt }[] = [];
  for (const w of [...source.ways.filter(q => q.kind !== 'taxi'), ...fore, ...laid, ...laidDrives]) for (const [a, b] of waySegs(w)) keep.push({ a, b });
  // v0.23: one outline per building; its pieces share a gate letter and one run of gate numbers
  const shells = shellsOf(source.zones, world.cuts ?? []); const shellOf = new Map<number, Shell>(); for (const sh of shells) for (const id of sh.ids) if (!shellOf.has(id)) shellOf.set(id, sh);   // (a piece a cut-out splits is in each part; it is named by the largest)
  const group = new Map<number, number>(); shells.forEach((sh, i) => { for (const id of sh.ids) group.set(id, i); });
  const junctions = junctionsOf(shells, source.zones, z => freeRing((z as Zone).cls ?? 2));
  // (v0.32: and a building a cut-out takes from, or one with a free-drawn piece: its outline is not its pieces')
  const shellWalks = shells.filter(sh => sh.ids.length > 1 || sh.cut || sh.ids.some(id => source.zones.find(q => q.id === id)?.poly)).map(sh => ({ ids: sh.ids, outer: sh.outer, rings: sh.rings, cut: sh.cut }));
  const GA = buildGateAreas(world, runways, runwayWidth, { self: true, keep, group, walks: shellWalks });
  aprons.push(...GA.aprons); gates.push(...GA.gates);
  for (const [id, u] of GA.units) units.set(id, u);
  const gateLetter = GA.letters;

  for (const z of world.zones) if (z.type !== 'concourse') {
    const max = maxUnits(z);
    units.set(z.id, { max, count: clamp(z.units ?? max, 1, max) });
  }

  const frames = new Map<number, Frame>();

  // ---- Concourse interiors (see bands.ts): holdrooms behind the gates, a spine, commercial lots in what is left.
  const shops = new Map<number, Shop[]>();
  const budgets = new Map<number, Budget>();
  const bandItems = new Map<number, LItem[]>();
  const lease = new Map<number, Units>();
  for (const z of world.zones.filter(q => q.type === 'concourse')) {
    let C;
    // v0.32: a free-drawn area is open floor (the building's own space, planned in shell.ts): no bands, no lots of its own
    if (z.poly) {
      // (every part of the building it is in: a cut-out may have split it, and each part keeps its own plan)
      const mineSh = shells.filter(sh => sh.ids.includes(z.id)); const rs = mineSh.length ? mineSh.flatMap(sh => sh.rings) : [zonePts(z)];
      // (v0.40: and the security or passport control that opens into it, where walk-through duty free can go; touching
      //  or overlapping: carveFree finds where along its outline)
      const near = (a: Rect, b: Rect, k: number) => a.x <= b.x + b.w + k && b.x <= a.x + a.w + k && a.y <= b.y + b.h + k && b.y <= a.y + a.h + k;
      C = carveFree(z, rs, gates, world.zones.filter(o => o.id !== z.id && mineSh.some(sh => sh.ids.includes(o.id))), world.zones.filter(o => (o.type === 'security' || o.type === 'passport') && o.level === z.level && near(zoneBox(o), zoneBox(z), 2)));
    }   // (v0.33: holdrooms and lots round its walls, the hall in the middle)
    else if (z.sides) C = carveHub(z, world, gates);   // a hall is carved where it stands: a ring of lots round an atrium
    else if (z.rot || z.bend || z.taper) {
      // an angled pier is laid out in its own upright frame, then every piece is turned into place
      // (v0.19: its neighbours are brought into that frame too, as the box each one fills there, so the pier finds
      //  its entry and its windowless walls where they really are)
      // (v0.20: a bent pier too: its frame is as long as its arc, and what is laid out on it is carried onto the curve)
      const zl = { ...z, ...frameOf(z), rot: undefined, bend: undefined, taper: undefined };
      const nearParts = zoneParts({ x: z.x - 2, y: z.y - 2, w: z.w + 4, h: z.h + 4, rot: z.rot, bend: z.bend, taper: z.taper });   // the pier's outline, 2 m out
      const local: World = { ...world, zones: world.zones.map(o => {
        if (o.id === z.id) return zl;
        // only the part of a neighbour that is at the pier counts, or its box would wall off stretches it never touches;
        // one that is nowhere near is kept as a dot at its centre, for "which end faces security"
        // (a bent pier's outline is not convex, so the neighbour is clipped wedge by wedge and the pieces boxed together)
        const part = nearParts.flatMap(q => { const c0 = polyClip(zonePts(o), q); return c0.length >= 3 && polyArea(c0) > 1 ? c0 : []; }); const c = toLocal(z, heart(o));
        const box = part.length >= 3 ? polyBox(part.map(p => toLocal(z, p))) : { x: c.x - 0.5, y: c.y - 0.5, w: 1, h: 1 };
        return { ...o, ...box, rot: undefined, sides: undefined };
      }) };
      C = carveConcourse(zl, local, gates.filter(g => g.zone.id === z.id).map(g => ({ ...g, zone: zl, door: toLocal(z, g.door) })));
      // v0.42: a tapered pier is re-planned for its width at each point along it. Carried into the world, its frame is
      // scaled across by the width there; so first each point is moved across the frame so that a holdroom keeps its
      // true depth from its wall, the spine its true width about its middle, and the lots between them take up the
      // difference (deeper at the wide end, shallower at the narrow one). Where that would leave a lot under 2 m deep,
      // the layout there is scaled across as before.
      if (z.taper && C.lat) {
        const lat = C.lat; const Fw = frameOf(z).w;
        const kAt = (u: number) => Math.max(0.05, widthK(z, u / Fw));
        // (across the frame at one place along it: the band edges read at `uAt`, which way to plan decided at width
        //  `kb` (an item's narrowest, so all its corners take the same way), and the point itself carried at `k`.
        //  The spine's middle stays where it is in the frame, so the spine line never slants)
        const across = (v: number, uAt: number, k: number, kb = k) => {
          const L = lat(uAt); const c = (L.s0 + L.s1) / 2; const from = [0, L.a, L.s0, c, L.s1, L.b, L.S];
          const at = (q: number) => [0, L.a / q, c - (c - L.s0) / q, c, c + (L.s1 - c) / q, L.S - (L.S - L.b) / q, L.S];
          const tb = at(kb); const lotOK = (i: number) => from[i + 1] - from[i] < 0.5 || (tb[i + 1] - tb[i]) * kb >= 2;
          let mode = 0;
          if (!lotOK(1) || !lotOK(4) || tb.some((x, i) => i && x < tb[i - 1] - 1e-9)) {
            // (too narrow for lots: the holdrooms keep their depth, the lots go and the spine takes what is left, if
            //  that is at least 4 m; else it is all scaled across)
            const ha = L.a / kb, hb = L.S - (L.S - L.b) / kb; mode = (hb - ha) * kb < 4 || c < ha || c > hb ? 2 : 1;
          }
          if (mode === 2) return v;
          const to = at(k); if (mode === 1) { to[1] = to[2] = L.a / k; to[4] = to[5] = L.S - (L.S - L.b) / k; }
          for (let i = 0; i < 6; i++) if (v <= from[i + 1] || i === 5) { const s = from[i + 1] - from[i]; return s < 1e-9 ? to[i] : to[i] + ((v - from[i]) / s) * (to[i + 1] - to[i]); }
          return v;
        };
        // (an item, or a lot, is planned as one: its band edges read at its middle, its way decided at its narrowest;
        //  a line down the building is planned point by point)
        const remap = (pts: Pt[], whole: boolean) => {
          const uc = pts.reduce((s, p) => s + p.x, 0) / pts.length - zl.x; const kb = Math.min(...pts.map(p => kAt(p.x - zl.x)));
          return pts.map(p => { const u = p.x - zl.x; return { x: p.x, y: zl.y + across(p.y - zl.y, whole ? uc : u, kAt(u), whole ? kb : kAt(u)) }; });
        };
        // (long edges along the building are cut into 6 m pieces first: the map is not straight along it)
        const cut = (pts: Pt[], closed: boolean) => { const out: Pt[] = []; const n = pts.length; for (let i = 0; i < (closed ? n : n - 1); i++) { const a = pts[i], b = pts[(i + 1) % n]; const m = Math.max(1, Math.ceil(Math.abs(b.x - a.x) / 6)); for (let j = 0; j < m; j++) out.push({ x: a.x + ((b.x - a.x) * j) / m, y: a.y + ((b.y - a.y) * j) / m }); } if (!closed && n) out.push(pts[n - 1]); return out; };
        for (const sh of C.shops) {
          const uc = sh.pts.reduce((s, p) => s + p.x, 0) / sh.pts.length - zl.x; const kb = Math.min(...sh.pts.map(p => kAt(p.x - zl.x)));
          sh.pts = remap(sh.pts, true); sh.door = { x: sh.door.x, y: zl.y + across(sh.door.y - zl.y, uc, kAt(sh.door.x - zl.x), kb) };
        }
        for (const it of C.items) {
          const line = it.k === 'spine' || it.k === 'lane';
          // (a holdroom's edge line is planned as its holdroom is: read at its middle, not at its ends, where the run ends)
          if (it.closed || line) it.pts = remap(cut(it.pts, !!it.closed), !!it.closed || it.k === 'lane');
          else it.pts = remap(it.pts, false);
        }
      }
      // a lot keeps its four corners (the sim and the renderers count on them; a lot is short enough that its walls
      // can stay straight). Floors, and the long lines down the building, are cut into short pieces that follow a bend.
      for (const sh of C.shops) { sh.zone = z; sh.pts = sh.pts.map(p => toWorld(z, p)); sh.door = toWorld(z, sh.door); }
      // (and a lot of a tapered pier is as deep, and as big, as it really is: that is what decides who bids for it)
      if (z.taper) for (const sh of C.shops) if (sh.pts.length === 4) {
        const [p0, p1, p2, p3] = sh.pts; const fr = (dist(p0, p1) + dist(p3, p2)) / 2, dp = (dist(p0, p3) + dist(p1, p2)) / 2;
        sh.depth = dp; sh.frontage = fr; sh.area = fr * dp;
      }
      if (z.taper) C.shops = C.shops.filter(sh => sh.depth >= 1.5);   // (a lot squeezed out at a narrow end is no lot)
      if (z.taper) { C.budget.commerce = C.shops.reduce((t, sh) => t + sh.area, 0); C.budget.lots = C.shops.length; C.budget.window = C.shops.filter(sh => sh.window).length; }
      for (const it of C.items) it.pts = it.closed || it.k === 'spine' || it.k === 'lane' ? bendPath(z, it.pts, !!it.closed) : it.pts.map(p => toWorld(z, p));
    } else C = carveConcourse(z, world, gates);
    shops.set(z.id, C.shops); budgets.set(z.id, C.budget); bandItems.set(z.id, C.items);
  }
  // v0.19: where one building runs into another the floor is left open: no lot stands in the overlap, so a pier
  // drawn into a concourse has a way through instead of a row of shops across its mouth.
  for (const [id, list] of shops) {
    const z = world.zones.find(q => q.id === id)!;
    const into = world.zones.filter(o => o.id !== id && o.level === z.level && (o.type === 'concourse' || o.type === 'security') && (shaped(o) || shaped(z)) && zonesOverlap(z, o, 24));
    if (into.length) shops.set(id, list.filter(sh => !into.some(o => inZone(polyCentre(sh.pts), o))));
  }
  // v0.25: and no lot stands in a space the building keeps for itself (a junction hall, food court or garden)
  if (junctions.length) for (const [id, list] of shops) {
    const z = world.zones.find(q => q.id === id)!; const js = junctions.filter(j => j.level === z.level && j.kind !== 'court'); if (!js.length) continue;
    const kept = list.filter(sh => { const c = polyCentre(sh.pts); return !js.some(j => inJunction(c, j)); });
    // v0.26: a lot that fronts one of these spaces is seen across it, and takes its trade from it
    for (const sh of kept) {
      const c = polyCentre(sh.pts); const reach = SC.plazaReach + Math.sqrt(sh.area) / 2; const rank = { hall: 3, food: 2, garden: 1, court: 0 };
      const j = js.filter(q => junctionGap(c, q) <= reach && junctionGap(sh.door, q) <= reach).sort((a, b) => rank[b.kind] - rank[a.kind])[0];
      if (j && j.kind !== 'court') { sh.plaza = j.kind; sh.vis = clamp(sh.vis + SC.plazaVis, 0, 1); }
    }
    shops.set(id, kept);
    // and the piece's own fit-out stops at the space: no holdroom seats, counters or restrooms in it, and the lines
    // down the building (the spine, the moving walkways) break off at its edge and start again beyond it
    const items = bandItems.get(id);
    if (items) bandItems.set(id, items.flatMap(it => {
      if (it.closed || it.pts.length < 2 || (it.k !== 'spine' && it.k !== 'lane')) { const c = polyCentre(it.pts); return js.some(j => inJunction(c, j)) ? [] : [it]; }
      return outsideRuns(it.pts, js).map(pts => ({ ...it, pts }));
    }));
  }
  // v0.32: nothing stands where a cut-out has taken the floor away: lots and fit-out under it go, and the spine and
  // moving walkways stop at its edge (as at a junction space)
  const took = new Set(shells.flatMap(sh => sh.cuts ?? []));   // (only the cut-outs that took floor from a building)
  const cutJ = (world.cuts ?? []).filter(k => took.has(k.id)).map(k => ({ level: k.level, rings: [k.pts] } as unknown as Junction));
  if (cutJ.length) for (const [id, list] of shops) {
    const z = world.zones.find(q => q.id === id)!; const ks = cutJ.filter(k => k.level === z.level); if (!ks.length) continue;
    // (v0.36: and none that reaches into one, or whose door is in one: no one shops in a courtyard)
    //  (nor any that the floor the cut-out took crosses at all, however narrow: a shopper stands anywhere in a lot)
    const vs = shells.filter(q => q.level === z.level && q.voids).flatMap(q => q.voids!);
    const meets = (a: Pt[], v: Pt[]) => a.some((p, i) => v.some((q, k) => segsIntersect(p, a[(i + 1) % a.length], q, v[(k + 1) % v.length]))) || pointInPoly(polyCentre(a), v) || v.some(q => pointInPoly(q, a));
    shops.set(id, list.filter(sh => !ks.some(k => inJunction(polyCentre(sh.pts), k) || inJunction(sh.door, k) || sh.pts.some(p => inJunction(lerpPt(p, polyCentre(sh.pts), 0.05), k))) && !vs.some(v => meets(sh.pts, v))));
    const items = bandItems.get(id);
    if (items) bandItems.set(id, items.flatMap(it => {
      if (it.closed || it.pts.length < 2 || (it.k !== 'spine' && it.k !== 'lane')) { const c = polyCentre(it.pts); return ks.some(k => inJunction(c, k)) ? [] : [it]; }
      return outsideRuns(it.pts, ks).map(pts => ({ ...it, pts }));
    }));
  }
  // v0.31: a food court or hall trades. Counters round its edge (shell.ts `counters`) become lots of the piece of the
  // building they stand in, so tenants bid for them and passengers stop at them like any other lot; the way in from
  // each spine stays open. They are scored as lots fronting the space, with the footfall of the stretch they stand on.
  junctions.forEach(j => {
    if (j.kind !== 'food' && j.kind !== 'hall') return;
    const owner = world.zones.find(q => q.id === j.ids[0] && q.type === 'concourse'); if (!owner) return;
    const B = budgets.get(owner.id); const list = shops.get(owner.id); if (!B || !list) return;
    const ends: Pt[] = j.ids.flatMap(id => (bandItems.get(id) ?? []).filter(it => (it.k === 'spine' || it.k === 'lane') && it.pts.length > 1).flatMap(it => [it.pts[0], it.pts[it.pts.length - 1]]))
      .filter(p => junctionGap(p, j) < 4);
    const F = frameOf(owner); const priors = list.map(sh => sh.prior).sort((a, b) => a - b); const prior = priors.length ? priors[Math.floor(priors.length / 2)] : 0;
    // (never over a lot of the building's own plan that reaches the space's edge)
    const others = j.ids.flatMap(id => shops.get(id) ?? []).filter(sh => !sh.court);
    const bb = (q: Pt[]) => { const r = polyBox(q); return { x: r.x - 1, y: r.y - 1, w: r.w + 2, h: r.h + 2 }; }; const boxes = others.map(sh => bb(sh.pts));
    const clash = (q: Pt[]) => { const b = bb(q); return others.some((sh, i) => rectsOverlap(b, boxes[i]) && (q.some(p => pointInPoly(p, sh.pts)) || sh.pts.some(p => pointInPoly(p, q)) || pointInPoly(polyCentre(q), sh.pts) || q.some((p, i) => sh.pts.some((r, k) => segsIntersect(p, q[(i + 1) % q.length], r, sh.pts[(k + 1) % sh.pts.length]))))); };
    // (and not against a wall with stands: a gate door wants its holdroom, not a kitchen)
    const doors = gates.filter(g => j.ids.includes(g.zone.id)).map(g => g.door);
    // (v0.33: nor in front of a free area's lots, which face the space across its edge: a counter would block their shopfront)
    // (v0.38: and not in front of a free area's restroom core, which faces the space as its lots do)
    const fronts: { pts: Pt[] }[] = [...others.filter(sh => sh.zone.poly && (sh.key.startsWith('F') || sh.key === 'DF')), ...j.ids.filter(id => world.zones.find(q => q.id === id)?.poly).flatMap(id => (bandItems.get(id) ?? []).filter(it => it.k === 'wc' && it.pts.length === 4))];
    const blocks = (q: Pt[]) => {
      const c = polyCentre(q);
      return fronts.some(sh => {
        // (in the strip straight out from its shopfront, `pts[3]`–`pts[2]`, as deep as a counter and a little more)
        const a = sh.pts[3], b = sh.pts[2]; const L = dist(a, b) || 1; const t = ((c.x - a.x) * (b.x - a.x) + (c.y - a.y) * (b.y - a.y)) / (L * L);
        const nx = (a.x - sh.pts[0].x), ny = (a.y - sh.pts[0].y); const nl = Math.hypot(nx, ny) || 1; const out = ((c.x - a.x) * nx + (c.y - a.y) * ny) / nl;
        return t > -0.2 && t < 1.2 && out > -1 && out < JUNCTION.counter.depth + 4;
      });
    };
    counters(j, ends, doors).filter(c => !blocks(c.pts) && !clash(c.pts)).forEach(c => {
      // (named by the pieces it is between and where it stands in its owner's frame, so the name holds while the
      //  building is unchanged, whatever else is built: a sitting tenant and the day's takings stay with it)
      const at = toLocal(owner, polyCentre(c.pts)); const u = B.horiz ? at.x - F.x : at.y - F.y; const key = `J${[...j.ids].sort((a, b) => a - b).join('-')}@${Math.round(at.x)},${Math.round(at.y)}`;
      list.push({
        zone: owner, i: list.length, pts: c.pts, door: c.door, type: 'food', kind: '', area: c.front * c.depth, cap: 4, window: false, rank: 0,
        key, id: `${owner.id}:${key}`, court: true, side: 'E', u0: u - c.front / 2, u1: u + c.front / 2, depth: c.depth, frontage: c.front, tenant: 'grab', plaza: j.kind as 'food' | 'hall',
        vis: clamp(0.7 + SC.plazaVis, 0, 1), near: 0.5, far: 0.5, gates: 0, gateScore: 0, prior,
        foot: 0, dwell: 0, measured: false, footScore: 0, dwellScore: 0, bids: {}, bid: 0, rent: 0,
      });
    });
  });
  // ---- Tenants bid for the lots by footfall, visibility, dwell and position (see commerce.ts); best lots lease first.
  letLots(source, shops, budgets);
  for (const [id, list] of shops) {
    const z = world.zones.find(q => q.id === id)!; const n = list.filter(sh => !sh.court).length;
    const nc = list.length - n; lease.set(id, { max: n, count: n ? clamp(z.leased ?? Math.ceil(n * 0.4), 1, n) : 0, ...(nc ? { courts: nc } : {}) });
  }

  // ---- Airfield network: runways, player taxiways and gate stubs (stands join the taxiway they face).
  const taxis = world.ways.filter(w => w.kind === 'taxi');
  const airSegs: NSeg[] = [];
  const airExtra: { a: Pt; b: Pt; cls: number }[] = [];
  for (const r of runways) airSegs.push({ a: r.rw.a, b: r.rw.b, kind: 'rwy', cls: 3, ref: r.rw.id });
  for (const w of taxis) airSegs.push({ a: w.a, b: w.b, kind: 'taxi', cls: w.cls, ref: w.id });
  for (const g of gates) airSegs.push({ a: g.front, b: g.stand, kind: 'stand', cls: g.cls, ref: -1 });
  // (v0.46: from a drawn taxiway's true ends only, not from the ends of its chords along a curve)
  for (const w of drawn.ways.filter(q => q.kind === 'taxi')) for (const e of [w.a, w.b]) {
    for (const r of runways) {
      const dd = segDist(e, r.rw.a, r.rw.b);
      if (dd > 4 && dd <= r.width / 2 + 15) {
        const q = lerpPt(r.rw.a, r.rw.b, clamp(projT(e, r.rw.a, r.rw.b), 0, 1));
        airSegs.push({ a: e, b: q, kind: 'taxi', cls: w.cls, ref: w.id }); airExtra.push({ a: e, b: q, cls: w.cls });
      }
    }
  }
  // v0.19: taxilanes the concourses laid for themselves, and their links to the airfield
  GA.lanes.forEach((l, i) => { airSegs.push({ a: l.a, b: l.b, kind: 'taxi', cls: l.cls, ref: -(LANE_REF + i) }); airExtra.push({ a: l.a, b: l.b, cls: l.cls }); });
  const air = buildNet(airSegs, 4);
  for (const g of gates) g.frontNode = nearestNode(air, g.front, 5);
  for (const r of runways) {
    const set = new Set<number>();
    for (const e of air.edges) if (e.kind === 'rwy' && e.ref === r.rw.id) { set.add(e.u); set.add(e.v); }
    r.nodes = [...set].map(n => ({ n, s: clamp(projT(air.nodes[n], r.rw.a, r.rw.b), 0, 1) * r.length })).sort((p, q) => p.s - q.s);
    r.nodeA = r.nodes[0]?.n ?? -1; r.nodeB = r.nodes[r.nodes.length - 1]?.n ?? -1;
  }
  // Which runways reach which gates, for each aircraft class (taxiway width limits the big ones).
  for (const r of runways) {
    if (!r.nodes.length) continue;
    for (let c = 0; c <= 3; c++) {
      const cand = gates.filter(g => g.cls >= c && g.frontNode >= 0);
      if (!cand.length) continue;
      const dj = dijkstra(air, r.nodes.map(x => ({ n: x.n, c: 0 })), e => e.cls >= c);
      for (const g of cand) if (isFinite(dj.dist[g.frontNode])) g.rwys[c].add(r.rw.id);
    }
  }
  const gateAir = (g: Gate, c: number) => g.cls >= c && runways.some(r => r.cls >= c && g.rwys[c].has(r.rw.id));

  // ---- Taxiway letters: straight, connected runs share a letter, like an airport diagram.
  // (v0.46: one per taxiway as drawn, not per chord of a curve; where two meet, by each one's direction at that end)
  const dTaxis = drawn.ways.filter(w => w.kind === 'taxi');
  const parent = dTaxis.map((_, i) => i);
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  const endDir = (w: Way, end: 'a' | 'b') => norm(w.c ? (end === 'a' ? sub(w.c, w.a) : sub(w.b, w.c)) : sub(w.b, w.a));
  for (let i = 0; i < dTaxis.length; i++) for (let j = i + 1; j < dTaxis.length; j++) {
    const A = dTaxis[i], B = dTaxis[j];
    for (const ea of ['a', 'b'] as const) for (const eb of ['a', 'b'] as const)
      if (dist(A[ea], B[eb]) < 6 && Math.abs(dot(endDir(A, ea), endDir(B, eb))) > Math.cos((12 * Math.PI) / 180)) parent[root(i)] = root(j);
  }
  const LET = 'ABCDEFGHJKLMNPQRSTUVWYZ';
  const groupLetter = new Map<number, string>();
  const taxiLetter = new Map<number, string>();
  const taxiLabels: TaxiLabel[] = [];
  dTaxis.forEach((w, i) => {
    const r = root(i);
    if (!groupLetter.has(r)) { const k = groupLetter.size; groupLetter.set(r, k < LET.length ? LET[k] : LET[Math.floor(k / LET.length) - 1] + LET[k % LET.length]); }
    taxiLetter.set(w.id, groupLetter.get(r)!);
  });
  for (const [r, letter] of groupLetter) {
    const members = dTaxis.filter((_, i) => root(i) === r);
    const longest = members.reduce((m, w) => (wayLen(w) > wayLen(m) ? w : m));
    if (wayLen(longest) < 60) continue;
    // (at the middle of the curve, along it there: a quadratic's tangent half way is the line between its ends)
    taxiLabels.push({ text: letter, p: wayMid(longest), ang: Math.atan2(longest.b.y - longest.a.y, longest.b.x - longest.a.x) });
  }

  // ---- Hot spots: taxi routes that cross a runway, and runway intersections.
  const hotspots: Pt[] = [];
  for (const r of runways) for (const { n } of r.nodes) {
    let pos = false, neg = false;
    for (const eid of air.adj[n]) {
      const e = air.edges[eid]; if (e.kind === 'rwy') continue;
      const o = e.u === n ? e.v : e.u; const s = dot(sub(air.nodes[o], air.nodes[n]), r.normal);
      if (s > 1) pos = true; if (s < -1) neg = true;
    }
    if (pos && neg) hotspots.push(air.nodes[n]);
  }
  for (let i = 0; i < runways.length; i++) for (let j = i + 1; j < runways.length; j++) {
    const x = segIntersection(runways[i].rw.a, runways[i].rw.b, runways[j].rw.a, runways[j].rw.b);
    if (x) hotspots.push(x);
  }

  // ---- Pedestrian network: doors between touching zones, vertical cores, sidewalks.
  const zs = world.zones;
  const ped: PNode[] = [];
  const pedE: [number, number, number][] = [];
  const cores: Core[] = [];
  const vpairs: [number, number][] = [];
  const zonesAt = (p: Pt, lv: Level, tol = 0.5) => zs.filter(z => z.level === lv && inZone(p, z, tol)).map(z => z.id);
  const shared = (A: Rect, B: Rect): [Pt, Pt] | null => {
    for (const [ax, bx] of [[A.x + A.w, B.x], [B.x + B.w, A.x]]) if (Math.abs(ax - bx) <= 1) {
      const y0 = Math.max(A.y, B.y), y1 = Math.min(A.y + A.h, B.y + B.h);
      if (y1 - y0 >= 6) return [{ x: ax, y: y0 }, { x: ax, y: y1 }];
    }
    for (const [ay, by] of [[A.y + A.h, B.y], [B.y + B.h, A.y]]) if (Math.abs(ay - by) <= 1) {
      const x0 = Math.max(A.x, B.x), x1 = Math.min(A.x + A.w, B.x + B.w);
      if (x1 - x0 >= 6) return [{ x: x0, y: ay }, { x: x1, y: ay }];
    }
    return null;
  };
  const spread = (s: [Pt, Pt], max: number) => {
    const k = clamp(Math.floor(dist(s[0], s[1]) / 80), 1, max);
    return Array.from({ length: k }, (_, i) => lerpPt(s[0], s[1], (i + 0.5) / k));
  };
  const vertical = (p: Pt, up: number[], down: number[], frontage: boolean) => {
    const a = ped.push({ p, level: 1, zones: up }) - 1;
    const b = ped.push({ p, level: 0, zones: down }) - 1;
    pedE.push([a, b, 25]); vpairs.push([a, b]);
    cores.push({ x: p.x, y: p.y, frontage });
  };
  for (let i = 0; i < zs.length; i++) for (let j = i + 1; j < zs.length; j++) {
    const A = zs[i], B = zs[j];
    if (shaped(A) || shaped(B)) {
      // v0.17: shapes merge. Two turned buildings on a level that overlap are one building, joined where they
      // overlap; a turned one over a hall on the other level gets a core there.
      // v0.29: and a turned hall's curb (which overlaps its face by half a metre) has doors along it, and frontage
      // stairs up to the hall above where it runs under the departures level
      const curbPair = (A.type === 'curb' && TERMINAL_TYPES.has(B.type)) || (B.type === 'curb' && TERMINAL_TYPES.has(A.type));
      if (curbPair) {
        const ov = overlapOf(A, B, 4); if (!ov) continue;
        const bx = polyBox(ov); const long = bx.w >= bx.h; const lo = long ? bx.x : bx.y, hi = long ? bx.x + bx.w : bx.y + bx.h;
        const ends = ov.reduce((m, p) => { const k = long ? p.x : p.y; return [k <= lo + 0.5 && (!m[0] || (long ? p.y : p.x) < (long ? m[0].y : m[0].x)) ? p : m[0], k >= hi - 0.5 && (!m[1] || (long ? p.y : p.x) < (long ? m[1].y : m[1].x)) ? p : m[1]]; }, [null, null] as (Pt | null)[]);
        const sh: [Pt, Pt] = [ends[0] ?? ov[0], ends[1] ?? ov[1]];
        const cb = A.type === 'curb' ? A : B, md = A.type === 'curb' ? B : A;
        if (A.level === B.level) { for (const p of spread(sh, 4)) ped.push({ p, level: A.level, zones: [A.id, B.id] }); }
        else if (cb.level === 0) for (const p of spread(sh, 2)) vertical(p, [...new Set([md.id, ...zonesAt(p, 1)])], [...new Set([cb.id, ...zonesAt(p, 0)])], true);
        continue;
      }
      if (!TERMINAL_TYPES.has(A.type) || !TERMINAL_TYPES.has(B.type)) continue;
      const ov = overlapOf(A, B, A.level === B.level ? 24 : 256); if (!ov) continue;
      const c = polyCentre(ov);
      if (A.level === B.level) ped.push({ p: c, level: A.level, zones: [A.id, B.id] });
      else vertical(c, zonesAt(c, 1), zonesAt(c, 0), false);
      continue;
    }
    const sh = shared(A, B); if (!sh) continue;
    if (A.level === B.level) { for (const p of spread(sh, 4)) ped.push({ p, level: A.level, zones: [A.id, B.id] }); }
    else {
      const up = A.level === 1 ? A : B, dn = A.level === 1 ? B : A;
      if (dn.type === 'curb' && ZONES[up.type].terminal)
        for (const p of spread(sh, 2)) vertical(p, [...new Set([up.id, ...zonesAt(p, 1)])], [...new Set([dn.id, ...zonesAt(p, 0)])], true);
    }
  }
  for (const u of zs.filter(z => z.level === 1 && !shaped(z))) for (const l of zs.filter(z => z.level === 0 && !shaped(z) && (ZONES[z.type].terminal || z.type === 'curb'))) {
    const ir = intersectRect(u, l);
    if (!ir || ir.w < 16 || ir.h < 16) continue;
    const c = center(ir);
    if (cores.some(k => !k.frontage && Math.hypot(k.x - c.x, k.y - c.y) < 40)) continue;
    vertical(c, zonesAt(c, 1), zonesAt(c, 0), false);
  }
  // v0.9: a lot that no sidewalk reaches lays its own to the nearest curb (frontage.ts)
  // (laid above, before the self-laid aprons: `laid`)
  // v0.10: AirTrain stations join into one line; riding it is a fast edge in the pedestrian network
  const tLinks = trainLinks(zs);
  const tNode = new Map<number, number>(); const tKeys = new Set<string>();
  const tKey = (p: Pt) => `${Math.round(p.x)},${Math.round(p.y)}`;
  for (const z of zs) if (z.type === 'train') { const c = center(z); tNode.set(z.id, ped.push({ p: c, level: 0, zones: [z.id] }) - 1); tKeys.add(tKey(c)); }
  for (const l of tLinks) pedE.push([tNode.get(l.a.id)!, tNode.get(l.b.id)!, dist(center(l.a), center(l.b)) / GROWTH.trainSpeed + GROWTH.trainWait * TUNE.walkSpeed]);
  // v0.16: a concourse that touches no terminal is a satellite. It links itself to the nearest concourse that is
  // already part of a terminal (or of another linked satellite) with an airside people mover: a station in each,
  // and a fast ride between them. Generated like a forecourt, never saved.
  const movers: { a: Pt; b: Pt; from: number; to: number; land?: boolean; line?: number; stations?: number; loop?: boolean }[] = [];
  /** v0.45: the platform nodes beside mover stations: reached only from their station, never from outside. */
  const platNodes = new Set<number>();
  /** v0.44: a site whose remote building a landside people mover has linked to a hall on another site: it is part of
   *  that hall's terminal. */
  const siteJoin = new Map<number, Site>();
  {
    const mods = zs.filter(z => TERMINAL_TYPES.has(z.type));
    const par = new Map<number, number>(mods.map(z => [z.id, z.id]));
    const root = (i: number): number => { const q = par.get(i)!; return q === i ? i : (par.set(i, root(q)), par.get(i)!); };
    for (let i = 0; i < mods.length; i++) for (let j = i + 1; j < mods.length; j++) {
      const A = mods[i], B = mods[j]; const ir = A.level !== B.level && !shaped(A) && !shaped(B) ? intersectRect(A, B) : null;
      if (shaped(A) || shaped(B) ? zonesOverlap(A, B, A.level === B.level ? 24 : 256) : (A.level === B.level && shared(A, B)) || (ir && ir.w >= 16 && ir.h >= 16)) par.set(root(A.id), root(B.id));
    }
    const concs = mods.filter(z => z.type === 'concourse');
    const gap0 = (A: Rect, B: Rect) => Math.hypot(Math.max(0, A.x - (B.x + B.w), B.x - (A.x + A.w)), Math.max(0, A.y - (B.y + B.h), B.y - (A.y + A.h)));
    const gap = (A: Zone, B: Zone) => gap0(zoneBox(A), zoneBox(B));
    const inset = (z: Zone) => Math.min(12, z.w / 2 - 1, z.h / 2 - 1);
    const station = (z: Zone, to: Pt) => (z.sides ? centreOf(z) : toWorld(z, clampToRect(toLocal(z, to), frameOf(z), inset(z))));
    // v0.45: one station per module, shared by every mover that stops there, so movers that meet make one line. The
    // links are chosen first and the stations placed after: in the middle of a module two or more movers serve (as on
    // a line through several concourses), else at its end nearer the one it links to, as before.
    const pairs: { a: Zone; b: Zone; land?: boolean }[] = [];
    const link = (a: Zone, b: Zone, land?: boolean) => { pairs.push({ a, b, land }); };
    // v0.44: a landside people mover. A building with its own security and concourse but no check-in (a remote
    // concourse, screened at its own door) links itself to the nearest check-in hall within reach, before security:
    // a station in the hall and one in its security, so a passenger checks in, rides out and is screened there, and
    // an arriving one rides back to the hall and down to baggage claim. Nearest first, so each such building takes
    // the hall nearest it.
    {
      const hasT = (r: number, t: ZoneType) => mods.some(z => z.type === t && root(z.id) === r);
      // (only to a hall with no security of its own, so a terminal keeps one airside and everyone is screened where
      //  their gates are; and across sites only from one that has no check-in of its own, which then joins the hall's
      //  terminal: a remote building laid out on a New terminal site is part of the terminal it is linked to)
      const siteIds = (r: number) => new Set(mods.filter(z => root(z.id) === r).map(z => siteOf(world, z)?.id).filter((x): x is number => x !== undefined));
      const siteHasCI = (id: number) => mods.some(z => z.type === 'checkin' && siteOf(world, z)?.id === id);
      const sitesOK = (rs: number, rh: number) => { const a = siteIds(rs), b = siteIds(rh); return !a.size || !b.size || [...a].every(id => b.has(id) || !siteHasCI(id)); };
      for (let guard = 0; guard < 40; guard++) {
        let best: { s: Zone; h: Zone; d: number } | null = null;
        for (const sz of mods) if (sz.type === 'security') {
          const r = root(sz.id); if (hasT(r, 'checkin') || !hasT(r, 'concourse')) continue;
          for (const h of mods) if (h.type === 'checkin' && root(h.id) !== r && !hasT(root(h.id), 'security') && sitesOK(r, root(h.id))) { const d0 = gap(sz, h); if (d0 <= MOVER.reach && (!best || d0 < best.d || (d0 === best.d && sz.id < best.s.id))) best = { s: sz, h, d: d0 }; }
        }
        if (!best) break;
        link(best.s, best.h, true);
        { const hs = siteOf(world, best.h); if (hs) for (const id of siteIds(root(best.s.id))) if (id !== hs.id) siteJoin.set(id, hs); }
        par.set(root(best.s.id), root(best.h.id));
      }
    }
    const linked = new Set<number>(mods.filter(z => z.type === 'security').map(z => root(z.id)));
    for (let guard = 0; guard < 40; guard++) {
      let best: { s: Zone; m: Zone; d: number } | null = null;
      for (const sz of concs) if (!linked.has(root(sz.id))) for (const m of concs) if (linked.has(root(m.id))) {
        const d0 = gap(sz, m); if (d0 <= MOVER.reach && (!best || d0 < best.d || (d0 === best.d && sz.id < best.s.id))) best = { s: sz, m, d: d0 };
      }
      if (!best) break;
      link(best.s, best.m);
      linked.add(root(best.s.id));
    }
    // v0.45: lines and loops. Movers that share a station are one line. A line of three or more stations in a row whose
    // two end stations are within reach of each other closes into a loop. Riding it: a platform beside each station
    // (getting on and off costs the wait less one stop, half each way), and a run between neighbouring platforms that
    // costs the ride and one stop; so a ride costs one wait and a stop at each station passed, and the rider follows
    // the line through them, not a chord across.
    const stns = new Map<number, { z: Zone; p: Pt; n: number }>();
    {
      const deg = new Map<number, number>(); for (const q of pairs) for (const z of [q.a, q.b]) deg.set(z.id, (deg.get(z.id) ?? 0) + 1);
      const place = (z: Zone, p: Pt) => { const s = { z, p, n: ped.push({ p, level: z.level, zones: [z.id] }) - 1 }; stns.set(z.id, s); tKeys.add(tKey(p)); return s; };
      // (a middle station keeps off the floor a cut-out took, and 6 m clear of it: along the centreline from the
      //  middle, the nearest point clear; else at the end nearer its partner, as a single mover's is)
      const inVoid = (p: Pt, lv: number) => shells.some(sh => sh.level === lv && sh.voids?.some(v => [p, { x: p.x + 6, y: p.y }, { x: p.x - 6, y: p.y }, { x: p.x, y: p.y + 6 }, { x: p.x, y: p.y - 6 }].some(q => pointInPoly(q, v))));
      const middle = (z: Zone, to: Pt) => {
        const m0 = z.sides ? centreOf(z) : heart(z); if (!inVoid(m0, z.level)) return m0;
        if (!z.sides && !z.poly) { const F = frameOf(z); const cy = F.y + F.h / 2; for (let k = 6; k < F.w / 2 - inset(z); k += 6) for (const x of [F.x + F.w / 2 - k, F.x + F.w / 2 + k]) { const q = toWorld(z, { x, y: cy }); if (!inVoid(q, z.level)) return q; } }
        return station(z, to);
      };
      const stationOf = (z: Zone, to: Pt) => stns.get(z.id) ?? place(z, deg.get(z.id)! >= 2 ? middle(z, to) : station(z, to));
      for (const q of pairs) {
        const sa = stationOf(q.a, stns.get(q.b.id)?.p ?? heart(q.b)), sb = stationOf(q.b, sa.p);
        vpairs.push([sa.n, sb.n]); movers.push({ a: sa.p, b: sb.p, from: q.a.id, to: q.b.id, ...(q.land ? { land: true } : {}) });
      }
    }
    {
      const adj = new Map<number, Set<number>>(); const add = (a: number, b: number) => { adj.set(a, (adj.get(a) ?? new Set()).add(b)); adj.set(b, (adj.get(b) ?? new Set()).add(a)); };
      for (const m of movers) add(m.from, m.to);
      const seen = new Set<number>(); let line = 0;
      for (const id0 of [...adj.keys()].sort((p, q) => p - q)) {
        if (seen.has(id0)) continue;
        const comp: number[] = []; const st = [id0]; seen.add(id0);
        while (st.length) { const u = st.pop()!; comp.push(u); for (const v of adj.get(u)!) if (!seen.has(v)) { seen.add(v); st.push(v); } }
        const ends = comp.filter(u => adj.get(u)!.size === 1);
        const path = comp.length >= 3 && ends.length === 2 && comp.every(u => adj.get(u)!.size <= 2);
        const za = path ? stns.get(ends[0])!.z : null, zb = path ? stns.get(ends[1])!.z : null;
        const own = movers.filter(m => comp.includes(m.from));
        // (only where it shortens the way round: a closing run less than 80% of the line, so stations in a row never loop)
        const runL = own.reduce((t, m) => t + dist(m.a, m.b), 0);
        if (za && zb && gap(za, zb) <= MOVER.reach && !own.some(m => m.land) && dist(stns.get(za.id)!.p, stns.get(zb.id)!.p) < 0.8 * runL) {
          const sa = stns.get(za.id)!, sb = stns.get(zb.id)!; vpairs.push([sa.n, sb.n]);
          movers.push({ a: sa.p, b: sb.p, from: za.id, to: zb.id, loop: true }); add(za.id, zb.id);
        }
        for (const m of movers) if (comp.includes(m.from)) { m.line = line; m.stations = comp.length; if (za && zb && comp.length >= 3 && movers.some(q => q.loop && comp.includes(q.from))) m.loop = true; }
        line++;
      }
      const plat = new Map<number, number>();
      for (const [id, s] of stns) { const q = ped.push({ p: s.p, level: s.z.level, zones: [] }) - 1; plat.set(id, q); platNodes.add(q); pedE.push([s.n, q, ((MOVER.wait - MOVER.dwell) * TUNE.walkSpeed) / 2]); }
      for (const m of movers) pedE.push([plat.get(m.from)!, plat.get(m.to)!, dist(m.a, m.b) / MOVER.speed + MOVER.dwell * TUNE.walkSpeed]);
    }
  }
  const walks = [...world.ways.filter(w => w.kind === 'walk'), ...laid];
  const walkNet = buildNet(walks.map(w => ({ a: w.a, b: w.b, kind: 'walk', cls: 0, ref: w.id })), 4);
  const wOff = ped.length;
  for (const p of walkNet.nodes) ped.push({ p, level: 0, zones: zs.filter(z => z.level === 0 && inRect(p, z, 3)).map(z => z.id) });
  for (const e of walkNet.edges) pedE.push([wOff + e.u, wOff + e.v, e.len]);
  const byZone = new Map<number, number[]>();
  ped.forEach((n, i) => { for (const z of n.zones) byZone.set(z, [...(byZone.get(z) ?? []), i]); });
  for (const ns of byZone.values()) for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++)
    pedE.push([ns[i], ns[j], dist(ped[ns[i]].p, ped[ns[j]].p)]);
  const N = ped.length;
  const { D, nxt } = allPairs(N, pedE);

  const zoneAt = (p: Pt, lv: Level) => zs.find(z => z.level === lv && inZone(p, z, 0.5));
  const zoneReach = (a: number, b: number) => {
    if (a === b) return true;
    const A = byZone.get(a) ?? [], B = byZone.get(b) ?? [];
    for (const i of A) for (const j of B) if (D[i * N + j] < Infinity) return true;
    return false;
  };
  const nearPed = (p: Pt, lv: Level) => {
    const out: { n: number; c: number }[] = [];
    ped.forEach((q, i) => { if (q.level === lv && !platNodes.has(i)) { const d0 = dist(p, q.p); if (d0 < 120) out.push({ n: i, c: d0 }); } });
    return out.sort((a, b) => a.c - b.c).slice(0, 4);
  };
  // v0.20: inside a bent pier a straight line from one point to another can leave the building. Wherever two
  // points of a route in a row are in the same bent pier, the walk between them is laid along its centreline.
  const bent = zs.filter(z => curved(z));   // (v0.41: and an S)
  const thread = (from: Pt, lv0: Level, r: Route): Route => {
    if (!bent.length) return r;
    const pts: Pt[] = [], lvs: Level[] = []; let a = from, la = lv0; let extra = 0;
    for (let i = 0; i < r.pts.length; i++) {
      const b = r.pts[i], lb = r.lvs[i];
      const z = la === lb ? bent.find(q => q.level === la && inZone(a, q, 1) && inZone(b, q, 1)) : undefined;
      if (z) {
        const ua = toLocal(z, a), ub = toLocal(z, b); const F = frameOf(z); const k = Math.floor(Math.abs(ub.x - ua.x) / 24);
        // drift to the centreline over the first and last stretch, and keep to it in between
        let prev = a, walked = 0;
        for (let j = 1; j <= k; j++) { const t = j / (k + 1); const w = Math.min(1, t * (k + 1) / 2, (1 - t) * (k + 1) / 2); const y0 = ua.y + (ub.y - ua.y) * t; const q = toWorld(z, { x: ua.x + (ub.x - ua.x) * t, y: y0 + (F.y + F.h / 2 - y0) * w }); pts.push(q); lvs.push(lb); walked += dist(prev, q); prev = q; }
        if (k) extra += walked + dist(prev, b) - dist(a, b);   // the walk round the bend is longer than the chord the route was costed on
      }
      pts.push(b); lvs.push(lb); a = b; la = lb;
    }
    return { pts, lvs, len: r.len + extra };
  };
  // v0.36: and no one walks across a courtyard or a notch. A leg that crosses the floor a cut-out took away (a shell's
  // `voids`, not the cut-out as drawn: rounding the outline again fills a narrow one back and takes thin strips beside
  // it) goes round it instead, by the shortest way past the corners of every void on that level (set `SKIRT.off` out
  // and kept where they stand on the floor), never leaving the floor: a visibility graph searched with Dijkstra.
  const voidsSeen = new Set<Pt[][]>(); const voidList: { level: number; pts: Pt[] }[] = [];
  for (const sh of shells) if (sh.voids && !voidsSeen.has(sh.voids)) { voidsSeen.add(sh.voids); for (const v of sh.voids) voidList.push({ level: sh.level, pts: v }); }
  // (floor: a building's shell, or any other module or curb on that level: a door into security is on floor)
  const otherFloor = zs.filter(z => z.type !== 'concourse' && (ZONES[z.type].terminal || z.type === 'curb'));
  const onFloor = (p: Pt, lv: number) => shells.some(sh => sh.level === lv && sh.rings.reduce((t, r) => t + (pointInPoly(p, r) ? 1 : 0), 0) % 2 === 1) || otherFloor.some(z => z.level === lv && inZone(p, z));
  const skirtCuts = voidList.map(k => {
    const n = k.pts.length; const ccw = k.pts.reduce((t, p, i) => t + (p.x * k.pts[(i + 1) % n].y - k.pts[(i + 1) % n].x * p.y), 0) > 0;
    const grow = (d: number) => k.pts.map((p, i) => {
      // each corner moved out along its bisector, far enough that both its walls are `d` clear
      const a = k.pts[(i + n - 1) % n], b = k.pts[(i + 1) % n]; const e0 = norm(sub(p, a)), e1 = norm(sub(b, p));
      const out = (e: Pt) => (ccw ? { x: e.y, y: -e.x } : { x: -e.y, y: e.x });
      const m = norm(add(out(e0), out(e1))); const c = Math.max(0.35, dot(m, out(e0))); return add(p, mul(m, d / c));
    });
    return { level: k.level, pts: k.pts, wall: grow(SKIRT.clear), nodes: grow(SKIRT.off).filter(p => onFloor(p, k.level)) };
  });
  const crosses = (a: Pt, b: Pt, poly: Pt[]) => pointInPoly(lerpPt(a, b, 0.5), poly) || pointInPoly(a, poly) || pointInPoly(b, poly) || poly.some((p, i) => segsIntersect(a, b, p, poly[(i + 1) % poly.length]));
  const inWall = (p: Pt, lv: number) => skirtCuts.find(c => c.level === lv && pointInPoly(p, c.wall));
  // (a point in a void, such as a door the void has reached, steps out to the nearest floor beside it)
  const stepOut = (p: Pt, lv: number): Pt => {
    const c = inWall(p, lv); if (!c) return p;
    let best = p, bd = Infinity;
    c.pts.forEach((u, i) => { const v = c.pts[(i + 1) % c.pts.length]; const t = Math.max(0, Math.min(1, dot(sub(p, u), sub(v, u)) / (dot(sub(v, u), sub(v, u)) || 1))); const q = lerpPt(u, v, t); const d = dist(p, q); if (d < bd) { bd = d; best = q; } });
    const away = norm(sub(best, polyCentre(c.pts))); const q = add(best, mul(away, SKIRT.off));
    return onFloor(q, lv) ? q : p;
  };
  const skirt = (from: Pt, lv0: Level, r: Route): Route | null => {
    if (!skirtCuts.length) return r;
    // (a point of the route in a void, such as a bent pier's centreline point or a door the void has reached, steps out
    //  to the floor beside it; the way round is then found from there)
    // (v0.45: a ride runs underground: its stations and platforms stay where they are, and a run between two of them
    //  is never taken round a courtyard)
    const isTrain = (p: Pt) => tKeys.has(tKey(p));
    const rp = r.pts.map((p, i) => (i < r.pts.length - 1 && !isTrain(p) ? stepOut(p, r.lvs[i]) : p)), rl = r.lvs;
    const pts: Pt[] = [], lvs: Level[] = []; let a = from, la = lv0, extra = 0;
    for (let i = 0; i < rp.length; i++) {
      const b = rp[i], lb = rl[i];
      const walls = la === lb && !(isTrain(a) && isTrain(b)) ? skirtCuts.filter(c => c.level === la) : [];
      if (walls.some(c => crosses(a, b, c.wall))) {
        const a2 = stepOut(a, la), b2 = stepOut(b, la);
        const V = [a2, b2, ...walls.flatMap(c => c.nodes)];
        // (an edge may not cross a void, nor leave the floor: on a bent pier a chord can cut across the outside)
        const ok = (u: Pt, v: Pt) => !walls.some(c => crosses(u, v, c.wall)) && [0.25, 0.5, 0.75].every(t => onFloor(lerpPt(u, v, t), la));
        const dd = V.map(() => Infinity), pv = V.map(() => -1), done = V.map(() => false); dd[0] = 0;
        for (;;) {
          let u = -1; for (let k = 0; k < V.length; k++) if (!done[k] && dd[k] < Infinity && (u < 0 || dd[k] < dd[u])) u = k;
          if (u < 0 || u === 1) break; done[u] = true;
          for (let k = 0; k < V.length; k++) if (!done[k] && k !== u) { const c = dd[u] + dist(V[u], V[k]); if (c < dd[k] && ok(V[u], V[k])) { dd[k] = c; pv[k] = u; } }
        }
        // no way round on the floor: a cut-out has cut the building in two here, and no one can walk across
        if (dd[1] === Infinity) return null;
        const via: Pt[] = []; for (let k = pv[1]; k > 0; k = pv[k]) via.unshift(V[k]);
        if (a2 !== a) { pts.push(a2); lvs.push(lb); }
        for (const q of via) { pts.push(q); lvs.push(lb); }
        if (b2 !== b) { pts.push(b2); lvs.push(lb); }
        extra += dist(a, a2) + dd[1] + dist(b2, b) - dist(a, b);
      }
      pts.push(b); lvs.push(lb); a = b; la = lb;
    }
    return extra || rp.some((p, i) => p !== r.pts[i]) ? { pts, lvs, len: r.len + extra } : r;
  };
  const pedRoute = (p: Pt, lv: Level, q: Pt, lvq: Level): Route | null => {
    const za = zoneAt(p, lv), zb = zoneAt(q, lvq);
    if (za && zb && za.id === zb.id) return skirt(p, lv, thread(p, lv, { pts: [q], lvs: [lvq], len: dist(p, q) }));   // (null if a cut-out has cut the way)
    const S = za ? (byZone.get(za.id) ?? []).map(n => ({ n, c: dist(p, ped[n].p) })) : nearPed(p, lv);
    const T = zb ? (byZone.get(zb.id) ?? []).map(n => ({ n, c: dist(q, ped[n].p) })) : nearPed(q, lvq);
    let best = Infinity, bs = -1, bt = -1;
    for (const s of S) for (const t of T) { const c = s.c + D[s.n * N + t.n] + t.c; if (c < best) { best = c; bs = s.n; bt = t.n; } }
    if (bs < 0) return null;
    const pts: Pt[] = [ped[bs].p], lvs: Level[] = [ped[bs].level];
    let i = bs, guard = 0;
    while (i !== bt && guard++ < 2000) { i = nxt[i * N + bt]; pts.push(ped[i].p); lvs.push(ped[i].level); }
    pts.push(q); lvs.push(lvq);
    return skirt(p, lv, thread(p, lv, { pts, lvs, len: best }));
  };

  // ---- Road network: the highway plus player roads; curbs and lots attach where a road ends.
  const HY = SITE.highwayY;
  // v0.10: facilities with no road at their edge lay their own access drive
  const laidRoads = [...fore, ...laidDrives];
  const roads = [...world.ways.filter(w => w.kind === 'road'), ...laidRoads];
  const roadSegs: NSeg[] = [{ a: { x: 0, y: HY }, b: { x: SITE.width, y: HY }, kind: 'hwy', cls: 0, ref: -1, lanes: 6 }];
  // v0.11: curves become chords, straight roads split where generated curbs begin and end (so cars can pull in
  // along the frontage), and every road that reaches a roundabout is cut back to its ring.
  const rounds = world.rounds ?? [];
  const pieces = roadPieces(roads, rounds, curbCuts(FR.curbs, roads));
  for (const p of pieces) if (dist(p.a, p.b) > 1) roadSegs.push({ a: p.a, b: p.b, kind: 'road', cls: 0, ref: p.ref, lanes: p.lanes, ow: p.ow });
  for (const w of roads) if (w.fore !== 'ramp') for (const e of [w.a, w.b]) {   // (v0.28: a ramp's pieces join their road, never the highway)
    const dy = Math.abs(e.y - HY);
    if (dy > 4 && dy <= 20) roadSegs.push({ a: e, b: { x: e.x, y: HY }, kind: 'road', cls: 0, ref: w.id, lanes: w.lanes });
  }
  const road = buildNet(roadSegs, 4);
  const hwyEnds = [nearestNode(road, { x: 0, y: HY }, 5), nearestNode(road, { x: SITE.width, y: HY }, 5)];
  const attach = new Map<number, number[]>();
  for (const z of zs) if (z.type === 'curb' || ROAD_SERVED.has(z.type)) {
    // generated curbs attach to the road nodes along their outer edge; drawn ones to roads that end at them
    const reach = z.auto ? z.auto.gap + 12 : 3;
    const ns: number[] = []; road.nodes.forEach((p, i) => { if ((z.rot ? inZone(p, z, reach) : inRect(p, z, reach)) && (!z.auto || road.adj[i].some(e => road.edges[e].ref === z.auto!.road))) ns.push(i); });
    attach.set(z.id, ns);
  }
  // a place is road-served when cars can drive in from the highway and back out again (one-way roads count)
  const hs = hwyEnds.filter(n => n >= 0).map(n => ({ n, c: 0 }));
  const djH = dijkstra(road, hs, undefined, undefined, 1), djBack = dijkstra(road, hs, undefined, undefined, -1);
  const roadOK = new Set<number>();
  for (const [id, ns] of attach) if (ns.some(n => isFinite(djH.dist[n])) && ns.some(n => isFinite(djBack.dist[n]))) roadOK.add(id);
  if (world.ways.some(w => w.kind === 'road' && w.oneway && [nearestNode(road, w.a, 5), nearestNode(road, w.b, 5)].some(n => n >= 0 && isFinite(djH.dist[n]) !== isFinite(djBack.dist[n]))))
    issues.push({ level: 'warn', text: 'A one-way road leads nowhere: cars can get in but not back to State Route 12, or the other way round. Close the loop, reverse it, or make it two-way.' });
  const crosswalks: Crosswalk[] = [];
  for (const w of walks) for (const r of roadSegs) {
    const x = segIntersection(w.a, w.b, r.a, r.b);
    if (x) crosswalks.push({ p: x, ang: Math.atan2(r.b.y - r.a.y, r.b.x - r.a.x), width: r.kind === 'hwy' ? 24 : isRingRef(r.ref) ? ringWidth(rounds, r.ref) : wayWidth('road', 0, r.lanes ?? 2) });
  }

  // ---- Terminals: modules joined by doors or cores form one building. A terminal goes live only when
  // check-in, security, a concourse with working gates and baggage claim all connect, with road-served curbs.
  const termTypes = TERMINAL_TYPES;
  const tParent = new Map<number, number>();
  for (const z of zs) if (termTypes.has(z.type)) tParent.set(z.id, z.id);
  const tRoot = (i: number): number => { const p = tParent.get(i)!; if (p === i) return i; const r = tRoot(p); tParent.set(i, r); return r; };
  const unite = (ids: number[]) => { const t = ids.filter(id => tParent.has(id)); for (let k = 1; k < t.length; k++) tParent.set(tRoot(t[k]), tRoot(t[0])); };
  for (let i = 0; i < wOff; i++) unite(ped[i].zones);
  for (const [a, b] of vpairs) unite([...ped[a].zones, ...ped[b].zones]);
  // v0.8: a terminal is a site and the modules on it. Modules on no site (old saves) group by touching, as before.
  const sites = world.sites ?? [];
  const groups = new Map<string, { zones: Zone[]; site?: Site }>();
  for (const st of sites) if (!siteJoin.has(st.id)) groups.set(`s${st.id}`, { zones: [], site: st });
  // a module on no site joins the site of whatever it connects to on foot
  // (v0.44: and a module on a site a landside people mover has joined to another, that other one)
  const siteFor = (z: Zone) => { const st = siteOf(world, z); return st ? siteJoin.get(st.id) ?? st : undefined; };
  const rootSite = new Map<number, Site>();
  for (const z of zs) if (tParent.has(z.id)) { const st = siteFor(z); if (st && !rootSite.has(tRoot(z.id))) rootSite.set(tRoot(z.id), st); }
  for (const z of zs) if (tParent.has(z.id)) {
    const st = siteFor(z) ?? rootSite.get(tRoot(z.id));
    const k = st ? `s${st.id}` : `c${tRoot(z.id)}`;
    const g = groups.get(k) ?? { zones: [] }; g.zones.push(z); groups.set(k, g);
  }
  const order = (g: { zones: Zone[]; site?: Site }) => g.site ? g.site.id : Math.min(...g.zones.map(z => z.id));
  const terminals: Terminal[] = [...groups.values()].sort((a, b) => order(a) - order(b)).map((g, i) => ({
    id: i + 1, name: `Terminal ${i + 1}`, zones: g.zones, active: false, problems: [], site: g.site,
    bbox: g.site ? { x: g.site.x, y: g.site.y, w: g.site.w, h: g.site.h } : bboxOf(g.zones), gateAreas: 0, gates: 0, shops: 0, intl: false,
  }));
  const termOf = new Map<number, Terminal>();
  for (const T of terminals) for (const z of T.zones) termOf.set(z.id, T);
  const roadCurbs = zs.filter(z => z.type === 'curb' && roadOK.has(z.id));
  const listOf = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
  const nearPair = (A: Zone[], B: Zone[]) => {
    let pa = A[0], pb = B[0];
    for (const a of A) for (const b of B) if (dist(center(a), center(b)) < dist(center(pa), center(pb))) { pa = a; pb = b; }
    return [pa, pb] as const;
  };
  for (const T of terminals) {
    const of = (t: ZoneType) => T.zones.filter(z => z.type === t);
    const ci = of('checkin'), sec = of('security'), ga = of('concourse'), cl = of('claim');
    const tg = gates.filter(g => T.zones.includes(g.zone));
    T.gateAreas = ga.length; T.gates = tg.length; T.shops = ga.reduce((n, z) => n + (shops.get(z.id)?.length ?? 0), 0);
    const missing: string[] = [];
    if (!T.zones.length) { T.problems.push('an empty site: open it and lay out check-in, security, a concourse and baggage claim'); T.active = false; continue; }
    if (!ci.length) missing.push('check-in'); if (!sec.length) missing.push('security');
    if (!ga.length) missing.push('a concourse'); if (!cl.length) missing.push('baggage claim');
    if (missing.length) {
      const others = terminals.filter(o => o !== T);
      T.problems.push(`needs ${listOf(missing)}${others.length ? `: connect it to another terminal or build them touching it${ga.length && !sec.length ? `, or bring the concourse within ${MOVER.reach.toLocaleString()} m of a terminal's concourse for a people mover` : ga.length && sec.length && !ci.length ? `, or bring its security within ${MOVER.reach.toLocaleString()} m of a check-in hall that has no security of its own, for a landside people mover` : ''}` : ''}`);
      if (others.length) {
        const [a, b] = nearPair(T.zones, others.flatMap(o => o.zones));
        links.push({ a: center(a), b: center(b), text: 'Not connected' });
      }
    }
    const pair = (A: Zone[], B: Zone[], text: string) => {
      if (!A.length || !B.length || A.some(a => B.some(b => zoneReach(a.id, b.id)))) return;
      T.problems.push(text); const [a, b] = nearPair(A, B); links.push({ a: center(a), b: center(b), text: 'No walking route' });
    };
    pair(ci, sec, "check-in can't reach security"); pair(sec, ga, "security can't reach the concourse"); pair(ga, cl, "the concourse can't reach baggage claim");
    if (ci.length && !roadCurbs.some(c => ci.some(z => zoneReach(c.id, z.id)))) T.problems.push('no road-served curb reaches check-in');
    if (cl.length && !roadCurbs.some(c => cl.some(z => zoneReach(c.id, z.id)))) T.problems.push('no road-served curb reaches baggage claim');
    if (ga.length && !tg.length) T.problems.push('no gates: its concourse has no room for stands on any side');
    else if (tg.length && !tg.some(g => g.rwys[0].size > 0)) T.problems.push('no taxiway route from a runway to its gates');
    T.active = T.problems.length === 0;
    const pp = of('passport');
    T.intl = T.active && pp.some(q => ga.some(g => zoneReach(g.id, q.id)) && (cl.some(c => zoneReach(q.id, c.id))));
  }
  const gateUsable = (g: Gate, c: number) => gateAir(g, c) && !!termOf.get(g.zone.id)?.active;

  // ---- Interior layouts (see layout.ts). Carousels default to one per three gates in the terminal.
  for (const z of zs) {
    const T = termOf.get(z.id);
    const L = layoutZone(z, world, { items: bandItems.get(z.id), claimNeed: Math.ceil((T?.gates ?? 0) / 3) });
    frames.set(z.id, L.frame);
    if (z.type === 'checkin' || z.type === 'security' || z.type === 'passport') units.set(z.id, { max: L.max, count: clamp(z.units ?? L.max, 1, Math.max(1, L.max)) });
    if (z.type === 'claim') units.set(z.id, { max: L.max, count: L.count ?? 1 });
    if (z.type === 'curb') units.set(z.id, { max: L.max, count: L.max });
  }

  // ---- v0.10: which landside facilities work: a road where they need one, and a way on foot to an open terminal
  const served = new Set<number>();
  const entries = zs.filter(z => (z.type === 'checkin' || z.type === 'claim') && termOf.get(z.id)?.active);
  for (const z of zs) if (SELF_CONNECT.has(z.type)) {
    const needsRoad = z.type !== 'train';
    if ((!needsRoad || roadOK.has(z.id)) && entries.some(e => zoneReach(z.id, e.id))) served.add(z.id);
  }
  for (const z of zs) if (SELF_CONNECT.has(z.type) && z.type !== 'parking' && !served.has(z.id) && entries.length) {
    const noRoad = z.type !== 'train' && !roadOK.has(z.id);
    issues.push({ level: 'warn', zoneId: z.id, text: `${ZONES[z.type].label}: ${noRoad ? `no road within ${GROWTH.autoRoadReach} m to connect to` : 'no way on foot to a terminal. Move it closer, draw a sidewalk, or link it by AirTrain'}.` });
  }

  // ---- Capability
  const longest = Math.max(0, ...runways.map(r => r.length));
  const maxCls = runways.length ? Math.max(...runways.map(r => r.cls)) : -1;
  const ws = windSamples();
  const coverage = runways.length ? ws.filter(w => runways.some(r => runwayUsable(r, w))).length / ws.length : 0;

  // ---- Design check
  const byType = (t: ZoneType) => zs.filter(z => z.type === t);
  const has = (t: ZoneType) => byType(t).length > 0;
  // v0.36: a cut-out that cuts a building in two: no one can walk from one part to the other
  for (const z of world.zones.filter(q => q.type === 'concourse')) if (shells.filter(sh => sh.ids.includes(z.id)).length > 1 && !issues.some(q => q.zoneId === z.id && q.text.startsWith('A cut-out')))
    issues.push({ level: 'warn', zoneId: z.id, text: `A cut-out cuts Concourse ${GA.letters.get(z.id) ?? ''} in two: no one can walk from one part to the other. Fill it in, make it smaller, or link the parts.` });
  if (!runways.length) issues.push({ level: 'error', text: 'Draw a runway. 2,100 m lets A320s operate; 3,000 m lets A380s operate.' });
  else if (maxCls < 0) issues.push({ level: 'error', text: `Longest runway is ${Math.round(longest).toLocaleString()} m. Turboprops need 1,200 m.` });
  else if (maxCls < 2) issues.push({ level: 'warn', text: `Longest runway is ${Math.round(longest).toLocaleString()} m: up to ${CLASSES[maxCls].example}. A320s need 2,100 m.` });
  if (runways.length && coverage < 0.9) issues.push({ level: 'warn', text: `Crosswind coverage is ${Math.round(coverage * 100)}%. Prevailing wind is from ${SITE.windFrom}°; align a runway with it.` });
  if (!has('concourse')) issues.push({ level: 'error', text: 'No concourse: aircraft have nowhere to park.' });
  else if (!gates.length) issues.push({ level: 'error', text: 'No gates: no concourse has room for stands. Give one an open side, clear of roads and the runway strip.' });
  for (const z of byType('concourse')) {
    const gs = GA.guides.filter(g => g.zone.id === z.id);
    if (!GA.slots.some(sl => sl.zone.id === z.id)) {
      const why = gs.find(g => g.note)?.note;
      issues.push({ level: 'info', zoneId: z.id, text: `Concourse ${gateLetter.get(z.id)} has no gates, so it is all shops and seating${why ? ` (${why})` : ''}. Stands lay themselves on any side with ${Math.round(selfDepth(zoneCls(z)))} m clear of buildings and roads, outside the runway strip.` });
    } else for (const g of gs) if (g.served && g.note) issues.push({ level: 'info', zoneId: z.id, text: `Concourse ${gateLetter.get(z.id)}, ${sideName(g.side).toLowerCase()} side: ${g.note}.` });
  }
  const cutOff = new Set<number>();
  for (const ap of aprons) {
    const gs = gates.filter(g => g.apron === ap);
    const reachAny = gs.some(g => g.rwys[0].size > 0);
    if (runways.length && !reachAny) {
      if (ap.self) {
        // one line and one missing link per building, not per face
        if (cutOff.has(ap.zone.id)) continue; cutOff.add(ap.zone.id);
        issues.push({ level: 'error', text: `Gates ${ap.letter}: their apron found no clear way to a taxiway or runway within ${APRON.reach} m. Draw a taxiway to it.`, zoneId: ap.zone.id });
      } else issues.push({ level: 'error', text: `Gates ${ap.letter}: the taxiway they face doesn't connect to a runway.`, zoneId: ap.zone.id });
      const r = runways.reduce((m, q) => (segDist(ap.mouth, q.rw.a, q.rw.b) < segDist(ap.mouth, m.rw.a, m.rw.b) ? q : m));
      links.push({ a: ap.mouth, b: lerpPt(r.rw.a, r.rw.b, clamp(projT(ap.mouth, r.rw.a, r.rw.b), 0, 1)), text: 'No taxiway' });
    } else if (reachAny && !gs.some(g => gateAir(g, g.cls))) {
      const C = CLASSES[ap.cls];
      if (ap.cls > maxCls) issues.push({ level: 'warn', text: `Gates ${ap.letter} are sized for ${C.example}, but no runway is ${C.minRunway.toLocaleString()} m long. Smaller aircraft still use them.`, zoneId: ap.zone.id });
      else issues.push({ level: 'warn', text: `Gates ${ap.letter} are sized for ${C.example}, but no Code F taxiway route reaches them. Smaller aircraft still use them.`, zoneId: ap.zone.id });
    }
  }
  for (const T of terminals) if (!T.active) issues.push({ level: 'error', text: `${T.name} is closed: ${T.problems.join('; ')}.` });
  if (!has('curb')) issues.push({ level: 'error', text: `No curb: draw any road within ${FRONTAGE.reach} m of the hall and it lays its own forecourt, or run a road along its face yourself.` });
  const entry = [...byType('curb'), ...byType('checkin')];
  for (const lot of byType('parking')) if (entry.length && !entry.some(z => zoneReach(lot.id, z.id))) {
    issues.push({ level: 'warn', text: 'A parking lot has no sidewalk to the curb or terminal. Drivers will use the curb instead.', zoneId: lot.id });
    const t = entry.reduce((m, z) => (dist(center(z), center(lot)) < dist(center(m), center(lot)) ? z : m));
    links.push({ a: center(lot), b: center(t), text: 'No walking route' });
  }
  for (const z of [...byType('curb'), ...byType('parking')]) if (!roadOK.has(z.id)) {
    issues.push({ level: z.type === 'curb' ? 'error' : 'warn', text: `${z.type === 'curb' ? 'A curb' : 'A parking lot'} has no road to State Route 12. Draw a road from the highway to its edge.`, zoneId: z.id });
    links.push({ a: center(z), b: { x: center(z).x, y: HY }, text: 'No road' });
  }
  if (hotspots.length) issues.push({ level: 'warn', text: 'A taxi route crosses a runway (hot spot, circled). Expect holds at the crossing.' });
  for (let i = 0; i < runways.length; i++) for (let j = i + 1; j < runways.length; j++) {
    const a = runways[i], b = runways[j];
    if (Math.abs(dot(a.dir, b.dir)) > 0.996) {
      const sep = Math.abs(dot(sub(b.rw.a, a.rw.a), a.normal));
      if (sep < TUNE.dependentSpacing) issues.push({ level: 'info', text: `${a.labels[0]} and ${b.labels[0]} are ${Math.round(sep)} m apart: dependent operations (under ${TUNE.dependentSpacing} m).` });
    }
  }
  issues.sort((p, q) => ['error', 'warn', 'info'].indexOf(p.level) - ['error', 'warn', 'info'].indexOf(q.level));
  if (!issues.some(i => i.level !== 'info')) issues.unshift({ level: 'info', text: `${terminals.filter(t => t.active).length === 1 ? 'Terminal is' : 'All terminals are'} open. Watch the queues.` });

  // the same line about the same building is said once (two of its aprons can earn the same remark)
  { const seen = new Set<string>(); for (let k = 0; k < issues.length; k++) { const key = `${issues[k].level}|${issues[k].zoneId ?? ''}|${issues[k].text}`; if (seen.has(key)) issues.splice(k--, 1); else seen.add(key); } }
  return {
    runways, aprons, gates, shells, shellOf, junctions, pads: GA.pads, air, airExtra, taxiLabels, taxiLetter, hotspots, cores, ped,
    road, hwyEnds, attach, roadOK, crosswalks, units, frames, issues, links, longest, maxCls, coverage,
    zoneAt, pedRoute, inCut: (p: Pt, lv: Level) => !!inWall(p, lv) && !onFloor(p, lv), zoneReach, gateUsable, shops, terminals, termOf, gateLetter, gateSlots: GA.slots, gateGuides: GA.guides, lease, budgets,   // (inCut: in a cut-out, and off the floor: a notch's rounded corners keep a little of it)
    zones: zs, decks: FR.decks, frontGuides: FR.guides, autoWalks: laid,
    roadPieces: pieces, rounds, rampRefs: new Set(fore.filter(w => w.fore === 'ramp').map(w => w.id)),
    wayPieces: source.ways.filter(w => w.kind !== 'road'), autoRoads: laidRoads, trainLinks: [...tLinks.map(l => ({ a: center(l.a), b: center(l.b) })), ...movers.map(m => ({ ...m, apm: true }))], served, isTrainNode: (p: Pt) => tKeys.has(tKey(p)),
  };
}

const ROAD_SERVED = new Set<ZoneType>(['parking', 'rideshare', 'rental', 'bus', 'hotel']);
export const unitsOf = (d: Derived, z: Zone) => d.units.get(z.id)?.count ?? 0;
const ringWidth = (rounds: Round[], ref: number) => { const r = rounds.find(q => q.id === -ref - RING_REF); return r ? roundDef(r).width : 7; };
export const segDistWay = (p: Pt, w: { a: Pt; b: Pt; c?: Pt }) => wayDist(p, w);

// ------------------------------------------------------------ auto-connect: taxiways drawn beside a runway
export type WaySpec = { a: Pt; b: Pt; cls: number };
const landsFromA = (heading: number) => Math.abs(((SITE.windFrom - heading + 540) % 360) - 180) <= 90;
const PAR_MIN = 90, PAR_MAX = 450;   // parallel taxiway offset from runway centreline, m

/** Along-runway positions of taxiways that already touch this runway. */
function runwayStubs(world: World, rw: Runway, extra: WaySpec[] = []): number[] {
  const rd = norm(sub(rw.b, rw.a)); const half = runwayWidth(dist(rw.a, rw.b)) / 2 + 15;
  const out: number[] = [];
  for (const w of [...world.ways.filter(x => x.kind === 'taxi'), ...extra]) for (const e of [w.a, w.b])
    if (segDist(e, rw.a, rw.b) <= half) out.push(dot(sub(e, rw.a), rd));
  return out;
}

/**
 * Connectors for a taxiway drawn parallel to a runway: stubs at the thresholds (or the taxiway's ends),
 * plus intermediate exits every ~650 m. Exits past the landing roll are angled 30° as rapid exits
 * for the prevailing landing direction; the rest are square.
 */
export function autoConnectors(world: World, w: WaySpec, aprons: Apron[]): WaySpec[] {
  const out: WaySpec[] = [];
  const wd = norm(sub(w.b, w.a));
  for (const rw of world.runways) {
    const rd = norm(sub(rw.b, rw.a));
    if (Math.abs(dot(wd, rd)) < 0.996) continue;
    const L = dist(rw.a, rw.b); const n = perpLeft(rd);
    const off = dot(sub(lerpPt(w.a, w.b, 0.5), rw.a), n);
    if (Math.abs(off) < PAR_MIN || Math.abs(off) > PAR_MAX) continue;
    const ta = dot(sub(w.a, rw.a), rd), tb = dot(sub(w.b, rw.a), rd);
    if (Math.abs(tb - ta) < 1) continue;
    const lo = Math.max(Math.min(ta, tb), 0), hi = Math.min(Math.max(ta, tb), L);
    if (hi - lo < 250) continue;
    const onRwy = (s: number) => add(rw.a, mul(rd, s));
    const onTwy = (s: number) => lerpPt(w.a, w.b, (s - ta) / (tb - ta));
    const taken = runwayStubs(world, rw);
    const tryAdd = (sR: number, sT: number) => {
      if (taken.some(t => Math.abs(t - sR) < 150)) return;
      const spec = { a: onRwy(sR), b: onTwy(sT), cls: w.cls };
      if (!canPlaceWay(world, 'taxi', spec.a, spec.b, aprons).ok) return;
      out.push(spec); taken.push(sR);
    };
    const sLo = Math.min(ta, tb) <= 60 ? 0 : lo, sHi = Math.max(ta, tb) >= L - 60 ? L : hi;
    tryAdd(sLo, Math.max(sLo, lo));
    tryAdd(sHi, Math.min(sHi, hi));
    const fromA = landsFromA(headingOf(rw.a, rw.b));
    const span = sHi - sLo; const k = Math.max(0, Math.floor(span / 650) - 1);
    const run = Math.abs(off) / Math.tan(Math.PI / 6);
    for (let i = 1; i <= k; i++) {
      const s = sLo + (span * i) / (k + 1);
      const fromTh = fromA ? s : L - s;              // distance from the landing threshold
      if (fromTh > 900) {
        const sT = s + (fromA ? 1 : -1) * run;
        if (sT >= lo + 20 && sT <= hi - 20) { tryAdd(s, sT); continue; }
      }
      tryAdd(s, s);
    }
  }
  return out;
}

/**
 * When a runway end moves outward, stretch parallel taxiways that ended near the old threshold
 * and add a stub at the new one.
 */
export function followRunwayEnd(world: World, fixed: Pt, oldEnd: Pt, newEnd: Pt, aprons: Apron[]) {
  const moves: { way: Way; end: 'a' | 'b'; to: Pt }[] = [];
  const adds: WaySpec[] = [];
  let cost = 0;
  const along = norm(sub(oldEnd, fixed)); const n = perpLeft(along);
  const sOld = dist(fixed, oldEnd), sNew = dot(sub(newEnd, fixed), along);
  if (sNew <= sOld + 20) return { moves, adds, cost };
  for (const w of world.ways) {
    if (w.kind !== 'taxi' || w.c || Math.abs(dot(norm(sub(w.b, w.a)), along)) < 0.996) continue;   // (v0.46: not a curved one)
    const off = dot(sub(lerpPt(w.a, w.b, 0.5), fixed), n);
    if (Math.abs(off) < PAR_MIN || Math.abs(off) > PAR_MAX) continue;
    for (const end of ['a', 'b'] as const) {
      const q = w[end]; const sq = dot(sub(q, fixed), along);
      if (Math.abs(sq - sOld) > 100) continue;
      const to = add(add(fixed, mul(along, sNew)), mul(n, dot(sub(q, fixed), n)));
      const other = end === 'a' ? w.b : w.a;
      if (!canPlaceWay(world, 'taxi', other, to, aprons).ok) continue;
      moves.push({ way: w, end, to });
      cost += Math.max(0, sNew - sq) * wayCostPerM('taxi', w.cls, 0);   // (v0.50: a taxiway pulled back to the new end costs nothing, and gives nothing back)
      if (canPlaceWay(world, 'taxi', newEnd, to, aprons).ok) { adds.push({ a: newEnd, b: to, cls: w.cls }); cost += dist(newEnd, to) * wayCostPerM('taxi', w.cls, 0); }
    }
  }
  return { moves, adds, cost };
}
