// Piers and halls (v0.17, v0.18): concourses at any angle, and round or polygonal halls, that merge into the
// building they are drawn into.
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
const entry = `
import { Sim } from './src/sim';
import { sampleWorld } from './src/sample';
import { inZone } from './src/shapes';
const run = (name, edit, days = 2) => {
  const sim = new Sim(sampleWorld(), 7); const w = sim.world;
  edit(w, sim); sim.relayout(); sim.startDay();
  const d = sim.d; const turned = new Set(w.zones.filter(z => z.rot || z.sides).map(z => z.id));
  const per = w.zones.filter(z => z.type === 'concourse').map(z => (z.sides ? (z.sides >= 24 ? 'round hall' : z.sides + '-sided hall') : z.rot ? 'pier ' + Math.round(z.rot * 180 / Math.PI) + '°' : 'concourse') + ': ' + d.gates.filter(g => g.zone.id === z.id).length + ' gates, ' + (d.shops.get(z.id)?.length ?? 0) + ' lots').join(' | ');
  console.log(name + ':', d.terminals.map(t => t.name + (t.active ? ' open' : ' CLOSED (' + t.problems.join('; ') + ')') + ' · ' + t.gateAreas + ' concourses, ' + t.gates + ' gates').join(' | '),
    '|', per, '| people movers:', d.trainLinks.filter(l => l.apm).length);
  const pf = new Set(); let inPier = 0, outside = 0;
  sim.onDayEnd = r => { const s = r.stats;
    console.log('  ' + r.label, '| flights', s.flights, '(' + pf.size + ' at pier or hall gates)', 'pax', s.paxDep + s.paxArr, 'missed', s.missed, 'stranded', s.stranded, '| people seen in a pier or hall', inPier, '(outside any building on their level: ' + outside + ')', '| sat', r.sat.toFixed(0)); pf.clear(); inPier = 0; outside = 0; };
  let tick = 0;
  while (sim.day < days) {
    sim.step(0.25);
    for (const f of sim.flights) if (f.gate && turned.has(f.gate.zone.id)) pf.add(f.id);
    if (tick++ % 8 === 0) for (const p of sim.pax) if (p.level === 1 && !p.ride) {
      const z = d.zoneAt(p, 1); if (z && (z.rot || z.sides)) inPier++; else if (!z && !d.zones.some(q => q.level === 1 && inZone(p, q, 4))) outside++;
    }
  }
  return sim;
};
// a pier 400 m long and 50 m wide, turned 20 degrees, run into the east end of the concourse, with a taxiway each side
const pier = (w, cx, cy, len, wid, deg) => w.zones.push({ id: w.nextId++, type: 'concourse', level: 1, x: cx - len / 2, y: cy - wid / 2, w: len, h: wid, tier: 0, cls: 2, rot: deg * Math.PI / 180 });
const taxi = (w, ax, ay, bx, by) => w.ways.push({ id: w.nextId++, kind: 'taxi', a: { x: ax, y: ay }, b: { x: bx, y: by }, cls: 2, lanes: 0 });
const angled = w => {
  pier(w, 3568, 2718, 400, 50, 20);
  taxi(w, 3369, 2534, 3839, 2705); taxi(w, 3369, 2534, 3369, 2490);     // north side, joined to taxiway A
  taxi(w, 3438, 2782, 3767, 2902); taxi(w, 3767, 2902, 3900, 2800); taxi(w, 3900, 2800, 3839, 2705);   // south side, round the tip
};

run('sample', () => {}, 1);
run('angled pier merged into the concourse', angled, 3);

// the same pier with the main concourse's gates switched off: every flight uses the pier
run('pier only (main gates switched off)', (w, sim) => {
  angled(w); sim.relayout();
  const main = w.zones.find(z => z.type === 'concourse' && !z.rot); main.off = sim.d.gateSlots.filter(q => q.zone.id === main.id).map(q => q.key);
});

// v0.18: a round hall on the east end of the concourse, with the angled pier running out of the hall instead
const hall = (w, cx, cy, dia, sides, deg = 0) => w.zones.push({ id: w.nextId++, type: 'concourse', level: 1, x: cx - dia / 2, y: cy - dia / 2, w: dia, h: dia, tier: 0, cls: 2, sides, rot: deg ? deg * Math.PI / 180 : undefined });
const hub = (sides) => (w, sim) => {
  hall(w, 3470, 2660, 150, sides);
  pier(w, 3700, 2745, 400, 50, 20);
  taxi(w, 3501, 2561, 3971, 2732); taxi(w, 3501, 2561, 3501, 2490);
  taxi(w, 3570, 2809, 3899, 2929); taxi(w, 3899, 2929, 4032, 2827); taxi(w, 4032, 2827, 3971, 2732);
};
run('round hall joining the concourse and a pier', hub(32), 3);
run('the same with the main gates switched off', (w, sim) => {
  hub(32)(w, sim); sim.relayout();
  const main = w.zones.find(z => z.type === 'concourse' && !z.rot && !z.sides); main.off = sim.d.gateSlots.filter(q => q.zone.id === main.id).map(q => q.key);
});
run('hexagonal hall instead', hub(6));

// a pier standing apart at an angle is a satellite: it links by people mover
run('angled pier standing apart', w => {
  pier(w, 3968, 2718, 400, 50, 20);
  taxi(w, 3769, 2534, 4239, 2705); taxi(w, 3769, 2534, 3769, 2490);
});
`;
const dir = mkdtempSync(join(tmpdir(), 'piers-')); const out = join(dir, 'run.mjs');
await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' });
await import(out);
