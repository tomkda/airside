// Goals and the airport's rating (v0.9). Pure logic: reads sim state, no DOM.
// Goals are milestones that point a new player at the next interesting thing to build, each with a grant.
// They are checked when the layout changes and when a day closes; done goals are saved.
import type { Sim, Report } from './sim';
import { clamp } from './geom';

export interface Goal {
  id: string; title: string; hint: string; reward: number;
  /** Progress toward the goal, as [value, target]; done when value >= target. */
  progress(s: Sim, last?: Report): [number, number];
}

const last = (s: Sim) => s.history[s.history.length - 1];
const active = (s: Sim) => s.d.terminals.filter(t => t.active).length;
const leased = (s: Sim) => [...s.d.shops.values()].flat().filter(sh => s.leased(sh)).length;

export const GOALS: Goal[] = [
  { id: 'open', title: 'Open your first terminal', hint: 'Check-in, security, a concourse with gates and bag claim, joined on foot, with a road along the front for a curb.', reward: 10e6,
    progress: s => [Math.min(1, active(s)), 1] },
  { id: 'day', title: 'Fly a full day', hint: 'Let a day run to midnight with flights operating.', reward: 5e6,
    progress: (s, r) => [r && r.stats.flights > 0 ? 1 : 0, 1] },
  { id: 'deck', title: 'Build a two-level frontage road', hint: 'Stack check-in on Level 1 over bag claim, then run a road along that face.', reward: 8e6,
    progress: s => [Math.min(1, s.d.decks.length), 1] },
  { id: 'pax3', title: '3,000 departures in a day', hint: 'More gates, more runway, a fair slot fee.', reward: 15e6,
    progress: (s, r) => [Math.round(r?.stats.paxDep ?? 0), 3000] },
  { id: 'lots', title: 'Lease 40 commercial lots', hint: 'Footfall leases lots: put shops where departing passengers walk.', reward: 10e6,
    progress: s => [leased(s), 40] },
  { id: 'df', title: 'Open walk-through duty free', hint: 'Select a concourse that security opens into and switch on Walk-through.', reward: 6e6,
    progress: s => [s.world.zones.some(z => z.dutyFree) ? 1 : 0, 1] },
  { id: 'sat', title: 'Satisfaction 88 for a day', hint: 'Short queues, short walks, seats at the gate.', reward: 20e6,
    progress: (s, r) => [Math.round(r?.sat ?? 0), 88] },
  { id: 'twin', title: 'Open a second terminal', hint: 'New terminal (N), lay it out, give it a curb and gates.', reward: 30e6,
    progress: s => [active(s), 2] },
  { id: 'a380', title: 'Welcome an A380', hint: 'A 3,000 m runway, Code F taxiways the whole way, and A380 gates.', reward: 40e6,
    progress: (s, r) => [Math.min(1, r?.plan.byAirline.find(b => b.airline.iata === 'PX')?.scheduled ?? 0), 1] },
  { id: 'pax6', title: '6,000 departures in a day', hint: 'Two terminals, parallel runways, more lanes.', reward: 40e6,
    progress: (s, r) => [Math.round(r?.stats.paxDep ?? 0), 6000] },
  { id: 'profit', title: '$250k profit in a day', hint: 'Commerce, parking and slot fees all count.', reward: 25e6,
    progress: (s, r) => [Math.round(r?.profit ?? 0), 250000] },
];

/** Goals newly reached. The caller pays the reward and records them. */
export function checkGoals(s: Sim, done: Set<string>): Goal[] {
  const r = last(s);
  return GOALS.filter(g => !done.has(g.id) && (() => { const [v, t] = g.progress(s, r); return v >= t; })());
}
export const nextGoals = (s: Sim, done: Set<string>, n = 3) => GOALS.filter(g => !done.has(g.id)).slice(0, n);

/**
 * The airport's star rating, 0.5–5 in half stars: satisfaction (half the weight), on-time running, and how much of
 * the day's demand you could take. Shown in the header; it rewards a well-run airport, not a big one.
 */
export function rating(s: Sim): number {
  const r = last(s); if (!r) return 0;
  const sat = clamp((r.sat - 55) / 35, 0, 1);
  const onTime = clamp(r.onTime, 0, 1);
  const served = r.plan.demand ? clamp(r.plan.scheduled / r.plan.demand, 0, 1) : 0;
  const missed = r.stats.paxDep ? clamp(1 - r.stats.missed / Math.max(1, r.stats.paxDep) * 10, 0, 1) : 0;
  return Math.max(0.5, Math.round((sat * 0.45 + onTime * 0.2 + served * 0.2 + missed * 0.15) * 10) / 2);
}
