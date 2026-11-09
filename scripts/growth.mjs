// Growth: every v0.10 facility on the sample airport. Each should connect itself (drive and sidewalk), work,
// and show up in the day's numbers; passport control should bring international flights.
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
const entry = `
import { Sim } from './src/sim';
import { sampleWorld } from './src/sample';
const sim = new Sim(sampleWorld(), 7); const w = sim.world; const site = w.sites[0].id;
sim.moneyOn = false;   // sandbox: everything unlocked
const Z = (type, level, x, y, ww, h, extra = {}) => { const z = { id: w.nextId++, type, level, x, y, w: ww, h, tier: 0, ...extra }; w.zones.push(z); return z; };
const line = () => { const s = sim.stats; return 'served ' + [...sim.d.served].length + ' | drives ' + sim.d.autoRoads.length + ' walks ' + sim.d.autoWalks.length + ' | train links ' + sim.d.trainLinks.length + ' | boost ' + sim.accessBoost().toFixed(2); };
console.log('base:', line(), '| demand', Math.round(sim.demandAt(sim.slotPrice).reduce((a, q) => a + q.n, 0)));
Z('bus', 0, 2800, 2960, 60, 20);
Z('rideshare', 0, 3340, 2905, 80, 40);
Z('rental', 0, 3360, 3010, 120, 80);
Z('hotel', 0, 2640, 2960, 60, 40);
w.zones.find(z => z.type === 'parking').floors = 3;
// a remote garage, too far to walk: two AirTrain stations bring it in
const far = Z('parking', 0, 3400, 3600, 200, 120, { floors: 4 });
Z('train', 0, 3400, 3560, 40, 16); Z('train', 0, 3230, 2905, 40, 16);
// passport control on the ground floor between the concourse cores and claim
Z('passport', 0, 3150, 2650, 100, 60, { site });
sim.staff.officers = 10; sim.staff.screeners = 24; sim.staff.agents = 20;
sim.relayout(); sim.startDay();
console.log('built:', line(), '| demand', Math.round(sim.demandAt(sim.slotPrice).reduce((a, q) => a + q.n, 0)));
console.log('terminal intl:', sim.d.terminals[0].intl, '| far garage served:', sim.d.served.has(far.id), '| issues:', sim.d.issues.filter(i => i.level !== 'info').map(i => i.text));
let ride = 0; const st = sim.step.bind(sim);
sim.onDayEnd = r => { const s = r.stats; const au = r.plan.byAirline.find(b => b.airline.iata === 'AU');
  console.log(r.label, '| flights', s.flights, 'intl', au ? au.scheduled + '/' + au.requested : '-', '| pax', s.paxDep, 'missed', s.missed, 'stranded', s.stranded,
    '| passport wait', s.waits.passport.n ? (s.waits.passport.sum / s.waits.passport.n).toFixed(1) + '/' + s.waits.passport.max.toFixed(0) + ' n=' + s.waits.passport.n : '-',
    '| hotel $', Math.round(s.rev.hotel), 'rental $', Math.round(s.rev.rental), 'rideshare $', Math.round(s.rev.rideshare), '| sat', r.sat.toFixed(0), '| rode AirTrain', ride); ride = 0; };
while (sim.day < 3) { sim.step(0.25); for (const p of sim.pax) if (p.ride && !p._r) { p._r = 1; ride++; } }
`;
const dir = mkdtempSync(join(tmpdir(), 'growth-')); const out = join(dir, 'run.mjs');
await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' });
await import(out);
