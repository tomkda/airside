// World model (what the player builds) and the layout the game derives from it:
// runway designators and classes, aprons and gates, the taxiway / road / sidewalk networks,
// vertical cores, pedestrian routing, fit-out frames and the design check.
import {
  Pt, Rect, add, sub, mul, dot, dist, norm, perpLeft, lerpPt, clamp, projT, center, area,
  rectsOverlap, intersectRect, inRect, rectSegDist, rectCorners, clampToRect, segIntersection, segsIntersect, pointInPoly, deg, segDist,
} from './geom';
import { ZONES, ZoneType, Level, SITE, TUNE, MOVER, PIER, HALL, CLASSES, Cls, rwyClass, TAXI_CLASSES, ROAD_LANES, WALK, ROADS, FRONTAGE, ShopType, TenantId, SITES, GROWTH, APRON } from './config';
import { autoFrontage, autoForecourt, curbCuts, autoWalks, autoRoads, trainLinks, SELF_CONNECT, AutoTag, DeckSpan, FrontGuide } from './frontage';
import { NSeg, Net, buildNet, dijkstra, allPairs, nearestNode } from './net';
import { Round, Piece, roadPieces, isRingRef, RING_REF, wayDist, waySegs, wayLen, curveOK, roundOuter, roundDef } from './ways';
export type { Round, Piece } from './ways';
import { zonePts, inZone, toLocal, toWorld, overlapOf, polyCentre, zonesOverlap, centreOf, zoneBox, shaped, polyBox, polyClip, polyArea, arcOf, frameOf, bendPath, heart, maxBend } from './shapes';
import { buildGateAreas, GateSlot, SideGuide, SIDE_NAMES, sideName, LANE_REF, selfDepth } from './gates';
import { layoutZone, LItem } from './layout';
import { carveConcourse, carveHub, Budget } from './bands';
import { letLots } from './commerce';

export interface Zone {
  id: number; type: ZoneType; level: Level; x: number; y: number; w: number; h: number; tier: 0 | 1; units?: number; cls?: Cls; leased?: number; off?: string[];
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
  /** Generated, never saved (v0.12): part of a hall's own forecourt, along its face or linking it to a road. */
  fore?: 'face' | 'link' | 'ramp';
  /** For a ramp: the id of the frontage road whose upper deck it climbs to. */
  face?: number }
export interface World { zones: Zone[]; runways: Runway[]; ways: Way[]; nextId: number; sites?: Site[]; rounds?: Round[] }

export const newWorld = (): World => ({ zones: [], runways: [], ways: [], nextId: 1, sites: [], rounds: [] });

/** Bring older saves up to date. */
export function migrateWorld(w: World): World {
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
  for (const z of w.zones) if (z.bend !== undefined) {   // v0.20: or bend, and only as far as their width allows
    if (z.type !== 'concourse' || z.sides || !isFinite(z.bend)) { delete z.bend; continue; }
    const m = maxBend(z.w, z.h); z.bend = Math.max(-m, Math.min(m, z.bend)); if (Math.abs(z.bend) < 4) delete z.bend;
  }
  for (const z of w.zones) if (z.pair !== undefined && !w.zones.some(q => q.id === z.pair && q.pair === z.id)) delete z.pair;
  // v0.11: roundabouts, and roads that may curve or run one way. Drop anything malformed.
  w.rounds = (Array.isArray(w.rounds) ? w.rounds : []).filter(r => r && isFinite(r.x) && isFinite(r.y) && (r.size === 0 || r.size === 1));
  for (const y of w.ways) {
    if (y.c && !(y.kind === 'road' && isFinite(y.c.x) && isFinite(y.c.y))) delete y.c;
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
  const r = padRect(bboxOf([st, ...mine.map(z => padRect(z, SITES.pad))]), 0);
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
export interface Units { max: number; count: number }
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
  autoRoads: Way[]; trainLinks: { a: Pt; b: Pt; apm?: boolean; from?: number; to?: number }[]; served: Set<number>;
  isTrainNode(p: Pt): boolean;
  zoneAt(p: Pt, lv: Level): Zone | undefined;
  pedRoute(p: Pt, lv: Level, q: Pt, lvq: Level): Route | null;
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

export function canPlaceWay(world: World, kind: WayKind, a: Pt, b: Pt, aprons: Apron[], c?: Pt): PlaceCheck {
  if (dist(a, b) < 10) return { ok: false, reason: 'Too short' };
  if (!c) return placeSeg(world, kind, a, b, aprons);
  if (!curveOK({ a, b, c })) return { ok: false, reason: `Curve too tight: ${ROADS.minRadius} m radius at least` };
  for (const [p, q] of waySegs({ a, b, c })) { const r = placeSeg(world, kind, p, q, aprons); if (!r.ok) return r; }
  return { ok: true };
}
/**
 * v0.17: can a pier (a concourse at any angle) go here? It may overlap other concourses: that is how it joins a
 * building. It may not overlap anything else on its level, cross a taxiway, or reach into a runway strip.
 */
export function canPlacePier(world: World, z: { x: number; y: number; w: number; h: number; rot?: number; sides?: number; bend?: number; level: Level }, ignoreId = -1): PlaceCheck {
  if (z.sides && Math.min(z.w, z.h) < HALL.minDia) return { ok: false, reason: `Too small: a hall needs ${HALL.minDia} m across at least` };
  if (Math.max(z.w, z.h) < PIER.minLen) return { ok: false, reason: `Too short: a pier needs ${PIER.minLen} m at least` };
  const pts = zonePts(z); const edges = pts.map((p, i) => [p, pts[(i + 1) % pts.length]] as const);
  for (const p of pts) if (!inRect(p, SITE.buildable) || pointInPoly(p, SITE.lake)) return { ok: false, reason: 'Outside the site boundary or in the lake' };
  for (const rw of world.runways) for (const [a, b] of edges)
    if (segsIntersect(a, b, rw.a, rw.b) || segDist(a, rw.a, rw.b) < TUNE.runwayClear || segDist(rw.a, a, b) < TUNE.runwayClear || segDist(rw.b, a, b) < TUNE.runwayClear) return { ok: false, reason: 'Inside the runway safety strip (150 m)' };
  for (const o of world.zones) {
    if (o.id === ignoreId || !zonesOverlap(z, o, 4)) continue;
    if (o.level === z.level && o.type !== 'concourse' && !(z.sides && o.type === 'security')) return { ok: false, reason: `Overlaps ${ZONES[o.type].short}: ${z.sides ? 'a hall joins concourses and security' : 'a pier joins a concourse'}, not ${ZONES[o.type].short.toLowerCase()}` };
    if (o.level !== z.level && o.type === 'parking') return { ok: false, reason: 'Cannot build over a surface lot' };
  }
  for (const w of world.ways) if (w.kind === 'taxi' && (inZone(w.a, z) || inZone(w.b, z) || edges.some(([a, b]) => segsIntersect(a, b, w.a, w.b)))) return { ok: false, reason: 'Crosses a taxiway' };
  for (const rd of world.rounds ?? []) if (inZone(rd, z, roundOuter(rd)) && z.level === 0) return { ok: false, reason: 'Overlaps a roundabout' };
  return { ok: true };
}
/** Does a segment pass through a turned zone (2 m inside its outline)? */
function segInZone(z: Zone, a: Pt, b: Pt): boolean {
  if (z.sides || z.bend) { const pts = zonePts(z); return inZone(a, z, -2) || inZone(b, z, -2) || pts.some((p, i) => segsIntersect(a, b, p, pts[(i + 1) % pts.length])); }
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
  for (const w of world.ways) if (w.kind === 'taxi' && segDist(p, w.a, w.b) < R + 10) return { ok: false, reason: 'Too close to a taxiway' };
  for (const o of world.rounds ?? []) if (o.id !== ignoreId && dist(o, p) < R + roundOuter(o) + 6) return { ok: false, reason: 'Too close to another roundabout' };
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
  for (const w of world.ways) if (w.kind === 'taxi' && segsIntersect(a, b, w.a, w.b)) return { ok: false, reason: `${name}s can't cross a taxiway` };
  if (kind === 'walk') for (const rd of world.rounds ?? []) if (segDist(rd, a, b) < roundOuter(rd) - 2) return { ok: false, reason: "Sidewalks go round a roundabout, not through it" };
  for (const ap of aprons) if (!ap.self && rectSegDist(inset(ap.rect, 2), a, b) === 0) return { ok: false, reason: `${name}s can't cross an apron` };
  for (const z of world.zones) if (z.level === 0 && rectSegDist(inset(z, 2), a, b) === 0)
    return { ok: false, reason: `${name}s end at the edge of the ${ZONES[z.type].short.toLowerCase()}; they can't run through it` };
  return { ok: true };
}

/** v0.19: can this shape be swung round by its ends? A pier or satellite can: a concourse that belongs to no site. */
export const canTurn = (z: Zone) => z.type === 'concourse' && !z.sides && (z.site === undefined || !!z.rot || !!z.bend);

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
export function derive(source: World): Derived {
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
  const GA = buildGateAreas(world, runways, runwayWidth, { self: true, keep });
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
    if (z.sides) C = carveHub(z, world, gates);   // a hall is carved where it stands: a ring of lots round an atrium
    else if (z.rot || z.bend) {
      // an angled pier is laid out in its own upright frame, then every piece is turned into place
      // (v0.19: its neighbours are brought into that frame too, as the box each one fills there, so the pier finds
      //  its entry and its windowless walls where they really are)
      // (v0.20: a bent pier too: its frame is as long as its arc, and what is laid out on it is carried onto the curve)
      const zl = { ...z, ...frameOf(z), rot: undefined, bend: undefined };
      const near = zonePts({ x: z.x - 2, y: z.y - 2, w: z.w + 4, h: z.h + 4, rot: z.rot, bend: z.bend });   // the pier's outline, 2 m out
      const local: World = { ...world, zones: world.zones.map(o => {
        if (o.id === z.id) return zl;
        // only the part of a neighbour that is at the pier counts, or its box would wall off stretches it never touches;
        // one that is nowhere near is kept as a dot at its centre, for "which end faces security"
        const part = polyClip(zonePts(o), near); const c = toLocal(z, centreOf(o));
        const box = part.length >= 3 && polyArea(part) > 1 ? polyBox(part.map(p => toLocal(z, p))) : { x: c.x - 0.5, y: c.y - 0.5, w: 1, h: 1 };
        return { ...o, ...box, rot: undefined, sides: undefined };
      }) };
      C = carveConcourse(zl, local, gates.filter(g => g.zone.id === z.id).map(g => ({ ...g, zone: zl, door: toLocal(z, g.door) })));
      // a lot keeps its four corners (the sim and the renderers count on them; a lot is short enough that its walls
      // can stay straight). Floors, and the long lines down the building, are cut into short pieces that follow a bend.
      for (const sh of C.shops) { sh.zone = z; sh.pts = sh.pts.map(p => toWorld(z, p)); sh.door = toWorld(z, sh.door); }
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
  // ---- Tenants bid for the lots by footfall, visibility, dwell and position (see commerce.ts); best lots lease first.
  letLots(source, shops, budgets);
  for (const [id, list] of shops) {
    const z = world.zones.find(q => q.id === id)!; const n = list.length;
    lease.set(id, { max: n, count: n ? clamp(z.leased ?? Math.ceil(n * 0.4), 1, n) : 0 });
  }

  // ---- Airfield network: runways, player taxiways and gate stubs (stands join the taxiway they face).
  const taxis = world.ways.filter(w => w.kind === 'taxi');
  const airSegs: NSeg[] = [];
  const airExtra: { a: Pt; b: Pt; cls: number }[] = [];
  for (const r of runways) airSegs.push({ a: r.rw.a, b: r.rw.b, kind: 'rwy', cls: 3, ref: r.rw.id });
  for (const w of taxis) airSegs.push({ a: w.a, b: w.b, kind: 'taxi', cls: w.cls, ref: w.id });
  for (const g of gates) airSegs.push({ a: g.front, b: g.stand, kind: 'stand', cls: g.cls, ref: -1 });
  for (const w of taxis) for (const e of [w.a, w.b]) {
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
  const parent = taxis.map((_, i) => i);
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  const tdir = taxis.map(w => norm(sub(w.b, w.a)));
  for (let i = 0; i < taxis.length; i++) for (let j = i + 1; j < taxis.length; j++) {
    const A = taxis[i], B = taxis[j];
    const share = [A.a, A.b].some(p => [B.a, B.b].some(q => dist(p, q) < 6));
    if (share && Math.abs(dot(tdir[i], tdir[j])) > Math.cos((12 * Math.PI) / 180)) parent[root(i)] = root(j);
  }
  const LET = 'ABCDEFGHJKLMNPQRSTUVWYZ';
  const groupLetter = new Map<number, string>();
  const taxiLetter = new Map<number, string>();
  const taxiLabels: TaxiLabel[] = [];
  taxis.forEach((w, i) => {
    const r = root(i);
    if (!groupLetter.has(r)) { const k = groupLetter.size; groupLetter.set(r, k < LET.length ? LET[k] : LET[Math.floor(k / LET.length) - 1] + LET[k % LET.length]); }
    taxiLetter.set(w.id, groupLetter.get(r)!);
  });
  for (const [r, letter] of groupLetter) {
    const members = taxis.filter((_, i) => root(i) === r);
    const longest = members.reduce((m, w) => (dist(w.a, w.b) > dist(m.a, m.b) ? w : m));
    if (dist(longest.a, longest.b) < 60) continue;
    taxiLabels.push({ text: letter, p: lerpPt(longest.a, longest.b, 0.5), ang: Math.atan2(longest.b.y - longest.a.y, longest.b.x - longest.a.x) });
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
  const movers: { a: Pt; b: Pt; from: number; to: number }[] = [];
  {
    const mods = zs.filter(z => TERMINAL_TYPES.has(z.type));
    const par = new Map<number, number>(mods.map(z => [z.id, z.id]));
    const root = (i: number): number => { const q = par.get(i)!; return q === i ? i : (par.set(i, root(q)), par.get(i)!); };
    for (let i = 0; i < mods.length; i++) for (let j = i + 1; j < mods.length; j++) {
      const A = mods[i], B = mods[j]; const ir = A.level !== B.level && !shaped(A) && !shaped(B) ? intersectRect(A, B) : null;
      if (shaped(A) || shaped(B) ? zonesOverlap(A, B, A.level === B.level ? 24 : 256) : (A.level === B.level && shared(A, B)) || (ir && ir.w >= 16 && ir.h >= 16)) par.set(root(A.id), root(B.id));
    }
    const linked = new Set<number>(mods.filter(z => z.type === 'security').map(z => root(z.id)));
    const concs = mods.filter(z => z.type === 'concourse');
    const gap0 = (A: Rect, B: Rect) => Math.hypot(Math.max(0, A.x - (B.x + B.w), B.x - (A.x + A.w)), Math.max(0, A.y - (B.y + B.h), B.y - (A.y + A.h)));
    const gap = (A: Zone, B: Zone) => gap0(zoneBox(A), zoneBox(B));
    for (let guard = 0; guard < 40; guard++) {
      let best: { s: Zone; m: Zone; d: number } | null = null;
      for (const sz of concs) if (!linked.has(root(sz.id))) for (const m of concs) if (linked.has(root(m.id))) {
        const d0 = gap(sz, m); if (d0 <= MOVER.reach && (!best || d0 < best.d || (d0 === best.d && sz.id < best.s.id))) best = { s: sz, m, d: d0 };
      }
      if (!best) break;
      const inset = (z: Zone) => Math.min(12, z.w / 2 - 1, z.h / 2 - 1);
      const station = (z: Zone, to: Pt) => (z.sides ? centreOf(z) : toWorld(z, clampToRect(toLocal(z, to), frameOf(z), inset(z))));
      const pa = station(best.s, heart(best.m)), pb = station(best.m, pa);
      const na = ped.push({ p: pa, level: best.s.level, zones: [best.s.id] }) - 1, nb = ped.push({ p: pb, level: best.m.level, zones: [best.m.id] }) - 1;
      pedE.push([na, nb, dist(pa, pb) / MOVER.speed + MOVER.wait * TUNE.walkSpeed]); vpairs.push([na, nb]);
      tKeys.add(tKey(pa)); tKeys.add(tKey(pb));
      movers.push({ a: pa, b: pb, from: best.s.id, to: best.m.id });
      linked.add(root(best.s.id));
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
    ped.forEach((q, i) => { if (q.level === lv) { const d0 = dist(p, q.p); if (d0 < 120) out.push({ n: i, c: d0 }); } });
    return out.sort((a, b) => a.c - b.c).slice(0, 4);
  };
  // v0.20: inside a bent pier a straight line from one point to another can leave the building. Wherever two
  // points of a route in a row are in the same bent pier, the walk between them is laid along its centreline.
  const bent = zs.filter(z => arcOf(z));
  const thread = (from: Pt, lv0: Level, r: Route): Route => {
    if (!bent.length) return r;
    const pts: Pt[] = [], lvs: Level[] = []; let a = from, la = lv0;
    for (let i = 0; i < r.pts.length; i++) {
      const b = r.pts[i], lb = r.lvs[i];
      const z = la === lb ? bent.find(q => q.level === la && inZone(a, q, 1) && inZone(b, q, 1)) : undefined;
      if (z) {
        const ua = toLocal(z, a), ub = toLocal(z, b); const F = frameOf(z); const k = Math.floor(Math.abs(ub.x - ua.x) / 24);
        // drift to the centreline over the first and last stretch, and keep to it in between
        for (let j = 1; j <= k; j++) { const t = j / (k + 1); const w = Math.min(1, t * (k + 1) / 2, (1 - t) * (k + 1) / 2); const y0 = ua.y + (ub.y - ua.y) * t; pts.push(toWorld(z, { x: ua.x + (ub.x - ua.x) * t, y: y0 + (F.y + F.h / 2 - y0) * w })); lvs.push(lb); }
      }
      pts.push(b); lvs.push(lb); a = b; la = lb;
    }
    return { pts, lvs, len: r.len };
  };
  const pedRoute = (p: Pt, lv: Level, q: Pt, lvq: Level): Route | null => {
    const za = zoneAt(p, lv), zb = zoneAt(q, lvq);
    if (za && zb && za.id === zb.id) return thread(p, lv, { pts: [q], lvs: [lvq], len: dist(p, q) });
    const S = za ? (byZone.get(za.id) ?? []).map(n => ({ n, c: dist(p, ped[n].p) })) : nearPed(p, lv);
    const T = zb ? (byZone.get(zb.id) ?? []).map(n => ({ n, c: dist(q, ped[n].p) })) : nearPed(q, lvq);
    let best = Infinity, bs = -1, bt = -1;
    for (const s of S) for (const t of T) { const c = s.c + D[s.n * N + t.n] + t.c; if (c < best) { best = c; bs = s.n; bt = t.n; } }
    if (bs < 0) return null;
    const pts: Pt[] = [ped[bs].p], lvs: Level[] = [ped[bs].level];
    let i = bs, guard = 0;
    while (i !== bt && guard++ < 2000) { i = nxt[i * N + bt]; pts.push(ped[i].p); lvs.push(ped[i].level); }
    pts.push(q); lvs.push(lvq);
    return thread(p, lv, { pts, lvs, len: best });
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
  for (const w of roads) for (const e of [w.a, w.b]) {
    const dy = Math.abs(e.y - HY);
    if (dy > 4 && dy <= 20) roadSegs.push({ a: e, b: { x: e.x, y: HY }, kind: 'road', cls: 0, ref: w.id, lanes: w.lanes });
  }
  const road = buildNet(roadSegs, 4);
  const hwyEnds = [nearestNode(road, { x: 0, y: HY }, 5), nearestNode(road, { x: SITE.width, y: HY }, 5)];
  const attach = new Map<number, number[]>();
  for (const z of zs) if (z.type === 'curb' || ROAD_SERVED.has(z.type)) {
    // generated curbs attach to the road nodes along their outer edge; drawn ones to roads that end at them
    const reach = z.auto ? z.auto.gap + 12 : 3;
    const ns: number[] = []; road.nodes.forEach((p, i) => { if (inRect(p, z, reach) && (!z.auto || road.adj[i].some(e => road.edges[e].ref === z.auto!.road))) ns.push(i); });
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
  for (const st of sites) groups.set(`s${st.id}`, { zones: [], site: st });
  // a module on no site joins the site of whatever it connects to on foot
  const rootSite = new Map<number, Site>();
  for (const z of zs) if (tParent.has(z.id)) { const st = siteOf(world, z); if (st && !rootSite.has(tRoot(z.id))) rootSite.set(tRoot(z.id), st); }
  for (const z of zs) if (tParent.has(z.id)) {
    const st = siteOf(world, z) ?? rootSite.get(tRoot(z.id));
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
      T.problems.push(`needs ${listOf(missing)}${others.length ? `: connect it to another terminal or build them touching it${ga.length && !sec.length ? `, or bring the concourse within ${MOVER.reach.toLocaleString()} m of a terminal's concourse for a people mover` : ''}` : ''}`);
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
    runways, aprons, gates, pads: GA.pads, air, airExtra, taxiLabels, taxiLetter, hotspots, cores, ped,
    road, hwyEnds, attach, roadOK, crosswalks, units, frames, issues, links, longest, maxCls, coverage,
    zoneAt, pedRoute, zoneReach, gateUsable, shops, terminals, termOf, gateLetter, gateSlots: GA.slots, gateGuides: GA.guides, lease, budgets,
    zones: zs, decks: FR.decks, frontGuides: FR.guides, autoWalks: laid,
    roadPieces: pieces, rounds, rampRefs: new Set(fore.filter(w => w.fore === 'ramp').map(w => w.id)),
    autoRoads: laidRoads, trainLinks: [...tLinks.map(l => ({ a: center(l.a), b: center(l.b) })), ...movers.map(m => ({ ...m, apm: true }))], served, isTrainNode: (p: Pt) => tKeys.has(tKey(p)),
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
    if (w.kind !== 'taxi' || Math.abs(dot(norm(sub(w.b, w.a)), along)) < 0.996) continue;
    const off = dot(sub(lerpPt(w.a, w.b, 0.5), fixed), n);
    if (Math.abs(off) < PAR_MIN || Math.abs(off) > PAR_MAX) continue;
    for (const end of ['a', 'b'] as const) {
      const q = w[end]; const sq = dot(sub(q, fixed), along);
      if (Math.abs(sq - sOld) > 100) continue;
      const to = add(add(fixed, mul(along, sNew)), mul(n, dot(sub(q, fixed), n)));
      const other = end === 'a' ? w.b : w.a;
      if (!canPlaceWay(world, 'taxi', other, to, aprons).ok) continue;
      moves.push({ way: w, end, to });
      cost += (sNew - sq) * wayCostPerM('taxi', w.cls, 0);
      if (canPlaceWay(world, 'taxi', newEnd, to, aprons).ok) { adds.push({ a: newEnd, b: to, cls: w.cls }); cost += dist(newEnd, to) * wayCostPerM('taxi', w.cls, 0); }
    }
  }
  return { moves, adds, cost };
}
