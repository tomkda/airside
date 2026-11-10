// Satellites (v0.16): a concourse that touches no terminal links itself to the nearest one by people mover.
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
const entry = `
import { Sim } from './src/sim';
import { sampleWorld } from './src/sample';
const run = (name, edit, days = 2) => {
  const sim = new Sim(sampleWorld(), 7); const w = sim.world;
  edit(w, sim); sim.relayout(); sim.startDay();
  const d = sim.d; const mv = d.trainLinks.filter(l => l.apm);
  console.log(name + ':', d.terminals.map(t => t.name + (t.active ? ' open' : ' CLOSED (' + t.problems.join('; ') + ')') + ' · ' + t.gateAreas + ' concourses, ' + t.gates + ' gates').join(' | '),
    '| people movers: ' + (mv.map(l => Math.round(Math.hypot(l.a.x - l.b.x, l.a.y - l.b.y)) + ' m').join(', ') || 'none'));
  let rode = 0; const seen = new Set(); const satF = new Set(); const sat = new Set(mv.map(l => l.from));
  sim.onDayEnd = r => { const s = r.stats; const atSat = satF.size; satF.clear();
    console.log('  ' + r.label, '| flights', s.flights, '(' + atSat + ' at satellite gates)', 'pax', s.paxDep + s.paxArr, 'missed', s.missed, 'stranded', s.stranded, '| rode the mover', rode, '| sat', r.sat.toFixed(0)); rode = 0; };
  while (sim.day < days) { sim.step(0.25); for (const f of sim.flights) if (f.gate && sat.has(f.gate.zone.id)) satF.add(f.id); for (const p of sim.pax) if (p.ride && !seen.has(p)) { seen.add(p); rode++; } }
  return sim;
};
const conc = (w, x, y, ww, h) => w.zones.push({ id: w.nextId++, type: 'concourse', level: 1, x, y, w: ww, h, tier: 0, cls: 2 });

run('sample', () => {}, 1);

// one satellite 500 m east along the same taxiway
// (v0.19: the satellite lays stands on every side, so the schedule grows to 30 flights by week 3; a few more
//  check-in agents and screeners are hired for them, as a player would, so the result is about the satellite)
run('one satellite', (w, sim) => { conc(w, 3900, 2620, 400, 60); sim.staff.agents += 4; sim.staff.screeners += 2; }, 3);

// a chain: a second satellite beyond the first links to the first, not all the way back
run('two satellites in a line', w => { conc(w, 3520, 2620, 300, 60); conc(w, 3980, 2620, 400, 60); }, 3);

// every gate on the main concourse switched off: all flights use the satellite, and every passenger rides
run('satellite only (main gates switched off)', (w, sim) => {
  conc(w, 3900, 2620, 400, 60); sim.relayout();
  const main = w.zones.find(z => z.type === 'concourse'); main.off = sim.d.gateSlots.filter(q => q.zone.id === main.id).map(q => q.key);
}, 2);

// too far for a people mover: stays a closed terminal of its own, and the design check says how to fix it
run('satellite out of reach', w => { conc(w, 600, 600, 400, 60); }, 0);
`;
const dir = mkdtempSync(join(tmpdir(), 'sat-')); const out = join(dir, 'run.mjs');
await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' });
await import(out);
