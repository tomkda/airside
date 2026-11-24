// v0.63: what a runway's exits do for it. Pure: read by the sim (capacity), the advisor and the UI.
import { Cls, EXITS, TAXI_CLASSES } from './config';
import { Pt, add, mul, sub, dot, norm, dist, segDist, rectSegDist } from './geom';
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
  /** how many exits that far apart the stretch has room for (at most four): with that many the runway is at its best */
  full: number;
}
/** The factor with n exits counted, where `full` is as many as fit. */
export const exitFactor = (n: number, full: number) => EXITS.factor[n >= full ? EXITS.factor.length - 1 : Math.min(n, EXITS.factor.length - 1)];

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
  // (an exit is a place on the runway where a taxiway leaves it and leads somewhere: to a stand, or to a junction
  //  with another taxiway clear of the runway. A stub that ends in the grass takes nobody off the runway.)
  const own = new Set(r.nodes.map(q => q.n)); const fronts = new Set(d.gates.map(g => g.frontNode));
  const off = (i: number) => Math.abs(dot(sub(d.air.nodes[i], r.rw.a), r.normal));
  const leads = (n0: number) => {
    const seen = new Set<number>([n0]); const q = [n0];
    while (q.length) { const u = q.pop()!;
      for (const ei of d.air.adj[u]) { const e = d.air.edges[ei]; if (e.kind === 'rwy') continue; const v = e.u === u ? e.v : e.u;
        if (seen.has(v) || own.has(v)) continue; seen.add(v);
        if (fronts.has(v) || (off(v) >= 60 && d.air.adj[v].length >= 2)) return true;
        q.push(v); } }
    return false;
  };
  for (const { n, s } of r.nodes) if (leads(n)) all.push(fromA ? s : r.length - s);
  all.sort((p, q) => p - q);
  const at: number[] = [];
  for (const s of all) if (s >= lo - 1 && s <= hi + 1 && (!at.length || s - at[at.length - 1] >= EXITS.apart)) at.push(s);
  const full = Math.max(1, Math.min(EXITS.factor.length - 1, Math.floor((hi - lo) / EXITS.apart) + 1));
  const info: ExitInfo = { fromA, cls, lo, hi, all, at, n: at.length, factor: exitFactor(at.length, full), full };
  m.set(r, info); return info;
}

const PAR_MIN = 90, PAR_MAX = 450;

/** One more exit for this runway: a rapid exit (30° off the runway, turning the way aircraft land) from the place in
 *  the stretch furthest from the exits it has, to the parallel taxiway beside it; a square one where the angled one
 *  does not fit. */
export function rapidExit(world: World, d: Derived, r: RunwayInfo, aprons: Apron[]): { way: WaySpec; s: number; rapid: boolean; cost: number } | { why: string } {
  const X = runwayExits(d, r);
  if (X.n >= X.full) return { why: 'it has every exit that counts' };
  const rd = norm(sub(r.rw.b, r.rw.a)); const n = { x: -rd.y, y: rd.x }; const L = r.length;
  const pars = chordWays(world.ways.filter(w => w.kind === 'taxi' && !w.c)).filter(w => {
    if (Math.abs(dot(norm(sub(w.b, w.a)), rd)) < 0.996) return false;
    const off = Math.abs(dot(sub(w.a, r.rw.a), n)); return off >= PAR_MIN && off <= PAR_MAX && w.cls >= X.cls;
  }).sort((p, q) => Math.abs(dot(sub(p.a, r.rw.a), n)) - Math.abs(dot(sub(q.a, r.rw.a), n)));   // (the nearest first: an exit never crosses one parallel to reach another)
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
    const sR = X.fromA ? s : L - s; const side = Math.sign(dot(sub(w.a, r.rw.a), n)) || 1;
    // (it meets the taxiway's own line, which need not be exactly parallel)
    const a = add(r.rw.a, mul(rd, sR)); const ang = EXITS.angle * Math.PI / 180;
    const dir = rapid ? add(mul(rd, sgn * Math.cos(ang)), mul(n, side * Math.sin(ang))) : mul(n, side);
    const wd = sub(w.b, w.a); const den = dir.x * wd.y - dir.y * wd.x; if (Math.abs(den) < 1e-6) continue;
    const t = ((w.a.x - a.x) * wd.y - (w.a.y - a.y) * wd.x) / den, u = ((w.a.x - a.x) * dir.y - (w.a.y - a.y) * dir.x) / den;
    const wl = dist(w.a, w.b); if (t <= 0 || u * wl < 20 || u * wl > wl - 20) continue;
    const b = add(a, mul(dir, t));
    // (never through stands, nor across another runway)
    if (aprons.some(ap => rectSegDist(ap.rect, a, add(a, mul(dir, Math.max(0, t - 15)))) === 0))   // (its last metres are on the taxiway the stands face)
      { why = 'it would run through stands'; continue; }
    if (d.runways.some(o => o !== r && [0, 0.25, 0.5, 0.75, 1].some(k => segDist(add(a, mul(sub(b, a), k)), o.rw.a, o.rw.b) < o.width / 2 + 40))) { why = 'another runway lies in its way'; continue; }
    const ok = canPlaceWay(world, 'taxi', a, b, aprons, undefined, w.cls);
    if (!ok.ok) { why = ok.reason ?? why; continue; }
    return { way: { a, b, cls: w.cls }, s, rapid, cost: dist(a, b) * TAXI_CLASSES[w.cls >= 3 ? 1 : 0].costPerM };
  }
  return { why };
}
