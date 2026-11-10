// Concourse gates. Every side of a concourse can grow gates, by one predictable rule:
//
//   A side gets gates when a taxiway runs parallel to it, no farther out than its "reach"
//   (two stand depths). The gate size is the largest that fits the gap, up to the area's size.
//   Gates sit on a fixed grid along the side, so adding or extending a taxiway never shuffles them,
//   and each slot can be switched off or back on by the player.
//
// The ideal taxiway line for each side (one stand depth out) is exported as a guide for drawing and snapping.
import { Pt, Rect, add, sub, mul, dot, dist, norm, perpLeft, lerpPt, projT, rectsOverlap, rectSegDist } from './geom';
import { CLASSES, Cls } from './config';
import type { World, Zone, Way, Apron, Gate, RunwayInfo } from './world';
import { zonePts, toWorld, dirWorld, polyClip, polyArea, polyBox } from './shapes';
import { pointInPoly } from './geom';

export type SideKey = 'n' | 'e' | 's' | 'w';
export interface GateSlot {
  key: string; id: string; zone: Zone; side: SideKey; i: number; cls: Cls; on: boolean;
  door: Pt; stand: Pt; front: Pt; ang: number; outward: Pt; cell: Pt[];
}
export interface SideGuide {
  zone: Zone; side: SideKey; a: Pt; b: Pt; out: Pt; ideal: number; reach: number;
  served: boolean; d?: number; cls?: Cls; note?: string;
}

export const standDepth = (c: number) => CLASSES[c].length + 22;          // building face to taxiway centreline
export const sideReach = (c: number) => Math.max(150, 2 * standDepth(c) + 40); // farthest a taxiway can be and still count
export const SIDE_NAMES: Record<SideKey, string> = { n: 'North', e: 'East', s: 'South', w: 'West' };

const inset = (r: Rect, k: number): Rect => ({ x: r.x + k, y: r.y + k, w: Math.max(0, r.w - 2 * k), h: Math.max(0, r.h - 2 * k) });

export function sidesOf(z: Zone) {
  const sides = [
    { side: 'n' as SideKey, a: { x: z.x, y: z.y }, b: { x: z.x + z.w, y: z.y }, out: { x: 0, y: -1 } },
    { side: 'e' as SideKey, a: { x: z.x + z.w, y: z.y }, b: { x: z.x + z.w, y: z.y + z.h }, out: { x: 1, y: 0 } },
    { side: 's' as SideKey, a: { x: z.x + z.w, y: z.y + z.h }, b: { x: z.x, y: z.y + z.h }, out: { x: 0, y: 1 } },
    { side: 'w' as SideKey, a: { x: z.x, y: z.y + z.h }, b: { x: z.x, y: z.y }, out: { x: -1, y: 0 } },
  ];
  // v0.17: a turned zone keeps its side names (north is the north of its own frame); the geometry turns with it
  return z.rot ? sides.map(sd => ({ side: sd.side, a: toWorld(z, sd.a), b: toWorld(z, sd.b), out: dirWorld(z, sd.out) })) : sides;
}

export function buildGateAreas(world: World, runways: RunwayInfo[], runwayWidth: (len: number) => number) {
  const gates: Gate[] = [], aprons: Apron[] = [], slots: GateSlot[] = [], guides: SideGuide[] = [];
  const letters = new Map<number, string>();
  const units = new Map<number, { max: number; count: number }>();
  const taxis = world.ways.filter(w => w.kind === 'taxi');
  let idx = 0;
  for (const z of world.zones.filter(q => q.type === 'concourse')) {
    const zc = (z.cls ?? 2) as Cls;
    const letter = idx < 26 ? String.fromCharCode(65 + idx) : `G${idx + 1}`; idx++;
    letters.set(z.id, letter);
    const off = new Set(z.off ?? []);
    let k = 0, nSlots = 0;
    for (const sd of sidesOf(z)) {
      const L = dist(sd.a, sd.b); const al = norm(sub(sd.b, sd.a));
      const guide: SideGuide = { zone: z, side: sd.side, a: sd.a, b: sd.b, out: sd.out, ideal: standDepth(zc), reach: sideReach(zc), served: false };
      guides.push(guide);
      // nearest parallel taxiway within reach that overlaps this side
      let best: { w: Way; d: number; ov: number } | null = null;
      for (const w of taxis) {
        if (Math.abs(dot(norm(sub(w.b, w.a)), al)) < 0.985) continue;
        const d = (dot(sub(w.a, sd.a), sd.out) + dot(sub(w.b, sd.a), sd.out)) / 2;
        if (d < 8 || d > sideReach(zc)) continue;
        const s0 = dot(sub(w.a, sd.a), al), s1 = dot(sub(w.b, sd.a), al);
        const ov = Math.min(L, Math.max(s0, s1)) - Math.max(0, Math.min(s0, s1));
        if (ov < 20) continue;
        if (!best || d < best.d - 3 || (Math.abs(d - best.d) <= 3 && ov > best.ov)) best = { w, d, ov };
      }
      if (!best) continue;
      guide.d = best.d;
      let cls = -1;
      for (let c = zc; c >= 0; c--) if (standDepth(c) <= best.d + 1) { cls = c; break; }
      if (cls < 0) { guide.note = `taxiway is ${Math.round(best.d)} m out; the smallest stands need ${standDepth(0)} m`; continue; }
      guide.cls = cls as Cls;
      if (cls < zc) guide.note = `taxiway is ${Math.round(best.d)} m out: fits ${CLASSES[cls].example}; ${CLASSES[zc].example} stands need ${standDepth(zc)} m`;
      const C = CLASSES[cls]; const sp = C.gateSpacing; const D = best.d;
      // stretches of the side where something else sits in the apron strip
      const strip: Rect = (() => {
        const p1 = sd.a, p2 = add(sd.b, mul(sd.out, D));
        return { x: Math.min(p1.x, p2.x), y: Math.min(p1.y, p2.y), w: Math.abs(p2.x - p1.x), h: Math.abs(p2.y - p1.y) };
      })();
      if (runways.some(r => rectSegDist(strip, r.rw.a, r.rw.b) < runwayWidth(r.length) / 2 + 40)) { guide.note = 'the apron would reach into the runway strip'; continue; }
      const blocked: [number, number][] = [];
      const proj = (pts: Pt[]) => { const s = pts.map(p => dot(sub(p, sd.a), al)); return [Math.min(...s), Math.max(...s)] as [number, number]; };
      // v0.17: where either building is turned, the test is on the true outlines, and only the part of the other
      // building that is actually in the strip blocks gates. That is what lets a pier run into a concourse and
      // keep gates on the rest of its length, and the concourse keep gates either side of the pier.
      const stripPts = [add(sd.a, add(mul(al, 1), mul(sd.out, 1))), add(sd.b, add(mul(al, -1), mul(sd.out, 1))), add(sd.b, add(mul(al, -1), mul(sd.out, D))), add(sd.a, add(mul(al, 1), mul(sd.out, D)))];
      const cut = (pts: Pt[]) => { const c = polyClip(pts, stripPts); if (c.length >= 3 && polyArea(c) > 2) blocked.push(proj(c)); };
      for (const o of world.zones) if (o.id !== z.id) {
        if (z.rot || o.rot) cut(zonePts(o));
        else if (rectsOverlap(inset(o, 1), strip)) blocked.push(proj([{ x: o.x, y: o.y }, { x: o.x + o.w, y: o.y + o.h }, { x: o.x + o.w, y: o.y }, { x: o.x, y: o.y + o.h }]));
      }
      for (const ap of aprons) {
        if (z.rot || ap.zone.rot) cut(ap.pts);
        else if (rectsOverlap(inset(ap.rect, 1), strip)) blocked.push(proj([{ x: ap.rect.x, y: ap.rect.y }, { x: ap.rect.x + ap.rect.w, y: ap.rect.y + ap.rect.h }, { x: ap.rect.x + ap.rect.w, y: ap.rect.y }, { x: ap.rect.x, y: ap.rect.y + ap.rect.h }]));
      }
      for (const w of world.ways) if (w.kind !== 'taxi' && rectSegDist(inset(strip, 2), w.a, w.b) === 0) blocked.push(proj([w.a, w.b]));
      const wn = perpLeft(norm(sub(best.w.b, best.w.a)));
      const meet = (p: Pt) => add(p, mul(sd.out, dot(sub(best!.w.a, p), wn) / dot(sd.out, wn)));
      const n = Math.floor(L / sp); const pad = (L - n * sp) / 2;
      let run: GateSlot[] = [];
      const flush = () => {
        if (!run.length) return;
        const first = run[0], last = run[run.length - 1];
        const pts = [...first.cell, ...last.cell];
        const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
        const rect = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
        const ap: Apron = { zone: z, rect, pts: [first.cell[0], last.cell[1], last.cell[2], first.cell[3]], outward: sd.out, laneA: first.front, laneB: last.front, mouth: lerpPt(first.front, last.front, 0.5), cls: cls as Cls, letter };
        aprons.push(ap);
        for (const sl of run) if (sl.on) {
          k++;
          gates.push({ id: sl.id, key: sl.key, num: `${letter}${k}`, zone: z, apron: ap, cls: sl.cls, door: sl.door, stand: sl.stand, front: sl.front, ang: sl.ang, frontNode: -1, rwys: [new Set(), new Set(), new Set(), new Set()] });
        }
        run = [];
      };
      for (let i = 0; i < n; i++) {
        const s = pad + (i + 0.5) * sp;
        const ep = add(sd.a, mul(al, s));
        const front = meet(ep);
        const t = projT(front, best.w.a, best.w.b);
        const free = t >= -0.001 && t <= 1.001 && !blocked.some(([b0, b1]) => b1 > s - sp / 2 + 1 && b0 < s + sp / 2 - 1);
        if (!free) { flush(); continue; }
        const key = `${sd.side}${i}`;
        const h = mul(al, sp / 2);
        const cell = [sub(ep, h), add(ep, h), add(add(ep, h), mul(sd.out, D)), add(sub(ep, h), mul(sd.out, D))];
        const sl: GateSlot = {
          key, id: `${z.id}-${key}`, zone: z, side: sd.side, i, cls: cls as Cls, on: !off.has(key),
          door: add(ep, mul(sd.out, -7)), stand: add(ep, mul(sd.out, C.length / 2 + 8)), front, ang: Math.atan2(-sd.out.y, -sd.out.x), outward: sd.out, cell,
        };
        slots.push(sl); nSlots++; guide.served = true;
        run.push(sl);
      }
      flush();
    }
    units.set(z.id, { max: nSlots, count: k });
  }
  return { gates, aprons, slots, guides, letters, units };
}

/** Which slot (on or off) is under a point, if any. */
export function slotAt(slots: GateSlot[], p: Pt): GateSlot | undefined {
  return slots.find(s => pointInPoly(p, s.cell));
}
