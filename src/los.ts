// v0.57: level of service. Each processing module and concourse is judged the way IATA's Airport Development
// Reference Manual judges a subsystem: on the floor each waiting passenger has, and on how long they wait, each
// over-design, optimum or sub-optimum; the two together give the module's band. Pure: reads the sim, writes nothing.
import { LOS } from './config';
import type { Sim, LosStat } from './sim';
import type { Zone } from './world';
import { polyArea } from './shapes';

export type Axis = 0 | 1 | 2;                 // over-design, optimum, sub-optimum
export type Band = 0 | 1 | 2 | 3;             // …and under-provided
export type LosKind = keyof typeof LOS.std;
export interface Los {
  kind: LosKind; band: Band;
  /** m² per waiting passenger at the peak, and its band; minutes waited at the peak, and its band */
  space: number; sBand: Axis; wait?: number; wBand?: Axis;
  /** the most people waiting at once, the floor they wait on, the busiest hour's arrivals, and what the open and all the desks can serve an hour */
  peakQ: number; area: number; demand: number; cap: number; capMax: number;
  /** open desks the busiest hour needed to keep up */
  need: number; open: number; max: number;
}
export const losKind = (z: Zone): LosKind | null => (z.type in LOS.std ? z.type as LosKind : null);
const floor = (z: Zone) => (z.poly ? polyArea(z.poly) : z.w * z.h);
/** The floor people wait on: a share of a processing module, a concourse's holdrooms. */
export function losArea(sim: Sim, z: Zone): number {
  if (z.type === 'concourse') return sim.d.budgets.get(z.id)?.hold ?? 0;
  return floor(z) * (LOS.queueShare[z.type as keyof typeof LOS.queueShare] ?? 0.5);
}
const spaceAxis = (v: number, [lo, hi]: readonly number[]): Axis => (v > hi ? 0 : v >= lo ? 1 : 2);
const waitAxis = (w: number, [lo, hi]: readonly number[]): Axis => (w < lo ? 0 : w <= hi ? 1 : 2);
/** IATA's matrix: sub-optimum on both counts is under-provided; on either, sub-optimum; over-design on both (or on
 *  the only count there is), over-design; else optimum. A concourse has no wait: under 3/4 of the least floor is under-provided. */
export function bandOf(s: Axis, w: Axis | undefined, space: number, lo: number): Band {
  if (w === undefined) return s === 2 ? (space < lo * 0.75 ? 3 : 2) : s === 0 ? 0 : 1;
  return s === 2 && w === 2 ? 3 : s === 2 || w === 2 ? 2 : s === 0 && w === 0 ? 0 : 1;
}
/** A module's level of service from a day's figures (or the moment's). Null where nobody has waited. */
export function losFrom(sim: Sim, z: Zone, st: LosStat | undefined): Los | null {
  const kind = losKind(z); if (!kind || !st || (!st.peakQ && !st.peakWait)) return null;
  const std = LOS.std[kind]; const area = losArea(sim, z);
  const space = st.peakQ ? area / st.peakQ : Infinity; const sBand = spaceAxis(space, std.space);
  const wait = std.wait ? st.peakWait : undefined; const wBand = std.wait ? waitAxis(st.peakWait, std.wait) : undefined;
  const p = sim.procs.get(z.id); const svc = p && (kind === 'checkin' || kind === 'security' || kind === 'passport') ? sim.svcTime(p) : 0;
  const demand = Math.max(0, ...st.in);
  return { kind, band: bandOf(sBand, wBand, space, std.space[0]), space, sBand, wait, wBand, peakQ: st.peakQ, area, demand,
    cap: svc && p ? p.servers * 60 / svc : 0, capMax: svc && p ? p.maxServers * 60 / svc : 0, need: svc ? Math.ceil(demand * svc / 60) : 0, open: p?.servers ?? 0, max: p?.maxServers ?? 0 };
}
/** The day's level of service: today's so far once people have waited there, else the last full day's. */
export const losDay = (sim: Sim, z: Zone): Los | null => losFrom(sim, z, sim.los.get(z.id)) ?? losFrom(sim, z, sim.losLast.get(z.id));
/** As things stand this minute. */
export function losNow(sim: Sim, z: Zone): Los | null {
  const p = sim.procs.get(z.id); let q = 0, w = 0;
  if (z.type === 'concourse') { for (const x of sim.pax) if (x.stage === 'dwell' && x.flight.gate.zone.id === z.id) q++; }
  else if (z.type === 'claim') { for (const x of sim.pax) if (x.stage === 'waitBag' && x.proc === p) { q++; w = Math.max(w, sim.t - x.since); } }
  else if (p) { q = p.queue.length; w = Math.max(p.recentWait, q && p.servers ? q * sim.svcTime(p) / p.servers : 0); }
  return losFrom(sim, z, { peakQ: q, peakWait: w, in: [] });
}
/** What would lift a module out of sub-optimum, in a sentence. */
export function losFix(L: Los, unit: string): string {
  if (L.band === 0) return 'room to spare: it could take more flights as it is, or be built smaller';
  if (L.band < 2) return '';
  const std = LOS.std[L.kind]; const parts: string[] = [];
  if (L.wBand === 2) {
    if (L.kind === 'claim') parts.push('bags are slow to arrive: hire baggage handlers or add carousels');
    else if (L.need > L.max) parts.push(`the busiest hour brings ${Math.round(L.demand)} people and every one of its ${unit} can serve ${Math.round(L.capMax)}: make the module larger, upgrade it, or build another`);
    else if (L.need > L.open) parts.push(`the busiest hour brings ${Math.round(L.demand)} people and the ${L.open} open ${unit} serve ${Math.round(L.cap)}: staff ${L.need} of its ${L.max}`);
    else parts.push(`its queue waits ${Math.round(L.wait ?? 0)} min at the peak (${std.wait![1]} at most): staff more ${unit}`);
  }
  if (L.sBand === 2) parts.push(`${L.peakQ} people wait on ${Math.round(L.area)} m² (${L.space.toFixed(1)} m² each, ${std.space[0]} at least): ${L.kind === 'concourse' ? 'widen the concourse or build fewer, larger stands' : `it needs about ${Math.round(L.peakQ * std.space[0] / (LOS.queueShare[L.kind as keyof typeof LOS.queueShare] ?? 0.5))} m² of floor`}`);
  return parts.join('; ');
}
