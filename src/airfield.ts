// v0.63: what a runway's exits do for it. Pure: read by the sim (capacity), the advisor and the UI.
import { Cls, EXITS, TAXI_CLASSES } from './config';
import { Pt, add, mul, sub, dot, norm, dist } from './geom';
import { Derived, RunwayInfo, World, WaySpec, Apron, canPlaceWay, landsFromA } from './world';
import { chordWays } from './ways';

export interface ExitInfo {
  /** landing from end a (into the prevailing wind) */
  fromA: boolean; cls: Cls;
  /** the stretch, from the landing threshold, where an exit takes a landing aircraft off the runway promptly */
  lo: number; hi: number;
  /** every exit's distance from the landing threshold, and the ones counted (in the stretch, `EXITS.apart` apart) */
  all: number[]; at: number[];
  n: number; factor: number;
}

const memo = new WeakMap<Derived, WeakMap<RunwayInfo, ExitInfo>>();

/** The largest aircraft this runway takes that has a gate here: its landing roll sets the stretch. */
function mixCls(d: Derived, r: RunwayInfo): Cls {
  for (let c = Math.max(0, r.cls); c > 0; c--) if (d.gates.some(g => d.gateUsable(g, c))) return c as Cls;
  return 0;
}

/** Exits of a runway, counted as FAA AC 150/5060-5 counts them for its exit factor: those within the stretch for the
 *  aircraft mix, each at least 750 ft from the last. */
export function runwayExits(d: Derived, r: RunwayInfo): ExitInfo {
  let m = memo.get(d); if (!m) memo.set(d, m = new WeakMap());
  const had = m.get(r); if (had) return had;
  const fromA = landsFromA(r.heading); const cls = mixCls(d, r);
  const [lo, hi0] = EXITS.range[cls]; const hi = Math.min(hi0, r.length);
  const all: number[] = [];
  for (const { n, s } of r.nodes) {
    // (an exit is a place on the runway where something other than the runway leaves it)
    if (!d.air.adj[n].some(e => d.air.edges[e].kind !== 'rwy')) continue;
    all.push(fromA ? s : r.length - s);
  }
  all.sort((p, q) => p - q);
  const at: number[] = [];
  for (const s of all) if (s >= lo - 1 && s <= hi + 1 && (!at.length || s - at[at.length - 1] >= EXITS.apart)) at.push(s);
  const info: ExitInfo = { fromA, cls, lo, hi, all, at, n: at.length, factor: EXITS.factor[Math.min(at.length, EXITS.factor.length - 1)] };
  m.set(r, info); return info;
}

const PAR_MIN = 90, PAR_MAX = 450;

/** One more exit for this runway: a rapid exit (30° off the runway, turning the way aircraft land) from the place in
 *  the stretch furthest from the exits it has, to the parallel taxiway beside it; a square one where the angled one
 *  does not fit. */
export function rapidExit(world: World, d: Derived, r: RunwayInfo, aprons: Apron[]): { way: WaySpec; s: number; rapid: boolean; cost: number } | { why: string } {
  const X = runwayExits(d, r);
  if (X.n >= EXITS.factor.length - 1) return { why: 'it has every exit that counts' };
  const rd = norm(sub(r.rw.b, r.rw.a)); const n = { x: -rd.y, y: rd.x }; const L = r.length;
  const pars = chordWays(world.ways.filter(w => w.kind === 'taxi' && !w.c)).filter(w => {
    if (Math.abs(dot(norm(sub(w.b, w.a)), rd)) < 0.996) return false;
    const off = Math.abs(dot(sub(w.a, r.rw.a), n)); return off >= PAR_MIN && off <= PAR_MAX && w.cls >= X.cls;
  });
  if (!pars.length) return { why: `no taxiway runs parallel to it within ${PAR_MAX} m for an exit to lead to` };
  // places in the stretch, furthest from the exits already counted first
  const cands: number[] = [];
  for (let s = X.lo; s <= X.hi; s += 10) if (X.all.every(q => Math.abs(q - s) >= EXITS.apart)) cands.push(s);
  if (!cands.length) return { why: `the stretch ${Math.round(X.lo)}–${Math.round(X.hi)} m from the threshold has no place ${EXITS.apart} m from the exits it has` };
  const gap = (s: number) => Math.min(...X.all.map(q => Math.abs(q - s)), 1e9);
  // (the earliest place that keeps its distance: an aircraft that can take it is off soonest. Ties go to the wider gap.)
  cands.sort((p, q) => (gap(q) >= EXITS.apart * 1.5 ? 1 : 0) - (gap(p) >= EXITS.apart * 1.5 ? 1 : 0) || p - q);
  const sgn = X.fromA ? 1 : -1; let why = 'no place for one clear of what is built';
  for (const rapid of [true, false]) for (const s of cands) for (const w of pars) {
    const sR = X.fromA ? s : L - s; const off = dot(sub(w.a, r.rw.a), n);
    const ta = dot(sub(w.a, r.rw.a), rd), tb = dot(sub(w.b, r.rw.a), rd);
    const sT = sR + (rapid ? sgn * Math.abs(off) / Math.tan(EXITS.angle * Math.PI / 180) : 0);
    if (sT < Math.min(ta, tb) + 20 || sT > Math.max(ta, tb) - 20) continue;
    const a = add(r.rw.a, mul(rd, sR)), b = add(add(r.rw.a, mul(rd, sT)), mul(n, off));
    const ok = canPlaceWay(world, 'taxi', a, b, aprons, undefined, w.cls);
    if (!ok.ok) { why = ok.reason ?? why; continue; }
    return { way: { a, b, cls: w.cls }, s, rapid, cost: dist(a, b) * TAXI_CLASSES[w.cls >= 3 ? 1 : 0].costPerM };
  }
  return { why };
}
