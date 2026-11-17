// Shells (v0.23): a building as one outline. Pure logic, no DOM.
//
//   Until now a terminal's airside was a pile of separate pieces (concourses, piers, hubs) that overlapped, each
//   drawn on its own. A shell is what those pieces add up to: every concourse on a level is merged into one
//   outline per building, its inside corners are filled in with a generous radius and its outside corners eased.
//   Anything that makes a shape (a pier, a path, a hub, later a free-drawn area or a cut-out) only has to add to
//   or take from this one outline, and everything that reads the outline blends by itself.
//
//   The merging and rounding are done by Clipper (clipper-lib, Angus Johnson's polygon clipper): union, then an
//   outward and inward offset with round joins to fill the inside corners, then inward and outward to ease the
//   outside ones.
import ClipperLib from 'clipper-lib';
import { Pt } from './geom';
import { Shaped, zonePts, heart } from './shapes';

/** `rings`: the outline, outer boundaries and holes together (fill with the even-odd rule). `ids`: the zones it is made of. */
export interface Shell { level: number; ids: number[]; rings: Pt[][]; outer: Pt[];
  /** v0.32: a cut-out takes something away from it (so its outline is no longer just its pieces'), and which. */
  cut?: boolean; cuts?: number[] }
/** v0.32: a cut-out: a polygon taken away from whatever building it is drawn over, on one level. Saved with the world. */
export interface Cut { id: number; level: number; pts: Pt[] }
export const SHELL = { fillet: 16, ease: 5, scale: 100 };   // inside-corner radius, outside-corner radius (m); Clipper works in whole numbers

type IPath = { X: number; Y: number }[];
const toPath = (pts: Pt[]): IPath => { const p = pts.map(q => ({ X: Math.round(q.x * SHELL.scale), Y: Math.round(q.y * SHELL.scale) })); if (!ClipperLib.Clipper.Orientation(p)) p.reverse(); return p; };
const fromPath = (p: IPath): Pt[] => p.map(q => ({ x: q.X / SHELL.scale, y: q.Y / SHELL.scale }));
function offset(paths: IPath[], d: number): IPath[] {
  const co = new ClipperLib.ClipperOffset(2, 0.08 * SHELL.scale);
  co.AddPaths(paths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const out = new ClipperLib.Paths(); co.Execute(out, d * SHELL.scale); return out;
}
function inPoly(p: Pt, poly: Pt[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside; }
  return inside;
}

/** One shell for each group of concourse pieces on a level that touch or overlap. */
export function shellsOf(zones: (Shaped & { id: number; type: string; level: number })[], cuts: Cut[] = []): Shell[] {
  const out: Shell[] = [];
  const exec = (subj: IPath[], clip: IPath[], type: number) => {
    const c = new ClipperLib.Clipper();
    c.AddPaths(subj, ClipperLib.PolyType.ptSubject, true);
    if (clip.length) c.AddPaths(clip, ClipperLib.PolyType.ptClip, true);
    const tree = new ClipperLib.PolyTree();
    c.Execute(type, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
    return ClipperLib.JS.PolyTreeToExPolygons(tree) as { outer: IPath; holes: IPath[] }[];
  };
  for (const level of [0, 1]) {
    const zs = zones.filter(z => z.type === 'concourse' && z.level === level); if (!zs.length) continue;
    // (each piece is grown a hair, so pieces that only share a wall still merge)
    const subj = zs.flatMap(z => offset([toPath(zonePts(z))], 0.3));
    const mine = cuts.filter(k => k.level === level && k.pts.length >= 3);
    const taken = new Set<number>();
    for (const ex of exec(subj, [], ClipperLib.ClipType.ctUnion)) {
      // fill the inside corners, then ease the outside ones; a building is rounded on its own, never bridged to its neighbour
      let paths: IPath[] = [ex.outer, ...ex.holes];
      paths = offset(offset(paths, SHELL.fillet), -SHELL.fillet);
      paths = offset(offset(paths, -SHELL.ease), SHELL.ease);
      if (!paths.length) continue;
      const raw = fromPath(ex.outer);
      const owned = zs.filter(z => !taken.has(z.id) && inPoly(heart(z), raw)); owned.forEach(z => taken.add(z.id));
      // v0.32: then take away every cut-out on this level whose floor overlaps it, after the rounding (so a narrow
      // cut-out is not filled back in by the fillet), and ease the corners the cut-out made
      const hit = mine.filter(k => owned.some(z => overlapArea([toPath(zonePts(z))], [toPath(k.pts)]) > 1));
      if (!hit.length) { const rings = paths.map(fromPath); if (owned.length) out.push({ level, ids: owned.map(z => z.id), rings, outer: rings.reduce((m, r) => (Math.abs(area(r)) > Math.abs(area(m)) ? r : m)) }); continue; }
      // a cut-out may split the building: each part with floor is a building of its own, made of every piece with
      // floor in it (a piece cut in two is in both), the part holding most of a piece first
      const parts: { ids: number[]; rings: Pt[][]; outer: Pt[]; a: number }[] = [];
      for (const part of exec(paths, hit.map(k => toPath(k.pts)), ClipperLib.ClipType.ctDifference)) {
        let ps: IPath[] = [part.outer, ...part.holes];
        ps = offset(offset(ps, SHELL.ease), -SHELL.ease);
        ps = offset(offset(ps, -SHELL.ease), SHELL.ease);
        if (!ps.length) continue;
        const rings = ps.map(fromPath);
        const outer = rings.reduce((m, r) => (Math.abs(area(r)) > Math.abs(area(m)) ? r : m));
        const ids = owned.filter(z => overlapArea([toPath(zonePts(z))], ps) > 1).map(z => z.id);
        if (ids.length) parts.push({ ids, rings, outer, a: Math.abs(area(outer)) });
      }
      parts.sort((p, q) => q.a - p.a);
      for (const p of parts) out.push({ level, ids: p.ids, rings: p.rings, outer: p.outer, cut: true, cuts: hit.map(k => k.id) });
    }
  }
  return out;
}
/** The area (m²) two sets of paths have in common. */
function overlapArea(a: IPath[], b: IPath[]) {
  const c = new ClipperLib.Clipper(); c.AddPaths(a, ClipperLib.PolyType.ptSubject, true); c.AddPaths(b, ClipperLib.PolyType.ptClip, true);
  const sol = new ClipperLib.Paths(); c.Execute(ClipperLib.ClipType.ctIntersection, sol, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return (sol as IPath[]).reduce((t, p) => t + ClipperLib.Clipper.Area(p), 0) / (SHELL.scale * SHELL.scale);
}
function area(r: Pt[]) { let a = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p.x * q.y - q.x * p.y; } return a / 2; }

// ---- Junction spaces (v0.25): the first step of planning a building's inside as a whole.
//
//   Where two pieces of a building run into each other, neither piece's own plan fits: its shops would stand across
//   the other's way through. And where the shell fills an inside corner there is floor that belongs to no piece at
//   all. Both are given to the building instead: the overlap, a few metres round it and any filled corner that
//   touches it become one open space (a hall, a food court or a winter garden, by size), a filled corner on its own
//   becomes a planted corner, and a hole enclosed by the building becomes a courtyard garden.
export type JunctionKind = 'hall' | 'food' | 'garden' | 'court';
/** `seeds`: where its trees or tables stand (trees for a garden or court, tables for a food court, both for a hall: `t`). */
export interface Junction { level: number; kind: JunctionKind; rings: Pt[][]; outer: Pt[]; area: number; c: Pt; ids: number[]; seeds: { x: number; y: number; t: 'tree' | 'table'; s: number }[] }
// A food court wants room for a ring of counters and seating between them: at 1.4–1.9 m2 a seat (the usual food-court
// planning range; Neufert gives 1.4–1.6 m2 for self-service dining), 400 m2 seats about 150 once aisles are taken out.
// Above 1,500 m2 the space is a hall: a planted middle with seating round it.
export const JUNCTION = { grow: 6, min: 30, corner: 600, food: 400, hall: 1500, tree: 9, table: 4.2,
  // v0.31: counters round a food court or hall. A food-court counter is usually 6–9 m of frontage and 5–7 m deep with
  // its kitchen behind (from memory of airport concession practice, not a cited standard); `gap` keeps a spine's
  // way in clear.
  counter: { front: 7, depth: 6, gap: 9, door: 14, per: 900 } };   // per: a space over 10,000 m² gets at most one counter for every `per` m²

type Ex = { outer: IPath; holes: IPath[] };
function clip(type: number, subj: IPath[], clipP: IPath[], subjFill = ClipperLib.PolyFillType.pftNonZero, clipFill = ClipperLib.PolyFillType.pftNonZero): Ex[] {
  const c = new ClipperLib.Clipper();
  if (subj.length) c.AddPaths(subj, ClipperLib.PolyType.ptSubject, true);
  if (clipP.length) c.AddPaths(clipP, ClipperLib.PolyType.ptClip, true);
  const tree = new ClipperLib.PolyTree(); c.Execute(type, tree, subjFill, clipFill);
  return ClipperLib.JS.PolyTreeToExPolygons(tree) as Ex[];
}
const flat = (ex: Ex[]): IPath[] => ex.flatMap(e => [e.outer, ...e.holes]);
function centroid(r: Pt[]): Pt { let a = 0, x = 0, y = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; const k = p.x * q.y - q.x * p.y; a += k; x += (p.x + q.x) * k; y += (p.y + q.y) * k; } return Math.abs(a) < 1e-6 ? r[0] : { x: x / (3 * a), y: y / (3 * a) }; }
function edgeGap(p: Pt, rings: Pt[][]) {
  let m = Infinity;
  for (const r of rings) for (let i = 0; i < r.length; i++) {
    const a = r[i], b = r[(i + 1) % r.length]; const dx = b.x - a.x, dy = b.y - a.y; const L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0; m = Math.min(m, Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t));
  }
  return m;
}
/** Points on a grid inside a space, each nudged a little (the same way every time), `margin` clear of its edge. */
function seedsIn(rings: Pt[][], outer: Pt[], step: number, margin: number, jitter: number): Pt[] {
  // (the grid is hung on the space's own middle, so its planting moves with it when the building is dragged)
  const o = centroid(outer); rings = rings.map(r => r.map(p => ({ x: p.x - o.x, y: p.y - o.y }))); outer = rings[0];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const p of outer) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  const out: Pt[] = []; const inside = (p: Pt) => rings.reduce((n, r) => n + (inPoly(p, r) ? 1 : 0), 0) % 2 === 1;
  for (let gy = Math.floor(y0 / step); gy * step <= y1; gy++) for (let gx = Math.floor(x0 / step); gx * step <= x1; gx++) {
    const h = Math.sin(gx * 127.1 + gy * 311.7) * 43758.5453; const r1 = h - Math.floor(h); const h2 = Math.sin(gx * 269.5 + gy * 183.3) * 24634.6345; const r2 = h2 - Math.floor(h2);
    const p = { x: (gx + (gy & 1 ? 0.5 : 0)) * step + (r1 - 0.5) * jitter, y: gy * step + (r2 - 0.5) * jitter };
    if (inside(p) && edgeGap(p, rings) >= margin) out.push({ x: p.x + o.x, y: p.y + o.y });
  }
  return out;
}

/** The spaces a building of several pieces keeps for itself: see above. One-piece buildings have none. */
export function junctionsOf(shells: Shell[], zones: (Shaped & { id: number; type: string; level: number })[], ring: (z: Shaped) => number = () => 0): Junction[] {
  const out: Junction[] = [];
  for (const sh of shells) {
    const zs = zones.filter(z => sh.ids.includes(z.id));
    // (v0.32: a building of one piece has spaces of its own only if it is free-drawn, or a cut-out has made a courtyard)
    if (sh.ids.length < 2 && !sh.cut && !zs.some(z => z.poly)) continue;
    const P = zs.map(z => toPath(zonePts(z)));
    const shell = sh.rings.map(toPath); const EO = ClipperLib.PolyFillType.pftEvenOdd;
    // where two pieces overlap (a hall already has its own open middle, so a pier running into one is left to the hall)
    const cores: { ring: Pt[]; ids: number[]; holes?: IPath[] }[] = [];
    const hubs = zs.map((z, i) => (z.sides ? P[i] : null)).filter((q): q is IPath => !!q);
    const boxes = P.map(q => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const v of q) { x0 = Math.min(x0, v.X); y0 = Math.min(y0, v.Y); x1 = Math.max(x1, v.X); y1 = Math.max(y1, v.Y); } return { x0, y0, x1, y1 }; });
    const areas = P.map(q => Math.abs(area(fromPath(q))));
    for (let i = 0; i < zs.length; i++) for (let j = i + 1; j < zs.length; j++) {
      if (zs[i].sides || zs[j].sides) continue;
      const a = boxes[i], b = boxes[j]; if (a.x1 < b.x0 || b.x1 < a.x0 || a.y1 < b.y0 || b.y1 < a.y0) continue;
      // a junction is a crossing. One piece drawn along or inside another (a concourse lengthened by drawing over
      // its end) is just more concourse: the two run the same way, or the overlap is most of a piece.
      const axis = (z: Shaped) => (z.rot ?? 0) + (z.w >= z.h ? 0 : Math.PI / 2);
      if (!zs[i].bend && !zs[j].bend && Math.abs(Math.cos(axis(zs[i]) - axis(zs[j]))) > 0.94) continue;   // within 20 degrees of parallel
      let over = clip(ClipperLib.ClipType.ctIntersection, [P[i]], [P[j]]);
      const oa = over.reduce((n, e) => n + Math.abs(area(fromPath(e.outer))), 0);
      if (oa > 0.5 * Math.min(areas[i], areas[j])) continue;
      // (two legs of a path both end inside their corner hall: that part is the hall's)
      if (hubs.length) over = clip(ClipperLib.ClipType.ctDifference, flat(over), hubs);
      for (const e of over) if (Math.abs(area(fromPath(e.outer))) >= JUNCTION.min) cores.push({ ring: fromPath(e.outer), ids: [zs[i].id, zs[j].id] });
    }
    // v0.32: a free-drawn area is open floor: all of it is the building's own space (a hall, a food court or a garden)
    // (v0.33: less the band round its walls, `ring` deep, where its holdrooms and lots are planned: bands.ts `carveFree`)
    zs.forEach(z => {
      if (!z.poly) return; const d = ring(z);
      // (the outer wall moved in and every courtyard grown out, each wound the right way first: a ring's winding as it
      //  comes out of the shell is not to be trusted)
      const pos = (q: IPath) => (ClipperLib.Clipper.Area(q) < 0 ? [...q].reverse() : q);
      const holes = sh.rings.filter(r => r !== sh.outer).map(r => pos(toPath(r)));
      const walls = d > 0 ? flat(clip(ClipperLib.ClipType.ctDifference, offset([pos(toPath(sh.outer))], -(d + JUNCTION.grow)), offset(holes, d + JUNCTION.grow))) : sh.rings.map(toPath);
      if (walls.length) for (const e of clip(ClipperLib.ClipType.ctIntersection, [toPath(z.poly)], walls, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftEvenOdd)) cores.push({ ring: fromPath(e.outer), ids: [z.id], holes: e.holes });   // (its holes too: the band round a courtyard is not hall)
    });
    // floor the shell added in its inside corners
    // (a large stretch of it, like the gap closed between two piers standing close side by side, is a garden of its
    //  own; only a corner's worth joins the junction beside it)
    const fills = clip(ClipperLib.ClipType.ctDifference, shell, P, EO);
    const big = fills.filter(e => Math.abs(area(fromPath(e.outer))) > JUNCTION.corner), fill = flat(fills.filter(e => !big.includes(e)));
    const grown = cores.length ? offset(cores.flatMap(c => [toPath(c.ring), ...(c.holes ?? [])]), JUNCTION.grow) : [];
    let space = flat(clip(ClipperLib.ClipType.ctIntersection, flat(clip(ClipperLib.ClipType.ctUnion, [...grown, ...fill], [])), shell, ClipperLib.PolyFillType.pftNonZero, EO));
    space = offset(offset(space, -1.5), 1.5);   // slivers along a wall are not a space
    if (big.length) space = flat(clip(ClipperLib.ClipType.ctDifference, space, flat(big)));
    for (const e of clip(ClipperLib.ClipType.ctUnion, space, [], ClipperLib.PolyFillType.pftNonZero)) {
      const outer = fromPath(e.outer); const rings = [outer, ...e.holes.map(fromPath)];
      const a = Math.abs(area(outer)) - e.holes.reduce((n, h) => n + Math.abs(area(fromPath(h))), 0); if (a < JUNCTION.min) continue;
      const mine = cores.filter(c => inPoly(centroid(c.ring), outer)); const ids = [...new Set(mine.flatMap(c => c.ids))];
      const kind: JunctionKind = !mine.length ? 'garden' : a >= JUNCTION.hall || ids.length > 2 && a >= JUNCTION.food ? 'hall' : a >= JUNCTION.food ? 'food' : 'garden';
      out.push({ level: sh.level, kind, rings, outer, area: a, c: centroid(outer), ids, seeds: plant(kind, rings, outer) });
    }
    for (const e of clip(ClipperLib.ClipType.ctUnion, offset(offset(flat(big), -1.5), 1.5), [])) {
      const outer = fromPath(e.outer); const rings = [outer, ...e.holes.map(fromPath)]; const a = Math.abs(area(outer)); if (a < JUNCTION.min) continue;
      out.push({ level: sh.level, kind: 'garden', rings, outer, area: a, c: centroid(outer), ids: [], seeds: plant('garden', rings, outer) });
    }
    // a hole right through the building is a courtyard
    for (const r of sh.rings) if (r !== sh.outer && inPoly(r[0], sh.outer) && Math.abs(area(r)) >= JUNCTION.min) out.push({ level: sh.level, kind: 'court', rings: [r], outer: r, area: Math.abs(area(r)), c: centroid(r), ids: [], seeds: plant('court', [r], r) });
  }
  return out;
}
// (derive runs on every frame of a drag, and planting is half the cost of a junction: a space that has not changed
//  shape keeps the planting it had)
const planted = new Map<string, Junction['seeds']>();
function plant(kind: JunctionKind, rings: Pt[][], outer: Pt[]): Junction['seeds'] {
  let k = kind; for (const r of rings) { k += '|' + r.length; for (const p of r) k += ',' + Math.round(p.x * 10) + ',' + Math.round(p.y * 10); }
  let v = planted.get(k); if (!v) { if (planted.size > 400) planted.clear(); v = plant0(kind, rings, outer); planted.set(k, v); }
  return v;
}
function plant0(kind: JunctionKind, rings: Pt[][], outer: Pt[]): Junction['seeds'] {
  const size = (p: Pt) => { const h = Math.sin(p.x * 12.9898 + p.y * 78.233) * 43758.5453; return 0.8 + 0.4 * (h - Math.floor(h)); };
  // (a large courtyard is planted more openly: about eighty trees however big it is)
  const step = kind === 'court' ? Math.max(JUNCTION.tree, Math.round(Math.sqrt(Math.abs(area(outer))) / 9 / 3) * 3) : JUNCTION.tree;
  const trees = (m: number) => seedsIn(rings, outer, step, m, step / 3).map(p => ({ ...p, t: 'tree' as const, s: size(p) }));
  const tables = (m: number) => seedsIn(rings, outer, JUNCTION.table, m, 0.6).map(p => ({ ...p, t: 'table' as const, s: 1 }));
  if (kind === 'garden') return trees(2.2);
  if (kind === 'court') return trees(3);
  if (kind === 'food') return tables(JUNCTION.counter.depth + 2.5);   // (v0.31: clear of the counters round the edge)
  // a hall: planting in the middle (well clear of the edge), seating round it
  const c = centroid(outer); const all = trees(2.5).filter(p => edgeGap(p, rings) >= 11);
  // (a grove in the middle, never more than about a sixth of the floor, so a large hall, like a free area, stays a hall)
  const cap = Math.max(4, Math.round(Math.abs(area(outer)) / 6 / (step * step)));
  const deep = all.length <= cap ? all : [...all].sort((p, q) => Math.hypot(p.x - c.x, p.y - c.y) - Math.hypot(q.x - c.x, q.y - c.y)).slice(0, cap);
  const far = deep.reduce((m, p) => Math.max(m, Math.hypot(p.x - c.x, p.y - c.y)), 0);
  const seats = tables(JUNCTION.counter.depth + 2.5).filter(p => !deep.some(t => Math.hypot(t.x - p.x, t.y - p.y) < 5.5) && (!deep.length || Math.hypot(p.x - c.x, p.y - c.y) > far * 0.4));
  // (and seating round it, at most about a fifth of the floor, nearest the grove first; the rest is open floor)
  const room = Math.max(8, Math.round(Math.abs(area(outer)) / 5 / (JUNCTION.table * JUNCTION.table)));
  return [...deep, ...(seats.length <= room ? seats : [...seats].sort((p, q) => Math.hypot(p.x - c.x, p.y - c.y) - Math.hypot(q.x - c.x, q.y - c.y)).slice(0, room))];
}
/** How far a point is from a junction space's edge (0 if it is inside). */
export function junctionGap(p: Pt, j: Junction) { return inJunction(p, j) ? 0 : edgeGap(p, j.rings); }
/** The stretches of a line that lie outside every one of these spaces (a spine stops at a hall and starts again beyond it). */
export function outsideRuns(pts: Pt[], js: Junction[], step = 1.5): Pt[][] {
  const runs: Pt[][] = []; let cur: Pt[] = [];
  const inAny = (p: Pt) => js.some(j => inJunction(p, j));
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1]; const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let k = i ? 1 : 0; k <= n; k++) {
      const p = { x: a.x + (b.x - a.x) * k / n, y: a.y + (b.y - a.y) * k / n };
      if (inAny(p)) { if (cur.length > 1) runs.push(cur); cur = []; }
      else if (k === 0 || k === n || !cur.length) cur.push(p);
      else if (cur.length === 1 || k === n) cur.push(p); else cur[cur.length - 1] = p;
    }
  }
  if (cur.length > 1) runs.push(cur);
  return runs;
}
/** v0.31: the counters round a food court or hall: along each straight stretch of its edge, `counter.front` wide and
 *  `counter.depth` deep, facing in; none where a spine comes in (`ends`, within `counter.gap`), and none that would
 *  not stand wholly inside the space. */
export function counters(j: Junction, ends: Pt[], doors: Pt[] = []): { pts: Pt[]; door: Pt; front: number; depth: number }[] {
  if (j.kind !== 'food' && j.kind !== 'hall') return [];
  const { front: F, depth: D, gap } = JUNCTION.counter; const r = j.outer; const out: { pts: Pt[]; door: Pt; front: number; depth: number }[] = [];
  for (let i = 0; i < r.length; i++) {
    const a = r[i], b = r[(i + 1) % r.length]; const L = Math.hypot(b.x - a.x, b.y - a.y); const k = Math.floor(L / F); if (k < 1) continue;
    const d = { x: (b.x - a.x) / L, y: (b.y - a.y) / L }; let nIn = { x: -d.y, y: d.x };
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; if (!inJunction({ x: mid.x + nIn.x, y: mid.y + nIn.y }, j)) nIn = { x: d.y, y: -d.x };
    const s0 = (L - k * F) / 2;
    for (let q = 0; q < k; q++) {
      const p0 = { x: a.x + d.x * (s0 + q * F), y: a.y + d.y * (s0 + q * F) }, p1 = { x: p0.x + d.x * F, y: p0.y + d.y * F };
      const p2 = { x: p1.x + nIn.x * D, y: p1.y + nIn.y * D }, p3 = { x: p0.x + nIn.x * D, y: p0.y + nIn.y * D };
      const m = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
      if (ends.some(e => Math.hypot(e.x - m.x, e.y - m.y) < gap + F / 2)) continue;
      if (doors.some(e => Math.hypot(e.x - m.x, e.y - m.y) < JUNCTION.counter.door + F / 2)) continue;   // (v0.31: not by a gate door)
      const c = { x: (p0.x + p2.x) / 2, y: (p0.y + p2.y) / 2 };
      if (![p2, p3, c].every(p => inJunction(p, j) && edgeGap(p, j.rings) >= (p === c ? D / 2 - 0.5 : 0))) continue;
      if (out.some(o => Math.hypot(o.door.x - (p2.x + p3.x) / 2 - nIn.x, o.door.y - (p2.y + p3.y) / 2 - nIn.y) < F * 0.9)) continue;
      out.push({ pts: [p0, p1, p2, p3], door: { x: (p2.x + p3.x) / 2 + nIn.x, y: (p2.y + p3.y) / 2 + nIn.y }, front: F, depth: D });
    }
  }
  // (v0.32: a very large space, like a free-drawn hall, gets counters in proportion to its floor, spread round it)
  const max = Math.max(6, Math.floor(j.area / JUNCTION.counter.per));
  return out.length <= max || j.area < 10000 ? out : Array.from({ length: max }, (_, i) => out[Math.floor((i * out.length) / max)]);
}
/** Is a point in a junction space (its holes are not part of it)? */
export function inJunction(p: Pt, j: Junction) { return j.rings.reduce((n, r) => n + (inPoly(p, r) ? 1 : 0), 0) % 2 === 1; }
