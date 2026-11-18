// Roads (v0.11): curves, roundabouts and one-way loops on the sample airport.
// Cars should route round the ring, a one-way frontage loop should serve the terminal, and a loop turned against
// itself should be caught by the design check.
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
const entry = `
import { Sim } from './src/sim';
import { sampleWorld } from './src/sample';
import { roadPlan } from './src/roads';
import { isRingRef, wayLen } from './src/ways';
import { carPoses } from './src/traffic';
import { YIELD } from './src/config';
let fails = 0; const check = (what, ok) => { if (!ok) { fails++; console.log('   FAIL:', what); } };
const run = (name, edit, days = 2) => {
  const sim = new Sim(sampleWorld(), 7); const w = sim.world;
  edit(w); sim.relayout(); sim.startDay();
  const RP = roadPlan(sim.d); const E = sim.d.road.edges;
  const T = sim.d.terminals[0];
  console.log(name + ':', T.active ? 'Terminal 1 open' : 'Terminal 1 CLOSED (' + T.problems.join('; ') + ')', '| roundabouts', RP.rounds.map(r => r.entries.length + ' roads').join(', ') || 'none',
    '| curved', w.ways.filter(q => q.c).length, 'one-way', w.ways.filter(q => q.oneway).length, '| issues:', sim.d.issues.filter(i => i.level !== 'info').map(i => i.text));
  let ring = 0, wrong = 0; const seen = new Set(); let pairsRaw = 0, pairsLane = 0, samples = 0;
  // v0.47: who gives way where. A held car waits at the first junction it has not been let through
  const N = sim.d.road.nodes; let held = 0, moving = 0, prio = 0, longest = 0; const heldAt = [new Set(), new Set(), new Set()];
  const giveWay = () => {
    const q = new Map();
    for (const c of sim.cars) {
      if (c.stage === 'in' || c.stage === 'out' || c.stage === 'park') moving++;
      if (!c.wait) continue;
      held++;
      const i = Math.max(c.si, (c.passed ?? -1) + 1), a = E[c.eids[i]], b = E[c.eids[i + 1]]; if (!a || !b) continue;
      const n = a.u === b.u || a.u === b.v ? a.u : a.v, k = sim.yieldKind[n];
      heldAt[k].add(c.id);
      const m0 = sim.major[n * 2], m1 = sim.major[n * 2 + 1];
      if (!k || (k === 2 && isRingRef(a.ref)) || (k === 1 && ((a.id === m0 && b.id === m1) || (a.id === m1 && b.id === m0)))) prio++;
      const key = a.id + ':' + n; q.set(key, (q.get(key) || 0) + 1);
    }
    for (const v of q.values()) longest = Math.max(longest, v);
  };
  sim.onDayEnd = r => { const s = r.stats; console.log('  ' + r.label, '| flights', s.flights, 'pax', s.paxDep, 'missed', s.missed, 'stranded', s.stranded, '| cars round the ring', ring, '| wrong-way', wrong, '| sat', r.sat.toFixed(0),
    '| gave way:', heldAt[2].size, 'cars at roundabout entries,', heldAt[1].size, 'at junctions, longest queue', longest, 'cars, waiting', (100 * held / Math.max(1, moving)).toFixed(1) + '% of the time driven, with right of way', prio,
    r.stats && pairsRaw ? '| overlapping cars: ' + pairsRaw + ' on the centreline, ' + pairsLane + ' as drawn' : '');
    if (T.active) { check(name + ': nobody with right of way waits', prio === 0); check(name + ': nobody missed or stranded', s.missed === 0 && s.stranded === 0); check(name + ': no queue over 60 cars (gridlock)', longest <= 60); }
    ring = 0; pairsRaw = 0; held = moving = prio = longest = 0; heldAt.forEach(x => x.clear()); };
  const close = pts => { let n = 0; for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) if (Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) < 3) n++; return n; };
  while (sim.day < days) {
    sim.step(0.25); giveWay();
    if (sim.day === 0) {   // v0.12: cars as drawn keep to lanes and hold a gap, so far fewer sit on top of each other
      const mv = sim.cars.filter(c => c.stage === 'in' || c.stage === 'out' || c.stage === 'park'); const ps = carPoses(sim);
      pairsRaw += close(mv); pairsLane += close(mv.map(c => ps.get(c)).filter(Boolean)); samples += mv.length;
    }
    for (const c of sim.cars) if (!seen.has(c.id)) {
      seen.add(c.id);
      if (c.eids.some(e => e >= 0 && E[e] && isRingRef(E[e].ref))) ring++;
      // every one-way edge must be driven from its u node to its v node
      c.eids.forEach((e, i) => { const ed = E[e]; if (e >= 0 && ed && ed.ow) { const p = c.pts[i], q = sim.d.road.nodes[ed.u]; if (Math.hypot(p.x - q.x, p.y - q.y) > 1) wrong++; } });
    }
  }
  return sim;
};
const road = (w, a, b, o = {}) => w.ways.push({ id: w.nextId++, kind: 'road', a: { x: a[0], y: a[1] }, b: { x: b[0], y: b[1] }, cls: 0, lanes: 2, ...o });

run('sample', () => {}, 1);

// a crossroads on the east approach, then a roundabout dropped onto it
run('crossroads', w => { road(w, [3000, 3700], [3700, 3700]); }, 1);
run('crossroads + roundabout', w => { road(w, [3000, 3700], [3700, 3700]); w.rounds.push({ id: w.nextId++, x: 3320, y: 3700, size: 0 }); });

// the whole forecourt as a one-way loop: in up the west side, along the terminal face, out down the east side
const loop = w => { w.rounds = []; for (const q of w.ways) if (q.kind === 'road' && q.lanes === 4) q.oneway = true; };
run('one-way loop', loop);

// the same loop with the frontage turned against the flow: nothing can get round
const bad = run('one-way loop, frontage reversed', w => { loop(w); const f = w.ways.find(q => q.kind === 'road' && q.lanes === 4 && q.a.y === q.b.y); [f.a, f.b] = [f.b, f.a]; }, 0);

// only a curved road reaches the terminal face from the highway side
run('curved approach', w => {
  w.rounds = []; w.ways = w.ways.filter(q => !(q.kind === 'road' && q.a.x === q.b.x));
  road(w, [2400, 5700], [2780, 3230], { c: { x: 2400, y: 3230 }, lanes: 4 });
  road(w, [3320, 3230], [3700, 5700], { c: { x: 3700, y: 3230 }, lanes: 4 });
});
// v0.47: each approach lets cars through at the HCM gap-acceptance capacity for the flow it crosses, whatever the step
{ const sim = new Sim(sampleWorld(), 7); sim.relayout(); const R = sim.d.road;
  const rate = (kind, q, dt) => {   // cars a minute let through from one approach, given q cars a minute crossing it
    const n = sim.yieldKind.findIndex(k => k === kind); if (n < 0) return NaN;
    const e = R.adj[n].find(k => !isRingRef(R.edges[k].ref) && !(sim.major[n * 2] === k && kind === 1) ) ?? R.adj[n][0];
    const slot = e * 2 + (R.edges[e].v === n ? 1 : 0); sim.yieldCredit[slot] = 0; let out = 0;
    for (let t = 0; t < 30; t += dt) { sim.yieldFlow[n] = q * YIELD.window; sim.updateCars(dt); const w = Math.floor(sim.yieldCredit[slot]); out += w; sim.yieldCredit[slot] -= w; }
    return out / 30; };
  const hcmEntry = q => (YIELD.entry / 60) * Math.exp(-YIELD.entryB * q * 60), siegloch = q => (60 / YIELD.tf) * Math.exp(-(q / 60) * (YIELD.tc - YIELD.tf / 2));
  for (const [kind, q, f, what] of [[2, 0, hcmEntry, 'a roundabout entry, empty ring'], [2, 20, hcmEntry, 'a roundabout entry, 1,200 cars an hour on the ring'], [1, 10, siegloch, 'a side road onto 600 cars an hour']]) {
    const a = rate(kind, q, 0.25), b = rate(kind, q, 0.05), want = f(q);
    console.log('capacity of ' + what + ':', a.toFixed(1), 'cars a minute at 0.25 min steps,', b.toFixed(1), 'at 0.05; HCM', want.toFixed(1));
    check(what + ': HCM capacity at either step size', Math.abs(a - want) < 0.1 * want + 0.1 && Math.abs(b - want) < 0.1 * want + 0.1);
  } }
console.log(fails ? fails + ' CHECK(S) FAILED' : 'all checks passed'); if (fails) process.exitCode = 1;
`;
const dir = mkdtempSync(join(tmpdir(), 'roads-')); const out = join(dir, 'run.mjs');
await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' });
await import(out);
