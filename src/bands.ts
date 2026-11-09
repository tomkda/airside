// Concourse interiors, carved from the frontage inward (Phase 1 of "Procedural Terminal Interiors").
//
//   1. Holdroom band behind every run of gates: ACRP load rule (80% of seats, 60% seated at 1.4 m²,
//      40% standing at 0.9 m², plus podium and boarding lane), never shallower than 9 m.
//   2. A spine down the long axis: 9 m, or 13.4 m with two moving walkways on arms over 300 m.
//   3. Whatever is left either side of the spine becomes commercial lots that front the spine, sized by depth:
//      under 4 m seating only · 4–8 m kiosks · 8–15 m shops and cafés · over 15 m restaurants and lounges.
//   4. Restroom cores first, one per ~160 m of spine, so no seat is more than ~90 m from one.
//
// Lots on an ungated exterior wall get window views. Removing a gate gives its frontage and its holdroom depth
// back to commerce. This file carves the lots and scores what the plan alone decides: visibility from the spine,
// distance from the security exit, the gate cluster nearby. Who leases each lot is settled in commerce.ts (v0.7).
// With walk-through duty free on, the stretch in front of the security exit becomes one store everyone crosses.
import { Pt, clamp, rectsOverlap, Rect } from './geom';
import { CLASSES, COMMERCE } from './config';
import type { World, Zone, Gate, Shop } from './world';
import { orient, LItem } from './layout';

export interface Budget {
  hold: number; spine: number; commerce: number; seats: number;
  spineW: number; walkways: boolean; long: number; width: number;
  lots: number; window: number; kinds: Record<string, number>; depthA: number; depthB: number;
  /** Long axis (x when horiz), where passengers enter from security, the spine's extent, and whether duty free can go in. */
  horiz: boolean; entryU: number; entrySide: 'A' | 'B' | 'E'; uA: number; uZ: number; dutyFreeOK: boolean; gates: number;
}
export interface Carved { shops: Shop[]; items: LItem[]; budget: Budget }

/** Holdroom depth behind one gate of this class, m. */
export function holdDepth(c: number) {
  const C = CLASSES[c]; const pax = 0.8 * C.seats;
  const area = pax * (0.6 * 1.4 + 0.4 * 0.9) + 21 + 17;
  return Math.max(9, area / C.gateSpacing + 2);
}
export const spineWidth = (long: number) => (long > 300 ? 13.4 : 9);

/** Depth classes, in the words the inspector uses. */
export function depthClass(d: number) {
  return d < 4 ? 'seating only' : d < 8 ? 'kiosks' : d < 15 ? 'shops and cafés' : 'restaurants and lounges';
}

/** Integer hash to [0, 1): stable per lot, uncorrelated between neighbours. */
export const hash = (n: number) => {
  let h = Math.imul((Math.round(n) | 0) ^ 0x9e3779b9, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
};

export function carveConcourse(z: Zone, world: World, gates: Gate[]): Carved {
  const horiz = z.w >= z.h; const L = horiz ? z.w : z.h, S = horiz ? z.h : z.w;
  const W = (u: number, v: number): Pt => (horiz ? { x: z.x + u, y: z.y + v } : { x: z.x + v, y: z.y + u });
  const U = (p: Pt) => (horiz ? p.x - z.x : p.y - z.y), V = (p: Pt) => (horiz ? p.y - z.y : p.x - z.x);
  const R = (u0: number, v0: number, u1: number, v1: number) => [W(u0, v0), W(u1, v0), W(u1, v1), W(u0, v1)];
  const sideA = horiz ? 'n' : 'w', sideB = horiz ? 's' : 'e', end0 = horiz ? 'w' : 'n';

  // ---- 1. Holdroom runs behind the gates that are switched on
  const mine = gates.filter(g => g.zone.id === z.id);
  type Run = { u0: number; u1: number; d: number };
  const runsA: Run[] = [], runsB: Run[] = [];
  let e0 = 0, e1 = 0;
  for (const g of mine) {
    const s = g.key[0]; const d = holdDepth(g.cls); const half = CLASSES[g.cls].gateSpacing / 2;
    if (s === sideA || s === sideB) { const u = U(g.door); (s === sideA ? runsA : runsB).push({ u0: u - half, u1: u + half, d }); }
    else if (s === end0) e0 = Math.max(e0, d); else e1 = Math.max(e1, d);
  }
  let hA = Math.max(0, ...runsA.map(r => r.d)), hB = Math.max(0, ...runsB.map(r => r.d));
  if (hA + hB > S - 4) { const k = (S - 4) / (hA + hB); hA *= k; hB *= k; for (const r of runsA) r.d *= k; for (const r of runsB) r.d *= k; }
  if (e0 + e1 > L - 20) { const k = Math.max(0, L - 20) / (e0 + e1); e0 *= k; e1 *= k; }
  const holdAt = (runs: Run[], u: number) => runs.reduce((m, r) => (u > r.u0 && u < r.u1 ? Math.max(m, r.d) : m), 0);

  // ---- 2. Spine
  const sw = clamp(spineWidth(L), 4, Math.max(4, S - hA - hB));
  const c = clamp(S / 2, hA + sw / 2, S - hB - sw / 2);
  const vs0 = c - sw / 2, vs1 = c + sw / 2;
  const walkways = sw >= 13;
  const uA = e0, uZ = L - e1;

  // entry: the edge facing security (or another concourse); lots nearest it lease first
  const f = orient(z, world);
  // the entry point is the middle of the shared wall with security (or the upstream concourse), not the edge's middle
  const ebox: Rect = { x: Math.min(f.a.x, f.b.x) - 1, y: Math.min(f.a.y, f.b.y) - 1, w: Math.abs(f.b.x - f.a.x) + 2, h: Math.abs(f.b.y - f.a.y) + 2 };
  const ups = world.zones.filter(o => o.id !== z.id && o.level === z.level && (o.type === 'security' || o.type === 'concourse') && rectsOverlap(ebox, o));
  const upsS = ups.some(o => o.type === 'security') ? ups.filter(o => o.type === 'security') : ups;
  let eu = clamp(U({ x: (f.a.x + f.b.x) / 2, y: (f.a.y + f.b.y) / 2 }), 0, L);
  if (upsS.length) {
    const lo = Math.min(...upsS.map(o => Math.max(0, Math.min(U({ x: o.x, y: o.y }), U({ x: o.x + o.w, y: o.y + o.h }))))) ;
    const hi = Math.max(...upsS.map(o => Math.min(L, Math.max(U({ x: o.x, y: o.y }), U({ x: o.x + o.w, y: o.y + o.h })))));
    if (hi > lo) eu = (lo + hi) / 2;
  }

  // which exterior wall stretches touch another module on this level (internal, no view)
  const walls: Record<'A' | 'B', Rect[]> = { A: [], B: [] };
  const box = (p: Pt, q: Pt): Rect => ({ x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), w: Math.abs(q.x - p.x), h: Math.abs(q.y - p.y) });
  for (const o of world.zones) if (o.id !== z.id && o.level === z.level) {
    if (rectsOverlap(box(W(0, -1.5), W(L, -0.5)), o)) walls.A.push(o);
    if (rectsOverlap(box(W(0, S + 0.5), W(L, S + 1.5)), o)) walls.B.push(o);
  }
  const windowAt = (side: 'A' | 'B', u0: number, u1: number) => {
    const v = side === 'A' ? -1 : S + 1;
    return !walls[side].some(o => rectsOverlap(box(W(u0 + 1, v - 0.5), W(u1 - 1, v + 0.5)), o));
  };

  const items: LItem[] = [];
  const shops: Shop[] = [];
  const kinds: Record<string, number> = {};
  let hold = 0, commerce = 0, seats = 0, windowLots = 0;

  // ---- holdroom fit-out: rows of seats facing the windows, a podium by each door
  for (const g of mine) {
    const s = g.key[0]; const C = CLASSES[g.cls]; const wdt = Math.min(C.gateSpacing * 0.72, 34);
    if (s === sideA || s === sideB) {
      const u = U(g.door); const inA = s === sideA; const d = holdAt(inA ? runsA : runsB, u) || holdDepth(g.cls);
      const vw = (k: number) => (inA ? k : S - k);
      hold += C.gateSpacing * d;
      for (let k = 2.8; k < d - 1.4; k += 2.4) { items.push({ k: 'seat', pts: [W(u - wdt / 2, vw(k)), W(u + wdt / 2, vw(k))] }); seats += Math.floor(wdt / 0.6); }
      items.push({ k: 'kiosk', pts: R(u + wdt / 2 - 2.5, Math.min(vw(1.2), vw(2.4)), u + wdt / 2 - 0.5, Math.max(vw(1.2), vw(2.4))), closed: true });
    } else {
      const v = V(g.door); const at0 = s === end0; const d = at0 ? e0 : e1;
      const uw = (k: number) => (at0 ? k : L - k);
      hold += C.gateSpacing * d;
      for (let k = 2.8; k < d - 1.4; k += 2.4) { items.push({ k: 'seat', pts: [W(uw(k), v - wdt / 2), W(uw(k), v + wdt / 2)] }); seats += Math.floor(wdt / 0.6); }
    }
  }
  // holdroom floor, tinted, with a thin line where it meets commerce
  for (const [runs, inA] of [[runsA, true], [runsB, false]] as const) for (const r of runs) {
    const v = inA ? r.d : S - r.d; const a = Math.max(uA, r.u0), b = Math.min(uZ, r.u1);
    items.unshift({ k: 'hold', pts: R(a, inA ? 0 : v, b, inA ? v : S), closed: true });
    items.push({ k: 'lane', pts: [W(a, v), W(b, v)] });
  }
  if (e0 > 0) { items.unshift({ k: 'hold', pts: R(0, 0, e0, S), closed: true }); items.push({ k: 'lane', pts: [W(e0, 0), W(e0, S)] }); }
  if (e1 > 0) { items.unshift({ k: 'hold', pts: R(L - e1, 0, L, S), closed: true }); items.push({ k: 'lane', pts: [W(L - e1, 0), W(L - e1, S)] }); }

  // ---- spine: centreline, and moving walkways on long arms
  items.push({ k: 'spine', pts: [W(uA, c), W(uZ, c)] });
  if (walkways) for (let u = uA + 30; u + 60 < uZ - 20; u += 95) for (const dv of [-2.6, 2.6])
    items.push({ k: 'belt', pts: R(u, c + dv - 0.7, u + 60, c + dv + 0.7), closed: true });

  // ---- commercial strips, one per side, split where the holdroom depth changes
  type Seg = { side: 'A' | 'B'; u0: number; u1: number; d: number; vWall: number; vSpine: number; window: boolean; wc?: boolean };
  const depthAt = (side: 'A' | 'B', u: number) => (side === 'A' ? vs0 - holdAt(runsA, u) : S - holdAt(runsB, u) - vs1);
  const cuts = new Set<number>([uA, uZ]);
  // entry side, and whether security is what the entry faces (walk-through duty free needs that)
  const em = { x: (f.a.x + f.b.x) / 2, y: (f.a.y + f.b.y) / 2 };
  const entrySide: 'A' | 'B' | 'E' = Math.abs(U(f.a) - U(f.b)) > Math.abs(V(f.a) - V(f.b)) ? (V(em) < S / 2 ? 'A' : 'B') : 'E';
  const dutyFreeOK = ups.some(o => o.type === 'security');
  if (z.dutyFree && dutyFreeOK && entrySide !== 'E') {
    const len = Math.min(COMMERCE.dfLen, uZ - uA); const u0 = clamp(eu - len / 2, uA, uZ - len);
    cuts.add(u0); cuts.add(u0 + len);
  }
  for (const r of [...runsA, ...runsB]) for (const x of [r.u0, r.u1]) if (x > uA && x < uZ) cuts.add(x);
  // restroom cores: reserve 10 m on the deeper side every ~160 m
  const wcs: { u: number; side: 'A' | 'B' }[] = [];
  if (uZ - uA >= 60) {
    const n = Math.max(1, Math.round((uZ - uA) / 160));
    for (let k = 0; k < n; k++) {
      const u = uA + ((uZ - uA) * (k + 0.5)) / n;
      const side = depthAt('A', u) >= depthAt('B', u) ? 'A' : 'B';
      if (depthAt(side, u) >= 4) { wcs.push({ u, side }); }
      else {
        const inA = holdAt(runsA, u) > 0; const d = holdAt(inA ? runsA : runsB, u);
        if (d > 0) { const v0 = inA ? d - 5 : S - d + 0.5, v1 = inA ? d - 0.5 : S - d + 5; items.push({ k: 'wc', pts: R(u - 4, v0, u + 4, v1), closed: true, label: 'WC' }); }
      }
    }
  }
  const segs: Seg[] = [];
  for (const side of ['A', 'B'] as const) {
    const xs = [...cuts]; for (const w of wcs) if (w.side === side) xs.push(w.u - 5, w.u + 5);
    const sorted = xs.filter(x => x >= uA && x <= uZ).sort((p, q) => p - q);
    for (let i = 0; i + 1 < sorted.length; i++) {
      const u0 = sorted[i], u1 = sorted[i + 1]; if (u1 - u0 < 1) continue;
      const um = (u0 + u1) / 2; const d = depthAt(side, um);
      const hold0 = side === 'A' ? holdAt(runsA, um) : holdAt(runsB, um);
      const vWall = side === 'A' ? hold0 : S - hold0, vSpine = side === 'A' ? vs0 : vs1;
      const isWc = wcs.some(w => w.side === side && Math.abs(w.u - um) < 5.5 && u1 - u0 <= 10.5);
      segs.push({ side, u0, u1, d, vWall, vSpine, window: hold0 === 0 && windowAt(side, u0, u1), wc: isWc });
    }
  }
  // ---- shopfronts: lots front the spine; tenants are chosen later by bidding (commerce.ts)
  const SC = COMMERCE; const half = sw / 2;
  /** Share of the spine that sees a frontage [a0, a1], against an endless straight spine. Corners and spine ends lose sightlines. */
  const sight = (a0: number, a1: number) => {
    const tan = Math.tan((SC.coneDeg * Math.PI) / 180);
    const score = (s0: number, s1: number) => {
      let sum = 0;
      for (let su = s0; su <= s1; su += 2) {
        const x = su < a0 ? a0 - su : su > a1 ? su - a1 : 0;
        if (x === 0) sum += SC.besideScore;
        else if (x <= SC.sightM) sum += half / x <= tan ? 1 - x / SC.sightM : SC.besideScore;
      }
      return sum;
    };
    const ideal = score(a0 - SC.sightM, a1 + SC.sightM);
    return ideal ? score(Math.max(uA, a0 - SC.sightM), Math.min(uZ, a1 + SC.sightM)) / ideal : 0;
  };
  // gate seats near a lot (its gate cluster), and the passengers a day who pass it on their way to a gate
  const gateU = mine.map(g => { const s0 = g.key[0]; return { u: s0 === sideA || s0 === sideB ? U(g.door) : s0 === end0 ? 0 : L, seats: CLASSES[g.cls].seats }; });
  const clusterAt = (a0: number, a1: number) => gateU.reduce((n, g) => {
    const x = g.u < a0 ? a0 - g.u : g.u > a1 ? g.u - a1 : 0; return n + g.seats * Math.max(0, 1 - x / SC.gateReach);
  }, 0);
  // ~2.4 departures per gate a day at 80% load, weighted ~1 per passer: a first guess until the sim has counted
  const priorAt = (a0: number, a1: number) => gateU.reduce((n, g) => n + (Math.min(eu, g.u) <= a1 && Math.max(eu, g.u) >= a0 ? g.seats * 0.8 * 2.4 : 0), 0);
  const farMax = Math.max(1, eu - uA, uZ - eu);

  const lot = (side: 'A' | 'B' | 'E', vWall: number, vSpine: number, u0: number, u1: number, window: boolean, df = false) => {
    const va = Math.min(vWall, vSpine) + 0.4, vb = Math.max(vWall, vSpine) - 0.4;
    const a0 = u0 + 0.5, a1 = u1 - 0.5; const area = (a1 - a0) * (vb - va);
    const um = (u0 + u1) / 2;
    const door = df ? W(um, c) : W(um, side === 'A' ? vSpine + 1.4 : vSpine - 1.4);
    const i = shops.length; const key = df ? 'DF' : `${side}${Math.round(u0)}`;
    const dEntry = Math.max(0, Math.abs(um - eu) - (u1 - u0) / 2);
    let vis = df ? 1 : SC.straightScore * sight(a0, a1);
    if (!df && entrySide !== 'E' && side !== entrySide && Math.abs(um - eu) <= SC.hubReach + (u1 - u0) / 2) vis += SC.hubBonus;
    if (!df && (u0 - uA < SC.cornerM || uZ - u1 < SC.cornerM)) vis -= SC.cornerPenalty;
    shops.push({
      zone: z, i, key, id: `${z.id}:${key}`, pts: R(a0, va, a1, vb), door, type: 'shop', kind: '', tenant: df ? 'dutyfree' : 'retail',
      area, cap: 4, window, rank: 0, side, u0, u1, depth: vb - va, frontage: a1 - a0,
      vis: clamp(vis, 0, 1), near: clamp(1 - dEntry / SC.nearSecurityM, 0, 1), far: clamp(dEntry / farMax, 0, 1),
      gates: clusterAt(u0, u1), gateScore: 0, prior: df ? gateU.reduce((n, g) => n + g.seats * 0.8 * 2.4, 0) : priorAt(u0, u1),
      foot: 0, dwell: 0, measured: false, footScore: 0, dwellScore: 0, bids: {}, bid: 0, rent: 0,
    });
    commerce += area; if (window) windowLots++;
  };

  // walk-through duty free: the stretch every departing passenger crosses after security
  let df: { u0: number; u1: number } | null = null;
  if (z.dutyFree && dutyFreeOK) {
    const len = Math.min(SC.dfLen, uZ - uA);
    const u0 = entrySide === 'E' ? (eu < L / 2 ? uA : uZ - len) : clamp(eu - len / 2, uA, uZ - len);
    df = { u0, u1: u0 + len };
    const um = u0 + len / 2;
    if (entrySide === 'A') lot('A', holdAt(runsA, um), vs1, u0, u0 + len, false, true);
    else if (entrySide === 'B') lot('B', S - holdAt(runsB, um), vs0, u0, u0 + len, false, true);
    else lot('E', holdAt(runsA, um), S - holdAt(runsB, um), u0, u0 + len, false, true);
  }
  const inDF = (sd: 'A' | 'B', um: number) => !!df && (entrySide === 'E' || entrySide === sd) && um > df.u0 && um < df.u1;

  for (const sg of segs) {
    const len = sg.u1 - sg.u0;
    if (sg.wc) { items.push({ k: 'wc', pts: R(sg.u0 + 0.5, Math.min(sg.vWall, sg.vSpine) + 0.4, sg.u1 - 0.5, Math.max(sg.vWall, sg.vSpine) - 0.4), closed: true, label: 'WC' }); continue; }
    if (len < 5) continue;
    if (sg.d < 4) {
      if (sg.d >= 1.5) { const v = (sg.vWall + sg.vSpine) / 2; for (let u = sg.u0 + 6; u + 6 < sg.u1; u += 14) { items.push({ k: 'seat', pts: [W(u - 4, v), W(u + 4, v)] }); seats += 13; } }
      continue;
    }
    if (inDF(sg.side, (sg.u0 + sg.u1) / 2)) continue;
    const fr = sg.d < 8 ? 8 : sg.d < 15 ? 14 : 22;
    const n = Math.max(1, Math.round(len / fr)); const step = len / n;
    for (let k = 0; k < n; k++) lot(sg.side, sg.vWall, sg.vSpine, sg.u0 + k * step, sg.u0 + (k + 1) * step, sg.window);
  }

  const dA = Math.max(0, vs0 - hA), dB = Math.max(0, S - hB - vs1);
  return {
    shops, items,
    budget: {
      hold, spine: sw * (uZ - uA), commerce, seats, spineW: sw, walkways, long: L, width: S, lots: shops.length, window: windowLots, kinds, depthA: dA, depthB: dB,
      horiz, entryU: eu, entrySide, uA, uZ, dutyFreeOK, gates: mine.length,
    },
  };
}
