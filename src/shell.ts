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
export interface Shell { level: number; ids: number[]; rings: Pt[][]; outer: Pt[] }
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
export function shellsOf(zones: (Shaped & { id: number; type: string; level: number })[]): Shell[] {
  const out: Shell[] = [];
  for (const level of [0, 1]) {
    const zs = zones.filter(z => z.type === 'concourse' && z.level === level); if (!zs.length) continue;
    const c = new ClipperLib.Clipper();
    // (each piece is grown a hair, so pieces that only share a wall still merge)
    for (const z of zs) c.AddPaths(offset([toPath(zonePts(z))], 0.3), ClipperLib.PolyType.ptSubject, true);
    const tree = new ClipperLib.PolyTree();
    c.Execute(ClipperLib.ClipType.ctUnion, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
    for (const ex of ClipperLib.JS.PolyTreeToExPolygons(tree) as { outer: IPath; holes: IPath[] }[]) {
      // fill the inside corners, then ease the outside ones; a building is rounded on its own, never bridged to its neighbour
      let paths: IPath[] = [ex.outer, ...ex.holes];
      paths = offset(offset(paths, SHELL.fillet), -SHELL.fillet);
      paths = offset(offset(paths, -SHELL.ease), SHELL.ease);
      if (!paths.length) continue;
      const rings = paths.map(fromPath);
      const outer = rings.reduce((m, r) => (Math.abs(area(r)) > Math.abs(area(m)) ? r : m));
      const raw = fromPath(ex.outer);
      const ids = zs.filter(z => inPoly(heart(z), raw)).map(z => z.id);
      if (ids.length) out.push({ level, ids, rings, outer });
    }
  }
  return out;
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
export const JUNCTION = { grow: 6, min: 30, corner: 600, food: 400, hall: 1500, tree: 9, table: 4.2 };

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
export function junctionsOf(shells: Shell[], zones: (Shaped & { id: number; type: string; level: number })[]): Junction[] {
  const out: Junction[] = [];
  for (const sh of shells) {
    if (sh.ids.length < 2) continue;
    const zs = zones.filter(z => sh.ids.includes(z.id)); const P = zs.map(z => toPath(zonePts(z)));
    const shell = sh.rings.map(toPath); const EO = ClipperLib.PolyFillType.pftEvenOdd;
    // where two pieces overlap (a hall already has its own open middle, so a pier running into one is left to the hall)
    const cores: { ring: Pt[]; ids: number[] }[] = [];
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
    // floor the shell added in its inside corners
    // (a large stretch of it, like the gap closed between two piers standing close side by side, is a garden of its
    //  own; only a corner's worth joins the junction beside it)
    const fills = clip(ClipperLib.ClipType.ctDifference, shell, P, EO);
    const big = fills.filter(e => Math.abs(area(fromPath(e.outer))) > JUNCTION.corner), fill = flat(fills.filter(e => !big.includes(e)));
    const grown = cores.length ? offset(cores.map(c => toPath(c.ring)), JUNCTION.grow) : [];
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
  if (kind === 'food') return tables(3);
  // a hall: planting in the middle (well clear of the edge), seating round it
  const c = centroid(outer); const deep = trees(2.5).filter(p => edgeGap(p, rings) >= 11);
  const far = deep.reduce((m, p) => Math.max(m, Math.hypot(p.x - c.x, p.y - c.y)), 0);
  return [...deep, ...tables(3.5).filter(p => !deep.some(t => Math.hypot(t.x - p.x, t.y - p.y) < 5.5) && (!deep.length || Math.hypot(p.x - c.x, p.y - c.y) > far * 0.4))];
}
/** Is a point in a junction space (its holes are not part of it)? */
export function inJunction(p: Pt, j: Junction) { return j.rings.reduce((n, r) => n + (inPoly(p, r) ? 1 : 0), 0) % 2 === 1; }
