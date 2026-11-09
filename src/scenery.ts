// Scenery (v0.9): where trees, street lamps, apron floodlight masts and the control tower go.
// Pure and deterministic: it follows the player's layout, so planting appears along new roads and clears
// itself from anything built later. Both renderers draw from it; the sim never reads it.
import { Pt, Rect, segDist, inRect, pointInPoly, dist, sub, norm, add, mul } from './geom';
import { SITE } from './config';
import type { World, Derived } from './world';
import { wayWidth } from './world';

export interface Tree { x: number; y: number; s: number; k: number }   // size (m), variety 0–1
export interface Scenery { trees: Tree[]; lamps: Pt[]; masts: Pt[]; tower?: Pt }

const cache = new WeakMap<Derived, Scenery>();
const hash = (a: number, b: number) => { const h = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return h - Math.floor(h); };

export function scenery(world: World, d: Derived): Scenery {
  const hit = cache.get(d); if (hit) return hit;
  const roads = [...world.ways.filter(w => w.kind === 'road' || w.kind === 'walk'), ...d.autoWalks];
  const taxis = [...world.ways.filter(w => w.kind === 'taxi').map(w => ({ a: w.a, b: w.b, w: wayWidth('taxi', w.cls, 0) })), ...d.airExtra.map(x => ({ a: x.a, b: x.b, w: wayWidth('taxi', x.cls, 0) }))];
  const pads: { r: Rect; k: number }[] = [
    ...d.zones.map(z => ({ r: z as Rect, k: 7 })), ...(world.sites ?? []).map(s => ({ r: s as Rect, k: 4 })), ...d.aprons.map(a => ({ r: a.rect, k: 14 })),
  ];
  const HY = SITE.highwayY;
  /** Somewhere a tree (or lamp) can stand: on land, clear of pavements, buildings, aprons and runway strips. */
  const free = (p: Pt, roadClear = 6) => {
    if (p.x < 10 || p.y < 10 || p.x > SITE.width - 10 || p.y > SITE.height - 10) return false;
    if (pointInPoly(p, SITE.lake)) return false;
    if (Math.abs(p.y - HY) < 12 + roadClear) return false;
    for (const q of pads) if (inRect(p, q.r, q.k)) return false;
    for (const r of d.runways) if (segDist(p, r.rw.a, r.rw.b) < r.width / 2 + 110) return false;
    for (const t of taxis) if (segDist(p, t.a, t.b) < t.w / 2 + 22) return false;
    for (const w of roads) if (segDist(p, w.a, w.b) < wayWidth(w.kind, w.cls, w.lanes) / 2 + roadClear) return false;
    return true;
  };

  const trees: Tree[] = [];
  const plant = (p: Pt, s: number, k: number) => { if (trees.length < 6500 && free(p)) trees.push({ x: p.x, y: p.y, s, k }); };
  // avenues: both sides of every road, every ~18 m
  for (const w of world.ways.filter(q => q.kind === 'road')) {
    const L = dist(w.a, w.b); const dv = norm(sub(w.b, w.a)); const n = { x: -dv.y, y: dv.x };
    const off = wayWidth('road', 0, w.lanes) / 2 + 8;
    for (let s = 9; s < L - 9; s += 18) for (const side of [-1, 1]) {
      const j = hash(w.id * 31 + s, side);
      plant(add(add(w.a, mul(dv, s + (j - 0.5) * 6)), mul(n, side * (off + j * 3))), 7 + j * 4, j);
    }
  }
  // the highway: a looser double row
  for (let x = 20; x < SITE.width; x += 26) for (const side of [-1, 1]) {
    const j = hash(x, side * 7);
    plant({ x: x + (j - 0.5) * 10, y: HY + side * (26 + j * 8) }, 8 + j * 5, j);
  }
  // groves in the open country around the airport and along the lake shore
  for (let x = 40; x < SITE.width; x += 64) for (let y = 40; y < SITE.height; y += 64) {
    const b = SITE.buildable; const inside = x > b.x && x < b.x + b.w && y > b.y && y < b.y + b.h;
    const h = hash(x * 0.37, y * 0.71);
    if (h > (inside ? 0.07 : 0.32)) continue;
    const n = 3 + Math.floor(h * 30) % 5;
    for (let i = 0; i < n; i++) { const a = hash(x + i, y - i) * Math.PI * 2, r = 6 + hash(y + i, x) * 22; plant({ x: x + Math.cos(a) * r, y: y + Math.sin(a) * r }, 8 + hash(i, x + y) * 8, hash(x + i * 3, y)); }
  }
  // street trees between the city blocks
  for (let x = SITE.cityX; x < SITE.width; x += 150) for (let y = 300; y < SITE.height - 200; y += 30) plant({ x: x + 6, y }, 6 + hash(x, y) * 3, hash(y, x));

  // street lamps every ~45 m on player roads, alternating sides
  const lamps: Pt[] = [];
  for (const w of world.ways.filter(q => q.kind === 'road')) {
    const L = dist(w.a, w.b); const dv = norm(sub(w.b, w.a)); const n = { x: -dv.y, y: dv.x };
    const off = wayWidth('road', 0, w.lanes) / 2 + 2; let k = 0;
    for (let s = 20; s < L - 10; s += 45) { const p = add(add(w.a, mul(dv, s)), mul(n, (k++ % 2 ? 1 : -1) * off)); lamps.push(p); }
  }
  // apron floodlight masts: along each apron's building edge, between stands
  const masts: Pt[] = [];
  for (const ap of d.aprons) {
    const o = ap.outward; const r = ap.rect;
    const along = Math.abs(o.x) > 0.5 ? { x: 0, y: 1 } : { x: 1, y: 0 };
    const len = Math.abs(o.x) > 0.5 ? r.h : r.w;
    const base = o.x > 0.5 ? { x: r.x + 5, y: r.y } : o.x < -0.5 ? { x: r.x + r.w - 5, y: r.y } : o.y > 0.5 ? { x: r.x, y: r.y + 5 } : { x: r.x, y: r.y + r.h - 5 };
    for (let s = 40; s < len - 20; s += 110) masts.push(add(base, mul(along, s)));
  }
  // the control tower: just outside the first terminal's site, where it is clear of everything
  let tower: Pt | undefined;
  const st = world.sites?.[0];
  if (st) {
    const cands: Pt[] = [];
    for (const k of [-60, -40, -80, -110]) cands.push({ x: st.x + k, y: st.y + st.h / 2 }, { x: st.x + st.w - k, y: st.y + st.h / 2 }, { x: st.x + k, y: st.y + st.h + 30 }, { x: st.x + st.w - k, y: st.y + st.h + 30 });
    tower = cands.find(p => free(p, 14) && !inRect(p, st, 20));
  }
  const out = { trees: tower ? trees.filter(t => Math.hypot(t.x - tower!.x, t.y - tower!.y) > 18) : trees, lamps, masts, tower };
  cache.set(d, out);
  return out;
}
