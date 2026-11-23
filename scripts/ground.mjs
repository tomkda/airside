// v0.58: ground traffic. Aircraft keep clear of each other on taxiways, stand off head-on on a single one, hold on
// stand for opposing traffic, and take a second taxiway where there is one. Exits 1 if a check fails.
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
const entry = `
import { derive, parallelTaxi } from './src/world';
import { sampleWorld } from './src/sample';
import { Sim } from './src/sim';
import { GROUND } from './src/config';
import * as W from './src/ways';
let bad = 0;
const check = (what, ok) => { if (!ok) { bad++; console.log('   FAIL: ' + what); } };
const fly = (w, days = 1) => { const sim = new Sim(w, 7); sim.relayout(); sim.startDay(); const out = []; let close = 1e9;
  sim.onDayEnd = r => out.push(r.stats);
  while (sim.day < days) { sim.step(0.25);
    const g = sim.flights.filter(f => (f.state === 'taxiIn' || f.state === 'taxiOut') && !(f.freeT > sim.t));
    for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) if (!g[i].pass?.has(g[j].id)) close = Math.min(close, Math.hypot(g[i].x - g[j].x, g[i].y - g[j].y)); }
  const s = out[out.length - 1]; return { sim, s, close }; };
const line = (name, r) => console.log(name + ':', r.s.flights, 'flights, cancelled', r.s.cancelled, '| taxi', (r.s.ground.taxi / Math.max(1, r.s.ground.moves)).toFixed(1), 'min a movement | held', r.s.ground.hold.toFixed(1), 'min taxiing,', r.s.ground.gate.toFixed(1), 'min on stand | stand-offs', r.s.ground.standoffs, '| closest two taxiing aircraft came', Math.round(r.close), 'm | missed', r.s.missed);

// 1. the sample: a parallel taxiway with an exit every few hundred metres
const A = fly(sampleWorld()); line('sample', A);
check('the sample flies with no stand-off and nobody cancelled', A.s.ground.standoffs === 0 && A.s.cancelled === 0 && A.s.ground.moves >= 2 * A.s.flights - 2);
check('taxiing aircraft never overlap', A.close > 30);

// 2. one link between the apron and the runway: everything meets on it
const one = () => { const w = sampleWorld(); const links = w.ways.filter(q => q.kind === 'taxi' && Math.abs(q.a.y - 2300) < 1);
  const keep = links.reduce((m, q) => (Math.abs(q.a.x - 3200) < Math.abs(m.a.x - 3200) ? q : m));
  w.ways = w.ways.filter(q => !links.includes(q) || q === keep); return { w, keep }; };
const B = fly(one().w); line('one link to the runway', B);
check('with one link aircraft are held: on stand for traffic coming in, or nose to nose on it', B.s.ground.hold + B.s.ground.gate > A.s.ground.hold + A.s.ground.gate + 5);
check('and still everything flies', B.s.cancelled === 0 && B.s.flights >= A.s.flights - 1);
const worst = [...B.sim.groundLast].sort((a, b) => b[1].min - a[1].min)[0];
console.log('   most held on way', worst && worst[0], worst && worst[1].min.toFixed(1), 'min,', worst && worst[1].so, 'stand-offs');
check('the day names where they stood', !!worst && worst[1].min > 1);

// 3. the one-click fix: a parallel beside the link
{ const { w, keep } = one(); const d = derive(w); const par = parallelTaxi(w, keep, d.aprons);
  check('a parallel can be laid beside the link', !('why' in par));
  if (!('why' in par)) {
    const L = Math.hypot(keep.b.x - keep.a.x, keep.b.y - keep.a.y); const sep = Math.abs((par.ways[0].a.x - keep.a.x) * (keep.b.y - keep.a.y) - (par.ways[0].a.y - keep.a.y) * (keep.b.x - keep.a.x)) / L;
    console.log('   parallel laid', Math.round(sep), 'm off, with', par.ways.length - 1, 'end link(s),', Math.round(par.len), 'm of taxiway');
    check('at the centre-line separation for its class', Math.abs(sep - GROUND.par[keep.cls]) < 0.01);
    for (const q of par.ways) w.ways.push({ id: w.nextId++, kind: 'taxi', a: q.a, b: q.b, cls: q.cls, lanes: 0 });
    const C = fly(w); line('with a parallel link', C);
    check('with a second link far less time is lost', C.s.ground.hold + C.s.ground.gate < (B.s.ground.hold + B.s.ground.gate) * 0.6 && C.s.ground.standoffs <= B.s.ground.standoffs);
    check('and nobody is cancelled', C.s.cancelled === 0); } }

// 4. taxiway A itself can take a parallel on the sample
{ const w = sampleWorld(); const d = derive(w); const Aw = w.ways.find(q => q.kind === 'taxi' && Math.abs(q.a.y - 2490) < 1 && Math.abs(q.b.y - 2490) < 1);
  const par = parallelTaxi(w, Aw, d.aprons); console.log('   a parallel to taxiway A:', 'why' in par ? 'refused: ' + par.why : 'laid at y ' + par.ways[0].a.y);
  check('taxiway A takes a parallel on its runway side (its stands stay)', !('why' in par) && par.ways[0].a.y < 2490);
  if (!('why' in par)) { for (const q of par.ways) w.ways.push({ id: w.nextId++, kind: 'taxi', a: q.a, b: q.b, cls: q.cls, lanes: 0 });
    const D = fly(w); line('sample with a second parallel', D);
    check('the sample keeps its 14 gates and flies', D.sim.d.gates.length === 14 && D.s.cancelled === 0 && D.s.missed === 0); } }
// 5. other days and seeds on the sample: no aircraft gives way to one that is standing for it, and a stand's swap is no stand-off
{ let tows = 0, so = 0, held = 0, cxl = 0;
  for (const seed of [1, 2, 8]) { const sim = new Sim(sampleWorld(), seed); sim.relayout(); sim.startDay();
    sim.onDayEnd = r => { tows += r.stats.ground.tows; so += r.stats.ground.standoffs; held += r.stats.ground.hold; };
    while (sim.day < 4) sim.step(0.25); }
  console.log('sample, seeds 1, 2 and 8 over four days each:', tows, 'towed clear,', so, 'stand-offs,', held.toFixed(0), 'min held');
  check('nobody stands long enough to be towed, and there is no stand-off', tows === 0 && so === 0 && held < 60); }

// 6. the parallel's ends, a second click, and a curve
{ const { w, keep } = one(); const d = derive(w); const par = parallelTaxi(w, keep, d.aprons);
  const m = par.ways[0]; console.log('   beside the angled link:', par.ways.length, 'way(s), from', Math.round(m.a.x) + ',' + Math.round(m.a.y), 'to', Math.round(m.b.x) + ',' + Math.round(m.b.y));
  check('its ends meet the runway centre line and taxiway A themselves, with no link laid along either', par.ways.length === 1 && Math.abs(m.a.y - 2300) < 0.5 && Math.abs(m.b.y - 2490) < 0.5);
  for (const q of par.ways) w.ways.push({ id: w.nextId++, kind: 'taxi', a: q.a, b: q.b, cls: q.cls, lanes: 0 });
  const again = parallelTaxi(w, keep, derive(w).aprons);
  check('a second click does not lay the same one again', 'why' in again || Math.abs(again.ways[0].a.x - m.a.x) > 40);
  const w2 = sampleWorld(); const A2 = w2.ways.find(q => q.kind === 'taxi' && Math.abs(q.a.y - 2490) < 1 && Math.abs(q.b.y - 2490) < 1);
  const p1 = parallelTaxi(w2, A2, derive(w2).aprons); for (const q of p1.ways) w2.ways.push({ id: w2.nextId++, kind: 'taxi', a: q.a, b: q.b, cls: q.cls, lanes: 0 });
  const p2 = parallelTaxi(w2, A2, derive(w2).aprons);
  console.log('   taxiway A: first', p1.ways.length, 'way(s) at y', p1.ways[0].a.y, '| asked again:', 'why' in p2 ? p2.why : 'y ' + p2.ways[0].a.y);
  check('taxiway A gets one way with no link (its ends are on the end links); asked again it is refused: one side has it, the other has the stands', p1.ways.length === 1 && 'why' in p2);
  const w3 = sampleWorld(); const cv = { id: w3.nextId++, kind: 'taxi', a: { x: 1500, y: 1500 }, b: { x: 2100, y: 1500 }, c: { x: 1800, y: 1300 }, cls: 2, lanes: 0 }; w3.ways.push(cv);
  const pc = parallelTaxi(w3, cv, derive(w3).aprons);
  if (!('why' in pc)) { const P = W.wayPts(cv), Q = W.wayPts(pc.ways[0]); let least = 1e9; for (const q of Q) for (const p of P) least = Math.min(least, Math.hypot(p.x - q.x, p.y - q.y));
    console.log('   beside a curve: never nearer than', least.toFixed(1), 'm'); check('a curve is set off along its own normals: 40 m or more all the way', least >= 40); }
  else console.log('   beside a curve: refused,', pc.why); }
console.log(bad ? bad + ' CHECK(S) FAILED' : 'all checks passed');
if (bad) process.exit(1);
`;
const dir = mkdtempSync(join(tmpdir(), 'ground-'));
const out = join(dir, 'run.mjs');
await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' });
await import(out);
