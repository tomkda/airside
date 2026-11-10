// A terminal in one drag (v0.15). Pure logic, no DOM.
//
//   Given the rectangle the player drags for a new terminal, this lays out a complete starter terminal inside it:
//   a concourse along the airside edge, security behind it, and the hall (check-in over baggage claim) on the
//   landside edge. Which edge is airside is read from the airfield: it is the edge that faces the nearest taxiway,
//   or the nearest runway if there is no taxiway yet. The player then moves and resizes the pieces like any others.
//
// Proportions follow the sample terminal, which was sized from ACRP Report 25 (Airport Passenger Terminal Planning
// and Design): a concourse 40–60 m deep, a checkpoint about a fifth of the frontage, and a hall about 60% of it.
import { Pt, Rect, clamp, segDist } from './geom';
import { Level, SITES, ZoneType, ZONES } from './config';
import type { World } from './world';

export type Side = 'n' | 'e' | 's' | 'w';
export interface PlanPart { type: ZoneType; level: Level; rect: Rect }
export const PLAN_MIN = { along: 120, deep: 140 };   // smallest site that gets a full layout (m, inside its margin)

/** The edge of the site that faces the airfield. */
export function airsideOf(site: Rect, world: World): Side {
  const mids: [Side, Pt][] = [
    ['n', { x: site.x + site.w / 2, y: site.y }], ['e', { x: site.x + site.w, y: site.y + site.h / 2 }],
    ['s', { x: site.x + site.w / 2, y: site.y + site.h }], ['w', { x: site.x, y: site.y + site.h / 2 }],
  ];
  const taxis = world.ways.filter(w => w.kind === 'taxi');
  const lines = taxis.length ? taxis : world.runways;
  if (!lines.length) return 'n';
  let best: Side = 'n', bd = Infinity;
  for (const [s, p] of mids) {
    // a terminal is long along its airside: prefer a long edge unless a short one is much nearer the airfield
    const short = (s === 'n' || s === 's') ? site.w < site.h : site.h < site.w;
    let d = Infinity; for (const l of lines) d = Math.min(d, segDist(p, l.a, l.b));
    d += short ? 120 : 0;
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}

/** The starter layout for a site, or null if the site is too small for one. */
export function planTerminal(site: Rect, air: Side): PlanPart[] | null {
  const pad = SITES.pad; const horiz = air === 'n' || air === 's';
  const W = (horiz ? site.w : site.h) - 2 * pad, D = (horiz ? site.h : site.w) - 2 * pad;
  if (W < PLAN_MIN.along || D < PLAN_MIN.deep) return null;
  const r5 = (v: number) => Math.round(v / 5) * 5;
  const conc = clamp(r5(D * 0.3), 40, 60), hall = clamp(r5(D * 0.32), 40, 90), sec = clamp(r5(D - conc - hall), 40, 130);
  const secW = clamp(r5(W * 0.22), 40, 140), hallW = Math.min(W, clamp(r5(W * 0.6), 80, 360));
  // local frame: t runs along the airside edge, s runs back from it
  const local = (t0: number, s0: number, tw: number, sd: number): Rect => {
    if (air === 'n') return { x: site.x + pad + t0, y: site.y + pad + s0, w: tw, h: sd };
    if (air === 's') return { x: site.x + pad + t0, y: site.y + site.h - pad - s0 - sd, w: tw, h: sd };
    if (air === 'w') return { x: site.x + pad + s0, y: site.y + pad + t0, w: sd, h: tw };
    return { x: site.x + site.w - pad - s0 - sd, y: site.y + pad + t0, w: sd, h: tw };
  };
  const mid = (w: number) => r5((W - w) / 2);
  const hallR = local(mid(hallW), conc + sec, hallW, hall);
  return [
    { type: 'concourse', level: 1, rect: local(0, 0, W, conc) },
    { type: 'security', level: 1, rect: local(mid(secW), conc, secW, sec) },
    { type: 'checkin', level: 1, rect: hallR },
    { type: 'claim', level: 0, rect: hallR },
  ];
}

export const planCost = (parts: PlanPart[]) => parts.reduce((t, p) => t + p.rect.w * p.rect.h * ZONES[p.type].costPerM2, 0);
