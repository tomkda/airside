// Concourse commerce (v0.7): scores per lot, and tenants bidding for lots. Pure logic, no DOM.
//
//   Footfall  departing passengers who pass a lot's frontage, each weighted by spare minutes before boarding.
//             The sim counts them in bins along the concourse's long axis (zone.flow); until it has, a lot uses
//             a structural estimate: the seats of the gates whose way from security runs past it.
//   Visibility how much of the spine sees the shopfront (bands.ts): straight runs and the face opposite the
//             security exit score high, lots tucked into the spine's ends score low.
//   Dwell     the average spare minutes of those passers.
//
// Each tenant format bids for each lot it fits (by depth). The best bid wins, a sitting tenant keeps the lot
// unless out-bid by COMMERCE.relet, and rent (the minimum guarantee) follows the winning score.
import { COMMERCE as SC, TENANTS, TenantId, TUNE, ShopType } from './config';
import type { World, Zone, Shop, Flow } from './world';
import { Budget, hash } from './bands';
import { clamp } from './geom';

export const flowBins = (long: number) => Math.max(1, Math.ceil(long / SC.binM));
export const newFlow = (n: number): Flow => ({ w: new Array(n).fill(0), n: new Array(n).fill(0), s: new Array(n).fill(0) });

/** Footfall over a frontage [u0, u1]: passers a day (mean over its bins), raw passers, and their mean spare minutes. */
export function flowOver(f: Flow | undefined, u0: number, u1: number) {
  if (!f || !f.w.length) return { w: 0, n: 0, dwell: 0 };
  const b0 = clamp(Math.floor(u0 / SC.binM), 0, f.w.length - 1), b1 = clamp(Math.ceil(u1 / SC.binM) - 1, b0, f.w.length - 1);
  let w = 0, n = 0, s = 0;
  for (let b = b0; b <= b1; b++) { w += f.w[b]; n += f.n[b]; s += f.s[b]; }
  const k = b1 - b0 + 1;
  return { w: w / k, n: n / k, dwell: n ? s / n : 0 };
}

const depthIdx = (d: number) => (d < 8 ? 0 : d < 15 ? 1 : 2);
const ORDER: TenantId[] = ['retail', 'dining', 'grab', 'lounge'];

/** What each format would pay for a lot, as a 0–1-ish score. Only formats that fit the lot's depth bid. */
export function bidsFor(sh: Shop): Partial<Record<TenantId, number>> {
  const F = sh.footScore, D = sh.dwellScore, V = sh.vis, N = sh.near, Far = sh.far, G = sh.gateScore, Wn = sh.window ? 1 : 0;
  const deep = clamp((sh.depth - 8) / 15, 0, 1);
  const di = depthIdx(sh.depth);
  const jit = (k: number) => (hash(sh.zone.id * 7919 + Math.round(sh.u0 * 4) * 31 + (sh.side === 'A' ? 0 : 17) + k * 1013) - 0.5) * SC.jitter;
  // Each format's locational fit, times how much traffic it needs. Only lounges are destinations that don't.
  const traffic = (k: number) => k + (1 - k) * F;
  const raw: Record<TenantId, number> = {
    // core retail: impulse buys, so the busiest, most visible fronts near security, before people settle
    retail: (0.35 * V + 0.4 * N + 0.25 * (1 - D)) * traffic(0.2),
    // sit-down food: apron views and gate clusters, where people have time
    dining: (0.4 * Wn + 0.35 * G + 0.25 * D) * traffic(0.25),
    // grab-and-go and convenience: out by the far gates, for people who walked straight there
    grab: (0.4 * Far + 0.25 * G + 0.2 * (1 - D)) * traffic(0.2),
    // lounges: deep and quiet, away from security, a view if there is one. Quiet, not dead: a lounge still wants
    // to sit off a pier people use, so the quiet score peaks at a third of the busiest lot's footfall.
    lounge: 0.4 * deep + 0.3 * (F < 0.33 ? F / 0.33 : (1 - F) / 0.67) + 0.2 * Far + 0.1 * Wn,
    dutyfree: 0,
  };
  const out: Partial<Record<TenantId, number>> = {};
  ORDER.forEach((t, k) => {
    if (!TENANTS[t].kinds[di]) return;
    if (t === 'lounge' && (sh.depth < SC.loungeMinDepth || sh.area < SC.loungeMinArea)) return;
    out[t] = Math.max(0, raw[t] + jit(k));
  });
  return out;
}

function fit(sh: Shop, t: TenantId) {
  const kind = TENANTS[t].kinds[depthIdx(sh.depth)] ?? TENANTS[t].kinds[2]!;
  const type: ShopType = kind === 'Convenience' ? 'shop' : TENANTS[t].type;
  sh.tenant = t; sh.kind = kind; sh.type = type;
  sh.cap = Math.max(4, Math.round(sh.area / TUNE.shops[type].m2));
  sh.bid = t === 'dutyfree' ? clamp(0.6 + 0.4 * sh.footScore, 0, 1) : sh.bids[t] ?? 0;
  sh.rent = sh.area * SC.rentPerM2Day[t] * (SC.rentFloor + sh.bid);
}

/** Score every lot in every concourse, then let them. Reads zone.flow and zone.tenants; writes only the Shop objects. */
export function letLots(world: World, shops: Map<number, Shop[]>, budgets: Map<number, Budget>) {
  const zoneOf = new Map<number, Zone>(world.zones.map(z => [z.id, z]));
  // footfall and dwell: measured when the sim has counted this concourse at its current length, else the prior
  for (const [id, list] of shops) {
    const z = zoneOf.get(id)!; const B = budgets.get(id)!;
    const f = z.flow && z.flow.w.length === flowBins(B.long) && z.flow.n.some(x => x > 0) ? z.flow : undefined;
    const gmax = Math.max(1, ...list.map(sh => sh.gates));
    for (const sh of list) {
      sh.gateScore = sh.gates / gmax;
      if (f) { const o = flowOver(f, sh.u0, sh.u1); sh.foot = o.w; sh.dwell = o.dwell; sh.measured = true; }
      else { sh.foot = sh.prior; sh.dwell = 30 + 20 * sh.far; sh.measured = false; }
    }
  }
  const all = [...shops.values()].flat().filter(sh => sh.tenant !== 'dutyfree');
  const fmax = Math.max(1, ...all.map(sh => sh.foot));
  for (const sh of [...shops.values()].flat()) {
    sh.footScore = clamp(sh.foot / fmax, 0, 1); sh.dwellScore = clamp((sh.dwell - SC.dwellLo) / (SC.dwellHi - SC.dwellLo), 0, 1);
  }

  for (const [id, list] of shops) {
    const z = zoneOf.get(id)!; const B = budgets.get(id)!; const was = z.tenants ?? {};
    const lots = list.filter(sh => sh.tenant !== 'dutyfree');
    for (const sh of lots) sh.bids = bidsFor(sh);
    const sitting = (sh: Shop, t: TenantId) => (was[sh.key] === t ? 1 + SC.relet : 1);
    // lounges first, by quota: one per ~10 gates (at least one on a long pier), plus one with the premium fit-out
    let quota = Math.max(B.long >= 150 ? 1 : 0, Math.round(B.gates / SC.loungePerGates)) + (z.tier ? 1 : 0);
    const taken = new Set<Shop>();
    for (const sh of lots.filter(q => q.bids.lounge !== undefined).sort((p, q) => q.bids.lounge! * sitting(q, 'lounge') - p.bids.lounge! * sitting(p, 'lounge'))) {
      if (quota <= 0) break; fit(sh, 'lounge'); taken.add(sh); quota--;
    }
    // everyone else: strongest lots first, so they set the mix their neighbours react to
    const best = (sh: Shop) => Math.max(0, ...ORDER.filter(t => t !== 'lounge').map(t => sh.bids[t] ?? 0));
    for (const sh of lots.filter(q => !taken.has(q)).sort((p, q) => best(q) - best(p) || p.i - q.i)) {
      const nb = lots.filter(o => taken.has(o) && o.side === sh.side && (Math.abs(o.u1 - sh.u0) < 1 || Math.abs(o.u0 - sh.u1) < 1)).map(o => o.tenant);
      let pick: TenantId = 'retail', top = -Infinity;
      for (const t of ORDER) {
        if (t === 'lounge' || sh.bids[t] === undefined) continue;
        const v = sh.bids[t]! * sitting(sh, t) - (nb.includes(t) ? SC.neighbour : 0);
        if (v > top) { top = v; pick = t; }
      }
      fit(sh, pick); taken.add(sh);
    }
    for (const sh of list) if (sh.tenant === 'dutyfree') { sh.bids = {}; fit(sh, 'dutyfree'); sh.cap = Math.max(20, Math.round(sh.area / 10)); }
    // best scores lease first
    [...list].sort((p, q) => Number(q.tenant === 'dutyfree') - Number(p.tenant === 'dutyfree') || q.bid - p.bid || p.i - q.i).forEach((sh, k) => (sh.rank = k));
    const kinds: Record<string, number> = {};
    for (const sh of list) kinds[sh.kind] = (kinds[sh.kind] ?? 0) + 1;
    B.kinds = kinds;
  }
}

/** Who holds each lot now, for saving on the zone. */
export const tenantsOf = (list: Shop[]) => Object.fromEntries(list.map(sh => [sh.key, sh.tenant])) as Record<string, TenantId>;
