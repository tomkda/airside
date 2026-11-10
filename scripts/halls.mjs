// Halls and forecourts (v0.12): check-in stacked over baggage claim as one hall, and a hall that lays its own
// two-level frontage road to whatever road is near. Nothing here is drawn along a building face by hand.
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
const entry = `
import { Sim } from './src/sim';
import { sampleWorld } from './src/sample';
const run = (name, edit, days = 2) => {
  const sim = new Sim(sampleWorld(), 7); const w = sim.world;
  edit(w, sim); sim.relayout(); sim.startDay();
  const d = sim.d; const fore = d.autoRoads.filter(r => r.fore);
  const curbs = d.zones.filter(z => z.auto).map(z => (z.level ? 'L1 ' : 'G ') + z.auto.deck).sort().join(', ') || 'none';
  console.log(name + ':', d.terminals.map(t => t.name + (t.active ? ' open' : ' CLOSED (' + t.problems.join('; ') + ')')).join(' | '),
    '| forecourt: ' + fore.filter(r => r.fore === 'face').length + ' frontage, ' + fore.filter(r => r.fore === 'link').length + ' links, ' + fore.filter(r => r.fore === 'ramp').length + ' ramps | curbs: ' + curbs + ' | decks ' + d.decks.length,
    '| issues:', d.issues.filter(i => i.level === 'error').map(i => i.text));
  let onRamp = 0, wrongRamp = 0; const seen = new Set(); const E = sim.d.road.edges;
  sim.onDayEnd = r => { const s = r.stats; console.log('  ' + r.label, '| flights', s.flights, 'pax', s.paxDep + s.paxArr, 'missed', s.missed, 'stranded', s.stranded, '| sat', r.sat.toFixed(0), '| cars up a ramp', onRamp, '(not for the deck: ' + wrongRamp + ')'); onRamp = 0; };
  while (sim.day < days) { sim.step(0.25); for (const c of sim.cars) if (!seen.has(c.id + c.stage)) { seen.add(c.id + c.stage); if (c.eids.some(e => e >= 0 && E[e] && sim.d.rampRefs.has(E[e].ref))) { onRamp++; if (c.curb?.zone.auto?.deck !== 'dep') wrongRamp++; } } }
  return sim;
};
const noFrontage = w => { w.ways = w.ways.filter(q => !(q.kind === 'road' && q.a.y === q.b.y && q.a.y < 2960)); };
const hall = (w, x, y, ww, h, site) => { const a = w.nextId++, b = w.nextId++; w.zones.push({ id: a, type: 'checkin', level: 1, x, y, w: ww, h, tier: 0, site, pair: b }, { id: b, type: 'claim', level: 0, x, y, w: ww, h, tier: 0, site, pair: a }); };

run('sample (frontage drawn by hand)', () => {}, 1);

// take away the roads along the terminal face: the hall should lay its own forecourt down to the approach roads
run('sample, no frontage road', noFrontage);

// the sample's separate check-in and claim replaced by one stacked hall, again with no frontage road
run('stacked hall, no frontage road', w => {
  noFrontage(w); const site = w.sites[0].id;
  w.zones = w.zones.filter(z => z.type !== 'checkin' && z.type !== 'claim');
  hall(w, 2880, 2740, 340, 130, site);
});

// a second terminal out east with nothing but one road passing 150 m south of it
run('second terminal beside a passing road', w => {
  const site = w.nextId++; w.sites.push({ id: site, x: 3680, y: 2600, w: 640, h: 300 });
  w.zones.push({ id: w.nextId++, type: 'concourse', level: 1, x: 3700, y: 2620, w: 600, h: 80, tier: 0, cls: 2, site });
  w.zones.push({ id: w.nextId++, type: 'security', level: 1, x: 3940, y: 2700, w: 120, h: 60, tier: 0, site });
  hall(w, 3830, 2760, 340, 100, site);
  w.ways.push({ id: w.nextId++, kind: 'road', a: { x: 3320, y: 3020 }, b: { x: 4500, y: 3020 }, cls: 0, lanes: 2 });
}, 3);

// a hall with no road anywhere near: no forecourt, and the design check says so
run('hall with no road in reach', w => { w.ways = w.ways.filter(q => q.kind !== 'road'); w.rounds = []; }, 0);
`;
const dir = mkdtempSync(join(tmpdir(), 'halls-')); const out = join(dir, 'run.mjs');
await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' });
await import(out);
