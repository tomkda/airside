// Simulation core. Pure logic: no DOM, no canvas. Deterministic for a given seed and command sequence.
// Time unit: minutes of the day. One sim "day" stands in for several calendar days.
// Everything moves on networks: aircraft on taxiways, cars on roads, people through doors, cores and sidewalks.
import { Pt, add, mul, dist, polyLen, along, rng, clamp, center, segDist } from './geom';
import { BANK, Bank, GROUND, CLASSES, AcClass, Cls, AIRLINES, Airline, Level, SITE, TUNE, ZONES, ZoneType, ShopType, COMMERCE, GROWTH, UNLOCKS, Unlock, UnlockId, WEATHER, WeatherKind, Offer, Deal, ROADS, MOVER, YIELD } from './config';
import { runwayExits } from './airfield';
import { World, Derived, Zone, Gate, RunwayInfo, Wind, Route, Terminal, Shop, Flow, derive, runwayUsable, unitsOf, Frame } from './world';
import { wayLen, isRingRef } from './ways';
import { toLocal, clampInto, frameOf, polyArea } from './shapes';
import { flowBins, newFlow, tenantsOf } from './commerce';
import { Goal, checkGoals } from './goals';
import { DJ, dijkstra, trace, nearestNode } from './net';

// ------------------------------------------------------------------ entities
export type Step = 'checkin' | 'security' | 'dutyfree' | 'shop' | 'gate' | 'passport' | 'claim' | 'curb' | 'lot';

export interface Party {
  id: number; dep: boolean; mode: 'curb' | 'park' | 'bus' | 'ride' | 'rental'; pax: Pax[]; atCurb: number; car?: Car; flight: Flight;
  curb?: Zone; lot?: Zone; stall?: Pt;
}

export interface Pax {
  id: number; dep: boolean; flight: Flight; party: Party; bags: boolean;
  x: number; y: number; level: Level;
  path: Pt[]; pathLv: Level[]; steps: Step[];
  stage: 'walk' | 'queue' | 'service' | 'dwell' | 'waitBag' | 'curbWait' | 'shopping' | 'stuck' | 'done';
  proc?: Proc; since: number; serviceEnd: number; bagNo: number;
  walked: number; sat: number; mood: 0 | 1 | 2; why?: string; stranded: boolean; premium: boolean; shop?: Shop;
  browse?: boolean;            // in duty free: stopped to shop (true) or just walking the serpentine (false)
  ride?: boolean;              // on the AirTrain between two stations
  xfer?: boolean;              // v0.60: changing aircraft here (never landside)
  fz?: number; fb?: number; fe?: number;   // footfall: concourse, and the bins already counted there
}

export interface Car {
  id: number; party: Party; pick: boolean; pts: Pt[]; eids: number[]; d: number; len: number; si: number; cum: number[];
  stage: 'in' | 'queue' | 'bay' | 'out' | 'park' | 'gone'; x: number; y: number; ang: number;
  bay: number; until: number; since: number; curb?: Proc; entry: number;
  /** v0.47: the last junction on its way it has been let through, and whether it is waiting at one now */
  passed?: number; wait?: boolean;
}

export interface Proc {
  zone: Zone; type: ZoneType; frame: Frame; servers: number; maxServers: number;
  queue: Pax[]; busy: (Pax | null)[]; served: number; waitSum: number; recentWait: number;
  cars?: Car[]; bays?: (Car | null)[];
  carousels?: (Flight | null)[];
}

export type FState = 'pending' | 'hold' | 'approach' | 'roll' | 'taxiIn' | 'waitGate' | 'stand' | 'taxiOut' | 'holdDep' | 'takeoff' | 'gone' | 'cancelled';
export interface Flight {
  id: number; code: string; airline: Airline; ac: AcClass; cls: Cls; schedArr: number; schedDep: number; gate: Gate;
  paxDep: number; paxArr: number; state: FState; path: Pt[]; d: number; len: number; speed: number;
  rw?: RunwayInfo; fromA: boolean; landT: number; standT: number; readyT: number; pushT: number; holdSince: number; exitNode: number;
  x: number; y: number; ang: number; alt: number;
  bagsArr: number; bagsDone: number; claim?: Proc; carousel: number;
  boarded: number; deplaned: number; spawnedDep: boolean;
  /** v0.58: on the ground. `route` is the air nodes its taxi path runs through (the last `route.length` points of
   *  `path`); `held` it is standing for another aircraft, since `heldT`; `hold` minutes lost so far this leg;
   *  `pass` aircraft it has been cleared past; `faceT` since when it has faced one head-on; `freeT` towed until then;
   *  `released` its departure is counted and it waits only for the taxiway (`gateT` since when). */
  /** v0.60: the bank it flies in; the flights its connecting passengers are bound for (one entry each, taken as they get off); and the seats on it filled by connections */
  bank?: number; xferOut?: Flight[]; xferIn?: number;
  route?: number[]; held?: boolean; /** (the aircraft it stands for) */ heldBy?: number; heldT?: number; hold?: number; pass?: Set<number>; faceT?: number; freeT?: number; released?: boolean; gateT?: number; taxiT?: number;
}

type WaitKey = 'curb' | 'checkin' | 'security' | 'claim' | 'passport';
/** v0.57: a module's day, for its level of service: the most people waiting at once, the longest wait (smoothed at a desk, the longest for a bag), and arrivals hour by hour. */
export interface LosStat { peakQ: number; peakWait: number; in: number[];
  /** how many desks were staffed when the wait peaked */ open?: number }
export interface DayStats {
  paxDep: number; paxArr: number; missed: number; stranded: number; satSum: number; satN: number;
  waits: Record<WaitKey, { sum: number; n: number; max: number }>;
  walkSum: number; walkN: number; flights: number; delayed: number; cancelled: number; delaySum: number;
  rev: { slots: number; pax: number; shops: number; food: number; lounges: number; dutyfree: number; rent: number; parking: number; curb: number; hotel: number; rental: number; rideshare: number };
  cost: { staff: number; upkeep: number };
  lotFull: number;
  /** v0.58: the airfield's day: aircraft movements that taxied, their taxi minutes, minutes held for other aircraft, held on stand, and head-on stand-offs. */
  /** v0.60: passengers who changed aircraft here, and those whose onward flight left without them */
  xfer: number; xferMissed: number;
  ground: { moves: number; taxi: number; hold: number; gate: number; standoffs: number; /** towed through after standing `GROUND.maxHold` minutes */ tows: number };
}
export interface PlanInfo {
  demand: number; byAirline: { airline: Airline; requested: number; scheduled: number }[];
  rejectedGates: number; rejectedRunway: number; rejectedAircraft: number; rejectedIntl: number; wantsSJ: number; scheduled: number;
  limit: string; loadFactor: number;
  /** v0.60: bank flights asked for today, and those of them turned away */
  bankAsked: number; bankLost: number;
}
export interface Report { label: string; day: number; stats: DayStats; plan: PlanInfo; profit: number; sat: number; onTime: number; money: number; periodDays: number }

const emptyStats = (): DayStats => ({
  paxDep: 0, paxArr: 0, missed: 0, stranded: 0, satSum: 0, satN: 0,
  waits: { curb: { sum: 0, n: 0, max: 0 }, checkin: { sum: 0, n: 0, max: 0 }, security: { sum: 0, n: 0, max: 0 }, claim: { sum: 0, n: 0, max: 0 }, passport: { sum: 0, n: 0, max: 0 } },
  walkSum: 0, walkN: 0, flights: 0, delayed: 0, cancelled: 0, delaySum: 0,
  rev: { slots: 0, pax: 0, shops: 0, food: 0, lounges: 0, dutyfree: 0, rent: 0, parking: 0, curb: 0, hotel: 0, rental: 0, rideshare: 0 }, cost: { staff: 0, upkeep: 0 }, lotFull: 0, xfer: 0, xferMissed: 0, ground: { moves: 0, taxi: 0, hold: 0, gate: 0, standoffs: 0, tows: 0 },
});

/** All revenue lines for a day. rent is the top-up when a lot's sales share falls short of its minimum guarantee. */
export const revTotal = (r: DayStats['rev']) => r.slots + r.pax + r.shops + r.food + r.lounges + r.dutyfree + r.rent + r.parking + r.curb + r.hotel + r.rental + r.rideshare;

export const DAY_START = 4 * 60;
export const DAY_END = 24 * 60;

// ------------------------------------------------------------------ simulation
export class Sim {
  world: World;
  d!: Derived;
  r: () => number;
  t = DAY_START;
  day = 0;
  calDays = 0;
  money = TUNE.startMoney;
  moneyOn = true;
  slotPrice = TUNE.refSlotPrice;
  staff: { agents: number; screeners: number; handlers: number; officers?: number } = { agents: 14, screeners: 18, handlers: 16, officers: 0 };
  rep = 1.0;
  flights: Flight[] = [];
  pax: Pax[] = [];
  cars: Car[] = [];
  procs = new Map<number, Proc>();
  /** v0.57: level-of-service figures by zone id, today's so far and the last full day's (los.ts reads them). */
  los = new Map<number, LosStat>(); losLast = new Map<number, LosStat>();
  losStat(id: number) { let L = this.los.get(id); if (!L) { L = { peakQ: 0, peakWait: 0, in: new Array(24).fill(0) }; this.los.set(id, L); } return L; }
  rwFree = new Map<number, number>();
  gateBusy = new Map<string, Flight | null>();
  lotUsed = 0;
  roadLoad = new Float32Array(0);
  roadCap = new Float32Array(0);
  /** v0.47: at each road node, 0 none, 1 a crossroads or T and 2 a roundabout entry, where cars give way; for an entry,
   *  the ring edge that arrives at it; for a crossroads or T, the two edges that line up best (the main road, -1 if none);
   *  and the flow each gives way to (cars passing it, decaying over `YIELD.window`). */
  yieldKind = new Uint8Array(0); ringIn = new Int32Array(0); major = new Int32Array(0); yieldFlow = new Float32Array(0);
  /** v0.47: how many cars each approach (road edge end, `edge * 2 + (the end is v)`) can let through now */
  yieldCredit = new Float32Array(0);
  stats = emptyStats();
  plan!: PlanInfo;
  history: Report[] = [];
  /** v0.9: goals reached (saved), and a hook so the UI can celebrate one. */
  goalsDone = new Set<string>();
  onGoal?: (g: Goal) => void;
  /** v0.10: facilities unlock as traffic grows (best day's departures). Saved. Sandbox mode has everything. */
  unlocked = new Set<UnlockId>(); bestPax = 0;
  onUnlock?: (u: Unlock) => void;
  /** v0.10: today's weather; an airline's open offer and the deals in force (saved). */
  weather: WeatherKind = 'clear';
  offer: Offer | null = null; deals: Record<string, Deal> = {};
  /** v0.60: the banks in force (saved) */
  banks: Bank[] = [];
  /** (No signing bonus unless the airline came asking: `bonus` is the offer's. One bank an airline and hour.) */
  addBank(airline: string, hour: number, n = BANK.n, bonus = 0) {
    const a = AIRLINES.find(q => q.id === airline); if (!a || a.intl) return false;
    this.banks = this.banks.filter(b => b.until > this.day);
    if (this.banks.some(b => b.airline === airline && b.hour === hour)) return false;
    this.banks.push({ id: this.banks.reduce((m, b) => Math.max(m, b.id), 0) + 1, airline, hour, n, until: this.day + BANK.days });
    if (this.moneyOn) this.money += bonus;
    this.note(`${a.name} will fly a bank of ${n} at ${this.clockOf(hour * 60)} from tomorrow, for ${BANK.days} days`);
    return true;
  }
  endBank(id: number) { this.banks = this.banks.filter(b => b.id !== id); }
  clockOf(min: number) { const h = Math.floor(min / 60) % 24, m = Math.floor(min % 60); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`; }
  onOffer?: (o: Offer) => void;
  dealOf(a: Airline) { const d = this.deals[a.id]; return d && d.until > this.day ? d : undefined; }
  acceptOffer() {
    const o = this.offer; if (!o) return; this.offer = null;
    if (o.kind === 'bank' && o.bank) { this.addBank(o.airline, o.bank.hour, o.bank.n, o.bonus); return; }
    this.deals[o.airline] = { mult: o.mult, feeMult: o.feeMult, until: this.day + o.days, kind: o.kind === 'base' ? 'base' : 'volume' };
    if (this.moneyOn) this.money += o.bonus;
    this.note(`Deal signed: ${o.title}`);
  }
  declineOffer() { if (this.offer) this.note(`Declined: ${this.offer.title}`); this.offer = null; }
  /** Now and then an airline that is happy here proposes something. Its own random stream, so the sim stays reproducible. */
  makeOffer(sat: number) {
    if (this.offer || sat < 78) return;
    const rr = rng(this.day * 104729 + 5); if (rr() > 0.4) return;
    const pool = AIRLINES.filter(a => !this.dealOf(a) && (!a.intl || (this.has('intl') && this.d.terminals.some(T => T.intl))) && a.id !== 'polaris');
    if (!pool.length) return;
    const a = pool[Math.floor(rr() * pool.length)];
    const volume = rr() < 0.55;
    const bonus = Math.round((2 + rr() * 4)) * 1e6;
    this.offer = volume
      ? { airline: a.id, kind: 'volume', title: `${a.name}: more flights for a lower fee`, mult: 1.4, feeMult: 0.75, bonus: 0, days: 10,
          text: `${a.name} will schedule 40% more flights here for the next 10 days if its slot fee drops 25%. More passengers through the terminal and the shops, less from each landing. Worth it if you have gates and lanes to spare.` }
      : { airline: a.id, kind: 'base', title: `${a.name}: a crew base`, mult: 1.2, feeMult: 1, bonus, days: 14,
          text: `${a.name} will base crews here: 20% more flights for 14 days and ${(bonus / 1e6).toFixed(0)} million dollars on signing. In return it expects 90% of flights on time; each day that falls short costs 1 million dollars.` };
    // v0.60: or a bank, from a carrier that connects its own flights
    { const pick = rr(), which = rr(); const sl = BANK.slots[Math.floor(which * BANK.slots.length)];
      if (pick < 0.35 && !a.intl && !this.banks.some(b => b.until > this.day && b.airline === a.id && b.hour === sl.hour))
      this.offer = { airline: a.id, kind: 'bank', bank: { hour: sl.hour, n: BANK.n }, title: `${a.name}: a ${sl.name.toLowerCase()} bank`, mult: 1, feeMult: 1, bonus: BANK.bonus, days: BANK.days,
        text: `${a.name} will land ${BANK.n} flights within ${BANK.window} minutes of ${this.clockOf(sl.hour * 60)}, hold them together and send them out again, every day for ${BANK.days} days, with ${(BANK.bonus / 1e6).toFixed(0)} million dollars on signing. About a third of their passengers change aircraft here and never see the kerb. It needs ${BANK.n} free stands at once, and the taxiways and concourse to move them.` }; }
    this.note(`Offer: ${this.offer.title}`); this.onOffer?.(this.offer);
  }
  has(id: UnlockId) { return !this.moneyOn || this.unlocked.has(id); }
  checkUnlocks() {
    for (const u of UNLOCKS) if (!this.unlocked.has(u.id) && this.bestPax >= u.at) {
      this.unlocked.add(u.id); this.note(`Unlocked: ${u.title}`); this.onUnlock?.(u);
    }
  }
  /** The first working facility of a kind (road where needed, and a way on foot to an open terminal). */
  facility(t: ZoneType): Zone | undefined { return this.d.zones.find(z => z.type === t && this.d.served.has(z.id)); }
  /** How much better access widens the catchment: buses, the AirTrain, a hotel, rental cars, rideshare, a garage. */
  accessBoost() {
    const B = GROWTH.boost; let b = 0;
    for (const t of ['bus', 'rideshare', 'rental', 'hotel', 'train'] as const) if (this.facility(t)) b += B[t];
    if (this.d.zones.some(z => z.type === 'parking' && (z.floors ?? 1) > 1 && this.d.roadOK.has(z.id))) b += B.garage;
    return 1 + b;
  }
  baseDemand() { return (this.population * TUNE.tripsPerCapita) / 365 * this.rep * this.accessBoost(); }
  log: { t: string; text: string; kind: 'info' | 'warn' | 'bad' }[] = [];
  wind: Wind = { from: SITE.windFrom, kt: SITE.windSpeed };
  dayWind = { shift: 0, gust: 1 };
  private ids = 1;
  private airCache = new Map<string, DJ>();
  private roadCache = new Map<number, DJ>();
  private noted = new Set<string>();
  private pending: { at: number; party: Party }[] = [];
  private openArr = new Map<number, Party>();
  private bagCounter: Record<number, number> = {};
  shopLoad = new Map<Shop, number>();
  shopDay = new Map<number, { visits: number; rev: number; own?: number }>();   // (own: visits to the building's own lots, not its food-court counters)
  /** Per lot (Shop.id): today's visits, revenue and, for duty free, passers; and yesterday's, for the heatmap. */
  lotDay = new Map<string, { visits: number; rev: number; passed: number }>();
  lotPrev = new Map<string, { visits: number; rev: number; passed: number }>();
  /** Today's footfall per concourse, in COMMERCE.binM bins along its long axis. Folded into zone.flow at day end. */
  flowDay = new Map<number, Flow>();
  onDayEnd?: (r: Report) => void;

  constructor(world: World, seed = 7) {
    this.world = world;
    this.r = rng(seed);
    this.relayout();
    this.startDay();
  }

  // ---------------------------------------------------------------- calendar
  get year() { return Math.floor(this.calDays / 364) + 1; }
  get week() { return Math.floor((this.calDays % 364) / 7) + 1; }
  get periodDays() { return this.year <= 3 ? 7 : this.year <= 8 ? 14 : 28; }
  get population() { return SITE.population * Math.pow(1 + SITE.growth, this.calDays / 364); }
  clock(t = this.t) { const m = Math.floor(t) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; }
  note(text: string, kind: 'info' | 'warn' | 'bad' = 'info') { this.log.unshift({ t: this.clock(), text, kind }); this.log.length = Math.min(this.log.length, 60); }
  noteOnce(text: string, kind: 'info' | 'warn' | 'bad' = 'bad') { if (!this.noted.has(text)) { this.noted.add(text); this.note(text, kind); } }
  spend(amount: number) { if (this.moneyOn) this.money -= amount; }
  canAfford(amount: number) { return !this.moneyOn || this.money >= amount; }

  // ---------------------------------------------------------------- layout changes
  relayout() {
    this.d = derive(this.world);
    this.airCache.clear(); this.roadCache.clear(); this.shopLoad.clear();
    for (const f of this.flights) f.route = undefined;   // (v0.58: the airfield's nodes are new ones)
    this.roadLoad = new Float32Array(this.d.road.edges.length);
    // v0.11: how much of its length each road edge can use. Traffic stops and starts at a crossroads or T, so an
    // edge that ends at one holds less; a roundabout keeps traffic moving, so its ring and its approaches do not lose any.
    const R = this.d.road;
    this.roadCap = new Float32Array(R.edges.length).fill(1);
    const stopAt = (n: number) => R.adj[n].length >= 3 && !R.adj[n].some(k => R.edges[k].kind === 'hwy' || isRingRef(R.edges[k].ref) || this.d.rampRefs.has(R.edges[k].ref));
    this.yieldKind = new Uint8Array(R.nodes.length); this.yieldFlow = new Float32Array(R.nodes.length); this.yieldCredit = new Float32Array(R.edges.length * 2).fill(YIELD.store); this.ringIn = new Int32Array(R.nodes.length).fill(-1); this.major = new Int32Array(R.nodes.length * 2).fill(-1);
    const dirOut = (k: number, n: number) => { const e = R.edges[k]; const o = R.nodes[e.u === n ? e.v : e.u], p = R.nodes[n]; const l = Math.hypot(o.x - p.x, o.y - p.y) || 1; return { x: (o.x - p.x) / l, y: (o.y - p.y) / l }; };
    for (let n = 0; n < R.nodes.length; n++) {
      const ring = R.adj[n].filter(k => isRingRef(R.edges[k].ref));
      if (ring.length) { const up = ring.find(k => R.edges[k].v === n); if (up !== undefined && R.adj[n].some(k => !isRingRef(R.edges[k].ref))) { this.yieldKind[n] = 2; this.ringIn[n] = up; } }
      else if (stopAt(n)) {
        this.yieldKind[n] = 1;
        let best = -0.866; // (the main road bends by less than 30° through the junction)
        const ks = R.adj[n];
        for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++) {
          const a = dirOut(ks[i], n), b = dirOut(ks[j], n), dot = a.x * b.x + a.y * b.y;
          if (dot < best) { best = dot; this.major[n * 2] = ks[i]; this.major[n * 2 + 1] = ks[j]; }
        }
      }
    }
    const keep = new Map(this.procs);
    this.procs.clear();
    for (const z of this.d.zones) {
      if (!['checkin', 'security', 'claim', 'curb', 'passport'].includes(z.type)) continue;
      const old = keep.get(z.id);
      const frame = this.d.frames.get(z.id)!;
      const n = unitsOf(this.d, z);
      const p: Proc = old ?? { zone: z, type: z.type, frame, servers: 0, maxServers: n, queue: [], busy: [], served: 0, waitSum: 0, recentWait: 0 };
      p.zone = z; p.frame = frame; p.maxServers = n;
      if (z.type === 'curb') { p.cars = old?.cars ?? []; p.bays = resize(old?.bays ?? [], n, null); }
      if (z.type === 'claim') p.carousels = resize(old?.carousels ?? [], n, null);
      this.procs.set(z.id, p);
    }
    // Road edge ids changed: cars finish their current trips without congestion data.
    for (const c of this.cars) {
      c.eids = c.eids.map(() => -1);
      if (c.curb && !this.procs.has(c.curb.zone.id)) {
        c.stage = 'gone';
        for (const q of c.party.pax) if (q.stage !== 'done') { if (c.pick) { q.stage = 'walk'; this.advance(q); } else { this.pax.push(q); this.miss(q); } }
      }
    }
    // Flights keep their gate by id when it still exists
    const gateIds = new Set(this.d.gates.map(g => g.id));
    for (const f of this.flights) {
      if (f.state === 'gone' || f.state === 'cancelled') continue;
      if (!gateIds.has(f.gate.id)) {
        const free = this.d.gates.find(g => this.d.gateUsable(g, f.cls) && !this.gateBusy.get(g.id) &&
          !this.flights.some(o => o !== f && o.gate.id === g.id && o.state !== 'gone' && o.state !== 'cancelled' && Math.abs(o.schedArr - f.schedArr) < 60));
        if (free) f.gate = free; else this.cancel(f, 'its gate was demolished');
      } else f.gate = this.d.gates.find(g => g.id === f.gate.id)!;
    }
    for (const id of [...this.gateBusy.keys()]) if (!gateIds.has(id)) this.gateBusy.delete(id);
    for (const f of this.flights) {
      if (!f.rw || f.state === 'gone' || f.state === 'cancelled') continue;
      const r = this.d.runways.find(x => x.rw.id === f.rw!.rw.id);
      if (r) f.rw = r;
      else if (f.state === 'approach' || f.state === 'roll' || f.state === 'takeoff') { this.cancel(f, 'its runway was closed'); continue; }
      if (f.state === 'roll' && f.path.length) {
        f.exitNode = nearestNode(this.d.air, f.path[f.path.length - 1], 8);
        // (v0.55: the exit it was rolling to is gone, the runway shortened under it: it leaves by the nearest node still on the runway)
        if (f.exitNode < 0 && r) { const q = f.path[f.path.length - 1], a = r.rw.a, b = r.rw.b, ab = { x: b.x - a.x, y: b.y - a.y };
          const t = Math.max(0, Math.min(1, ((q.x - a.x) * ab.x + (q.y - a.y) * ab.y) / (ab.x * ab.x + ab.y * ab.y || 1)));
          const on = { x: a.x + ab.x * t, y: a.y + ab.y * t }; f.path[f.path.length - 1] = on; f.exitNode = nearestNode(this.d.air, on, 400); }
      }
    }
    // People re-plan: their routes may run through something that changed.
    for (const p of this.pax) {
      if (p.stage === 'done') continue;
      if (p.proc && !this.procs.has(p.proc.zone.id)) { p.proc = undefined; p.stage = 'walk'; this.advance(p); }
      else if (p.stage === 'walk' || p.stage === 'stuck') { p.stage = 'walk'; this.advance(p); }
    }
    this.allocateStaff();
    this.lotUsed = Math.min(this.lotUsed, this.lotCapacity());
    this.checkGoals();
  }

  /** Pay out any goal just reached. Runs after every layout change and when a day closes. */
  checkGoals() {
    for (const g of checkGoals(this, this.goalsDone)) {
      this.goalsDone.add(g.id);
      if (this.moneyOn) this.money += g.reward;
      this.note(`Goal reached: ${g.title}`);
      this.onGoal?.(g);
    }
  }

  lotCapacity() { return this.d.zones.filter(z => z.type === 'parking').reduce((s, z) => s + unitsOf(this.d, z), 0); }

  /** Open or close desks. Someone being served at a desk that closes goes back to the head of the line (v0.57: they
   *  were left standing at it for good). */
  setDesks(p: Proc, n: number) {
    for (let i = p.busy.length - 1; i >= n; i--) { const b = p.busy[i]; if (b) { b.stage = 'queue'; p.queue.unshift(b); } }
    p.busy = resize(p.busy, n, null);
  }
  /** Staff go where today's passengers are: each terminal's share of departing passengers, split by desk count inside it. */
  allocateStaff() {
    const load = new Map<Terminal | undefined, number>();
    for (const f of this.flights) if (f.state !== 'cancelled') { const T = this.termOf(f); load.set(T, (load.get(T) ?? 0) + f.paxDep); }
    const share = (type: ZoneType, pool: number) => {
      const ps = [...this.procs.values()].filter(p => p.type === type);
      const inT = (p: Proc) => ps.filter(q => this.d.termOf.get(q.zone.id) === this.d.termOf.get(p.zone.id)).reduce((s, q) => s + q.maxServers, 0) || 1;
      let wts = ps.map(p => (load.get(this.d.termOf.get(p.zone.id)) ?? 0) * p.maxServers / inT(p));
      if (!wts.some(x => x > 0)) wts = ps.map(p => p.maxServers);
      const tot = wts.reduce((s, x) => s + x, 0) || 1;
      // v0.57: a module with its dial set takes that many first (in the order they were built); the rest are shared as before
      if (ps.some(p => p.zone.staff !== undefined)) {
        let left = pool; const auto: number[] = [];
        ps.forEach((p, i) => { if (p.zone.staff === undefined) { auto.push(i); return; } const a = clamp(Math.min(p.zone.staff, left), 0, p.maxServers); left -= a; p.servers = a; this.setDesks(p, a); });
        const at = auto.reduce((s, i) => s + wts[i], 0) || 1; const pool2 = left;
        auto.forEach((i, k) => { const p = ps[i]; const a = k === auto.length - 1 ? left : Math.min(left, Math.round(pool2 * wts[i] / at)); left -= a; p.servers = clamp(a, 0, p.maxServers); this.setDesks(p, p.servers); });
        return;
      }
      let left = pool;
      ps.forEach((p, i) => {
        const a = i === ps.length - 1 ? left : Math.round(pool * wts[i] / tot);
        left -= a;
        p.servers = clamp(a, 0, p.maxServers);
        this.setDesks(p, p.servers);
      });
    };
    share('checkin', this.staff.agents);
    share('security', Math.floor(this.staff.screeners / TUNE.screenersPerLane));
    share('passport', this.staff.officers ?? 0);
    for (const p of this.procs.values()) if (p.type === 'curb' || p.type === 'claim') p.servers = p.maxServers;
  }

  // ---------------------------------------------------------------- daily plan (demand -> schedule)
  startDay() {
    this.t = DAY_START;
    if (this.los.size) this.losLast = this.los; this.los = new Map();
    if (this.ground.size || this.flights.length) this.groundLast = this.ground; this.ground = new Map();
    this.flights = []; this.pax = []; this.cars = []; this.pending = [];
    this.openArr.clear(); this.bagCounter = {}; this.noted.clear(); this.shopLoad.clear(); this.shopDay.clear(); this.lotDay.clear(); this.flowDay.clear();
    this.gateBusy.clear(); this.rwFree.clear();
    for (const p of this.procs.values()) {
      p.queue = []; p.busy = p.busy.map(() => null); p.served = 0; p.waitSum = 0; p.recentWait = 0;
      if (p.bays) p.bays = p.bays.map(() => null);
      if (p.cars) p.cars = [];
      if (p.carousels) p.carousels = p.carousels.map(() => null);
    }
    this.stats = emptyStats();
    this.dayWind = { shift: (this.r() - 0.5) * 50, gust: 0.65 + this.r() * 0.9 };
    // weather draws from its own stream, so it never shifts the rest of the day's dice
    { const x = rng(this.day * 7919 + 13)(); let c = 0; this.weather = 'clear';
      if (this.day > 0) for (const k of ['clear', 'rain', 'fog', 'snow'] as const) { c += WEATHER[k].p; if (x < c) { this.weather = k; break; } }
      if (WEATHER[this.weather].note) this.note(WEATHER[this.weather].note, 'warn'); }
    this.lotUsed = Math.round(this.lotCapacity() * 0.55);
    this.plan = this.schedule();
    this.allocateStaff();
  }

  /** Flights per day each airline wants at a given slot fee (before capacity limits). */
  demandAt(price: number) {
    const D = this.baseDemand();
    const lf = 0.8;
    return AIRLINES.filter(a => !a.intl || this.has('intl')).map(a => {
      let n = 0;
      for (const [c, share] of Object.entries(a.mix)) n += (a.share * D * (share as number)) / (CLASSES[Number(c)].seats * lf);
      const deal = this.dealOf(a);
      return { airline: a, n: n * Math.pow((price * (deal?.feeMult ?? 1)) / TUNE.refSlotPrice, -a.elasticity) * (deal?.mult ?? 1) };
    });
  }

  schedule(): PlanInfo {
    const d = this.d;
    const D = this.baseDemand();
    const lfRef = clamp(0.66 + 0.18 * this.rep, 0.6, 0.93);
    const plan: PlanInfo = {
      demand: 0, byAirline: [], rejectedGates: 0, rejectedRunway: 0, rejectedAircraft: 0, rejectedIntl: 0, wantsSJ: 0,
      scheduled: 0, limit: '', loadFactor: lfRef, bankAsked: 0, bankLost: 0,
    };
    const operable = [0, 1, 2, 3].map(c => d.gates.some(g => d.gateUsable(g, c)));
    type Cand = { airline: Airline; cls: Cls; arr: number; bank?: Bank; k?: number };
    const cands: Cand[] = [];
    const intlOK = d.terminals.some(T => T.intl);
    for (const a of AIRLINES) {
      if (a.intl && !this.has('intl')) continue;   // not asking yet
      const row = { airline: a, requested: 0, scheduled: 0 };
      plan.byAirline.push(row);
      const deal = this.dealOf(a);
      const priceF = Math.pow((this.slotPrice * (deal?.feeMult ?? 1)) / TUNE.refSlotPrice, -a.elasticity) * (deal?.mult ?? 1);
      for (const [cs, share] of Object.entries(a.mix)) {
        const c = Number(cs) as Cls;
        const x = (a.share * D * (share as number) * priceF) / (CLASSES[c].seats * 0.8);
        const n = Math.floor(x) + (this.r() < x - Math.floor(x) ? 1 : 0);
        row.requested += n;
        for (let i = 0; i < n; i++) {
          if (a.intl && !intlOK) { plan.rejectedIntl++; continue; }
          let use: number = operable[c] ? c : -1;
          if (use < 0 && a.downgrade) for (let k = c - 1; k >= 0; k--) if (a.mix[k as Cls] !== undefined && operable[k]) { use = k; break; }
          if (use < 0) { plan.rejectedAircraft++; if (c === 3) plan.wantsSJ++; continue; }
          let h: number;
          if (this.r() < 0.3) h = 6 + this.r() * 15.5;
          else { const peak = [7.4, 12.6, 17.6][Math.floor(this.r() * 3)]; h = peak + gauss(this.r) * 1.25; }
          cands.push({ airline: a, cls: use as Cls, arr: Math.round(clamp(h, 6, 21.5) * 60) });
        }
      }
    }
    plan.demand = plan.byAirline.reduce((s, b) => s + b.requested, 0);
    // v0.60: banks. Each asks for its wave on top of the day's ordinary demand: `n` landings spread over the window,
    // all on the ground together, then away one after another. (No dice: a day with no bank is the day it always was.)
    for (const b of this.banks) {
      if (b.until <= this.day) continue; const a = AIRLINES.find(q => q.id === b.airline); if (!a || a.intl) continue;
      { const row = plan.byAirline.find(q => q.airline === a); if (row) row.requested += b.n; }
      const main = Number(Object.entries(a.mix).sort((p, q) => (q[1] as number) - (p[1] as number))[0][0]) as Cls;
      let use: number = operable[main] ? main : -1;
      if (use < 0 && a.downgrade) for (let k = main - 1; k >= 0; k--) if (a.mix[k as Cls] !== undefined && operable[k]) { use = k; break; }
      for (let i = 0; i < b.n; i++) { plan.bankAsked++; if (use < 0) { plan.rejectedAircraft++; plan.bankLost++; continue; } cands.push({ airline: a, cls: use as Cls, arr: Math.round(b.hour * 60 + (i + 0.5) * BANK.window / b.n), bank: b, k: i }); }
    }
    cands.sort((a, b) => a.arr - b.arr);
    const prevailing: Wind = { from: SITE.windFrom, kt: SITE.windSpeed };
    const usable = d.runways.filter(r => r.cls >= 0 && runwayUsable(r, prevailing));
    const capHr = this.capacityPerHour(usable.length ? usable : d.runways.filter(r => r.cls >= 0).slice(0, 1)) * WEATHER[this.weather].cap;
    const perHour = new Map<number, number>();
    const gateFree = new Map<string, number>(); const bankTerm = new Map<number, Terminal>();
    const flightNo = new Map<string, number>();
    for (const c of cands) {
      const ac = CLASSES[c.cls];
      const dep = c.bank ? Math.max(c.arr + ac.turn + 5, Math.round(c.bank.hour * 60 + BANK.window + BANK.connect + (c.k ?? 0) * BANK.stagger)) : c.arr + ac.turn + 5;
      const hA = Math.floor(c.arr / 60), hD = Math.floor(dep / 60);
      if ((perHour.get(hA) ?? 0) + 1 > capHr || (perHour.get(hD) ?? 0) + 1 > capHr) { plan.rejectedRunway++; if (c.bank) plan.bankLost++; continue; }
      const open = d.terminals.filter(T => T.active);
      const home = open.length ? open[AIRLINES.indexOf(c.airline) % open.length] : undefined;
      // (v0.60: a bank keeps to the terminal its first flight was given, so its passengers can walk between its gates)
      const mine = c.bank ? bankTerm.get(c.bank.id) ?? home : home;
      const rank = (g: Gate) => g.cls * 10 + (d.termOf.get(g.zone.id) === mine ? 0 : c.bank ? 5 : 1);
      const gate = d.gates.filter(g => d.gateUsable(g, c.cls) && (!c.airline.intl || d.termOf.get(g.zone.id)?.intl)).sort((p, q) => rank(p) - rank(q)).find(g => (gateFree.get(g.id) ?? 0) + 8 <= c.arr);
      if (!gate) { plan.rejectedGates++; if (c.bank) plan.bankLost++; continue; }
      gateFree.set(gate.id, dep); if (c.bank && !bankTerm.has(c.bank.id)) { const T = d.termOf.get(gate.zone.id); if (T) bankTerm.set(c.bank.id, T); }
      perHour.set(hA, (perHour.get(hA) ?? 0) + 1); perHour.set(hD, (perHour.get(hD) ?? 0) + 1);
      const no = (flightNo.get(c.airline.iata) ?? (100 + Math.floor(this.r() * 300))) + 7;
      flightNo.set(c.airline.iata, no);
      const lf = clamp(lfRef + (this.r() - 0.5) * 0.14, 0.4, 0.98);
      this.flights.push({
        id: this.ids++, code: `${c.airline.iata} ${no}`, airline: c.airline, ac, cls: c.cls, schedArr: c.arr, schedDep: dep, gate,
        paxDep: Math.round(ac.seats * lf), paxArr: Math.round(ac.seats * clamp(lf + (this.r() - 0.5) * 0.1, 0.4, 0.98)),
        state: 'pending', path: [], d: 0, len: 0, speed: 0, fromA: true, landT: 0, standT: 0, readyT: 0, pushT: 0, holdSince: 0, exitNode: -1,
        x: 0, y: 0, ang: 0, alt: 0, bagsArr: 0, bagsDone: 0, carousel: -1, boarded: 0, deplaned: 0, spawnedDep: false,
      });
      if (c.bank) this.flights[this.flights.length - 1].bank = c.bank.id;
      plan.byAirline.find(b => b.airline === c.airline)!.scheduled++;
    }
    // v0.60: who connects to what. A share of each bank flight's arriving passengers go on by another flight of the
    // same bank, shared out in turn; a departure takes only so many of its seats from connections.
    for (const b of this.banks) {
      const F = this.flights.filter(f => f.bank === b.id); if (F.length < 2) continue;
      F.forEach((X, i) => { X.xferOut = []; const n = Math.round(X.paxArr * BANK.share);
        for (let k = 0, j = 0; k < n && j < n * 4; j++) { const Y = F[(i + 1 + (j % (F.length - 1))) % F.length];
          // (only to a gate in the same terminal: there is no walking airside from one terminal to another)
          if (d.termOf.get(Y.gate.zone.id) !== d.termOf.get(X.gate.zone.id)) continue;
          if ((Y.xferIn ?? 0) + 1 > Y.paxDep * BANK.maxIn) continue; Y.xferIn = (Y.xferIn ?? 0) + 1; X.xferOut.push(Y); k++; } });
    }
    for (const f of this.flights) f.bagsArr = Math.round((f.paxArr - (f.xferOut?.length ?? 0)) * 0.62);
    plan.scheduled = this.flights.length;
    const lost = plan.rejectedGates + plan.rejectedRunway + plan.rejectedAircraft + plan.rejectedIntl;
    plan.limit = !d.runways.length ? 'No runway' : !d.gates.length ? 'No gates' : !operable.some(Boolean) ? 'No connected gates'
      : lost === 0 ? 'Demand' : plan.rejectedIntl > Math.max(plan.rejectedGates, plan.rejectedRunway, plan.rejectedAircraft) ? 'Passport control' : plan.rejectedAircraft >= Math.max(plan.rejectedGates, plan.rejectedRunway) ? 'Aircraft size'
      : plan.rejectedGates >= plan.rejectedRunway ? 'Gates' : 'Runway capacity';
    return plan;
  }

  capacityPerHour(rs: RunwayInfo[]) {
    if (!rs.length) return 0;
    // v0.63: each runway's rate follows its exits (the FAA's exit factor)
    const per0 = 60 / TUNE.separationMin;
    let cap = per0 * runwayExits(this.d, rs[0]).factor;
    for (let i = 1; i < rs.length; i++) {
      const per = per0 * runwayExits(this.d, rs[i]).factor;
      const par = rs.slice(0, i).some(o => Math.abs(o.dir.x * rs[i].dir.x + o.dir.y * rs[i].dir.y) > 0.996);
      const sep = par ? Math.min(...rs.slice(0, i).map(o => Math.abs((rs[i].rw.a.x - o.rw.a.x) * o.normal.x + (rs[i].rw.a.y - o.rw.a.y) * o.normal.y))) : 0;
      cap += par ? (sep >= TUNE.dependentSpacing ? per : per * 0.45) : per * 0.35;
    }
    return Math.floor(cap);
  }

  // ---------------------------------------------------------------- main step
  step(dt: number) {
    const t0 = this.t;
    this.t += dt;
    this.updateWind();
    this.updateFlights(dt);
    this.spawnDepartures(t0, this.t);
    this.updateCars(dt);
    this.updatePax(dt);
    this.updateProcs();
    this.updateBags(dt);
    if (Math.floor(this.t) !== Math.floor(t0)) this.sampleLos();
    if (this.t >= DAY_END) this.endDay();
  }

  updateWind() {
    const ph = (this.t / 1440) * Math.PI * 2;
    this.wind = {
      from: (SITE.windFrom + this.dayWind.shift + SITE.windSpread * Math.sin(ph + this.day) + 360) % 360,
      kt: Math.max(2, (SITE.windSpeed + 7 * Math.sin(ph + 1.3)) * this.dayWind.gust),
    };
  }

  usableRunways() { return this.d.runways.filter(r => runwayUsable(r, this.wind)); }

  /** Runways this flight may use now: long enough, open in this wind, and connected to its gate. */
  rwyOK(f: Flight) { return (r: RunwayInfo) => r.cls >= f.cls && f.gate.rwys[f.cls].has(r.rw.id) && runwayUsable(r, this.wind); }

  bookRunway(earliest: number, ok: (r: RunwayInfo) => boolean): { rw: RunwayInfo; t: number } | null {
    const rs = this.d.runways.filter(ok);
    if (!rs.length) return null;
    let best = rs[0], bt = Infinity;
    for (const r of rs) { const tt = Math.max(earliest, this.rwFree.get(r.rw.id) ?? 0); if (tt < bt) { bt = tt; best = r; } }
    return { rw: best, t: this.bookOn(best, earliest) };
  }

  bookOn(best: RunwayInfo, earliest: number): number {
    const bt = Math.max(earliest, this.rwFree.get(best.rw.id) ?? 0);
    this.rwFree.set(best.rw.id, bt + TUNE.separationMin / runwayExits(this.d, best).factor);
    for (const o of this.d.runways) {
      if (o === best) continue;
      const par = Math.abs(o.dir.x * best.dir.x + o.dir.y * best.dir.y) > 0.996;
      const sep = Math.abs((o.rw.a.x - best.rw.a.x) * best.normal.x + (o.rw.a.y - best.rw.a.y) * best.normal.y);
      if (!par || sep < TUNE.dependentSpacing) this.rwFree.set(o.rw.id, Math.max(this.rwFree.get(o.rw.id) ?? 0, bt + (par ? 0.9 : 1.3)));
    }
    return bt;
  }

  landingFromA(r: RunwayInfo) {
    const diff = Math.abs(((this.wind.from - r.heading + 540) % 360) - 180);
    return diff <= 90;
  }

  /** Taxi routing tree toward `node` for a class (runway back-taxi allowed but discouraged). */
  airDJ(node: number, cls: number): DJ {
    const key = `${node}:${cls}`;
    let dj = this.airCache.get(key);
    if (!dj) { dj = dijkstra(this.d.air, [{ n: node, c: 0 }], e => e.cls >= cls, e => (e.kind === 'rwy' ? e.len * 4 : e.len)); this.airCache.set(key, dj); }
    return dj;
  }

  // ---------------------------------------------------------------- aircraft
  updateFlights(dt: number) {
    const t = this.t;
    this.onGround = this.flights.filter(o => o.state === 'taxiIn' || o.state === 'taxiOut' || o.state === 'holdDep' || (o.state === 'takeoff' && t < o.landT));   // (one waiting for its stand is passed, as before: it waits off the lane)
    for (const f of this.flights) {
      switch (f.state) {
        case 'pending':
          if (t >= f.schedArr - 3) { f.state = 'hold'; f.holdSince = t; }
          break;
        case 'hold': {
          const slot = this.bookRunway(Math.max(t + 3, f.schedArr), this.rwyOK(f));
          if (slot) this.beginApproach(f, slot.rw, slot.t);
          else if (t - f.holdSince > 75) this.cancel(f, 'diverted: no usable runway connected to its gate');
          break;
        }
        case 'approach': case 'roll': case 'taxiIn': case 'taxiOut': case 'takeoff':
          this.move(f, dt);
          break;
        case 'waitGate':
          if (!this.gateBusy.get(f.gate.id)) { this.gateBusy.set(f.gate.id, f); this.setPath(f, [{ x: f.x, y: f.y }, f.gate.stand], TUNE.taxiSpeed * 0.3); f.route = undefined; f.state = 'taxiIn'; }
          break;
        case 'stand':
          this.atStand(f);
          break;
        case 'holdDep': {
          const ok = this.rwyOK(f);
          if (f.rw && ok(f.rw)) { f.landT = this.bookOn(f.rw, t); f.state = 'takeoff'; this.takeoffPath(f); }
          else {
            const alt = this.d.runways.filter(ok);
            if (alt.length) this.taxiToRunway(f, alt[0], false);
            else if (!f.holdSince || f.holdSince < f.pushT) f.holdSince = t;
            else if (t - f.holdSince > 90) this.cancel(f, 'held too long: no usable runway');
          }
          break;
        }
      }
    }
  }

  setPath(f: Flight, pts: Pt[], speed: number) { f.path = pts; f.d = 0; f.len = polyLen(pts); f.speed = speed; const a = along(pts, 0); f.x = a.p.x; f.y = a.p.y; f.ang = a.ang; }

  move(f: Flight, dt: number) {
    const t = this.t;
    if (f.state === 'approach') {
      const k = clamp(1 - (f.landT - t) / 4, 0, 1);
      const a = along(f.path, k * f.len); f.x = a.p.x; f.y = a.p.y; f.ang = a.ang; f.alt = 1 - k;
      if (t >= f.landT) { f.alt = 0; this.rollOut(f); }
      return;
    }
    if (f.state === 'takeoff') {
      const k = clamp((t - f.landT) / 2.2, 0, 1);
      const a = along(f.path, Math.pow(k, 1.6) * f.len); f.x = a.p.x; f.y = a.p.y; f.ang = a.ang; f.alt = Math.max(0, (k - 0.35) / 0.65);
      if (k >= 1) { f.state = 'gone'; this.gateBusy.forEach((v, key) => { if (v === f) this.gateBusy.set(key, null); }); }
      return;
    }
    const want = f.speed * dt; const go = f.state === 'taxiIn' || f.state === 'taxiOut' ? this.clearAhead(f, want, dt) : want;
    f.d += go;
    const a = along(f.path, f.d); f.x = a.p.x; f.y = a.p.y; if (go > 0.01 || !(f.state === 'taxiIn' || f.state === 'taxiOut')) f.ang = a.ang;
    if (f.d < f.len) return;
    if (f.state === 'taxiIn' || f.state === 'taxiOut') this.taxiDone(f);
    if (f.state === 'roll') { this.taxiIn(f); return; }
    if (f.state === 'taxiIn') {
      const end = f.path[f.path.length - 1];
      if (end !== f.gate.stand) {
        const busy = this.gateBusy.get(f.gate.id);
        if (busy && busy !== f) { f.state = 'waitGate'; return; }
        this.gateBusy.set(f.gate.id, f);
        this.setPath(f, [{ x: f.x, y: f.y }, f.gate.stand], TUNE.taxiSpeed * 0.3); f.route = undefined;
        return;
      }
      this.gateBusy.set(f.gate.id, f);
      f.state = 'stand'; f.standT = t; f.ang = f.gate.ang;
      f.readyT = Math.max(f.schedDep, t + f.ac.turn);
      const late = f.landT - f.schedArr;
      if (late > 15) this.note(`${f.code} on stand ${f.gate.num}, ${Math.round(late)} min late`, 'warn');
      return;
    }
    if (f.state === 'taxiOut') { f.state = 'holdDep'; return; }
  }

  // ---------------------------------------------------------------- ground traffic (v0.58)
  /** v0.58: how the airfield's day is going, by taxiway (way id; 0 for taxilanes and runways): minutes aircraft stood there, and stand-offs. */
  ground = new Map<number, { min: number; so: number }>(); groundLast = new Map<number, { min: number; so: number }>();
  private onGround: Flight[] = [];
  private groundAt(f: Flight) {
    let ref = 0, bd = 60; const p = { x: f.x, y: f.y };
    for (const e of this.d.air.edges) { if (e.kind !== 'taxi' || e.ref <= 0) continue; const d = segDist(p, this.d.air.nodes[e.u], this.d.air.nodes[e.v]); if (d < bd) { bd = d; ref = e.ref; } }
    let g = this.ground.get(ref); if (!g) { g = { min: 0, so: 0 }; this.ground.set(ref, g); } return g;
  }
  private taxiStart(f: Flight) { f.held = false; f.heldBy = undefined; f.heldT = undefined; f.faceT = undefined; f.hold = 0; f.taxiT = this.t; }
  private taxiDone(f: Flight) {
    if (f.taxiT === undefined) return;
    const g = this.stats.ground; g.moves++; g.taxi += this.t - f.taxiT; f.taxiT = undefined; f.held = false; f.route = undefined;
  }
  /** The directed stretches other taxiing aircraft still have ahead of them (from * N + to). */
  private claimed(me: Flight, skip?: (o: Flight) => boolean) {
    const N = this.d.air.nodes.length; const set = new Set<number>();
    for (const o of this.flights) {
      if (o === me || !o.route || (o.state !== 'taxiIn' && o.state !== 'taxiOut') || skip?.(o)) continue;
      // (from the node it is next bound for: walk its path to where it is)
      const off = o.path.length - o.route.length; let acc = 0, i = 1;
      for (; i < o.path.length; i++) { acc += dist(o.path[i - 1], o.path[i]); if (acc > o.d) break; }
      for (let k = Math.max(1, i - off); k < o.route.length; k++) set.add(o.route[k - 1] * N + o.route[k]);
      if (i - off >= 1 && i - off < o.route.length) set.add(o.route[i - off - 1] * N + o.route[i - off]);
    }
    return set;
  }
  /** A taxi route from `start` to `target`: the shortest, but a stretch another aircraft is about to come down the
   *  other way costs far more, so a second taxiway is taken where there is one. `opposed` counts such stretches left on it. */
  taxiRoute(f: Flight, start: number, target: number, skip?: (o: Flight) => boolean): { nodes: number[]; opposed: number } | null {
    const air = this.d.air; const N = air.nodes.length; const opp = this.claimed(f, skip);
    let dj = this.airDJ(target, f.cls);
    if (opp.size) dj = dijkstra(air, [{ n: target, c: 0 }], e => e.cls >= f.cls, undefined, 0,
      (e, from, to) => { const L = e.kind === 'rwy' ? e.len * 4 : e.len; return opp.has(to * N + from) ? L * GROUND.oppCost + GROUND.oppFlat : L; });
    if (start < 0 || !isFinite(dj.dist[start])) return null;
    const nodes = trace(air, dj, start).nodes; let opposed = 0;
    for (let k = 1; k < nodes.length; k++) if (opp.has(nodes[k] * N + nodes[k - 1])) opposed++;
    return { nodes, opposed };
  }
  /** How far a taxiing aircraft may move this step (at most `want`): it keeps its distance behind whoever is ahead,
   *  gives way where paths cross, and stops nose to nose with one coming the other way until a tug clears them. */
  clearAhead(f: Flight, want: number, dt: number): number {
    const t = this.t;
    if (f.freeT !== undefined && t < f.freeT) { f.held = false; return want; }
    const gap = GROUND.gap + f.ac.length, look = want + gap + 30, R = GROUND.reach;
    const taxi = (o: Flight) => o.state === 'taxiIn' || o.state === 'taxiOut';
    const prio = (o: Flight) => (o.state === 'taxiIn' ? 0 : 1e6) + o.id;
    let lim = want, facing: Flight | null = null, by = -1;
    for (const o of this.onGround) {
      if (o === f || f.pass?.has(o.id)) continue;
      // (the one leaving a stand and the one that waited for it pass each other: the swap is the stand's own business)
      if (o.gate === f.gate && (!o.route || !f.route)) continue;
      const dx = o.x - f.x, dy = o.y - f.y; if (dx * dx + dy * dy > (look + R) * (look + R)) continue;
      let hit = -1, ang = 0;
      for (let q = 8; q <= look; q += 8) {
        if (f.d + q > f.len + 1) break;
        const a = along(f.path, f.d + q); if (Math.hypot(a.p.x - o.x, a.p.y - o.y) < R) { hit = q; ang = a.ang; break; }
      }
      if (hit < 0) continue;
      const dot = Math.cos(ang - o.ang); const room = Math.max(0, hit - gap);
      if (taxi(o) && dot < -0.3) { if (room < lim) { lim = room; facing = o; by = o.id; } }
      // (one that stands because of this aircraft is not given way to in turn)
      else if (!taxi(o) || (o.held && o.heldBy !== f.id) || dot > 0.5 || prio(o) < prio(f)) { if (room < lim) { lim = room; facing = null; by = o.id; } }
    }
    if (lim >= want) { f.held = false; f.heldBy = undefined; f.heldT = undefined; f.faceT = undefined; return want; }
    const lost = (want - lim) / Math.max(1, f.speed);
    f.hold = (f.hold ?? 0) + lost; this.stats.ground.hold += lost; this.groundAt(f).min += lost;
    void dt;
    if (lim > 0.01) { f.held = false; f.heldBy = undefined; f.heldT = undefined; return lim; }
    f.held = true; f.heldBy = by; f.heldT ??= t;
    if (facing) {
      f.faceT ??= t;
      if (t - f.faceT >= GROUND.standoff) {
        (f.pass ??= new Set()).add(facing.id); (facing.pass ??= new Set()).add(f.id); f.faceT = undefined; facing.faceT = undefined;
        this.stats.ground.standoffs++; this.groundAt(f).so++;
        this.noteOnce(`${f.code} and ${facing.code} met head-on on a taxiway: a tug cleared them after ${GROUND.standoff} min. A second taxiway would let them pass.`, 'warn');
      }
    } else f.faceT = undefined;
    if (t - f.heldT >= GROUND.maxHold) { f.freeT = t + 1.5; f.heldT = undefined; f.heldBy = undefined; this.stats.ground.tows++; }
    return 0;
  }

  beginApproach(f: Flight, rw: RunwayInfo, at: number) {
    f.rw = rw; f.fromA = this.landingFromA(rw); f.landT = at;
    const th = f.fromA ? rw.rw.a : rw.rw.b; const dir = f.fromA ? rw.dir : mul(rw.dir, -1);
    this.setPath(f, [add(th, mul(dir, -6500)), add(th, mul(dir, 120))], 0);
    f.state = 'approach';
  }

  rollOut(f: Flight) {
    const rw = f.rw!; const th = f.fromA ? rw.rw.a : rw.rw.b; const dir = f.fromA ? rw.dir : mul(rw.dir, -1);
    const dj = this.airDJ(f.gate.frontNode, f.cls);
    let best = -1, bs = Infinity, bS = 0;
    for (const { n, s } of rw.nodes) {
      const s2 = f.fromA ? s : rw.length - s;
      if (s2 < f.ac.minRoll || !isFinite(dj.dist[n])) continue;
      const sc = s2 * 0.25 + dj.dist[n];
      if (sc < bs) { bs = sc; best = n; bS = s2; }
    }
    if (best < 0) { this.cancel(f, 'no taxiway from the runway to its gate'); return; }
    f.exitNode = best;
    this.setPath(f, [add(th, mul(dir, 120)), add(th, mul(dir, bS))], 0);
    f.speed = Math.max(250, f.len / 1.1);
    f.state = 'roll';
  }

  taxiIn(f: Flight) {
    const air = this.d.air;
    const dj = this.airDJ(f.gate.frontNode, f.cls);
    if (f.exitNode < 0 || !isFinite(dj.dist[f.exitNode])) { this.cancel(f, 'taxi route to its gate was removed'); return; }
    const tr = this.taxiRoute(f, f.exitNode, f.gate.frontNode) ?? { nodes: trace(air, dj, f.exitNode).nodes };
    this.setPath(f, [{ x: f.x, y: f.y }, ...tr.nodes.map(n => air.nodes[n])], TUNE.taxiSpeed);
    f.route = tr.nodes; f.state = 'taxiIn'; this.taxiStart(f);
  }

  atStand(f: Flight) {
    const t = this.t;
    if (f.deplaned < f.paxArr && t >= f.standT + 2) {
      const due = Math.min(f.paxArr, Math.floor((t - f.standT - 2) / 0.08));
      while (f.deplaned < due) { const Y = f.xferOut?.pop(); if (Y) this.spawnTransfer(f, Y); else this.spawnArrival(f); f.deplaned++; }
      if (f.deplaned >= f.paxArr) { const op = this.openArr.get(f.id); if (op) { op.atCurb = 0; this.openArr.delete(f.id); this.tryPickup(op); } }
    }
    if (!f.claim && f.bagsArr > 0) this.assignCarousel(f);
    if (t >= f.readyT - 20) for (const p of this.pax) if (p.flight === f && p.dep && p.stage === 'dwell') this.board(p);
    const remaining = this.pax.some(p => p.flight === f && p.dep && p.stage !== 'done');
    if (t >= f.readyT && (!remaining || t >= f.readyT + 2)) {
      if (!f.released) {
        f.released = true;
        for (const p of this.pax) if (p.flight === f && p.dep && p.stage !== 'done') this.miss(p);
        const delay = t - f.schedDep;
        this.stats.flights++;
        if (delay > 15) { this.stats.delayed++; this.stats.delaySum += delay; }
        this.stats.rev.slots += this.slotPrice * 2 * (this.dealOf(f.airline)?.feeMult ?? 1);
      }
      const ok = this.rwyOK(f);
      const cands = this.d.runways.filter(ok);
      const reach = this.d.runways.filter(r => r.cls >= f.cls && f.gate.rwys[f.cls].has(r.rw.id));
      const pool = cands.length ? cands : reach;
      if (!pool.length) { this.gateBusy.set(f.gate.id, null); this.cancel(f, 'no taxi route to a long-enough runway'); return; }
      const cost = (r: RunwayInfo) => this.airDJ(this.landingFromA(r) ? r.nodeA : r.nodeB, f.cls).dist[f.gate.frontNode];
      const rw = pool.reduce((m, r) => (cost(r) < cost(m) ? r : m));
      // v0.58: not pushed back into traffic coming the other way: it holds on its stand a few minutes for the taxiway
      // (unless what is coming is bound for this very stand)
      { const rt = this.taxiRoute(f, f.gate.frontNode, this.landingFromA(rw) ? rw.nodeA : rw.nodeB, o => o.gate === f.gate);
        if (rt && rt.opposed && t - (f.gateT ??= t) < GROUND.gateHold) return;
        if (f.gateT !== undefined) this.stats.ground.gate += t - f.gateT; }
      f.pushT = t;
      this.gateBusy.set(f.gate.id, null);
      this.taxiToRunway(f, rw, true);
    }
  }

  taxiToRunway(f: Flight, rw: RunwayInfo, fromStand: boolean) {
    f.rw = rw; f.fromA = this.landingFromA(rw);
    const air = this.d.air;
    const dj = this.airDJ(f.fromA ? rw.nodeA : rw.nodeB, f.cls);
    const pts: Pt[] = [{ x: f.x, y: f.y }];
    let start: number;
    if (fromStand) { pts.push(f.gate.front); start = f.gate.frontNode; }
    else start = nearestNode(air, { x: f.x, y: f.y });
    if (start < 0 || !isFinite(dj.dist[start])) { this.cancel(f, 'no taxi route to the runway'); return; }
    const rt = this.taxiRoute(f, start, f.fromA ? rw.nodeA : rw.nodeB) ?? { nodes: trace(air, dj, start).nodes };
    pts.push(...rt.nodes.map(n => air.nodes[n]));
    this.setPath(f, pts, TUNE.taxiSpeed);
    f.route = rt.nodes; f.state = 'taxiOut'; this.taxiStart(f);
  }

  takeoffPath(f: Flight) {
    const rw = f.rw!; const start = f.fromA ? rw.rw.a : rw.rw.b; const dir = f.fromA ? rw.dir : mul(rw.dir, -1);
    this.setPath(f, [start, add(start, mul(dir, rw.length * 0.75)), add(start, mul(dir, rw.length + 6000))], 0);
  }

  cancel(f: Flight, why: string) {
    if (f.state === 'cancelled' || f.state === 'gone') return;
    f.state = 'cancelled';
    this.stats.cancelled++;
    for (const p of this.pax) if (p.flight === f && p.dep && p.stage !== 'done') this.miss(p);
    this.gateBusy.forEach((v, k) => { if (v === f) this.gateBusy.set(k, null); });
    this.note(`${f.code} cancelled: ${why}`, 'bad');
  }

  // ---------------------------------------------------------------- passengers
  /** Processor that minimises walking time plus expected queue, among those reachable on foot. */
  chooseProc(type: ZoneType, from: Pt, lv: Level, T?: Terminal): { proc: Proc; route: Route } | null {
    let best: { proc: Proc; route: Route } | null = null, bs = Infinity;
    for (const p of this.procs.values()) {
      if (p.type !== type || !this.inTerm(p.zone, T)) continue;
      const route = this.d.pedRoute(from, lv, clampIn(this.queueSlot(p, p.queue.length), p.zone), p.zone.level);
      if (!route) continue;
      const svc = this.svcTime(p);
      const q = p.servers > 0 ? (p.queue.length * svc) / p.servers : 999;
      const s = route.len / TUNE.walkSpeed + q;
      if (s < bs) { bs = s; best = { proc: p, route }; }
    }
    return best;
  }

  svcTime(p: Proc) { return p.type === 'checkin' ? TUNE.checkinTime[p.zone.tier] : p.type === 'passport' ? GROWTH.passportTime[p.zone.tier] : TUNE.securityTime[p.zone.tier]; }

  stuck(p: Pax, why: string) {
    if (p.stage !== 'stuck') { p.stage = 'stuck'; p.since = this.t; }
    p.path = []; p.pathLv = []; p.why = why;
    if (!p.stranded) { p.stranded = true; this.stats.stranded++; }
    this.noteOnce(`Passengers stranded: ${why.charAt(0).toLowerCase()}${why.slice(1)}`);
  }

  spawnDepartures(t0: number, t1: number) {
    for (const f of this.flights) {
      if (f.spawnedDep || f.state === 'cancelled') continue;
      if (t1 < f.schedDep - 150) continue;
      f.spawnedDep = true;
      let left = f.paxDep - (f.xferIn ?? 0);   // (v0.60: the rest of its seats are filled by connections)
      while (left > 0) {
        const size = Math.min(left, this.r() < 0.55 ? 1 : this.r() < 0.67 ? 2 : 3);
        left -= size;
        const arriveAt = f.schedDep - (55 + Math.pow(this.r(), 0.8) * 80);
        this.makeDepParty(f, size, Math.max(arriveAt, t0));
      }
    }
  }

  makeDepParty(f: Flight, size: number, at: number) {
    const party: Party = { id: this.ids++, dep: true, mode: 'curb', pax: [], atCurb: 0, flight: f };
    const lotCap = this.lotCapacity();
    if (lotCap > 0 && this.r() < 0.35) {
      if (this.lotUsed < lotCap) { party.mode = 'park'; this.lotUsed++; }
      else this.stats.lotFull++;
    }
    if (party.mode === 'curb' && this.facility('bus') && this.r() < GROWTH.busShare) party.mode = 'bus';
    for (let i = 0; i < size; i++) party.pax.push(this.newPax(f, party, true));
    this.pending.push({ at, party });
  }

  newPax(f: Flight, party: Party, dep: boolean): Pax {
    const bags = this.r() < 0.62;
    return {
      id: this.ids++, dep, flight: f, party, bags, x: 0, y: 0, level: 0, path: [], pathLv: [],
      steps: dep ? [...(bags ? ['checkin' as Step] : []), 'security', 'gate'] : [...(f.airline.intl ? ['passport' as Step] : []), ...(bags ? ['claim' as Step] : []), party.mode === 'curb' ? 'curb' : 'lot'],
      stage: 'walk', since: this.t, serviceEnd: 0, bagNo: 0, walked: 0, sat: 86, mood: 0, stranded: false, premium: this.r() < TUNE.premiumShare,
    };
  }

  spawnArrival(f: Flight) {
    let party = this.openArr.get(f.id);
    if (!party || party.pax.length >= party.atCurb) {
      const size = this.r() < 0.55 ? 1 : this.r() < 0.67 ? 2 : 3;
      party = { id: this.ids++, dep: false, mode: 'curb', pax: [], atCurb: size, flight: f };
      const lot = this.pickLot(this.lotsByRoad());
      if (lot && this.lotUsed > 0 && this.r() < 0.35) { party.mode = 'park'; party.lot = lot; this.lotUsed--; }
      else {
        // other ways out, where they exist: an app-hailed ride from the rideshare lot, a rental car, the bus
        const ride = this.facility('rideshare'), rental = this.facility('rental'), bus = this.facility('bus');
        if (ride || rental || bus) {
          const x = this.r(); let c = 0;
          if (ride && x < (c += GROWTH.rideShare)) { party.mode = 'ride'; party.lot = ride; }
          else if (rental && x < (c += GROWTH.rentalShare)) { party.mode = 'rental'; party.lot = rental; }
          else if (bus && x < (c += GROWTH.busShare)) { party.mode = 'bus'; party.lot = bus; }
        }
      }
      this.openArr.set(f.id, party);
    }
    const p = this.newPax(f, party, false);
    party.pax.push(p);
    if (party.pax.length >= party.atCurb) { party.atCurb = 0; this.openArr.delete(f.id); }
    p.x = f.gate.door.x; p.y = f.gate.door.y; p.level = f.gate.zone.level;
    if (p.bags) { this.bagCounter[f.id] = (this.bagCounter[f.id] ?? 0) + 1; p.bagNo = this.bagCounter[f.id];
      // (v0.60: the belt carries every bag that was checked: a passenger whose bag was one more than the estimate waited for good, and held the belt)
      if (p.bagNo > f.bagsArr) f.bagsArr = p.bagNo; }
    this.pax.push(p);
    this.stats.paxArr++;
    this.advance(p);
  }

  /** v0.60: a passenger changing aircraft: off at one gate and, with time to spare, by way of the shops to another.
   *  Never landside: no check-in, no security, no bag to reclaim. */
  spawnTransfer(f: Flight, Y: Flight) {
    // their onward flight has gone, or cannot be walked to: they come out landside like anyone else, a connection missed
    if (Y.state === 'cancelled' || Y.state === 'gone' || Y.state === 'takeoff' || Y.state === 'taxiOut' || Y.state === 'holdDep' || !this.d.pedRoute(f.gate.door, f.gate.zone.level, Y.gate.door, Y.gate.zone.level)) {
      this.spawnArrival(f); this.stats.xfer++; this.stats.xferMissed++; return; }
    const party: Party = { id: this.ids++, dep: true, mode: 'curb', pax: [], atCurb: 0, flight: Y };
    const p = this.newPax(Y, party, true); party.pax.push(p);
    p.xfer = true; p.bags = false; p.steps = Y.schedDep - COMMERCE.boardLead - this.t > 25 ? ['shop', 'gate'] : ['gate'];
    p.x = f.gate.door.x; p.y = f.gate.door.y; p.level = f.gate.zone.level;
    this.pax.push(p); this.stats.xfer++;
    this.advance(p);
  }

  board(p: Pax) {
    p.flight.boarded++;
    const dwell = this.t - p.since;
    if (dwell > 20 && p.flight.gate.zone.tier === 1) p.sat += 4;
    else if (dwell > 40) p.sat -= 3;
    const delay = p.flight.readyT - p.flight.schedDep;
    if (delay > 15) p.sat -= (delay - 15) * 0.35;
    this.stats.paxDep++;
    this.stats.rev.pax += TUNE.paxFee + (p.flight.airline.intl ? GROWTH.intlPaxFee : 0);
    this.finishPax(p);
  }

  miss(p: Pax) { if (p.stage === 'done') return; this.stats.missed++; if (p.xfer) this.stats.xferMissed++; p.sat = 5; this.finishPax(p); }

  finishPax(p: Pax) {
    if (p.stage === 'done') return;
    if (p.proc) { p.proc.queue = p.proc.queue.filter(q => q !== p); p.proc.busy = p.proc.busy.map(b => (b === p ? null : b)); }
    if (p.shop) { this.shopLoad.set(p.shop, Math.max(0, (this.shopLoad.get(p.shop) ?? 1) - 1)); p.shop = undefined; }
    p.stage = 'done';
    this.stats.satSum += clamp(p.sat, 0, 100); this.stats.satN++;
    this.stats.walkSum += p.walked; this.stats.walkN++;
  }

  /** Send a passenger toward their next step along the pedestrian network. */
  advance(p: Pax) {
    const step = p.steps[0];
    if (!step) { this.finishPax(p); return; }
    const here = { x: p.x, y: p.y };
    const go = (q: Pt, l: Level) => this.d.pedRoute(here, p.level, q, l);
    let route: Route | null = null;
    switch (step) {
      case 'checkin': case 'security': case 'passport': {
        const best = this.chooseProc(step, here, p.level, this.termOf(p.flight));
        if (!best) { this.stuck(p, this.hasType(step) ? `No walking route to ${ZONES[step].short.toLowerCase()}` : `No ${ZONES[step].short.toLowerCase()} built`); return; }
        p.proc = best.proc; route = best.route; break;
      }
      case 'shop': {
        const T = this.termOf(p.flight);
        // Lots along the way to the gate win: score by detour, then pick among the best few.
        const gd = p.flight.gate.door;
        // First what they want: a meal or a drink if they have time, otherwise a browse. Premium passengers head for a lounge.
        const spare = p.flight.schedDep - COMMERCE.boardLead - this.t;
        const want: ShopType = p.premium && spare > 40 && this.r() < COMMERCE.wantLounge ? 'lounge' : this.r() < (spare > 45 ? COMMERCE.wantFood[1] : COMMERCE.wantFood[0]) ? 'food' : 'shop';
        const cands: { sh: Shop; c: number }[] = [];
        for (let pass = 0; pass < 2 && !cands.length; pass++) for (const z of T?.zones ?? []) if (z.type === 'concourse') for (const sh of this.d.shops.get(z.id) ?? []) {
          if (!this.leased(sh) || sh.tenant === 'dutyfree' || (sh.type === 'lounge' && !p.premium)) continue;
          if (pass === 0 && sh.type !== want) continue;
          if ((this.shopLoad.get(sh) ?? 0) >= sh.cap) continue;
          const detour = Math.hypot(sh.door.x - here.x, sh.door.y - here.y) + Math.hypot(sh.door.x - gd.x, sh.door.y - gd.y) - Math.hypot(gd.x - here.x, gd.y - here.y);
          // a shopfront people can see from the spine draws them: worth up to ~40 m of detour
          cands.push({ sh, c: detour * (0.6 + this.r() * 0.8) - sh.vis * 40 - (sh.type === 'lounge' ? 400 : 0) });
        }
        cands.sort((a, b) => a.c - b.c);
        const top = cands.slice(0, 6);
        const pick = top.length ? top[Math.floor(this.r() * top.length)].sh : undefined;
        const r = pick && go(pick.door, pick.zone.level);
        if (!pick || !r) { p.steps.shift(); this.advance(p); return; }
        p.shop = pick; this.shopLoad.set(pick, (this.shopLoad.get(pick) ?? 0) + 1);
        route = r; break;
      }
      case 'dutyfree': {
        const sh = this.dutyFreeFor(p);
        const r = sh && go(sh.door, sh.zone.level);
        if (!sh || !r) { p.steps.shift(); this.advance(p); return; }
        p.shop = sh; route = r; break;
      }
      case 'gate': {
        const g = p.flight.gate;
        const inward = { x: -g.outward.x, y: -g.outward.y };
        const wd = CLASSES[g.cls].gateSpacing * 0.6;
        const spot = () => clampIn(add(add(g.door, mul(inward, 1 + this.r() * 7)), { x: (this.r() - .5) * wd * Math.abs(inward.y), y: (this.r() - .5) * wd * Math.abs(inward.x) }), g.zone);
        let target = spot();
        // (v0.36: never a spot in a courtyard or notch: another one, or else the door itself)
        for (let k = 0; k < 4 && this.d.inCut(target, g.zone.level); k++) target = spot();
        if (this.d.inCut(target, g.zone.level)) target = g.door;
        route = go(target, g.zone.level);
        if (!route) { this.stuck(p, 'No walking route to the gates'); return; }
        break;
      }
      case 'claim': {
        const cands: Proc[] = p.flight.claim ? [p.flight.claim] : [...this.procs.values()].filter(q => q.type === 'claim');
        for (const proc of cands) {
          const ci = p.flight.claim === proc && p.flight.carousel >= 0 ? p.flight.carousel : 0;
          const c = proc.frame.slots[ci] ?? center(proc.zone);
          const a = this.r() * Math.PI * 2;
          const r = go(clampIn(add(c, { x: Math.cos(a) * 13, y: Math.sin(a) * 9 }), proc.zone), proc.zone.level);
          if (r && (!route || r.len < route.len)) { route = r; p.proc = proc; }
        }
        if (!route) { this.stuck(p, this.hasType('claim') ? 'No walking route to bag claim' : 'No bag claim built'); return; }
        break;
      }
      case 'curb': {
        const party = p.party;
        const fixed = party.curb ? this.procs.get(party.curb.id) : undefined;
        // pickups use the arrivals deck where a frontage road has two levels
        const all = [...this.procs.values()].filter(q => q.type === 'curb');
        const arr = all.filter(q => q.zone.auto?.deck !== 'dep');
        const cands = fixed ? [fixed] : arr.length ? arr : all;
        let roadRoute: Route | null = null, anyRoute: Route | null = null, rz: Proc | undefined, az: Proc | undefined;
        for (const proc of cands) {
          const f = proc.frame;
          const r = go(add(add(f.a, mul(f.along, f.edgeLen * (0.08 + this.r() * 0.84))), mul(f.inward, 3)), proc.zone.level);
          if (!r) continue;
          if (this.d.roadOK.has(proc.zone.id) && (!roadRoute || r.len < roadRoute.len)) { roadRoute = r; rz = proc; }
          if (!anyRoute || r.len < anyRoute.len) { anyRoute = r; az = proc; }
        }
        route = roadRoute ?? anyRoute;
        const proc = rz ?? az;
        if (!route || !proc) {
          if (fixed) { party.curb = undefined; this.advance(p); return; }
          this.stuck(p, this.hasType('curb') ? 'No walking route to the curb' : 'No curb built'); return;
        }
        party.curb = proc.zone; p.proc = proc;
        break;
      }
      case 'lot': {
        const party = p.party;
        const lot = party.lot && this.d.zones.includes(party.lot) ? party.lot : undefined;
        if (lot) { party.stall = party.stall ?? this.stall(lot); route = go(party.stall, 0); }
        if (!route) { p.steps = ['curb']; this.advance(p); return; }
        break;
      }
    }
    p.path = route!.pts; p.pathLv = route!.lvs; p.stage = 'walk';
  }

  termOf(f: Flight): Terminal | undefined { return this.d.termOf.get(f.gate.zone.id); }
  inTerm(z: Zone, T?: Terminal) { return !T || this.d.termOf.get(z.id) === T; }
  // (v0.31: a counter round a food court or hall is let with the court, outside the building's own count of let lots)
  leased(sh: Shop) {
    const L = this.d.lease.get(sh.zone.id); if (!L) return false;
    // the counters (ranked after the building's own lots) are let in the same proportion as its own lots
    const ok = sh.court ? sh.rank - L.max < Math.ceil(((L.courts ?? 0) * L.count) / Math.max(1, L.max)) : sh.rank < L.count;
    return ok && sh.bid >= COMMERCE.minBid;
  }

  /** The walk-through duty free a departing passenger crosses after security: one in their terminal they can reach. */
  dutyFreeFor(p: Pax): Shop | undefined {
    const T = this.termOf(p.flight);
    for (const z of T?.zones ?? []) if (z.type === 'concourse' && z.dutyFree) {
      const sh = this.d.shops.get(z.id)?.find(q => q.tenant === 'dutyfree');
      if (sh && this.d.zoneReach(z.id, p.flight.gate.zone.id)) return sh;
    }
    return undefined;
  }

  lotLedger(sh: Shop) {
    let e = this.lotDay.get(sh.id);
    if (!e) { e = { visits: 0, rev: 0, passed: 0 }; this.lotDay.set(sh.id, e); }
    return e;
  }

  /** Count a departing passenger across the footfall bins they walked over since last tick, weighted by spare time. */
  countFootfall(p: Pax) {
    const z = this.d.zoneAt(p, p.level);
    if (!z || z.type !== 'concourse') { p.fz = undefined; return; }
    const B = this.d.budgets.get(z.id); if (!B) return;
    const n = flowBins(B.long);
    let f = this.flowDay.get(z.id);
    if (!f || f.w.length !== n) { f = newFlow(n); this.flowDay.set(z.id, f); }
    const pl = toLocal(z, p);   // an angled pier counts along its own long axis
    const F = frameOf(z);       // (and a bent one along its curve)
    const u = B.horiz ? pl.x - F.x : pl.y - F.y;
    const b = clamp(Math.floor(u / COMMERCE.binM), 0, n - 1);
    const spare = Math.max(0, p.flight.schedDep - COMMERCE.boardLead - this.t);
    const w = clamp(spare / COMMERCE.spareRef, COMMERCE.spareMin, COMMERCE.spareCap);
    // each bin counts a passenger once per concourse visit: [fb, fe] is the stretch already counted
    const add1 = (k: number) => { f!.w[k] += w; f!.n[k]++; f!.s[k] += spare; };
    if (p.fz !== z.id || p.fb === undefined || p.fe === undefined) { add1(b); p.fb = p.fe = b; }
    else if (b < p.fb) { for (let k = b; k < p.fb; k++) add1(k); p.fb = b; }
    else if (b > p.fe) { for (let k = p.fe + 1; k <= b; k++) add1(k); p.fe = b; }
    p.fz = z.id;
  }

  /** Pay for the visit (pro rata if cut short), free the unit, head to the gate. */
  leaveShop(p: Pax) {
    const sh = p.shop; if (!sh) return;
    if (sh.tenant === 'dutyfree') {
      if (p.browse) {
        const take = COMMERCE.dfTake * (sh.zone.tier ? 1.35 : 1) * clamp(p.sat / 80, 0.5, 1.15) * (p.flight.airline.intl ? GROWTH.intlSpend : 1);
        this.stats.rev.dutyfree += take;
        const L = this.lotLedger(sh); L.visits++; L.rev += take;
        const day = this.shopDay.get(sh.zone.id) ?? { visits: 0, rev: 0 }; day.visits++; if (!sh.court) day.own = (day.own ?? 0) + 1; day.rev += take; this.shopDay.set(sh.zone.id, day);
      }
      p.shop = undefined; p.browse = undefined;
      if (p.stage !== 'done') { p.steps.shift(); p.stage = 'walk'; this.advance(p); }
      return;
    }
    const S = TUNE.shops[sh.type]; const m = S.min;
    const frac = clamp((this.t - p.since) / ((m[0] + m[1]) / 2), 0.3, 1);
    const take = S.take * frac * (sh.zone.tier ? 1.35 : 1) * clamp(p.sat / 80, 0.5, 1.15) * (p.flight.airline.intl ? GROWTH.intlSpend : 1);
    const key: Record<ShopType, 'shops' | 'food' | 'lounges'> = { shop: 'shops', food: 'food', lounge: 'lounges' };
    this.stats.rev[key[sh.type]] += take;
    const day = this.shopDay.get(sh.zone.id) ?? { visits: 0, rev: 0 }; day.visits++; if (!sh.court) day.own = (day.own ?? 0) + 1; day.rev += take; this.shopDay.set(sh.zone.id, day);
    const L = this.lotLedger(sh); L.visits++; L.rev += take;
    if (sh.type !== 'shop') p.sat += 3;
    this.shopLoad.set(sh, Math.max(0, (this.shopLoad.get(sh) ?? 1) - 1));
    p.shop = undefined;
    if (p.stage !== 'done') { p.steps.shift(); p.stage = 'walk'; this.advance(p); }
  }

  hasType(t: ZoneType) { return this.d.zones.some(z => z.type === t); }

  stall(lot: Zone): Pt {
    const cols = Math.max(1, Math.floor((lot.w - 16) / 6)), rows = Math.max(1, Math.floor((lot.h - 16) / 14));
    const i = Math.floor(this.r() * cols * rows);
    return { x: lot.x + 8 + (i % cols) * 6 + 3, y: lot.y + 8 + Math.floor(i / cols) * 14 + 5 };
  }

  queueSlot(proc: Proc, i: number): Pt {
    const f = proc.frame; const per = Math.max(4, Math.floor((f.edgeLen * 0.8) / 1.15));
    const row = Math.floor(i / per), k = i % per;
    const s = f.edgeLen * 0.1 + (row % 2 ? per - 1 - k : k) * 1.15;
    const maxRows = Math.max(1, Math.floor((f.depth * 0.42) / 1.9));
    const dIn = row < maxRows ? 3 + row * 1.9 : -(4 + (row - maxRows) * 1.9);   // overflow spills outside
    return add(add(f.a, mul(f.along, s)), mul(f.inward, dIn));
  }

  updatePax(dt: number) {
    const t = this.t;
    if (this.pending.length) {
      const keep: typeof this.pending = [];
      for (const e of this.pending) { if (e.at > t) keep.push(e); else this.arriveByCar(e.party); }
      this.pending = keep;
    }
    for (const p of this.pax) {
      if (p.stage === 'done') continue;
      if (p.stage === 'walk') {
        let step = TUNE.walkSpeed * dt * (p.ride ? GROWTH.trainSpeed : 1);
        while (step > 0 && p.path.length) {
          const tgt = p.path[0]; const dd = dist(p, tgt);
          if (dd <= step) {
            p.x = tgt.x; p.y = tgt.y; p.level = p.pathLv[0]; p.path.shift(); p.pathLv.shift(); step -= dd; if (!p.ride) p.walked += dd;
            // station to station is a ride on the AirTrain
            const was = p.ride; p.ride = !!p.path.length && this.d.isTrainNode(tgt) && this.d.isTrainNode(p.path[0]);
            if (was !== p.ride) step = p.ride ? step * GROWTH.trainSpeed : step / GROWTH.trainSpeed;
          }
          else { p.x += ((tgt.x - p.x) / dd) * step; p.y += ((tgt.y - p.y) / dd) * step; if (!p.ride) p.walked += step; step = 0; }
        }
        if (p.dep && (p.steps[0] === 'gate' || p.steps[0] === 'shop' || p.steps[0] === 'dutyfree')) this.countFootfall(p);
        if (!p.path.length) this.arrive(p);
        p.mood = p.sat < 45 ? 2 : p.sat < 65 ? 1 : 0;
      } else if (p.stage === 'queue') {
        const i = p.proc!.queue.indexOf(p);
        const s = this.queueSlot(p.proc!, i);
        p.x += (s.x - p.x) * 0.25; p.y += (s.y - p.y) * 0.25;
        const tol = TUNE.tolerance[p.proc!.type as 'checkin'];
        const w = t - p.since; p.mood = w < tol ? (p.sat < 55 ? 1 : 0) : w < tol * 2 ? 1 : 2;
      } else if (p.stage === 'waitBag') {
        const f = p.flight; const w = t - p.since;
        p.mood = w < TUNE.tolerance.claim ? 0 : w < TUNE.tolerance.claim * 2 ? 1 : 2;
        if (f.claim && f.bagsDone >= p.bagNo) { this.recordWait(p, 'claim', w); if (p.proc) { const L = this.losStat(p.proc.zone.id); if (w > L.peakWait) L.peakWait = w; } p.steps.shift(); p.proc = undefined; this.advance(p); }
      } else if (p.stage === 'shopping') {
        const f = p.flight;
        if (t >= p.serviceEnd || t >= f.schedDep - 30 || f.state === 'cancelled') this.leaveShop(p);
      } else if (p.stage === 'stuck') {
        p.mood = 2; p.sat -= dt * 0.5;
        if (Math.floor(t * 4) % 8 === 0) { const since = p.since; p.stage = 'walk'; this.advance(p); if ((p.stage as Pax['stage']) === 'stuck') p.since = since; }
      } else if (p.stage === 'dwell') {
        const f = p.flight;
        if (f.state === 'stand' && t >= f.readyT - 20) this.board(p);
        else if (f.state === 'cancelled' || f.state === 'gone' || f.state === 'taxiOut') this.miss(p);
      }
    }
    if (this.pax.length > 4000 || Math.floor(t) % 30 === 0) this.pax = this.pax.filter(p => p.stage !== 'done');
  }

  /** v0.57: once a sim minute, who is waiting where: people at the reclaim belts and in the holdrooms. */
  sampleLos() {
    const n = new Map<number, number>();
    for (const p of this.pax) {
      if (p.stage === 'dwell') { const id = p.flight.gate.zone.id; n.set(id, (n.get(id) ?? 0) + 1); }
      else if (p.stage === 'waitBag' && p.proc) { const id = p.proc.zone.id; n.set(id, (n.get(id) ?? 0) + 1); }
    }
    for (const [id, k] of n) { const L = this.losStat(id); if (k > L.peakQ) L.peakQ = k; }
    // (and the one who has stood longest in each desk queue: a queue nobody serves has a wait too)
    for (const p of this.procs.values()) if (p.queue.length && (p.type === 'checkin' || p.type === 'security' || p.type === 'passport')) {
      const w = this.t - p.queue[0].since; const L = this.losStat(p.zone.id); if (w > L.peakWait) { L.peakWait = w; L.open = p.servers; }
    }
  }
  arrive(p: Pax) {
    const step = p.steps[0];
    switch (step) {
      case 'checkin': case 'security': case 'passport':
        if (!p.proc || !this.procs.has(p.proc.zone.id)) { this.advance(p); return; }
        p.stage = 'queue'; p.since = this.t; p.proc.queue.push(p);
        { const L = this.losStat(p.proc.zone.id); L.in[Math.floor(this.t / 60) % 24]++; if (p.proc.queue.length > L.peakQ) L.peakQ = p.proc.queue.length; }
        return;
      case 'dutyfree': {
        const sh = p.shop;
        if (!sh) { p.steps.shift(); this.advance(p); return; }
        // everyone walks the serpentine; about 60% stop to browse. People short of time resent the detour.
        const spare = p.flight.schedDep - COMMERCE.boardLead - this.t;
        if (spare < COMMERCE.dfHurry) p.sat -= COMMERCE.dfHurrySat;
        p.browse = spare > 8 && this.r() < COMMERCE.dfCapture;
        const b = COMMERCE.dfBrowse;
        p.stage = 'shopping'; p.since = this.t;
        p.serviceEnd = this.t + COMMERCE.dfWalk + (p.browse ? b[0] + this.r() * (b[1] - b[0]) : 0);
        this.lotLedger(sh).passed++;
        const c = { x: (sh.pts[0].x + sh.pts[2].x) / 2, y: (sh.pts[0].y + sh.pts[2].y) / 2 };
        p.x = c.x + (this.r() - .5) * 14; p.y = c.y + (this.r() - .5) * 10;
        return;
      }
      case 'shop': {
        const sh = p.shop!; const m = TUNE.shops[sh.type].min;
        p.stage = 'shopping'; p.since = this.t; p.serviceEnd = this.t + m[0] + this.r() * (m[1] - m[0]);
        const c = { x: (sh.pts[0].x + sh.pts[2].x) / 2, y: (sh.pts[0].y + sh.pts[2].y) / 2 };
        p.x = c.x + (this.r() - .5) * 8; p.y = c.y + (this.r() - .5) * 6;
        return;
      }
      case 'gate': p.stage = 'dwell'; p.since = this.t; return;
      case 'claim': p.stage = 'waitBag'; p.since = this.t; return;
      case 'curb': p.stage = 'curbWait'; p.since = this.t; this.tryPickup(p.party); return;
      case 'lot': {
        const party = p.party;
        const n = party.pax.length; const kind = party.lot?.type;
        if (kind === 'rideshare') this.stats.rev.rideshare += GROWTH.rideFee / n;
        else if (kind === 'rental') this.stats.rev.rental += GROWTH.rentalFee * (party.lot!.tier ? 1.2 : 1) / n;
        else if (kind !== 'bus') this.stats.rev.parking += TUNE.parkingPerStay / n;
        this.finishPax(p);
        if (kind !== 'bus' && party.pax.every(q => q.stage === 'done') && party.lot && party.stall) this.leaveLot(party, party.lot, party.stall);
        return;
      }
    }
  }

  tryPickup(party: Party) {
    if (party.car || !party.pax.length || party.atCurb !== 0) return;
    if (!party.pax.every(q => q.stage === 'curbWait' || q.stage === 'done')) return;
    if (party.pax.every(q => q.stage === 'done')) return;
    const curb = party.curb ? this.procs.get(party.curb.id) : undefined;
    if (!curb) { for (const q of party.pax) if (q.stage === 'curbWait') { q.stage = 'walk'; this.advance(q); } return; }
    if (!this.driveTo(party, curb, true)) for (const q of party.pax) if (q.stage === 'curbWait') this.stuck(q, 'No road reaches the curb');
  }

  recordWait(p: Pax, k: WaitKey, w: number) {
    const s = this.stats.waits[k]; s.sum += w; s.n++; s.max = Math.max(s.max, w);
    const tol = TUNE.tolerance[k];
    if (w > tol) p.sat -= (w - tol) * 1.6;
  }

  updateProcs() {
    const t = this.t;
    for (const proc of this.procs.values()) {
      if (proc.type !== 'checkin' && proc.type !== 'security' && proc.type !== 'passport') continue;
      const svc = this.svcTime(proc);
      for (let i = 0; i < proc.busy.length; i++) {
        const b = proc.busy[i];
        if (b && t >= b.serviceEnd) {
          proc.busy[i] = null; proc.served++; b.proc = undefined; b.steps.shift();
          if (proc.type === 'security' && b.steps[0] === 'gate' && b.flight.schedDep - 25 - t > 25 && this.r() < 0.85) b.steps.unshift('shop');
          if (proc.type === 'security' && this.dutyFreeFor(b)) b.steps.unshift('dutyfree');
          this.advance(b);
        }
        if (!proc.busy[i] && proc.queue.length) {
          const p = proc.queue.shift()!;
          const w = t - p.since;
          this.recordWait(p, proc.type as 'checkin', w);
          proc.recentWait = proc.recentWait * 0.9 + w * 0.1;
          { const L = this.losStat(proc.zone.id); if (proc.recentWait > L.peakWait) { L.peakWait = proc.recentWait; L.open = proc.servers; } }
          p.stage = 'service'; p.serviceEnd = t + svc * (0.6 + this.r() * 0.8);
          const sp = proc.frame.slots[i] ?? center(proc.zone);
          p.x = sp.x - proc.frame.inward.x * 2; p.y = sp.y - proc.frame.inward.y * 2;
          proc.busy[i] = p;
        }
      }
      if (!proc.queue.length) proc.recentWait *= 0.98;
    }
  }

  // ---------------------------------------------------------------- bags
  assignCarousel(f: Flight) {
    for (const proc of this.procs.values()) {
      if (proc.type !== 'claim' || !proc.carousels) continue;
      if (!this.inTerm(proc.zone, this.termOf(f)) || !this.d.zoneReach(f.gate.zone.id, proc.zone.id)) continue;
      const i = proc.carousels.findIndex(c => !c || (c.bagsDone >= c.bagsArr && !this.pax.some(p => p.flight === c && p.stage === 'waitBag')));
      if (i >= 0) { proc.carousels[i] = f; f.claim = proc; f.carousel = i; return; }
    }
  }

  updateBags(dt: number) {
    const active = this.flights.filter(f => f.claim && f.state !== 'cancelled' && f.bagsDone < f.bagsArr && this.t >= f.standT + 9);
    if (active.length) {
      const rate = this.staff.handlers * TUNE.bagsPerHandlerPerMin * 0.6 / active.length;
      for (const f of active) f.bagsDone = Math.min(f.bagsArr, f.bagsDone + rate * dt);
    }
    for (const f of this.flights) if (f.state === 'stand' && !f.claim && f.bagsArr > 0) this.assignCarousel(f);
  }

  // ---------------------------------------------------------------- roads, cars, curbs, lots
  /** `deck`: the trip is to or from an upper departures deck, so it takes the deck's ramps; every other trip keeps off them. */
  roadDJ(target: number, deck = false): DJ {
    const key = deck ? -target - 1 : target;
    let dj = this.roadCache.get(key);
    if (!dj) {
      const ramps = this.d.rampRefs;
      dj = dijkstra(this.d.road, [{ n: target, c: 0 }], undefined, e => (e.len / (e.kind === 'hwy' ? 1.6 : e.lanes >= 4 ? 1.25 : 1)) * (ramps.has(e.ref) ? (deck ? 0.5 : 8) : 1), -1);
      this.roadCache.set(key, dj);
    }
    return dj;
  }
  roadRoute(from: number, to: number, deck = false): { pts: Pt[]; eids: number[] } | null {
    if (from < 0 || to < 0) return null;
    const dj = this.roadDJ(to, deck);
    if (!isFinite(dj.dist[from])) return null;
    const tr = trace(this.d.road, dj, from);
    return { pts: tr.nodes.map(n => this.d.road.nodes[n]), eids: tr.eids };
  }
  /** Drivers are already near the airport: start them 500 m up the highway from their exit. */
  trimHwy(r: { pts: Pt[]; eids: number[] }) {
    const E = this.d.road.edges;
    const i = r.eids.findIndex(e => E[e]?.kind !== 'hwy');
    if (i <= 0) return r;
    const j = r.pts[i], prev = r.pts[i - 1];
    const L = dist(prev, j);
    const start = L > 500 ? { x: j.x + ((prev.x - j.x) / L) * 500, y: j.y + ((prev.y - j.y) / L) * 500 } : prev;
    return { pts: [start, ...r.pts.slice(i)], eids: [r.eids[i - 1], ...r.eids.slice(i)] };
  }
  hwyEnd() { const [w, e] = this.d.hwyEnds; return this.r() < 0.8 ? (e >= 0 ? e : w) : (w >= 0 ? w : e); }

  /** Drivers spread over the lots and garages by size. */
  pickLot(lots: Zone[]): Zone | undefined {
    if (lots.length < 2) return lots[0];
    const tot = lots.reduce((n, l) => n + unitsOf(this.d, l), 0); let x = this.r() * tot;
    for (const l of lots) { x -= unitsOf(this.d, l); if (x <= 0) return l; }
    return lots[lots.length - 1];
  }
  lotsByRoad() { return this.d.zones.filter(z => z.type === 'parking' && this.d.roadOK.has(z.id)); }

  /** Departing party arrives: park if they planned to and a lot works, otherwise get dropped at a curb. */
  arriveByCar(party: Party) {
    if (party.mode === 'bus') {
      const bus = this.facility('bus');
      if (bus) { for (const p of party.pax) { const st = this.stall(bus); p.x = st.x; p.y = st.y; p.level = 0; p.since = this.t; this.pax.push(p); this.advance(p); } return; }
      party.mode = 'curb';
    }
    if (party.mode === 'park') {
      const PT = this.termOf(party.flight);
      const entry = this.d.zones.filter(z => (z.type === 'checkin' || z.type === 'security') && this.inTerm(z, PT));
      const lot = this.pickLot(this.lotsByRoad().filter(l => entry.some(z => this.d.zoneReach(l.id, z.id))));
      if (lot && this.driveToLot(party, lot)) return;
      party.mode = 'curb'; this.lotUsed = Math.max(0, this.lotUsed - 1);
    }
    const T = this.termOf(party.flight);
    const target = this.d.zones.filter(z => (z.type === 'checkin' || z.type === 'security') && this.inTerm(z, T));
    const curbs0 = [...this.procs.values()].filter(p => p.type === 'curb' && this.d.roadOK.has(p.zone.id));
    // drop-offs use the departures deck where a frontage road has two levels
    const curbs = curbs0.some(c => c.zone.auto?.deck !== 'arr') ? curbs0.filter(c => c.zone.auto?.deck !== 'arr') : curbs0;
    const good = curbs.filter(c => target.some(z => this.d.zoneReach(c.zone.id, z.id)));
    const pool = good.length ? good : curbs;
    const curb = pool.reduce<Proc | undefined>((m, c) => (!m || (c.cars!.length / Math.max(1, c.maxServers)) < (m.cars!.length / Math.max(1, m.maxServers)) ? c : m), undefined);
    if (!curb || !this.driveTo(party, curb, false)) {
      for (const p of party.pax) { this.pax.push(p); this.miss(p); }
      this.noteOnce('Passengers could not reach the airport: no road to a curb or lot');
    }
  }

  driveTo(party: Party, curb: Proc, pick: boolean): boolean {
    const o = this.hwyEnd();
    let best: { pts: Pt[]; eids: number[] } | null = null, bn = -1;
    const deck = curb.zone.auto?.deck === 'dep';
    for (const n of this.d.attach.get(curb.zone.id) ?? []) {
      const r0 = this.roadRoute(o, n, deck); const r = r0 && this.trimHwy(r0);
      if (r && (!best || polyLen(r.pts) < polyLen(best.pts))) { best = r; bn = n; }
    }
    if (!best) return false;
    if (best.pts.length < 2) best.pts.push({ ...best.pts[0] });
    this.spawnCar(party, pick, best.pts, best.eids, 'in', curb, bn);
    return true;
  }

  driveToLot(party: Party, lot: Zone): boolean {
    const o = this.hwyEnd();
    let best: { pts: Pt[]; eids: number[] } | null = null;
    for (const n of this.d.attach.get(lot.id) ?? []) {
      const r0 = this.roadRoute(o, n); const r = r0 && this.trimHwy(r0);
      if (r && (!best || polyLen(r.pts) < polyLen(best.pts))) best = r;
    }
    if (!best) return false;
    const st = this.stall(lot);
    party.lot = lot; party.stall = st;
    this.spawnCar(party, false, [...best.pts, st], [...best.eids, -1], 'park', undefined, -1);
    return true;
  }

  /** Route out from a point inside a curb or lot, via one of its road attachments, to a highway end. */
  exitRoute(from: Pt, zoneId: number, avoid: number): { pts: Pt[]; eids: number[] } {
    const dest = this.hwyEnd();
    let best: { pts: Pt[]; eids: number[] } | null = null, bc = Infinity;
    const deck = this.d.zones.find(z => z.id === zoneId)?.auto?.deck === 'dep';
    for (const n of this.d.attach.get(zoneId) ?? []) {
      const r = this.roadRoute(n, dest, deck);
      if (!r) continue;
      const c = polyLen(r.pts) + dist(from, r.pts[0]) + (n === avoid ? 120 : 0);
      if (c < bc) { bc = c; best = r; }
    }
    return best ? { pts: [from, ...best.pts], eids: [-1, ...best.eids] } : { pts: [from, from], eids: [-1] };
  }

  leaveLot(party: Party, lot: Zone, stall: Pt) {
    const r = this.exitRoute(stall, lot.id, -1);
    this.spawnCar(party, true, r.pts, r.eids, 'out', undefined, -1);
  }

  spawnCar(party: Party, pick: boolean, pts: Pt[], eids: number[], stage: Car['stage'], curb: Proc | undefined, entry: number) {
    const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
    const c: Car = { id: this.ids++, party, pick, pts, eids, cum, d: 0, len: cum[cum.length - 1], si: 0, stage, x: pts[0].x, y: pts[0].y, ang: 0, bay: -1, until: 0, since: this.t, curb, entry };
    party.car = c;
    this.cars.push(c);
    if (curb) curb.cars!.push(c);
  }

  /** v0.53: a runway was moved whole by `d`: aircraft landing, rolling out or taking off on it move with it, so their
   *  paths (and the exit a rolling one leaves by) stay on its pavement. Call before the relayout. */
  runwayMoved(rwId: number, d: Pt) {
    for (const f of this.flights) if (f.rw?.rw.id === rwId && (f.state === 'approach' || f.state === 'roll' || f.state === 'takeoff')) {
      f.path = f.path.map(q => ({ x: q.x + d.x, y: q.y + d.y })); f.x += d.x; f.y += d.y;
    }
  }

  /** v0.54: a roundabout centred at `o` was moved by `d`: the points of every car's path within `r` of it (its ring and
   *  approaches) go with it, so cars on it carry on round the moved ring. Call before the relayout. */
  roundMoved(o: Pt, r: number, d: Pt) {
    for (const c of this.cars) {
      if (c.stage === 'gone' || !c.pts.some(q => dist(q, o) < r)) continue;
      const d0 = c.d; const pts = c.pts.map(q => (dist(q, o) < r ? { x: q.x + d.x, y: q.y + d.y } : q));
      c.pts = pts; c.cum = [0]; for (let i = 1; i < pts.length; i++) c.cum.push(c.cum[i - 1] + dist(pts[i - 1], pts[i]));
      c.len = c.cum[c.cum.length - 1]; c.d = Math.min(d0, c.len); c.si = 0; while (c.si < c.cum.length - 2 && c.d > c.cum[c.si + 1]) c.si++;
    }
  }

  setCarPath(c: Car, pts: Pt[], eids: number[]) {
    c.pts = pts; c.eids = eids; c.cum = [0]; c.passed = -1; c.wait = false;
    for (let i = 1; i < pts.length; i++) c.cum.push(c.cum[i - 1] + dist(pts[i - 1], pts[i]));
    c.d = 0; c.si = 0; c.len = c.cum[c.cum.length - 1];
  }

  /** Speed factor for a road edge from its current load. */
  congestion(eid: number) {
    const e = this.d.road.edges[eid]; if (!e) return 1;
    const cap = Math.max(2, ((e.lanes * e.len) / 9) * (this.roadCap[eid] ?? 1));
    const x = this.roadLoad[eid] / cap;
    return x < 0.5 ? 1 : Math.max(0.08, 1 / (1 + 6 * (x - 0.5) * (x - 0.5)));
  }
  edgeLoadRatio(eid: number) {
    const e = this.d.road.edges[eid]; if (!e) return 0;
    return this.roadLoad[eid] / Math.max(2, ((e.lanes * e.len) / 9) * (this.roadCap[eid] ?? 1));
  }

  updateCars(dt: number) {
    const t = this.t;
    const load = this.roadLoad; load.fill(0);
    for (const c of this.cars) {
      if (c.stage === 'in' || c.stage === 'out' || c.stage === 'park') { const e = c.eids[c.si]; if (e >= 0 && e < load.length) load[e]++; }
      else if (c.stage === 'queue') { const e = c.eids[c.eids.length - 1]; if (e >= 0 && e < load.length) load[e]++; }
    }
    // v0.47: each approach to a junction lets cars through at the gap-acceptance capacity for the flow it gives way to
    const R = this.d.road, fade = Math.exp(-dt / YIELD.window);
    for (let n = 0; n < this.yieldKind.length; n++) {
      const k = this.yieldKind[n]; if (!k) continue;
      const q = this.yieldFlow[n] / YIELD.window; this.yieldFlow[n] *= fade; // cars a minute
      const cap = k === 2 ? (YIELD.entry / 60) * Math.exp(-YIELD.entryB * q * 60) : (60 / YIELD.tf) * Math.exp(-(q / 60) * (YIELD.tc - YIELD.tf / 2));
      for (const e of R.adj[n]) { const s2 = e * 2 + (R.edges[e].v === n ? 1 : 0); this.yieldCredit[s2] = Math.min(YIELD.store, this.yieldCredit[s2]) + cap * dt; /* (only what is left over is capped, so the step size does not limit capacity) */ }
    }
    for (const c of this.cars) {
      if (c.stage === 'gone') continue;
      if (c.stage === 'in' || c.stage === 'out' || c.stage === 'park') {
        const e = c.eids[c.si];
        let to = c.d + TUNE.carSpeed * (e >= 0 ? this.congestion(e) : 0.5) * dt; c.wait = false;
        // (at each junction ahead within this step's run: through if it can let one more car through, else stop at the line)
        for (let i = c.si; i < c.eids.length - 1 && c.cum[i + 1] - YIELD.stop < to; i++) {
          if ((c.passed ?? -1) >= i) continue;
          const a = R.edges[c.eids[i]], b = R.edges[c.eids[i + 1]]; if (!a || !b) continue;
          const n = a.u === b.u || a.u === b.v ? a.u : a.v;
          const k = this.yieldKind[n], m0 = this.major[n * 2], m1 = this.major[n * 2 + 1];
          if (!k) { c.passed = i; continue; }
          // (the ones that never wait, and are the flow the others wait for)
          if (k === 2 ? isRingRef(a.ref) : m0 >= 0 && ((a.id === m0 && b.id === m1) || (a.id === m1 && b.id === m0))) { if (k === 1 || (a.id === this.ringIn[n] && isRingRef(b.ref))) this.yieldFlow[n]++; /* (a ring car leaving here takes no gap) */ c.passed = i; continue; }
          if (k === 2 && !isRingRef(b.ref)) { c.passed = i; continue; }
          const slot = a.id * 2 + (a.v === n ? 1 : 0);
          if (this.yieldCredit[slot] >= 1) { this.yieldCredit[slot] -= 1; c.passed = i; continue; }
          to = Math.max(c.d, c.cum[i + 1] - YIELD.stop); c.wait = true; break;
        }
        c.d = to;
        while (c.si < c.cum.length - 2 && c.d > c.cum[c.si + 1]) c.si++;
        const a = along(c.pts, c.d); c.x = a.p.x; c.y = a.p.y; c.ang = a.ang;
        if (c.d >= c.len) {
          if (c.stage === 'in') { c.stage = 'queue'; c.since = t; }
          else if (c.stage === 'park') {
            c.stage = 'gone';
            const st = c.party.stall ?? { x: c.x, y: c.y };
            for (const p of c.party.pax) { p.x = st.x + (this.r() - .5) * 4; p.y = st.y; p.level = 0; p.since = t; this.pax.push(p); this.advance(p); }
          } else c.stage = 'gone';
        }
        continue;
      }
      if (c.stage === 'queue') {
        const curb = c.curb!; const bays = curb.bays!;
        const i = bays.indexOf(null);
        const qi = curb.cars!.filter(o => o.stage === 'queue').indexOf(c);
        const a = along([...c.pts].reverse(), 8 + qi * 7.5); c.x = a.p.x; c.y = a.p.y; c.ang = a.ang + Math.PI;
        if (i >= 0 && qi === 0) {
          bays[i] = c; c.bay = i; c.stage = 'bay';
          const s = curb.frame.slots[i] ?? center(curb.zone); c.x = s.x; c.y = s.y; c.ang = Math.atan2(curb.frame.along.y, curb.frame.along.x);
          const w = t - c.since;
          for (const p of c.party.pax) {
            if (c.pick) { if (p.stage !== 'done') this.recordWait(p, 'curb', t - p.since); }
            else p.sat -= Math.max(0, w - TUNE.tolerance.curb) * 1.2;
          }
          c.until = t + (c.pick ? TUNE.curbPickTime : TUNE.curbDropTime) * (0.7 + this.r() * 0.6);
          this.stats.rev.curb += TUNE.curbFeePerCar;
        }
        continue;
      }
      if (c.stage === 'bay' && t >= c.until) {
        const curb = c.curb!; curb.bays![c.bay] = null;
        if (c.pick) { for (const p of c.party.pax) this.finishPax(p); }
        else for (const p of c.party.pax) {
          p.x = c.x + (this.r() - .5) * 3; p.y = c.y + (this.r() - .5) * 3; p.level = curb.zone.level; p.since = t;
          this.pax.push(p); this.advance(p);
        }
        const r = this.exitRoute({ x: c.x, y: c.y }, curb.zone.id, c.entry);
        this.setCarPath(c, r.pts, r.eids);
        c.stage = 'out';
        curb.cars = curb.cars!.filter(o => o !== c);
      }
    }
    if (Math.floor(t) % 15 === 0) this.cars = this.cars.filter(c => c.stage !== 'gone');
  }

  // ---------------------------------------------------------------- end of day
  endDay() {
    for (const p of this.pax) if (p.stage !== 'done') { if (p.dep) this.miss(p); else this.finishPax(p); }
    const s = this.stats;
    const staffN = this.staff.agents + this.staff.screeners + this.staff.handlers + (this.staff.officers ?? 0);
    s.cost.staff = staffN * TUNE.wagePerDay;
    s.cost.upkeep = this.world.zones.reduce((u, z) => u + (z.poly ? polyArea(z.poly) : z.w * z.h) * ZONES[z.type].upkeepPerM2 * (z.type === 'parking' ? 1 + 0.6 * ((z.floors ?? 1) - 1) : z.type === 'hotel' ? 0 : 1), 0)
      + this.d.runways.reduce((u, r) => u + r.length * 4, 0)
      + this.d.trainLinks.reduce((u, l) => u + (l.apm ? dist(l.a, l.b) * MOVER.upkeepPerM : 0), 0)
      + this.world.ways.reduce((u, w) => u + wayLen(w) * (w.kind === 'taxi' ? 1.2 : w.kind === 'road' ? 0.8 : 0.2), 0);
    // Hotels: early departures and late arrivals fill rooms; the airport takes a ground-lease share per room night.
    let nights = s.paxDep * GROWTH.hotelGuests;
    for (const h of this.d.zones) if (h.type === 'hotel' && this.d.served.has(h.id)) {
      const n = Math.min(nights, unitsOf(this.d, h) * 0.92); nights -= n;
      s.rev.hotel += n * GROWTH.hotelTake * (h.tier ? 1.3 : 1);
    }
    // crew-base deals expect punctuality
    for (const a of AIRLINES) { const dl = this.dealOf(a); if (dl?.kind === 'base' && s.flights && 1 - s.delayed / s.flights < 0.9) { const fine = 1e6; if (this.moneyOn) this.money -= fine; this.note(`${a.name}: under 90% on time today. Penalty $1.0M under its crew-base deal.`, 'warn'); } }
    this.bestPax = Math.max(this.bestPax, s.paxDep);
    this.checkUnlocks();
    // Rent: each leased lot pays the greater of its sales share and its minimum guarantee (ACRP Report 54).
    for (const list of this.d.shops.values()) for (const sh of list) if (this.leased(sh)) {
      const L = this.lotLedger(sh); const short = sh.rent - L.rev;
      if (short > 0) { s.rev.rent += short; L.rev += short; }
    }
    this.lotPrev = new Map(this.lotDay);
    // Footfall: fold today's count into each concourse's running count, so scores move over two or three days.
    const before = new Map<number, Record<string, string>>();
    for (const z of this.world.zones) if (z.type === 'concourse') {
      const B = this.d.budgets.get(z.id); if (!B) continue;
      const n = flowBins(B.long); const today = this.flowDay.get(z.id) ?? newFlow(n);
      const old = z.flow && z.flow.w.length === n ? z.flow : undefined; const k = old ? COMMERCE.memory : 0;
      const mix = (a: number[] | undefined, b: number[]) => b.map((x, i) => Math.round(((a?.[i] ?? 0) * k + x * (1 - k)) * 10) / 10);
      z.flow = { w: mix(old?.w, today.w), n: mix(old?.n, today.n), s: mix(old?.s, today.s) };
      before.set(z.id, Object.fromEntries((this.d.shops.get(z.id) ?? []).map(sh => [sh.key, sh.kind])));
    }
    // Tenants: busy concourses lease more units, quiet ones lose a tenant.
    for (const z of this.world.zones) if (z.type === 'concourse') {
      // (v0.31: the building's own lots and their visits; the counters round a food court are let in step with them)
      const n = this.d.shops.get(z.id)?.filter(sh => !sh.court).length ?? 0; if (!n) continue;
      const cur = Math.max(1, this.d.lease.get(z.id)?.count ?? 1);
      const day = this.shopDay.get(z.id); const per = (day ? day.own ?? 0 : 0) / cur;
      let next = cur;
      if (per > 30) next = Math.min(n, cur + Math.max(1, Math.round(0.2 * (n - cur))));
      else if (per < 8) next = Math.max(1, cur - 1);
      if (next !== cur) { z.leased = next; if (next > cur) this.note(`${next - cur} new tenant${next - cur > 1 ? 's' : ''} opened in a concourse (${next} of ${n} units)`); }
    }
    const rev = revTotal(s.rev);
    const profit = rev - (s.cost.staff + s.cost.upkeep);
    const period = this.periodDays;
    if (this.moneyOn) this.money += profit * period;
    const sat = s.satN ? s.satSum / s.satN : 0;
    const onTime = s.flights ? 1 - s.delayed / s.flights : 0;
    const target = clamp(0.55 + (sat / 100) * 0.55 + onTime * 0.25 - (s.cancelled > 0 ? 0.05 : 0), 0.6, 1.3);
    this.rep = this.rep * 0.75 + target * 0.25;
    const rep: Report = { label: `Year ${this.year} · Week ${this.week}`, day: this.day, stats: s, plan: this.plan, profit, sat, onTime, money: this.money, periodDays: period };
    this.history.push(rep);
    if (this.history.length > 120) this.history.shift();
    this.calDays += period; this.day++;
    this.onDayEnd?.(rep);
    this.makeOffer(sat);
    this.relayout();
    // Re-let: with the new scores, tenants bid again. Save who holds what, and say what moved.
    for (const z of this.world.zones) if (z.type === 'concourse') {
      const list = this.d.shops.get(z.id) ?? []; const was = before.get(z.id) ?? {};
      const moved = list.filter(sh => was[sh.key] && was[sh.key] !== sh.kind && this.leased(sh));
      if (moved.length) {
        const eg = moved.slice(0, 2).map(sh => `${was[sh.key]} → ${sh.kind}`).join(', ');
        this.note(`Concourse ${this.d.gateLetter.get(z.id) ?? ''}: ${moved.length} lot${moved.length > 1 ? 's' : ''} re-let as footfall shifted (${eg}${moved.length > 2 ? ', …' : ''})`);
      }
      z.tenants = tenantsOf(list);
    }
    this.startDay();
  }
}

// ------------------------------------------------------------------ helpers
function resize<T>(arr: T[], n: number, fill: T): T[] { const out = arr.slice(0, n); while (out.length < n) out.push(fill); return out; }
function gauss(r: () => number) { let u = 0; for (let i = 0; i < 6; i++) u += r(); return u - 3; }
function clampIn(p: Pt, z: Zone): Pt { return clampInto(z, p, 3); }
