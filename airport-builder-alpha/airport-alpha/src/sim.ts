// Simulation core. Pure logic: no DOM, no canvas. Deterministic for a given seed and command sequence.
// Time unit: minutes of the day. One sim "day" stands in for several calendar days.
// Everything moves on networks: aircraft on taxiways, cars on roads, people through doors, cores and sidewalks.
import { Pt, add, mul, dist, polyLen, along, rng, clamp, center } from './geom';
import { CLASSES, AcClass, Cls, AIRLINES, Airline, Level, SITE, TUNE, ZONES, ZoneType, ShopType } from './config';
import { World, Derived, Zone, Gate, RunwayInfo, Wind, Route, Terminal, Shop, derive, runwayUsable, unitsOf, Frame } from './world';
import { DJ, dijkstra, trace, nearestNode } from './net';

// ------------------------------------------------------------------ entities
export type Step = 'checkin' | 'security' | 'shop' | 'gate' | 'claim' | 'curb' | 'lot';

export interface Party {
  id: number; dep: boolean; mode: 'curb' | 'park'; pax: Pax[]; atCurb: number; car?: Car; flight: Flight;
  curb?: Zone; lot?: Zone; stall?: Pt;
}

export interface Pax {
  id: number; dep: boolean; flight: Flight; party: Party; bags: boolean;
  x: number; y: number; level: Level;
  path: Pt[]; pathLv: Level[]; steps: Step[];
  stage: 'walk' | 'queue' | 'service' | 'dwell' | 'waitBag' | 'curbWait' | 'shopping' | 'stuck' | 'done';
  proc?: Proc; since: number; serviceEnd: number; bagNo: number;
  walked: number; sat: number; mood: 0 | 1 | 2; why?: string; stranded: boolean; premium: boolean; shop?: Shop;
}

export interface Car {
  id: number; party: Party; pick: boolean; pts: Pt[]; eids: number[]; d: number; len: number; si: number; cum: number[];
  stage: 'in' | 'queue' | 'bay' | 'out' | 'park' | 'gone'; x: number; y: number; ang: number;
  bay: number; until: number; since: number; curb?: Proc; entry: number;
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
}

type WaitKey = 'curb' | 'checkin' | 'security' | 'claim';
export interface DayStats {
  paxDep: number; paxArr: number; missed: number; stranded: number; satSum: number; satN: number;
  waits: Record<WaitKey, { sum: number; n: number; max: number }>;
  walkSum: number; walkN: number; flights: number; delayed: number; cancelled: number; delaySum: number;
  rev: { slots: number; pax: number; shops: number; food: number; lounges: number; parking: number; curb: number };
  cost: { staff: number; upkeep: number };
  lotFull: number;
}
export interface PlanInfo {
  demand: number; byAirline: { airline: Airline; requested: number; scheduled: number }[];
  rejectedGates: number; rejectedRunway: number; rejectedAircraft: number; wantsSJ: number; scheduled: number;
  limit: string; loadFactor: number;
}
export interface Report { label: string; day: number; stats: DayStats; plan: PlanInfo; profit: number; sat: number; onTime: number; money: number; periodDays: number }

const emptyStats = (): DayStats => ({
  paxDep: 0, paxArr: 0, missed: 0, stranded: 0, satSum: 0, satN: 0,
  waits: { curb: { sum: 0, n: 0, max: 0 }, checkin: { sum: 0, n: 0, max: 0 }, security: { sum: 0, n: 0, max: 0 }, claim: { sum: 0, n: 0, max: 0 } },
  walkSum: 0, walkN: 0, flights: 0, delayed: 0, cancelled: 0, delaySum: 0,
  rev: { slots: 0, pax: 0, shops: 0, food: 0, lounges: 0, parking: 0, curb: 0 }, cost: { staff: 0, upkeep: 0 }, lotFull: 0,
});

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
  staff = { agents: 14, screeners: 15, handlers: 16 };
  rep = 1.0;
  flights: Flight[] = [];
  pax: Pax[] = [];
  cars: Car[] = [];
  procs = new Map<number, Proc>();
  rwFree = new Map<number, number>();
  gateBusy = new Map<string, Flight | null>();
  lotUsed = 0;
  roadLoad = new Float32Array(0);
  stats = emptyStats();
  plan!: PlanInfo;
  history: Report[] = [];
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
  shopDay = new Map<number, { visits: number; rev: number }>();
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
    this.roadLoad = new Float32Array(this.d.road.edges.length);
    const keep = new Map(this.procs);
    this.procs.clear();
    for (const z of this.world.zones) {
      if (!['checkin', 'security', 'claim', 'curb'].includes(z.type)) continue;
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
      if (f.state === 'roll' && f.path.length) f.exitNode = nearestNode(this.d.air, f.path[f.path.length - 1], 8);
    }
    // People re-plan: their routes may run through something that changed.
    for (const p of this.pax) {
      if (p.stage === 'done') continue;
      if (p.proc && !this.procs.has(p.proc.zone.id)) { p.proc = undefined; p.stage = 'walk'; this.advance(p); }
      else if (p.stage === 'walk' || p.stage === 'stuck') { p.stage = 'walk'; this.advance(p); }
    }
    this.allocateStaff();
    this.lotUsed = Math.min(this.lotUsed, this.lotCapacity());
  }

  lotCapacity() { return this.world.zones.filter(z => z.type === 'parking').reduce((s, z) => s + unitsOf(this.d, z), 0); }

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
      let left = pool;
      ps.forEach((p, i) => {
        const a = i === ps.length - 1 ? left : Math.round(pool * wts[i] / tot);
        left -= a;
        p.servers = clamp(a, 0, p.maxServers);
        p.busy = resize(p.busy, p.servers, null);
      });
    };
    share('checkin', this.staff.agents);
    share('security', Math.floor(this.staff.screeners / TUNE.screenersPerLane));
    for (const p of this.procs.values()) if (p.type === 'curb' || p.type === 'claim') p.servers = p.maxServers;
  }

  // ---------------------------------------------------------------- daily plan (demand -> schedule)
  startDay() {
    this.t = DAY_START;
    this.flights = []; this.pax = []; this.cars = []; this.pending = [];
    this.openArr.clear(); this.bagCounter = {}; this.noted.clear(); this.shopLoad.clear(); this.shopDay.clear();
    this.gateBusy.clear(); this.rwFree.clear();
    for (const p of this.procs.values()) {
      p.queue = []; p.busy = p.busy.map(() => null); p.served = 0; p.waitSum = 0; p.recentWait = 0;
      if (p.bays) p.bays = p.bays.map(() => null);
      if (p.cars) p.cars = [];
      if (p.carousels) p.carousels = p.carousels.map(() => null);
    }
    this.stats = emptyStats();
    this.dayWind = { shift: (this.r() - 0.5) * 50, gust: 0.65 + this.r() * 0.9 };
    this.lotUsed = Math.round(this.lotCapacity() * 0.55);
    this.plan = this.schedule();
    this.allocateStaff();
  }

  /** Flights per day each airline wants at a given slot fee (before capacity limits). */
  demandAt(price: number) {
    const D = (this.population * TUNE.tripsPerCapita) / 365 * this.rep;
    const lf = 0.8;
    return AIRLINES.map(a => {
      let n = 0;
      for (const [c, share] of Object.entries(a.mix)) n += (a.share * D * (share as number)) / (CLASSES[Number(c)].seats * lf);
      return { airline: a, n: n * Math.pow(price / TUNE.refSlotPrice, -a.elasticity) };
    });
  }

  schedule(): PlanInfo {
    const d = this.d;
    const D = (this.population * TUNE.tripsPerCapita) / 365 * this.rep;
    const lfRef = clamp(0.66 + 0.18 * this.rep, 0.6, 0.93);
    const plan: PlanInfo = {
      demand: 0, byAirline: [], rejectedGates: 0, rejectedRunway: 0, rejectedAircraft: 0, wantsSJ: 0,
      scheduled: 0, limit: '', loadFactor: lfRef,
    };
    const operable = [0, 1, 2, 3].map(c => d.gates.some(g => d.gateUsable(g, c)));
    type Cand = { airline: Airline; cls: Cls; arr: number };
    const cands: Cand[] = [];
    for (const a of AIRLINES) {
      const row = { airline: a, requested: 0, scheduled: 0 };
      plan.byAirline.push(row);
      const priceF = Math.pow(this.slotPrice / TUNE.refSlotPrice, -a.elasticity);
      for (const [cs, share] of Object.entries(a.mix)) {
        const c = Number(cs) as Cls;
        const x = (a.share * D * (share as number) * priceF) / (CLASSES[c].seats * 0.8);
        const n = Math.floor(x) + (this.r() < x - Math.floor(x) ? 1 : 0);
        row.requested += n;
        for (let i = 0; i < n; i++) {
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
    cands.sort((a, b) => a.arr - b.arr);
    const prevailing: Wind = { from: SITE.windFrom, kt: SITE.windSpeed };
    const usable = d.runways.filter(r => r.cls >= 0 && runwayUsable(r, prevailing));
    const capHr = this.capacityPerHour(usable.length ? usable : d.runways.filter(r => r.cls >= 0).slice(0, 1));
    const perHour = new Map<number, number>();
    const gateFree = new Map<string, number>();
    const flightNo = new Map<string, number>();
    for (const c of cands) {
      const ac = CLASSES[c.cls];
      const dep = c.arr + ac.turn + 5;
      const hA = Math.floor(c.arr / 60), hD = Math.floor(dep / 60);
      if ((perHour.get(hA) ?? 0) + 1 > capHr || (perHour.get(hD) ?? 0) + 1 > capHr) { plan.rejectedRunway++; continue; }
      const open = d.terminals.filter(T => T.active);
      const home = open.length ? open[AIRLINES.indexOf(c.airline) % open.length] : undefined;
      const rank = (g: Gate) => g.cls * 10 + (d.termOf.get(g.zone.id) === home ? 0 : 1);
      const gate = d.gates.filter(g => d.gateUsable(g, c.cls)).sort((p, q) => rank(p) - rank(q)).find(g => (gateFree.get(g.id) ?? 0) + 8 <= c.arr);
      if (!gate) { plan.rejectedGates++; continue; }
      gateFree.set(gate.id, dep);
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
      plan.byAirline.find(b => b.airline === c.airline)!.scheduled++;
    }
    for (const f of this.flights) f.bagsArr = Math.round(f.paxArr * 0.62);
    plan.scheduled = this.flights.length;
    const lost = plan.rejectedGates + plan.rejectedRunway + plan.rejectedAircraft;
    plan.limit = !d.runways.length ? 'No runway' : !d.gates.length ? 'No gates' : !operable.some(Boolean) ? 'No connected gates'
      : lost === 0 ? 'Demand' : plan.rejectedAircraft >= Math.max(plan.rejectedGates, plan.rejectedRunway) ? 'Aircraft size'
      : plan.rejectedGates >= plan.rejectedRunway ? 'Gates' : 'Runway capacity';
    return plan;
  }

  capacityPerHour(rs: RunwayInfo[]) {
    if (!rs.length) return 0;
    const per = 60 / TUNE.separationMin;
    let cap = per;
    for (let i = 1; i < rs.length; i++) {
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
    this.rwFree.set(best.rw.id, bt + TUNE.separationMin);
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
          if (!this.gateBusy.get(f.gate.id)) { this.gateBusy.set(f.gate.id, f); this.setPath(f, [{ x: f.x, y: f.y }, f.gate.stand], TUNE.taxiSpeed * 0.3); f.state = 'taxiIn'; }
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
    f.d += f.speed * dt;
    const a = along(f.path, f.d); f.x = a.p.x; f.y = a.p.y; f.ang = a.ang;
    if (f.d < f.len) return;
    if (f.state === 'roll') { this.taxiIn(f); return; }
    if (f.state === 'taxiIn') {
      const end = f.path[f.path.length - 1];
      if (end !== f.gate.stand) {
        const busy = this.gateBusy.get(f.gate.id);
        if (busy && busy !== f) { f.state = 'waitGate'; return; }
        this.gateBusy.set(f.gate.id, f);
        this.setPath(f, [{ x: f.x, y: f.y }, f.gate.stand], TUNE.taxiSpeed * 0.3);
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
    const tr = trace(air, dj, f.exitNode);
    this.setPath(f, [{ x: f.x, y: f.y }, ...tr.nodes.map(n => air.nodes[n])], TUNE.taxiSpeed);
    f.state = 'taxiIn';
  }

  atStand(f: Flight) {
    const t = this.t;
    if (f.deplaned < f.paxArr && t >= f.standT + 2) {
      const due = Math.min(f.paxArr, Math.floor((t - f.standT - 2) / 0.08));
      while (f.deplaned < due) { this.spawnArrival(f); f.deplaned++; }
      if (f.deplaned >= f.paxArr) { const op = this.openArr.get(f.id); if (op) { op.atCurb = 0; this.openArr.delete(f.id); this.tryPickup(op); } }
    }
    if (!f.claim && f.bagsArr > 0) this.assignCarousel(f);
    if (t >= f.readyT - 20) for (const p of this.pax) if (p.flight === f && p.dep && p.stage === 'dwell') this.board(p);
    const remaining = this.pax.some(p => p.flight === f && p.dep && p.stage !== 'done');
    if (t >= f.readyT && (!remaining || t >= f.readyT + 2)) {
      for (const p of this.pax) if (p.flight === f && p.dep && p.stage !== 'done') this.miss(p);
      f.pushT = t;
      const delay = t - f.schedDep;
      this.stats.flights++;
      if (delay > 15) { this.stats.delayed++; this.stats.delaySum += delay; }
      this.stats.rev.slots += this.slotPrice * 2;
      const ok = this.rwyOK(f);
      const cands = this.d.runways.filter(ok);
      const reach = this.d.runways.filter(r => r.cls >= f.cls && f.gate.rwys[f.cls].has(r.rw.id));
      const pool = cands.length ? cands : reach;
      if (!pool.length) { this.gateBusy.set(f.gate.id, null); this.cancel(f, 'no taxi route to a long-enough runway'); return; }
      const cost = (r: RunwayInfo) => this.airDJ(this.landingFromA(r) ? r.nodeA : r.nodeB, f.cls).dist[f.gate.frontNode];
      const rw = pool.reduce((m, r) => (cost(r) < cost(m) ? r : m));
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
    pts.push(...trace(air, dj, start).nodes.map(n => air.nodes[n]));
    this.setPath(f, pts, TUNE.taxiSpeed);
    f.state = 'taxiOut';
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
      const svc = type === 'checkin' ? TUNE.checkinTime[p.zone.tier] : TUNE.securityTime[p.zone.tier];
      const q = p.servers > 0 ? (p.queue.length * svc) / p.servers : 999;
      const s = route.len / TUNE.walkSpeed + q;
      if (s < bs) { bs = s; best = { proc: p, route }; }
    }
    return best;
  }

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
      let left = f.paxDep;
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
    for (let i = 0; i < size; i++) party.pax.push(this.newPax(f, party, true));
    this.pending.push({ at, party });
  }

  newPax(f: Flight, party: Party, dep: boolean): Pax {
    const bags = this.r() < 0.62;
    return {
      id: this.ids++, dep, flight: f, party, bags, x: 0, y: 0, level: 0, path: [], pathLv: [],
      steps: dep ? [...(bags ? ['checkin' as Step] : []), 'security', 'gate'] : [...(bags ? ['claim' as Step] : []), party.mode === 'park' ? 'lot' : 'curb'],
      stage: 'walk', since: this.t, serviceEnd: 0, bagNo: 0, walked: 0, sat: 86, mood: 0, stranded: false, premium: this.r() < TUNE.premiumShare,
    };
  }

  spawnArrival(f: Flight) {
    let party = this.openArr.get(f.id);
    if (!party || party.pax.length >= party.atCurb) {
      const size = this.r() < 0.55 ? 1 : this.r() < 0.67 ? 2 : 3;
      party = { id: this.ids++, dep: false, mode: 'curb', pax: [], atCurb: size, flight: f };
      const lot = this.lotsByRoad()[0];
      if (lot && this.lotUsed > 0 && this.r() < 0.35) { party.mode = 'park'; party.lot = lot; this.lotUsed--; }
      this.openArr.set(f.id, party);
    }
    const p = this.newPax(f, party, false);
    party.pax.push(p);
    if (party.pax.length >= party.atCurb) { party.atCurb = 0; this.openArr.delete(f.id); }
    p.x = f.gate.door.x; p.y = f.gate.door.y; p.level = f.gate.zone.level;
    if (p.bags) { this.bagCounter[f.id] = (this.bagCounter[f.id] ?? 0) + 1; p.bagNo = this.bagCounter[f.id]; }
    this.pax.push(p);
    this.stats.paxArr++;
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
    this.stats.rev.pax += TUNE.paxFee;
    this.finishPax(p);
  }

  miss(p: Pax) { if (p.stage === 'done') return; this.stats.missed++; p.sat = 5; this.finishPax(p); }

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
      case 'checkin': case 'security': {
        const best = this.chooseProc(step, here, p.level, this.termOf(p.flight));
        if (!best) { this.stuck(p, this.hasType(step) ? `No walking route to ${ZONES[step].short.toLowerCase()}` : `No ${ZONES[step].short.toLowerCase()} built`); return; }
        p.proc = best.proc; route = best.route; break;
      }
      case 'shop': {
        const T = this.termOf(p.flight);
        // Lots along the way to the gate win: score by detour, then pick among the best few.
        const gd = p.flight.gate.door;
        const cands: { sh: Shop; c: number }[] = [];
        for (const z of T?.zones ?? []) if (z.type === 'concourse') for (const sh of this.d.shops.get(z.id) ?? []) {
          if (!this.leased(sh) || (sh.type === 'lounge' && !p.premium)) continue;
          if ((this.shopLoad.get(sh) ?? 0) >= sh.cap) continue;
          const detour = Math.hypot(sh.door.x - here.x, sh.door.y - here.y) + Math.hypot(sh.door.x - gd.x, sh.door.y - gd.y) - Math.hypot(gd.x - here.x, gd.y - here.y);
          cands.push({ sh, c: detour * (0.6 + this.r() * 0.8) - (sh.type === 'lounge' ? 200 : 0) });
        }
        cands.sort((a, b) => a.c - b.c);
        const top = cands.slice(0, 6);
        const pick = top.length ? top[Math.floor(this.r() * top.length)].sh : undefined;
        const r = pick && go(pick.door, pick.zone.level);
        if (!pick || !r) { p.steps.shift(); this.advance(p); return; }
        p.shop = pick; this.shopLoad.set(pick, (this.shopLoad.get(pick) ?? 0) + 1);
        route = r; break;
      }
      case 'gate': {
        const g = p.flight.gate;
        const inward = { x: -g.apron.outward.x, y: -g.apron.outward.y };
        const wd = CLASSES[g.cls].gateSpacing * 0.6;
        const target = clampIn(add(add(g.door, mul(inward, 1 + this.r() * 7)), { x: (this.r() - .5) * wd * Math.abs(inward.y), y: (this.r() - .5) * wd * Math.abs(inward.x) }), g.zone);
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
        const cands = fixed ? [fixed] : [...this.procs.values()].filter(q => q.type === 'curb');
        let roadRoute: Route | null = null, anyRoute: Route | null = null, rz: Proc | undefined, az: Proc | undefined;
        for (const proc of cands) {
          const f = proc.frame;
          const r = go(add(add(f.a, mul(f.along, f.edgeLen * (0.08 + this.r() * 0.84))), mul(f.inward, 3)), 0);
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
        const lot = party.lot && this.world.zones.includes(party.lot) ? party.lot : undefined;
        if (lot) { party.stall = party.stall ?? this.stall(lot); route = go(party.stall, 0); }
        if (!route) { p.steps = ['curb']; this.advance(p); return; }
        break;
      }
    }
    p.path = route!.pts; p.pathLv = route!.lvs; p.stage = 'walk';
  }

  termOf(f: Flight): Terminal | undefined { return this.d.termOf.get(f.gate.zone.id); }
  inTerm(z: Zone, T?: Terminal) { return !T || this.d.termOf.get(z.id) === T; }
  leased(sh: Shop) { return sh.rank < (this.d.lease.get(sh.zone.id)?.count ?? 0); }

  /** Pay for the visit (pro rata if cut short), free the unit, head to the gate. */
  leaveShop(p: Pax) {
    const sh = p.shop; if (!sh) return;
    const S = TUNE.shops[sh.type]; const m = S.min;
    const frac = clamp((this.t - p.since) / ((m[0] + m[1]) / 2), 0.3, 1);
    const take = S.take * frac * (sh.zone.tier ? 1.35 : 1) * clamp(p.sat / 80, 0.5, 1.15);
    const key: Record<ShopType, 'shops' | 'food' | 'lounges'> = { shop: 'shops', food: 'food', lounge: 'lounges' };
    this.stats.rev[key[sh.type]] += take;
    const day = this.shopDay.get(sh.zone.id) ?? { visits: 0, rev: 0 }; day.visits++; day.rev += take; this.shopDay.set(sh.zone.id, day);
    if (sh.type !== 'shop') p.sat += 3;
    this.shopLoad.set(sh, Math.max(0, (this.shopLoad.get(sh) ?? 1) - 1));
    p.shop = undefined;
    if (p.stage !== 'done') { p.steps.shift(); p.stage = 'walk'; this.advance(p); }
  }

  hasType(t: ZoneType) { return this.world.zones.some(z => z.type === t); }

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
        let step = TUNE.walkSpeed * dt;
        while (step > 0 && p.path.length) {
          const tgt = p.path[0]; const dd = dist(p, tgt);
          if (dd <= step) { p.x = tgt.x; p.y = tgt.y; p.level = p.pathLv[0]; p.path.shift(); p.pathLv.shift(); step -= dd; p.walked += dd; }
          else { p.x += ((tgt.x - p.x) / dd) * step; p.y += ((tgt.y - p.y) / dd) * step; p.walked += step; step = 0; }
        }
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
        if (f.claim && f.bagsDone >= p.bagNo) { this.recordWait(p, 'claim', w); p.steps.shift(); p.proc = undefined; this.advance(p); }
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

  arrive(p: Pax) {
    const step = p.steps[0];
    switch (step) {
      case 'checkin': case 'security':
        if (!p.proc || !this.procs.has(p.proc.zone.id)) { this.advance(p); return; }
        p.stage = 'queue'; p.since = this.t; p.proc.queue.push(p); return;
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
        this.stats.rev.parking += TUNE.parkingPerStay / party.pax.length;
        this.finishPax(p);
        if (party.pax.every(q => q.stage === 'done') && party.lot && party.stall) this.leaveLot(party, party.lot, party.stall);
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
      if (proc.type !== 'checkin' && proc.type !== 'security') continue;
      const svc = proc.type === 'checkin' ? TUNE.checkinTime[proc.zone.tier] : TUNE.securityTime[proc.zone.tier];
      for (let i = 0; i < proc.busy.length; i++) {
        const b = proc.busy[i];
        if (b && t >= b.serviceEnd) {
          proc.busy[i] = null; proc.served++; b.proc = undefined; b.steps.shift();
          if (proc.type === 'security' && b.steps[0] === 'gate' && b.flight.schedDep - 25 - t > 25 && this.r() < 0.85) b.steps.unshift('shop');
          this.advance(b);
        }
        if (!proc.busy[i] && proc.queue.length) {
          const p = proc.queue.shift()!;
          const w = t - p.since;
          this.recordWait(p, proc.type as 'checkin', w);
          proc.recentWait = proc.recentWait * 0.9 + w * 0.1;
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
  roadDJ(target: number): DJ {
    let dj = this.roadCache.get(target);
    if (!dj) { dj = dijkstra(this.d.road, [{ n: target, c: 0 }], undefined, e => e.len / (e.kind === 'hwy' ? 1.6 : e.lanes >= 4 ? 1.25 : 1)); this.roadCache.set(target, dj); }
    return dj;
  }
  roadRoute(from: number, to: number): { pts: Pt[]; eids: number[] } | null {
    if (from < 0 || to < 0) return null;
    const dj = this.roadDJ(to);
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

  lotsByRoad() { return this.world.zones.filter(z => z.type === 'parking' && this.d.roadOK.has(z.id)); }

  /** Departing party arrives: park if they planned to and a lot works, otherwise get dropped at a curb. */
  arriveByCar(party: Party) {
    if (party.mode === 'park') {
      const PT = this.termOf(party.flight);
      const entry = this.world.zones.filter(z => (z.type === 'checkin' || z.type === 'security') && this.inTerm(z, PT));
      const lot = this.lotsByRoad().find(l => entry.some(z => this.d.zoneReach(l.id, z.id)));
      if (lot && this.driveToLot(party, lot)) return;
      party.mode = 'curb'; this.lotUsed = Math.max(0, this.lotUsed - 1);
    }
    const T = this.termOf(party.flight);
    const target = this.world.zones.filter(z => (z.type === 'checkin' || z.type === 'security') && this.inTerm(z, T));
    const curbs = [...this.procs.values()].filter(p => p.type === 'curb' && this.d.roadOK.has(p.zone.id));
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
    for (const n of this.d.attach.get(curb.zone.id) ?? []) {
      const r0 = this.roadRoute(o, n); const r = r0 && this.trimHwy(r0);
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
    for (const n of this.d.attach.get(zoneId) ?? []) {
      const r = this.roadRoute(n, dest);
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

  setCarPath(c: Car, pts: Pt[], eids: number[]) {
    c.pts = pts; c.eids = eids; c.cum = [0];
    for (let i = 1; i < pts.length; i++) c.cum.push(c.cum[i - 1] + dist(pts[i - 1], pts[i]));
    c.d = 0; c.si = 0; c.len = c.cum[c.cum.length - 1];
  }

  /** Speed factor for a road edge from its current load. */
  congestion(eid: number) {
    const e = this.d.road.edges[eid]; if (!e) return 1;
    const cap = Math.max(2, (e.lanes * e.len) / 9);
    const x = this.roadLoad[eid] / cap;
    return x < 0.5 ? 1 : Math.max(0.08, 1 / (1 + 6 * (x - 0.5) * (x - 0.5)));
  }
  edgeLoadRatio(eid: number) {
    const e = this.d.road.edges[eid]; if (!e) return 0;
    return this.roadLoad[eid] / Math.max(2, (e.lanes * e.len) / 9);
  }

  updateCars(dt: number) {
    const t = this.t;
    const load = this.roadLoad; load.fill(0);
    for (const c of this.cars) {
      if (c.stage === 'in' || c.stage === 'out' || c.stage === 'park') { const e = c.eids[c.si]; if (e >= 0 && e < load.length) load[e]++; }
      else if (c.stage === 'queue') { const e = c.eids[c.eids.length - 1]; if (e >= 0 && e < load.length) load[e]++; }
    }
    for (const c of this.cars) {
      if (c.stage === 'gone') continue;
      if (c.stage === 'in' || c.stage === 'out' || c.stage === 'park') {
        const e = c.eids[c.si];
        c.d += TUNE.carSpeed * (e >= 0 ? this.congestion(e) : 0.5) * dt;
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
          p.x = c.x + (this.r() - .5) * 3; p.y = c.y + (this.r() - .5) * 3; p.level = 0; p.since = t;
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
    const staffN = this.staff.agents + this.staff.screeners + this.staff.handlers;
    s.cost.staff = staffN * TUNE.wagePerDay;
    s.cost.upkeep = this.world.zones.reduce((u, z) => u + z.w * z.h * ZONES[z.type].upkeepPerM2, 0)
      + this.d.runways.reduce((u, r) => u + r.length * 4, 0)
      + this.world.ways.reduce((u, w) => u + dist(w.a, w.b) * (w.kind === 'taxi' ? 1.2 : w.kind === 'road' ? 0.8 : 0.2), 0);
    // Tenants: busy concourses lease more units, quiet ones lose a tenant.
    for (const z of this.world.zones) if (z.type === 'concourse') {
      const n = this.d.shops.get(z.id)?.length ?? 0; if (!n) continue;
      const cur = Math.max(1, this.d.lease.get(z.id)?.count ?? 1);
      const per = (this.shopDay.get(z.id)?.visits ?? 0) / cur;
      let next = cur;
      if (per > 30) next = Math.min(n, cur + Math.max(1, Math.round(0.2 * (n - cur))));
      else if (per < 8) next = Math.max(1, cur - 1);
      if (next !== cur) { z.leased = next; if (next > cur) this.note(`${next - cur} new tenant${next - cur > 1 ? 's' : ''} opened in a concourse (${next} of ${n} units)`); }
    }
    const rev = s.rev.slots + s.rev.pax + s.rev.shops + s.rev.food + s.rev.lounges + s.rev.parking + s.rev.curb;
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
    this.relayout();
    this.startDay();
  }
}

// ------------------------------------------------------------------ helpers
function resize<T>(arr: T[], n: number, fill: T): T[] { const out = arr.slice(0, n); while (out.length < n) out.push(fill); return out; }
function gauss(r: () => number) { let u = 0; for (let i = 0; i < 6; i++) u += r(); return u - 3; }
function clampIn(p: Pt, z: Zone): Pt { return { x: clamp(p.x, z.x + 3, z.x + z.w - 3), y: clamp(p.y, z.y + 3, z.y + z.h - 3) }; }
