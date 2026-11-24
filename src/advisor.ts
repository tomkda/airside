// v0.59: the advisor. It reads the day (the schedule's turned-away flights, the airfield's holds, each module's level
// of service) and says what is holding the airport back, worst first, each with the one upgrade that would lift it.
// Pure: it reads the sim and decides nothing about cost or room; ui.ts works those out and lays the upgrade.
import { TUNE, ZONES, LOS, EXITS, CLASSES, WEATHER } from './config';
import { runwayExits } from './airfield';
import type { Sim } from './sim';
import type { Zone } from './world';
import { Pt } from './geom';
import { losDay } from './los';
import { heart } from './shapes';
import { wayMid } from './ways';

export type AdviceKind = 'stands' | 'extend' | 'parallel' | 'staff' | 'desks' | 'grow' | 'exit' | 'info';
export interface Advice {
  /** stable while the cause stands, so a button finds it again */
  key: string; kind: AdviceKind; title: string; why: string;
  /** what it bears on, and where to look */
  zone?: number; way?: number; runway?: number; at?: Pt;
  /** stands to build, staff to hire (0: only its dial is raised), desks to fit; `need` the desks the module should have staffed */
  n?: number; need?: number; pool?: 'agents' | 'screeners' | 'officers' | 'handlers';
  weight: number;
}
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const straight = (z: Zone) => !z.poly && !z.sides && !z.bend && !z.taper && !z.twist;

export function advise(sim: Sim): Advice[] {
  const out: Advice[] = []; const d = sim.d, p = sim.plan;
  const open = new Set(d.terminals.filter(T => T.active).flatMap(T => T.zones.map(z => z.id)));
  // ---- flights turned away for want of a gate
  if (p.rejectedGates > 0) {
    // (places on a building of an open terminal: stands elsewhere would be no use to the schedule)
    const offers = d.gateSlots.filter(sl => !sl.on && sl.zone.stands && (open.has(sl.zone.id) || !open.size));
    if (offers.length) {
      const n = Math.min(offers.length, Math.max(1, Math.ceil(p.rejectedGates / 3)));
      const z = offers[0].zone;
      out.push({ key: 'stands', kind: 'stands', n, zone: z.id, at: offers[0].door, weight: 80 + p.rejectedGates * 10,
        title: `Build ${plural(n, 'more stand')}`, why: `${plural(p.rejectedGates, 'flight')} today found no free gate. Your concourses have room for ${plural(offers.length, 'more stand')}; each takes three or four flights a day.` });
    } else {
      const z = d.zones.filter(q => q.type === 'concourse' && !q.auto && straight(q) && (open.has(q.id) || !open.size)).sort((a, b) => b.w * b.h - a.w * a.h)[0];
      if (z) out.push({ key: 'extend' + z.id, kind: 'extend', zone: z.id, at: heart(z), weight: 80 + p.rejectedGates * 10,
        title: `Lengthen Concourse ${d.gateLetter.get(z.id) ?? ''}`, why: `${plural(p.rejectedGates, 'flight')} today found no free gate, and every place for a stand is built. Two more stand widths of concourse offers new ones.` });
      else out.push({ key: 'gates', kind: 'info', weight: 80 + p.rejectedGates * 10, title: 'More gates', why: `${plural(p.rejectedGates, 'flight')} today found no free gate, and every place for a stand is built. Draw a pier out of a concourse, or add a satellite.` });
    }
  }
  // ---- the runway
  if (p.rejectedRunway > 0) {
    // v0.63: an exit where landing aircraft can use it comes before a second runway
    const short = d.runways.filter(r => r.cls >= 0).map(r => ({ r, X: runwayExits(d, r) })).filter(q => q.X.n < EXITS.factor.length - 1).sort((p, q) => p.X.n - q.X.n)[0];
    if (short) { const { r, X } = short; const per = 60 / TUNE.separationMin; const wx = WEATHER[sim.weather].cap; const now = Math.floor(per * X.factor), then = Math.floor(per * EXITS.factor[X.n + 1]);
      out.push({ key: 'exit' + r.rw.id, kind: 'exit', runway: r.rw.id, at: { x: (r.rw.a.x + r.rw.b.x) / 2, y: (r.rw.a.y + r.rw.b.y) / 2 }, weight: p.rejectedRunway * 8 + 1,
        title: `A rapid exit for Runway ${r.labels[0]}/${r.labels[1]}`, why: `${plural(p.rejectedRunway, 'flight')} today found no slot in the peak hours. Landing ${X.fromA ? r.labels[0] : r.labels[1]}, the runway has ${X.n ? plural(X.n, 'exit') : 'no exit'} between ${Math.round(X.lo).toLocaleString()} and ${Math.round(X.hi).toLocaleString()} m from the threshold, where ${CLASSES[X.cls].example}s have slowed enough to turn off: it takes ${now} movements an hour${wx < 1 ? ` (${Math.floor(now * wx)} in today's ${WEATHER[sim.weather].label.toLowerCase()})` : ''}, and one more exit there makes it ${then}.` }); }
    const rw = d.runways[0];
    if (!short) out.push({ key: 'runway', kind: 'info', at: rw ? { x: (rw.rw.a.x + rw.rw.b.x) / 2, y: (rw.rw.a.y + rw.rw.b.y) / 2 } : undefined, weight: p.rejectedRunway * 8,
      title: 'A second runway', why: `${plural(p.rejectedRunway, 'flight')} today found no slot in the peak hours: one runway takes about a movement every ${TUNE.separationMin} minutes. A second, parallel and ${TUNE.dependentSpacing} m or more away, doubles that; closer, or crossing, adds less.` });
  }
  if (p.rejectedAircraft > 0) out.push({ key: 'aircraft', kind: 'info', weight: p.rejectedAircraft * 6, title: 'Larger aircraft',
    why: `${plural(p.rejectedAircraft, 'flight')} today ${p.rejectedAircraft === 1 ? 'was' : 'were'} flown by aircraft nothing here can take${p.wantsSJ ? ` (${p.wantsSJ} by A380: a 3,000 m runway, Code F taxiways all the way, and A380 stands)` : ''}. Lengthen the runway, widen the taxiways on the way, or size a concourse for them.` });
  // ---- connections missed (v0.60)
  { const st = sim.stats.xfer >= 20 ? sim.stats : sim.history[sim.history.length - 1]?.stats;
    if (st && st.xfer >= 20 && st.xferMissed > st.xfer * 0.05) out.push({ key: 'xfer', kind: 'info', weight: 60 + st.xferMissed, title: 'Connections are being missed',
      why: `${st.xferMissed} of ${st.xfer} connecting passengers saw their onward flight leave without them. Their aircraft landed late or stood on a taxiway, or the walk between gates is too long: keep a bank's gates together, clear the taxiways, or link the concourses.` }); }
  if (p.rejectedIntl > 0) out.push({ key: 'intl', kind: 'info', weight: p.rejectedIntl * 6, title: 'Passport control',
    why: `${plural(p.rejectedIntl, 'international flight')} today had no terminal with passport control between a concourse and bag claim.` });
  // ---- the airfield: taxiways where aircraft stood
  { const G = sim.stats.ground.moves >= 6 && sim.ground.size ? sim.ground : sim.groundLast.size ? sim.groundLast : sim.ground;
    for (const [id, g] of G) {
      if (id <= 0 || (g.so === 0 && g.min < 10)) continue; const w = sim.world.ways.find(q => q.id === id); if (!w) continue;
      const L = d.taxiLetter.get(id) ?? '';
      out.push({ key: 'par' + id, kind: 'parallel', way: id, at: wayMid(w), weight: g.min * 2 + g.so * 10,
        title: `A parallel to taxiway ${L}`, why: `Aircraft stood ${g.min.toFixed(0)} minutes on taxiway ${L}${g.so ? `, ${plural(g.so, 'time')} nose to nose` : ''}. A second taxiway beside it gives each direction its own.` });
    } }
  // ---- the terminal: modules below optimum
  for (const z of d.zones) {
    if (z.auto) continue; const L = losDay(sim, z); if (!L || L.band < 2) continue;
    const name = z.type === 'concourse' ? `Concourse ${d.gateLetter.get(z.id) ?? ''}` : ZONES[z.type].short; const unit = ZONES[z.type].unit;
    const w0 = L.band * 20 + (L.wait ?? 0);
    if (L.wBand === 2 && (z.type === 'checkin' || z.type === 'security' || z.type === 'passport')) {
      const pool = z.type === 'checkin' ? 'agents' : z.type === 'security' ? 'screeners' : 'officers';
      const per = z.type === 'security' ? TUNE.screenersPerLane : 1; const max = d.units.get(z.id)?.max ?? L.max;
      const P = sim.procs.get(z.id); const cur = Math.max(L.open, P?.servers ?? 0);
      // what the busiest hour needed, of the desks it has; one more if it was a rush within the hour
      const target = Math.min(L.max, Math.max(L.need, L.open < L.max && L.need <= L.open ? L.open + 1 : 0));
      const rate = L.max ? L.capMax / L.max : 0;
      if (target > cur) {
        // people already on the roll and standing idle are used before anyone is hired
        const used = [...sim.procs.values()].filter(q => q.type === z.type).reduce((t, q) => t + q.servers * per, 0);
        const idle = Math.max(0, (sim.staff[pool] ?? 0) - used); const hire = Math.max(0, (target - cur) * per - idle);
        out.push({ key: 'staff' + z.id, kind: 'staff', zone: z.id, at: heart(z), n: hire, need: target, pool, weight: w0,
          title: `Staff ${plural(target - cur, 'more ' + unit.replace(/s$/, ''))} at ${name.toLowerCase()}`, why: `Its queue waited ${Math.round(L.wait ?? 0)} minutes in a rush (${LOS.std[L.kind].wait![1]} at most): the busiest hour brought ${Math.round(L.demand)} people and the ${L.open} staffed serve about ${Math.round(L.open * rate)}.${hire ? '' : ' The people are on the roll already: its dial holds them back.'}` });
      } else if (L.need > L.max && L.max < max) out.push({ key: 'desks' + z.id, kind: 'desks', zone: z.id, at: heart(z), n: Math.min(max, L.need) - L.max, weight: w0,
        title: `Fit ${plural(Math.min(max, L.need) - L.max, 'more ' + unit.replace(/s$/, ''))} in ${name.toLowerCase()}`, why: `The busiest hour brought ${Math.round(L.demand)} people; all ${L.max} of its ${unit} serve ${Math.round(L.capMax)}. It has room for ${max}.` });
      else if (L.open >= L.max) out.push({ key: 'grow' + z.id, kind: 'grow', zone: z.id, at: heart(z), weight: w0, title: `${name} is too small`,
        why: `Its queue waited ${Math.round(L.wait ?? 0)} minutes in a rush with every one of its ${unit} at work. Make it larger, upgrade its fit-out, or build a second.` });
    } else if (L.wBand === 2 && z.type === 'claim') out.push({ key: 'bags' + z.id, kind: 'staff', zone: z.id, at: heart(z), n: 2, pool: 'handlers', weight: w0, title: 'Hire baggage handlers',
      why: `The longest wait for a bag at ${name.toLowerCase()} was ${Math.round(L.wait ?? 0)} minutes (${LOS.std[L.kind].wait![1]} at most). More handlers bring bags to the belts sooner.` });
    else if (L.sBand === 2) out.push({ key: (z.type === 'concourse' ? 'los' : 'grow') + z.id, kind: z.type === 'concourse' ? 'info' : 'grow', zone: z.id, at: heart(z), weight: w0, title: `${name} is crowded`,
      why: `${L.peakQ} people waited on ${Math.round(L.area)} m² at the peak, ${L.space.toFixed(1)} m² each (${LOS.std[L.kind].space[0]} at least). ${z.type === 'concourse' ? 'Widen it, or build fewer and larger stands.' : 'Make it larger.'}` });
  }
  return out.sort((a, b) => b.weight - a.weight).slice(0, 6);
}
