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
const run = (name, edit, days = 2) => {
  const sim = new Sim(sampleWorld(), 7); const w = sim.world;
  edit(w); sim.relayout(); sim.startDay();
  const RP = roadPlan(sim.d); const E = sim.d.road.edges;
  const T = sim.d.terminals[0];
  console.log(name + ':', T.active ? 'Terminal 1 open' : 'Terminal 1 CLOSED (' + T.problems.join('; ') + ')', '| roundabouts', RP.rounds.map(r => r.entries.length + ' roads').join(', ') || 'none',
    '| curved', w.ways.filter(q => q.c).length, 'one-way', w.ways.filter(q => q.oneway).length, '| issues:', sim.d.issues.filter(i => i.level !== 'info').map(i => i.text));
  let ring = 0, wrong = 0; const seen = new Set();
  sim.onDayEnd = r => { const s = r.stats; console.log('  ' + r.label, '| flights', s.flights, 'pax', s.paxDep, 'missed', s.missed, 'stranded', s.stranded, '| cars round the ring', ring, '| wrong-way', wrong, '| sat', r.sat.toFixed(0)); ring = 0; };
  while (sim.day < days) {
    sim.step(0.25);
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
run('crossroads', w => { road(w, [3000, 3700], [3700, 3700]); });
run('crossroads + roundabout', w => { road(w, [3000, 3700], [3700, 3700]); w.rounds.push({ id: w.nextId++, x: 3320, y: 3700, size: 0 }); });

// the whole forecourt as a one-way loop: in up the west side, along the terminal face, out down the east side
const loop = w => { w.rounds = []; w.ways = w.ways.filter(q => !q.c); for (const q of w.ways) if (q.kind === 'road' && q.lanes === 4) q.oneway = true; };
run('one-way loop', loop);

// the same loop with the frontage turned against the flow: nothing can get round
const bad = run('one-way loop, frontage reversed', w => { loop(w); const f = w.ways.find(q => q.kind === 'road' && q.lanes === 4 && q.a.y === q.b.y); [f.a, f.b] = [f.b, f.a]; }, 0);

// only a curved road reaches the terminal face from the highway side
run('curved approach', w => {
  w.rounds = []; w.ways = w.ways.filter(q => !q.c);
  for (const q of w.ways) if (q.kind === 'road' && q.a.x === q.b.x) { if (q.a.y > 5000) q.a.y = 2955; else q.b.y = 2955; }
  road(w, [2400, 5700], [2780, 2898], { c: { x: 2400, y: 2898 }, lanes: 4 });
  road(w, [3320, 2898], [3700, 5700], { c: { x: 3700, y: 2898 }, lanes: 4 });
});
`;
const dir = mkdtempSync(join(tmpdir(), 'roads-')); const out = join(dir, 'run.mjs');
await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' });
await import(out);
