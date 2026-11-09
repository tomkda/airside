// Stress: cut and restore connections mid-day, then build up to A380 service.
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
const entry = `
import { Sim } from './src/sim';
import { sampleWorld } from './src/sample';
const sim = new Sim(sampleWorld(), 11);
const w = sim.world;
const out = [];
sim.onDayEnd = r => out.push([r.label.padEnd(18), 'sched', (r.plan.scheduled + '/' + r.plan.demand).padEnd(6), r.plan.limit.padEnd(14),
  'flights', r.stats.flights, 'cxl', r.stats.cancelled, 'missed', r.stats.missed, 'stranded', r.stats.stranded, 'sat', r.sat.toFixed(0),
  'PX', r.plan.byAirline.find(b => b.airline.iata === 'PX').scheduled, '|', sim.log.filter(l => l.kind === 'bad').slice(0, 2).map(l => l.text).join(' ; ')].join(' '));
let saved = {};
const at = (day, min, fn) => ({ day, min, fn });
const events = [
  at(2, 600, () => { saved.walk = w.ways.filter(x => x.kind === 'walk'); w.ways = w.ways.filter(x => x.kind !== 'walk'); }),
  at(3, 600, () => { saved.ci = w.zones.find(z => z.type === 'checkin'); w.zones = w.zones.filter(z => z !== saved.ci);
                     w.zones.push({ id: w.nextId++, type: 'checkin', level: 1, x: 4000, y: 2900, w: 200, h: 60, tier: 0 }); }),
  at(4, 300, () => { w.zones = w.zones.filter(z => !(z.type === 'checkin' && z.x === 4000)); w.zones.push(saved.ci); w.ways.push(...saved.walk); }),
  at(5, 600, () => { saved.apr = w.ways.filter(x => x.kind === 'taxi' && x.a.y === 2300 && x.b.y === 2490); w.ways = w.ways.filter(x => !saved.apr.includes(x)); }),
  at(6, 300, () => { w.ways.push(...saved.apr); }),
  at(7, 600, () => { saved.rd = w.ways.filter(x => x.kind === 'road' && x.lanes === 4 && (x.a.y === 5700 || x.b.y === 5700)); w.ways = w.ways.filter(x => !saved.rd.includes(x)); }),
  at(8, 300, () => { w.ways.push(...saved.rd); }),
  // A380 build-out: 3,200 m runway north, Code F concourse east, standard taxiway first
  at(9, 300, () => {
    w.runways.push({ id: w.nextId++, a: { x: 1600, y: 1500 }, b: { x: 4800, y: 1500 } });
    w.zones.push({ id: w.nextId++, type: 'concourse', level: 1, x: 3400, y: 2620, w: 700, h: 90, tier: 0, cls: 3 });
    for (const [ax, ay, bx, by] of [[1600,1500,1600,1700],[1600,1700,4800,1700],[4800,1500,4800,1700],[3000,1700,3000,2300],[4600,1700,4600,2300],[3700,2490,3700,2506]])
      w.ways.push({ id: w.nextId++, kind: 'taxi', a: { x: ax, y: ay }, b: { x: bx, y: by }, cls: 2, lanes: 0 });
  }),
  at(11, 300, () => { for (const x of w.ways) if (x.kind === 'taxi') x.cls = 3; }),
  at(12, 300, () => { w.zones.push({ id: w.nextId++, type: 'concourse', level: 1, x: 4300, y: 2900, w: 300, h: 80, tier: 0, cls: 2 }); w.ways.push({ id: w.nextId++, kind: 'taxi', a: { x: 4450, y: 2490 }, b: { x: 4450, y: 2821 }, cls: 2, lanes: 0 }); }),
];
for (let i = 0; i < 14; i++) {
  while (sim.day === i) {
    sim.step(0.25);
    for (const e of events) if (e.day === i && Math.abs(sim.t - e.min) < 0.13) { e.fn(); sim.relayout(); }
  }
  if (i === 9) console.log('after A380 build, std taxi:', sim.d.issues.filter(x => x.level !== 'info').map(x => x.text));
}
console.log(out.join('\\n'));
console.log('final issues:', sim.d.issues.map(x => x.text));
console.log('taxi letters:', sim.d.taxiLabels.map(l => l.text).join(' '), '| cores', sim.d.cores.length, '| crosswalks', sim.d.crosswalks.length);
`;
const dir = mkdtempSync(join(tmpdir(), 'stress-')); const out = join(dir, 'run.mjs');
await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' });
await import(out);
