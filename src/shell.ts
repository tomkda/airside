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
