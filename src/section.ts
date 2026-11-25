// v0.66: a section through a terminal: the cut an architect would draw, from the car park through the forecourt, the
// hall, security and the concourse to an aircraft on its stand and the taxiway beyond. Pure: it reads the layout and
// returns what the cut passes through; ui.ts draws it.
import { CLASSES, Cls, LEVELS, STYLES, Style, ZoneType } from './config';
import { Pt, add, mul, sub, norm, dist, segIntersection } from './geom';
import { heart, inZone } from './shapes';
import { Derived, World, Zone, Site, styleOfZone, wayWidth, runwayWidth } from './world';

/** A stretch of the cut inside one module: from s0 to s1 along it (metres from its landside end), floor to roof. */
export interface SecSlab { s0: number; s1: number; z0: number; z1: number; type: ZoneType; level: number; style: Style; mezz?: boolean; floors?: number; auto?: boolean }
/** Something the cut crosses: a road, a deck, a taxiway or a runway, `w` wide, at height z. */
export interface SecStrip { s: number; w: number; z: number; kind: 'road' | 'deck' | 'taxi' | 'runway' | 'walk' | 'bridge'; /** a footbridge: where along the cut it runs from and to, and which of its ends is a tower */ s0?: number; s1?: number; towers?: [boolean, boolean] }
export interface Section {
  a: Pt; b: Pt; len: number; slabs: SecSlab[]; strips: SecStrip[];
  /** the aircraft on the stand the cut runs through: its nose at `s`, nose towards the building */
  aircraft?: { s: number; len: number; cls: Cls; door: number; gate: string };
  name: string;
}

const SHOWN = new Set<ZoneType>(['checkin', 'claim', 'security', 'passport', 'concourse', 'curb', 'parking', 'hotel', 'rental', 'bus', 'rideshare', 'train']);

/** The cut for a terminal site: through the middle of its hall and the nearest of its gates. Null with no hall. */
export function sectionOf(world: World, d: Derived, site: Site): Section | null {
  const T = d.terminals.find(t => t.site?.id === site.id); if (!T) return null;
  const hall = T.zones.find(z => z.type === 'checkin') ?? T.zones.find(z => z.type === 'claim'); if (!hall) return null;
  const O = heart(hall); const ids = new Set(T.zones.map(z => z.id));
  const gs = d.gates.filter(g => ids.has(g.zone.id)).sort((p, q) => dist(O, p.door) - dist(O, q.door));
  const g = gs[0];
  // with no gate yet, the cut runs square to the hall's long axis, towards its concourse if it has one
  const conc = T.zones.find(z => z.type === 'concourse');
  let dir: Pt; let end: Pt;
  if (g) { dir = norm(sub(g.stand, O)); end = add(g.stand, mul(dir, CLASSES[g.cls].length + 170)); }
  else { const t = conc ? heart(conc) : { x: O.x, y: O.y - 1 }; dir = norm(sub(t, O)); end = add(conc ? t : O, mul(dir, 220)); }
  const sec = sectionAlong(world, d, add(O, mul(dir, -260)), end, T.name, g);
  return sec;
}

/** v0.69: the cut along any line: what it passes through and crosses from a to b. `g`: the gate whose aircraft to show;
 *  with none given, the first stand the line runs along (its door and stand both within 10 m of it). */
export function sectionAlong(world: World, d: Derived, a: Pt, b: Pt, name: string, g0?: Derived['gates'][number]): Section {
  const len = dist(a, b); const dir = norm(sub(b, a));
  const off = (p: Pt) => Math.abs((p.x - a.x) * dir.y - (p.y - a.y) * dir.x), along = (p: Pt) => (p.x - a.x) * dir.x + (p.y - a.y) * dir.y;
  const g = g0 ?? d.gates.filter(q => off(q.door) < 10 && off(q.stand) < 10 && along(q.door) > 0 && along(q.stand) < len && along(q.stand) > along(q.door)).sort((p, q) => along(p.door) - along(q.door))[0];
  const at = (s: number) => add(a, mul(dir, s));
  // modules: sampled every metre along the cut
  const slabs: SecSlab[] = [];
  for (const z of d.zones) { if (!SHOWN.has(z.type)) continue;
    let run: number | null = null;
    for (let s = 0; s <= len + 1; s += 1) { const inside = s <= len && inZone(at(s), z);
      if (inside && run === null) run = s;
      if (!inside && run !== null) { if (s - run >= 2) { const L = LEVELS[z.level]; const flat = z.type === 'parking' || z.type === 'rideshare';
          slabs.push({ s0: run, s1: s, z0: L.z0, z1: flat ? L.z0 + (z.floors ? z.floors * 3.2 : 0.4) : z.type === 'curb' ? L.z0 + 0.4 : L.z1, type: z.type, level: z.level, style: styleOfZone(world, d, z) ?? STYLES[0], ...(z.mezz ? { mezz: true } : {}), ...(z.floors ? { floors: z.floors } : {}), ...(z.auto ? { auto: true } : {}) }); }
        run = null; } } }
  slabs.sort((p, q) => p.s0 - q.s0 || p.level - q.level);
  // what it crosses
  const strips: SecStrip[] = []; const sOf = (p: Pt) => dist(a, p);
  for (const q of d.roadPieces) { if (d.rampRefs.has(q.ref)) continue; const x = segIntersection(a, b, q.a, q.b); if (x) strips.push({ s: sOf(x), w: q.lanes >= 4 ? 16 : 9, z: 0, kind: 'road' }); }
  for (const dk of d.decks) for (let i = 1; i < dk.pts.length; i++) { const x = segIntersection(a, b, dk.pts[i - 1], dk.pts[i]); if (!x) continue;
    const t = dist(dk.pts[i - 1], x) / (dist(dk.pts[i - 1], dk.pts[i]) || 1); const zk = dk.zs[i - 1] + (dk.zs[i] - dk.zs[i - 1]) * t;
    if (zk > 0.08) strips.push({ s: sOf(x), w: dk.ws[i - 1] + (dk.ws[i] - dk.ws[i - 1]) * t, z: zk * LEVELS[1].z0, kind: 'deck' }); }
  for (const w of d.wayPieces) { const x = segIntersection(a, b, w.a, w.b); if (x) strips.push({ s: sOf(x), w: wayWidth(w.kind, w.cls, w.lanes), z: 0, kind: w.kind === 'taxi' ? 'taxi' : 'walk' }); }
  for (const l of d.airExtra) { const x = segIntersection(a, b, l.a, l.b); if (x) strips.push({ s: sOf(x), w: wayWidth('taxi', l.cls, 0), z: 0, kind: 'taxi' }); }
  // (a footbridge is seen from the side where the cut runs along it, within a few metres)
  for (const fb of d.footbridges) { const off = (p: Pt) => Math.abs((p.x - a.x) * dir.y - (p.y - a.y) * dir.x); if (off(fb.a) > 30 || off(fb.b) > 30) continue;
    const sa = (fb.a.x - a.x) * dir.x + (fb.a.y - a.y) * dir.y, sb = (fb.b.x - a.x) * dir.x + (fb.b.y - a.y) * dir.y; if (Math.abs(sb - sa) < 6) continue;
    const fwd = sa <= sb; strips.push({ s: (sa + sb) / 2, w: Math.abs(sb - sa), z: fb.z, kind: 'bridge', s0: Math.min(sa, sb), s1: Math.max(sa, sb), towers: fwd ? [fb.ends[0] === 'tower', fb.ends[1] === 'tower'] : [fb.ends[1] === 'tower', fb.ends[0] === 'tower'] }); }
  for (const r of d.runways) { const x = segIntersection(a, b, r.rw.a, r.rw.b); if (x) strips.push({ s: sOf(x), w: runwayWidth(r.length), z: 0, kind: 'runway' }); }
  // (two crossings of one road within a few metres are one road)
  strips.sort((p, q) => p.s - q.s);
  const merged: SecStrip[] = []; for (const q of strips) { const l = merged[merged.length - 1]; if (l && l.kind === q.kind && Math.abs(l.s - q.s) < 4 && Math.abs(l.z - q.z) < 1) continue; merged.push(q); }
  const sec: Section = { a, b, len, slabs, strips: merged, name };
  if (g) { const door = dist(a, g.door); const L = CLASSES[g.cls].length; const nose = dist(a, g.stand) - L / 2; sec.aircraft = { s: Math.max(door + 4, nose), len: L, cls: g.cls, door, gate: g.num }; }
  return sec;
}
