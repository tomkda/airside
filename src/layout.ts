// Interior layouts. Each module gets a frame (u runs along its entry side, v runs into the room) and a
// procedural plan drawn from real planning rules: island check-in with queue mazes, banked security
// lanes and a greeters' hall in front of long reclaim carousels. Concourses are carved in bands.ts.
// Unit counts come from the plan, not from floor area.
import { Pt, add, mul, sub, dist, norm, center, clamp, lerpPt } from './geom';
import type { ZoneType } from './config';
import type { World, Zone, Frame } from './world';

export type LKind =
  | 'counter' | 'belt' | 'kiosk' | 'stanchion' | 'door'
  | 'divest' | 'xray' | 'body' | 'recompose' | 'lane'
  | 'carousel' | 'carousel-off' | 'feed'
  | 'seat' | 'spine' | 'wc' | 'office' | 'table' | 'plant' | 'hold';
export interface LItem { k: LKind; pts: Pt[]; closed?: boolean; slot?: number; label?: string }

const UPSTREAM: Record<ZoneType, ZoneType[]> = {
  checkin: ['curb'], security: ['checkin'], concourse: ['security', 'concourse'],
  claim: ['passport', 'curb'], curb: ['checkin', 'claim', 'security', 'concourse'], parking: ['curb'],
  passport: ['concourse'], rideshare: ['curb'], rental: ['curb'], bus: ['curb'], hotel: ['curb'], train: ['curb'],
};

/** Edges with inward normals. */
function edgesOf(z: Zone) {
  return [
    { a: { x: z.x, y: z.y }, b: { x: z.x + z.w, y: z.y }, inward: { x: 0, y: 1 }, depth: z.h },
    { a: { x: z.x + z.w, y: z.y + z.h }, b: { x: z.x, y: z.y + z.h }, inward: { x: 0, y: -1 }, depth: z.h },
    { a: { x: z.x, y: z.y + z.h }, b: { x: z.x, y: z.y }, inward: { x: 1, y: 0 }, depth: z.w },
    { a: { x: z.x + z.w, y: z.y }, b: { x: z.x + z.w, y: z.y + z.h }, inward: { x: -1, y: 0 }, depth: z.w },
  ];
}

/** Length of an axis-aligned edge that touches another rectangle's boundary. */
function touchLen(e: { a: Pt; b: Pt }, o: Zone) {
  if (Math.abs(e.a.y - e.b.y) < 0.5) {
    const y = e.a.y; if (Math.abs(o.y - y) > 1 && Math.abs(o.y + o.h - y) > 1) return 0;
    return Math.max(0, Math.min(Math.max(e.a.x, e.b.x), o.x + o.w) - Math.max(Math.min(e.a.x, e.b.x), o.x));
  }
  const x = e.a.x; if (Math.abs(o.x - x) > 1 && Math.abs(o.x + o.w - x) > 1) return 0;
  return Math.max(0, Math.min(Math.max(e.a.y, e.b.y), o.y + o.h) - Math.max(Math.min(e.a.y, e.b.y), o.y));
}

/** Entry side: the edge that touches the upstream module the most; otherwise the one nearest to it. */
export function orient(z: Zone, world: World) {
  const edges = edgesOf(z);
  const ups = world.zones.filter(o => o.id !== z.id && UPSTREAM[z.type].includes(o.type));
  let best = edges[1], bs = 0;
  for (const e of edges) { const s = ups.reduce((n, o) => n + touchLen(e, o), 0); if (s > bs) { bs = s; best = e; } }
  if (bs === 0 && ups.length) {
    const c = center(z);
    const U = center(ups.reduce((m, o) => (dist(center(o), c) < dist(center(m), c) ? o : m)));
    best = edges.reduce((m, q) => (dist(lerpPt(q.a, q.b, .5), U) < dist(lerpPt(m.a, m.b, .5), U) ? q : m));
  }
  return { a: best.a, b: best.b, along: norm(sub(best.b, best.a)), inward: best.inward, edgeLen: dist(best.a, best.b), depth: best.depth };
}

type F = ReturnType<typeof orient>;
const helpers = (f: F) => {
  const P = (u: number, v: number): Pt => add(add(f.a, mul(f.along, u)), mul(f.inward, v));
  const R = (u0: number, v0: number, u1: number, v1: number) => [P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)];
  const L = (u0: number, v0: number, u1: number, v1: number) => [P(u0, v0), P(u1, v1)];
  return { P, R, L };
};
/** Stadium (rounded-end belt) along v, centred at (uc, vc). */
function stadium(P: (u: number, v: number) => Pt, uc: number, vc: number, w: number, len: number) {
  const r = w / 2, h = len / 2 - r, pts: Pt[] = [];
  for (let i = 0; i <= 8; i++) { const a = Math.PI + (i / 8) * Math.PI; pts.push(P(uc + r * Math.cos(a), vc - h + r * Math.sin(a))); }
  for (let i = 0; i <= 8; i++) { const a = (i / 8) * Math.PI; pts.push(P(uc + r * Math.cos(a), vc + h + r * Math.sin(a))); }
  return pts;
}
/** Order indices centre-out so partial staffing or partial builds spread from the middle. */
const centreOut = (n: number) => Array.from({ length: n }, (_, i) => i).sort((p, q) => Math.abs(p - (n - 1) / 2) - Math.abs(q - (n - 1) / 2));
function doors(f: F, items: LItem[]) {
  const { R } = helpers(f);
  const n = Math.max(1, Math.floor(f.edgeLen / 40));
  for (let i = 0; i < n; i++) { const u = (f.edgeLen * (i + 0.5)) / n; items.push({ k: 'door', pts: R(u - 3, -0.6, u + 3, 0.6), closed: true }); }
}

// ---------------------------------------------------------------- check-in
function checkin(f: F) {
  const { P, R, L } = helpers(f); const W = f.edgeLen, D = f.depth;
  const items: LItem[] = []; const slots: Pt[] = [];
  doors(f, items);
  if (D >= 42 && W >= 34) {
    // Islands run back from the frontage: desks both sides of a bag belt, queue mazes in front.
    const v0 = 20, isl = clamp(D - v0 - 8, 16, 70), v1 = v0 + isl;
    const pitch = 26; const nI = Math.max(1, Math.floor((W - 6) / pitch)); const off = (W - nI * pitch) / 2 + pitch / 2;
    const per = Math.floor(isl / 2.4);
    const desk: { p: Pt; j: number; k: number; s: number; pts: Pt[] }[] = [];
    for (let k = 0; k < nI; k++) {
      const uc = off + k * pitch;
      items.push({ k: 'belt', pts: R(uc - 1, v0, uc + 1, v1), closed: true });
      for (let j = 0; j < per; j++) {
        const v = v0 + 1.2 + j * 2.4;
        desk.push({ p: P(uc - 5.5, v), j, k, s: 0, pts: R(uc - 3.2, v - 0.9, uc - 1.4, v + 0.9) });
        desk.push({ p: P(uc + 5.5, v), j, k, s: 1, pts: R(uc + 1.4, v - 0.9, uc + 3.2, v + 0.9) });
      }
      // queue maze between this island's front and the doors
      for (let r = 0; r < 4; r++) {
        const v = 8 + r * 2.4; const gap = r % 2 ? 1 : -1;
        items.push({ k: 'stanchion', pts: L(uc - 9 + (gap > 0 ? 2 : 0), v, uc + 9 - (gap < 0 ? 2 : 0), v) });
      }
      if (k < nI - 1) for (let q = 0; q < 3; q++) items.push({ k: 'kiosk', pts: R(uc + pitch / 2 - 1 + (q - 1) * 3, 5, uc + pitch / 2 + 1 + (q - 1) * 3, 7), closed: true });
    }
    // front desks first, alternating islands, so partial staffing spreads across the hall
    desk.sort((a, b) => a.j - b.j || a.k - b.k || a.s - b.s);
    desk.forEach((d, i) => { slots.push(d.p); items.push({ k: 'counter', pts: d.pts, closed: true, slot: i }); });
  } else {
    // Shallow hall: one frontal counter line with a belt behind and a queue band in front.
    const n = Math.max(1, Math.floor((W - 6) / 2.6)); const v = Math.max(8, D - 7);
    items.push({ k: 'belt', pts: R(3, v + 2, W - 3, v + 3.5), closed: true });
    const order = centreOut(n);
    order.forEach((i, r) => { const u = 3 + (i + 0.5) * ((W - 6) / n); slots.push(P(u, v - 3)); items.push({ k: 'counter', pts: R(u - 0.9, v - 0.9, u + 0.9, v + 0.9), closed: true, slot: r }); });
    for (let r = 0; r < Math.min(4, Math.floor((v - 6) / 2.4)); r++) items.push({ k: 'stanchion', pts: L(6 + (r % 2 ? 3 : 0), 4 + r * 2.4, W - 6 - (r % 2 ? 0 : 3), 4 + r * 2.4) });
  }
  return { items, slots, max: slots.length };
}

// ---------------------------------------------------------------- security
function security(f: F) {
  const { P, R, L } = helpers(f); const W = f.edgeLen, D = f.depth;
  const items: LItem[] = []; const slots: Pt[] = [];
  const Q = clamp(D * 0.33, 6, 22);
  for (let r = 0; r * 2 + 2 < Q; r++) items.push({ k: 'stanchion', pts: L(3 + (r % 2 ? 3 : 0), 2 + r * 2, W - 3 - (r % 2 ? 0 : 3), 2 + r * 2) });
  const v0 = Q + 2, Ll = clamp(D - v0 - 4, 12, 34);
  const lw = 4.6; const us: number[] = [];
  let u = 3, inBank = 0;
  while (u + lw <= W - 3) { us.push(u); u += lw; if (++inBank === 5) { u += 3; inBank = 0; } }
  const shift = (W - 3 - (us.length ? us[us.length - 1] + lw : 3)) / 2;
  const order = centreOut(us.length);
  order.forEach((i, r) => {
    const x = us[i] + shift;
    items.push({ k: 'lane', pts: L(x, v0, x, v0 + Ll) });
    items.push({ k: 'divest', pts: R(x + 0.6, v0, x + 1.6, v0 + Math.min(7, Ll * 0.3)), closed: true });
    items.push({ k: 'xray', pts: R(x + 0.4, v0 + Ll * 0.32, x + 2.2, v0 + Ll * 0.32 + 3.5), closed: true, slot: r });
    items.push({ k: 'body', pts: R(x + 2.8, v0 + Ll * 0.32, x + 4.0, v0 + Ll * 0.32 + 1.6), closed: true, slot: r });
    items.push({ k: 'recompose', pts: R(x + 0.6, v0 + Ll * 0.32 + 4.5, x + 1.6, v0 + Ll), closed: true });
    slots.push(P(x + 3.4, v0 + Ll * 0.25));
  });
  if (us.length) { const x = us[us.length - 1] + shift + lw; items.push({ k: 'lane', pts: L(x, v0, x, v0 + Ll) }); }
  return { items, slots, max: slots.length };
}

// ---------------------------------------------------------------- baggage claim
function claim(f: F, want: number | undefined, need: number) {
  const { P, R } = helpers(f); const W = f.edgeLen, D = f.depth;
  const items: LItem[] = []; const slots: Pt[] = [];
  doors(f, items);
  // Greeters' hall along the exit side, with a bag-service office and restrooms.
  const Gh = clamp(D * 0.16, 8, 24);
  items.push({ k: 'office', pts: R(W - Math.min(20, W * 0.2), 2, W - 3, Gh - 2), closed: true, label: 'BAG SVC' });
  items.push({ k: 'wc', pts: R(3, 2, 3 + Math.min(12, W * 0.12), Gh - 2), closed: true, label: 'WC' });
  // Carousel field: long belts perpendicular to the hall, fed from the back wall.
  const F0 = Gh + 5, F1 = D - 6, Fd = F1 - F0;
  const rows = Fd >= 2 * (32 + 12) ? 2 : 1;
  const len = clamp(Fd / rows - 12, 12, 55);
  const pitch = 26; const per = Math.max(1, Math.floor((W - 6) / pitch)); const off = (W - per * pitch) / 2 + pitch / 2;
  const pos: { uc: number; vc: number; r: number; k: number }[] = [];
  for (let r = 0; r < rows; r++) for (let k = 0; k < per; k++) pos.push({ uc: off + k * pitch, vc: F0 + 6 + r * (len + 12) + len / 2, r, k });
  const ord = centreOut(per);
  pos.sort((a, b) => a.r - b.r || ord.indexOf(a.k) - ord.indexOf(b.k));
  const max = pos.length;
  const count = clamp(want ?? Math.min(max, Math.max(2, need)), 1, max);
  pos.forEach((p, i) => {
    const built = i < count;
    items.push({ k: built ? 'carousel' : 'carousel-off', pts: stadium(P, p.uc, p.vc, 8, len), closed: true, slot: built ? i : undefined });
    if (built) { slots.push(P(p.uc, p.vc)); items.push({ k: 'feed', pts: [P(p.uc, p.vc + len / 2), P(p.uc, D - 1)] }); }
  });
  return { items, slots, max, count };
}

/** Passport control: a line of booths across the hall, a queue maze in front, a clear run behind (v0.10). */
function passport(f: F) {
  const { P, R, L } = helpers(f); const W = f.edgeLen, D = f.depth;
  const items: LItem[] = []; const slots: Pt[] = [];
  doors(f, items);
  const n = Math.max(1, Math.floor((W - 6) / 4.2)); const vB = D * 0.62; const u0 = (W - n * 4.2) / 2;
  const order = centreOut(n);
  order.forEach((i, slot) => {
    const u = u0 + i * 4.2 + 2.1;
    items.push({ k: 'counter', pts: R(u - 1.1, vB - 1, u + 1.1, vB + 1), closed: true, slot });
    items.push({ k: 'lane', pts: L(u + 2.1, vB - 2.5, u + 2.1, vB + 2.5) });
    slots[slot] = P(u, vB - 1.6);
  });
  for (let v = 5; v < vB - 5; v += 2.4) items.push({ k: 'stanchion', pts: L(W * 0.12, v, W * 0.88, v) });
  return { items, slots, max: n };
}

// ---------------------------------------------------------------- entry point
export function layoutZone(z: Zone, world: World, opts: { items?: LItem[]; claimNeed: number }): { frame: Frame; max: number; count?: number } {
  const f = orient(z, world);
  let items: LItem[] = [], slots: Pt[] = [], max = 0, count: number | undefined;
  if (z.type === 'checkin') ({ items, slots, max } = checkin(f));
  else if (z.type === 'security') ({ items, slots, max } = security(f));
  else if (z.type === 'claim') ({ items, slots, max, count } = claim(f, z.units, opts.claimNeed));
  else if (z.type === 'passport') ({ items, slots, max } = passport(f));
  else if (z.type === 'concourse') items = opts.items ?? [];
  else if (z.type === 'curb') {
    const n = Math.max(2, Math.floor(f.edgeLen / 9) * 2); const per = Math.ceil(n / 2); const { P } = helpers(f);
    for (let k = 0; k < n; k++) { const row = Math.floor(k / per), i = k % per; slots.push(P(f.edgeLen * (0.04 + 0.92 * (i + 0.5) / per), f.depth * (0.22 + 0.26 * row))); }
    max = n;
  }
  return { frame: { ...f, slots, items }, max, count };
}
void sub;
