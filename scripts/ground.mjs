// v0.58: ground traffic. Aircraft keep clear of each other on taxiways, stand off head-on on a single one, hold on
// stand for opposing traffic, and take a second taxiway where there is one. Exits 1 if a check fails.
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
const entry = `
import { derive, parallelTaxi } from './src/world';
import { sampleWorld } from './src/sample';
import { Sim } from './src/sim';
import { GROUND } from './src/config';
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
console.log(bad ? bad + ' CHECK(S) FAILED' : 'all checks passed');
if (bad) process.exit(1);
`;
const dir = mkdtempSync(join(tmpdir(), 'ground-'));
const out = join(dir, 'run.mjs');
await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' });
await import(out);
