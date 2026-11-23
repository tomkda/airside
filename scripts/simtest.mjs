// Headless check: build the sample airport, run several sim days, print the daily report.
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const entry = `
import * as LOSM from './src/los';
import * as CFG from './src/config';
import { Sim } from './src/sim';
import { sampleWorld } from './src/sample';
const sim = new Sim(sampleWorld(), 7);
console.log('issues:', sim.d.issues.map(i => i.level + ': ' + i.text));
console.log('terminals:', sim.d.terminals.map(t => t.name + ' ' + (t.active ? 'OPEN' : 'CLOSED ' + t.problems.join('; ')) + ' gates ' + t.gates + ' shops ' + t.shops));
console.log('runways:', sim.d.runways.map(r => r.labels.join('/') + ' ' + Math.round(r.length) + 'm'), 'gates:', sim.d.gates.length, 'cores:', sim.d.cores.length, 'coverage:', sim.d.coverage.toFixed(2));
const days = Number(process.argv[2] || 3);
let maxPax = 0;
sim.onDayEnd = r => {
  const s = r.stats; const w = k => s.waits[k].n ? (s.waits[k].sum / s.waits[k].n).toFixed(1) + '/' + s.waits[k].max.toFixed(0) : '-';
  console.log(r.label, '| plan', r.plan.scheduled + '/' + r.plan.demand, r.plan.limit,
    '| flights', s.flights, 'delayed', s.delayed, 'cxl', s.cancelled,
    '| pax dep', s.paxDep, 'arr', s.paxArr, 'missed', s.missed,
    '| ground: taxi', (s.ground.taxi / Math.max(1, s.ground.moves)).toFixed(1), 'min/move, held', s.ground.hold.toFixed(1), 'min, on stand', s.ground.gate.toFixed(1), 'stand-offs', s.ground.standoffs,
    '| waits avg/max curb', w('curb'), 'checkin', w('checkin'), 'sec', w('security'), 'claim', w('claim'),
    '| shops/food/lounge/dutyfree/rent $', Math.round(s.rev.shops), Math.round(s.rev.food), Math.round(s.rev.lounges), Math.round(s.rev.dutyfree), Math.round(s.rev.rent), 'leased', sim.world.zones.filter(z=>z.type==='concourse').map(z=>sim.d.lease.get(z.id).count+'/'+sim.d.lease.get(z.id).max).join(','), '| sat', r.sat.toFixed(0), 'onTime', (r.onTime * 100).toFixed(0) + '%', '| profit/day $', Math.round(r.profit), 'maxLivePax', maxPax);
  maxPax = 0;
};
const t0 = Date.now();
let ticks = 0;
while (sim.day < days) { sim.step(0.25); ticks++; maxPax = Math.max(maxPax, sim.pax.filter(p => p.stage !== 'done').length); }
console.log('ticks', ticks, 'ms', Date.now() - t0);
console.log('log:', sim.log.slice(0, 6));
// v0.57: level of service, and a module's own staffing dial
{ const { losFrom, bandOf } = LOSM; const { LOS } = CFG; let bad = 0; const check = (what, ok) => { if (!ok) { bad++; console.log('   FAIL: ' + what); } };
  const line = () => sim.d.zones.filter(z => !z.auto).map(z => ({ z, L: losFrom(sim, z, sim.losLast.get(z.id)) })).filter(q => q.L)
    .map(({ z, L }) => z.type + ' ' + LOS.names[L.band] + ' (' + (isFinite(L.space) ? L.space.toFixed(1) : '-') + ' m2' + (L.wait !== undefined ? ', ' + L.wait.toFixed(0) + ' min' : '') + (L.capMax ? ', ' + L.open + '/' + L.max + ' staffed, ' + L.need + ' needed' : '') + ')').join(' | ');
  console.log('level of service, last day:', line());
  const kinds = new Set(sim.d.zones.filter(z => losFrom(sim, z, sim.losLast.get(z.id))).map(z => z.type));
  check('check-in, security, claim and the concourse all have a level of service', ['checkin', 'security', 'claim', 'concourse'].every(k => kinds.has(k)));
  check('the matrix: sub-optimum on both counts is under-provided, on one sub-optimum, over-design only on both', bandOf(2, 2, 0.5, 1) === 3 && bandOf(2, 1, 0.9, 1) === 2 && bandOf(0, 2, 9, 1) === 2 && bandOf(0, 0, 9, 1) === 0 && bandOf(0, 1, 9, 1) === 1 && bandOf(2, undefined, 0.7, 1) === 3);
  const sec = sim.world.zones.find(z => z.type === 'security'); const before = losFrom(sim, sec, sim.losLast.get(sec.id)); const open0 = sim.procs.get(sec.id).servers;
  sec.staff = 2; sim.relayout(); const d0 = sim.day; while (sim.day === d0) sim.step(0.25);
  const after = losFrom(sim, sec, sim.losLast.get(sec.id));
  console.log('security with its dial at 2 lanes (was ' + open0 + '):', LOS.names[before.band], Math.round(before.wait) + ' min →', LOS.names[after.band], Math.round(after.wait) + ' min,', after.open + '/' + after.max, 'staffed,', after.need, 'needed');
  check('a module staffed below its busiest hour waits longer and drops a band', after.open === 2 && after.wait > before.wait && after.band > before.band && after.need > 2);
  delete sec.staff; sim.relayout(); check('with the dial off it takes its share again', sim.procs.get(sec.id).servers === open0);
  // turned down while people are being served: they go back to the head of the line, nobody is left at a closed lane
  { const d1 = sim.day; while (sim.day === d1 && !(sim.procs.get(sec.id).busy.filter(Boolean).length >= 3)) sim.step(0.25);
    sec.staff = 0; sim.relayout(); const P = sim.procs.get(sec.id);
    const lost = sim.pax.filter(p => p.stage === 'service' && p.proc === P).length;
    for (let i = 0; i < 4 * 90; i++) sim.step(0.25);
    const { losNow, losFix } = LOSM; const now = losNow(sim, sec);
    console.log('security closed mid-morning:', P.queue.length, 'in line,', lost, 'left at a closed lane | now', LOS.names[now.band], Math.round(now.wait) + ' min |', losFix(now, 'lanes'));
    check('nobody is left standing at a lane that closed', lost === 0 && P.queue.length > 10);
    check('a module nobody staffs is not over-design: its queue has a wait, and the advice says to staff it', now.band >= 2 && now.wait > 30 && /nobody is staffing/.test(losFix(now, 'lanes')));
    delete sec.staff; sim.relayout(); }
  if (bad) { console.log(bad + ' CHECK(S) FAILED'); process.exit(1); } }
`;
const dir = mkdtempSync(join(tmpdir(), 'simtest-'));
const out = join(dir, 'run.mjs');
await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' });
process.argv[2] = process.argv[2] ?? '3';
await import(out);
