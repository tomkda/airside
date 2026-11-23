// v0.59: the advisor: what holds the airport back, worst first, each with its upgrade. Exits 1 if a check fails.
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
const entry = `
import { derive } from './src/world';
import { sampleWorld } from './src/sample';
import { Sim } from './src/sim';
import { advise } from './src/advisor';
let bad = 0;
const check = (what, ok) => { if (!ok) { bad++; console.log('   FAIL: ' + what); } };
const day = (w, prep) => { const sim = new Sim(w, 7); sim.relayout(); if (prep) prep(sim); sim.startDay(); const d0 = sim.day; while (sim.day === d0) sim.step(0.25); return sim; };
const show = (name, list) => console.log(name + ':', list.length ? list.map(a => a.kind + ' "' + a.title + '"').join(' | ') : 'nothing');

// 1. the sample as it stands
{ const sim = day(sampleWorld()); const A = advise(sim); show('sample after a day', A);
  console.log('   plan:', sim.plan.scheduled + '/' + sim.plan.demand, sim.plan.limit, '| turned away: gates', sim.plan.rejectedGates, 'runway', sim.plan.rejectedRunway, 'aircraft', sim.plan.rejectedAircraft);
  check('it never advises building stands or a parallel where nothing was turned away or held', !A.some(a => a.kind === 'stands' || a.kind === 'parallel' || a.kind === 'extend'));
  check('every piece of advice says why', A.every(a => a.why.length > 30 && a.title.length > 3)); }

// 2. only four stands built: flights are turned away for gates, and there is room for more
{ const w = sampleWorld(); const d = derive(w); const c = w.zones.find(z => z.type === 'concourse');
  c.stands = d.gateSlots.filter(s => s.zone.id === c.id && s.on).slice(0, 4).map(s => ({ x: s.door.x, y: s.door.y, paid: 0, cls: s.cls }));
  // (and a bank asked for, so that whatever the day's dice, more aircraft want stands at once than there are)
  const sim = day(w, q => { q.addBank('meridian', 7); }); const A = advise(sim); show('four stands built, and a bank of eight', A);
  console.log('   gates', sim.d.gates.length, '| turned away for gates', sim.plan.rejectedGates, '| places left', sim.d.gateSlots.filter(s => !s.on).length);
  const st = A.find(a => a.kind === 'stands');
  check('flights turned away for gates bring the advice to build stands, first in the list', sim.plan.rejectedGates > 0 && !!st && A[0] === st && st.n >= 1 && st.n <= sim.d.gateSlots.filter(s => !s.on).length); }

// 3. every place built and still short: lengthen the concourse
{ const w = sampleWorld(); const c = w.zones.find(z => z.type === 'concourse'); c.x = 3000; c.w = 200;
  const d = derive(w); c.stands = d.gateSlots.filter(s => s.zone.id === c.id).map(s => ({ x: s.door.x, y: s.door.y, paid: 0, cls: s.cls }));
  const sim = day(w); const A = advise(sim); show('a 200 m concourse, every stand built', A);
  console.log('   gates', sim.d.gates.length, '| turned away for gates', sim.plan.rejectedGates);
  check('with no place left the advice is to lengthen the concourse', sim.plan.rejectedGates > 0 && A.some(a => a.kind === 'extend' && a.zone === c.id)); }

// 4. one link to the runway: a parallel to it
{ const w = sampleWorld(); const links = w.ways.filter(q => q.kind === 'taxi' && Math.abs(q.a.y - 2300) < 1); const keep = links.find(q => q.a.x === 3200);
  w.ways = w.ways.filter(q => !links.includes(q) || q === keep);
  const sim = day(w); const A = advise(sim); show('one link to the runway', A);
  check('aircraft standing nose to nose on the link bring the advice to lay a parallel to it', A.some(a => a.kind === 'parallel' && a.way === keep.id)); }

// 5. security short of staff: hire for it
{ const w = sampleWorld(); const sim = day(w, s => { s.staff.screeners = 6; }); const A = advise(sim); show('six screeners (two lanes)', A);
  const st = A.find(a => a.kind === 'staff');
  check('a queue past its limit with lanes unstaffed brings the advice to hire, with how many', !!st && st.pool === 'screeners' && st.n >= 3 && st.n % 3 === 0); }
console.log(bad ? bad + ' CHECK(S) FAILED' : 'all checks passed');
if (bad) process.exit(1);
`;
const dir = mkdtempSync(join(tmpdir(), 'advisor-'));
const out = join(dir, 'run.mjs');
await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' });
await import(out);
