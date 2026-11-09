// Concourse interiors, carved from the frontage inward (Phase 1 of "Procedural Terminal Interiors").
//
//   1. Holdroom band behind every run of gates: ACRP load rule (80% of seats, 60% seated at 1.4 m²,
//      40% standing at 0.9 m², plus podium and boarding lane), never shallower than 9 m.
//   2. A spine down the long axis: 9 m, or 13.4 m with two moving walkways on arms over 300 m.
//   3. Whatever is left either side of the spine becomes commercial lots that front the spine, sized by depth:
//      under 4 m seating only · 4–8 m kiosks · 8–15 m shops and cafés · over 15 m restaurants and lounges.
//   4. Restroom cores first, one per ~160 m of spine, so no seat is more than ~90 m from one.
//
// Lots on an ungated exterior wall get window views; restaurants and lounges take those first.
// Removing a gate gives its frontage and its holdroom depth back to commerce.
import { Pt, clamp, rectsOverlap, Rect } from './geom';
import { CLASSES, ShopType, TUNE } from './config';
import type { World, Zone, Gate, Shop } from './world';
import { orient, LItem } from './layout';

export interface Budget {
  hold: number; spine: number; commerce: number; seats: number;
  spineW: number; walkways: boolean; long: number; width: number;
  lots: number; window: number; kinds: Record<string, number>; depthA: number; depthB: number;
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
const hash = (n: number) => {
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
  const f = orient(z, world); const eu = clamp(U({ x: (f.a.x + f.b.x) / 2, y: (f.a.y + f.b.y) / 2 }), 0, L);

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
  type Seg = { side: 'A' | 'B'; u0: number; u1: number; d: number; vWall: number; vSpine: number; window: boolean; lounge?: boolean; wc?: boolean };
  const depthAt = (side: 'A' | 'B', u: number) => (side === 'A' ? vs0 - holdAt(runsA, u) : S - holdAt(runsB, u) - vs1);
  const cuts = new Set<number>([uA, uZ]);
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
  // lounges: one per ~10 gates (at least one on a long arm), plus one with the premium fit-out.
  // They go where it's deep and quiet: window walls first, then the far end from security.
  let lounges = Math.max(L >= 150 ? 1 : 0, Math.round(mine.length / 10)) + (z.tier ? 1 : 0);
  const far = (s: Seg) => Math.max(Math.abs(s.u0 - eu), Math.abs(s.u1 - eu));
  for (const s of [...segs].filter(s => !s.wc && s.d >= 12 && (s.u1 - s.u0) * s.d >= 500).sort((p, q) => Number(q.window) - Number(p.window) || far(q) - far(p))) {
    if (lounges <= 0) break; s.lounge = true; lounges--;
  }

  const lot = (s: Seg, u0: number, u1: number, type: ShopType, kind: string, prio: number) => {
    const va = Math.min(s.vWall, s.vSpine) + 0.4, vb = Math.max(s.vWall, s.vSpine) - 0.4;
    const a0 = u0 + 0.5, a1 = u1 - 0.5; const area = (a1 - a0) * (vb - va);
    const um = (u0 + u1) / 2;
    const door = W(um, s.side === 'A' ? s.vSpine + 1.4 : s.vSpine - 1.4);
    const cap = Math.max(4, Math.round(area / TUNE.shops[type].m2));
    const i = shops.length;
    shops.push({ zone: z, i, pts: R(a0, va, a1, vb), door, type, kind, area, cap, window: s.window, rank: prio + Math.abs(um - eu) + hash(z.id * 131 + i * 17) * 40 });
    kinds[kind] = (kinds[kind] ?? 0) + 1; commerce += area; if (s.window) windowLots++;
  };
  for (const s of segs) {
    const len = s.u1 - s.u0;
    if (s.wc) { items.push({ k: 'wc', pts: R(s.u0 + 0.5, Math.min(s.vWall, s.vSpine) + 0.4, s.u1 - 0.5, Math.max(s.vWall, s.vSpine) - 0.4), closed: true, label: 'WC' }); continue; }
    if (len < 5) continue;
    if (s.d < 4) {
      if (s.d >= 1.5) { const v = (s.vWall + s.vSpine) / 2; for (let u = s.u0 + 6; u + 6 < s.u1; u += 14) { items.push({ k: 'seat', pts: [W(u - 4, v), W(u + 4, v)] }); seats += 13; } }
      continue;
    }
    let a = s.u0, b = s.u1;
    if (s.lounge) {
      const ll = Math.min(len, Math.max(600 / s.d, 30));
      if (Math.abs(s.u0 - eu) > Math.abs(s.u1 - eu)) { lot(s, a, a + ll, 'lounge', 'Lounge', -1e6); a += ll; }
      else { lot(s, b - ll, b, 'lounge', 'Lounge', -1e6); b -= ll; }
    }
    if (b - a < 5) continue;
    const fr = s.d < 8 ? 8 : s.d < 15 ? 14 : 22;
    const n = Math.max(1, Math.round((b - a) / fr)); const step = (b - a) / n;
    for (let k = 0; k < n; k++) {
      const u0 = a + k * step, u1 = u0 + step; const h = hash(z.id * 7919 + Math.round(u0 * 4) * 31 + (s.side === 'A' ? 0 : 17));
      if (s.d < 8) { if (h < 0.55) lot(s, u0, u1, 'food', 'Grab-and-go', 0); else lot(s, u0, u1, 'shop', 'Kiosk', 0); }
      // window walls lean to food (people eat where they can watch aircraft), interiors lean to retail
      else if (s.d < 15) { if (h < (s.window ? 0.6 : 0.3)) lot(s, u0, u1, 'food', 'Café', 0); else lot(s, u0, u1, 'shop', 'Shop', 0); }
      else { if (h < (s.window ? 0.7 : 0.4)) lot(s, u0, u1, 'food', 'Restaurant', 0); else lot(s, u0, u1, 'shop', 'Flagship store', 0); }
    }
  }
  [...shops].sort((p, q) => p.rank - q.rank).forEach((sh, k) => (sh.rank = k));

  const dA = Math.max(0, vs0 - hA), dB = Math.max(0, S - hB - vs1);
  return {
    shops, items,
    budget: { hold, spine: sw * (uZ - uA), commerce, seats, spineW: sw, walkways, long: L, width: S, lots: shops.length, window: windowLots, kinds, depthA: dA, depthB: dB },
  };
}
