// Headless check: build the sample airport, run several sim days, print the daily report.
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const entry = `
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
    '| waits avg/max curb', w('curb'), 'checkin', w('checkin'), 'sec', w('security'), 'claim', w('claim'),
    '| shops/food/lounge/dutyfree/rent $', Math.round(s.rev.shops), Math.round(s.rev.food), Math.round(s.rev.lounges), Math.round(s.rev.dutyfree), Math.round(s.rev.rent), 'leased', sim.world.zones.filter(z=>z.type==='concourse').map(z=>sim.d.lease.get(z.id).count+'/'+sim.d.lease.get(z.id).max).join(','), '| sat', r.sat.toFixed(0), 'onTime', (r.onTime * 100).toFixed(0) + '%', '| profit/day $', Math.round(r.profit), 'maxLivePax', maxPax);
  maxPax = 0;
};
const t0 = Date.now();
let ticks = 0;
while (sim.day < days) { sim.step(0.25); ticks++; maxPax = Math.max(maxPax, sim.pax.filter(p => p.stage !== 'done').length); }
console.log('ticks', ticks, 'ms', Date.now() - t0);
console.log('log:', sim.log.slice(0, 6));
`;
const dir = mkdtempSync(join(tmpdir(), 'simtest-'));
const out = join(dir, 'run.mjs');
await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' });
process.argv[2] = process.argv[2] ?? '3';
await import(out);
