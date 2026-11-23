// v0.59: the advisor. It reads the day (the schedule's turned-away flights, the airfield's holds, each module's level
// of service) and says what is holding the airport back, worst first, each with the one upgrade that would lift it.
// Pure: it reads the sim and decides nothing about cost or room; ui.ts works those out and lays the upgrade.
import { TUNE, ZONES, LOS } from './config';
import type { Sim } from './sim';
import type { Zone } from './world';
import { Pt } from './geom';
import { losDay } from './los';
import { heart } from './shapes';
import { wayMid } from './ways';

export type AdviceKind = 'stands' | 'extend' | 'parallel' | 'staff' | 'desks' | 'info';
export interface Advice {
  /** stable while the cause stands, so a button finds it again */
  key: string; kind: AdviceKind; title: string; why: string;
  /** what it bears on, and where to look */
  zone?: number; way?: number; at?: Pt;
  /** stands to build, staff to hire, desks to fit */
  n?: number; pool?: 'agents' | 'screeners' | 'officers' | 'handlers';
  weight: number;
}
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const straight = (z: Zone) => !z.poly && !z.sides && !z.bend && !z.taper && !z.twist;

export function advise(sim: Sim): Advice[] {
  const out: Advice[] = []; const d = sim.d, p = sim.plan;
  const open = new Set(d.terminals.filter(T => T.active).flatMap(T => T.zones.map(z => z.id)));
  // ---- flights turned away for want of a gate
  if (p.rejectedGates > 0) {
    const offers = d.gateSlots.filter(sl => !sl.on && sl.zone.stands);
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
    const rw = d.runways[0];
    out.push({ key: 'runway', kind: 'info', at: rw ? { x: (rw.rw.a.x + rw.rw.b.x) / 2, y: (rw.rw.a.y + rw.rw.b.y) / 2 } : undefined, weight: p.rejectedRunway * 8,
      title: 'A second runway', why: `${plural(p.rejectedRunway, 'flight')} today found no slot in the peak hours: one runway takes a movement every ${TUNE.separationMin} minutes. A second, parallel and ${TUNE.dependentSpacing} m or more away, doubles that; closer, or crossing, adds less.` });
  }
  if (p.rejectedAircraft > 0) out.push({ key: 'aircraft', kind: 'info', weight: p.rejectedAircraft * 6, title: 'Larger aircraft',
    why: `${plural(p.rejectedAircraft, 'flight')} today ${p.rejectedAircraft === 1 ? 'was' : 'were'} flown by aircraft nothing here can take${p.wantsSJ ? ` (${p.wantsSJ} by A380: a 3,000 m runway, Code F taxiways all the way, and A380 stands)` : ''}. Lengthen the runway, widen the taxiways on the way, or size a concourse for them.` });
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
      if (L.need > L.open && L.need <= L.max) out.push({ key: 'staff' + z.id, kind: 'staff', zone: z.id, at: heart(z), n: (L.need - L.open) * per, pool, weight: w0,
        title: `Staff ${plural(L.need - L.open, 'more ' + unit.replace(/s$/, ''))} at ${name.toLowerCase()}`, why: `Its queue waited ${Math.round(L.wait ?? 0)} minutes in a rush (${LOS.std[L.kind].wait![1]} at most): the busiest hour brought ${Math.round(L.demand)} people and the ${L.open} staffed served ${Math.round(L.cap)}.` });
      else if (L.need > L.max && L.max < max) out.push({ key: 'desks' + z.id, kind: 'desks', zone: z.id, at: heart(z), n: Math.min(max, L.need) - L.max, weight: w0,
        title: `Fit ${plural(Math.min(max, L.need) - L.max, 'more ' + unit.replace(/s$/, ''))} in ${name.toLowerCase()}`, why: `The busiest hour brought ${Math.round(L.demand)} people; all ${L.max} of its ${unit} serve ${Math.round(L.capMax)}. It has room for ${max}.` });
      else out.push({ key: 'los' + z.id, kind: 'info', zone: z.id, at: heart(z), weight: w0, title: `${name} is too small`,
        why: `Its queue waited ${Math.round(L.wait ?? 0)} minutes in a rush with every one of its ${unit} at work. Make it larger, upgrade its fit-out, or build a second.` });
    } else if (L.sBand === 2) out.push({ key: 'los' + z.id, kind: 'info', zone: z.id, at: heart(z), weight: w0, title: `${name} is crowded`,
      why: `${L.peakQ} people waited on ${Math.round(L.area)} m² at the peak, ${L.space.toFixed(1)} m² each (${LOS.std[L.kind].space[0]} at least). ${z.type === 'concourse' ? 'Widen it, or build fewer and larger stands.' : 'Make it larger.'}` });
    else if (L.wBand === 2) out.push({ key: 'bags' + z.id, kind: 'staff', zone: z.id, at: heart(z), n: 2, pool: 'handlers', weight: w0, title: 'Hire baggage handlers',
      why: `The longest wait for a bag at ${name.toLowerCase()} was ${Math.round(L.wait ?? 0)} minutes (${LOS.std[L.kind].wait![1]} at most). More handlers bring bags to the belts sooner.` });
  }
  return out.sort((a, b) => b.weight - a.weight).slice(0, 6);
}
