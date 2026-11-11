// Halls and forecourts (v0.12): check-in stacked over baggage claim as one hall, and a hall that lays its own
// two-level frontage road to whatever road is near. Nothing here is drawn along a building face by hand.
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
const entry = `
import { Sim } from './src/sim';
import { sampleWorld } from './src/sample';
import { planTerminal, airsideOf } from './src/terminalplan';
const run = (name, edit, days = 2) => {
  const sim = new Sim(sampleWorld(), 7); const w = sim.world;
  edit(w, sim); sim.relayout(); sim.startDay();
  const d = sim.d; const fore = d.autoRoads.filter(r => r.fore);
  const curbs = d.zones.filter(z => z.auto).map(z => (z.level ? 'L1 ' : 'G ') + z.auto.deck).sort().join(', ') || 'none';
  console.log(name + ':', d.terminals.map(t => t.name + (t.active ? ' open' : ' CLOSED (' + t.problems.join('; ') + ')')).join(' | '),
    '| forecourt: ' + fore.filter(r => r.fore === 'face').length + ' frontage, ' + fore.filter(r => r.fore === 'link').length + ' links, ' + fore.filter(r => r.fore === 'ramp' && r.part === 'curve').length + ' ramps | curbs: ' + curbs + ' | decks ' + d.decks.length,
    '| issues:', d.issues.filter(i => i.level === 'error').map(i => i.text));
  let onRamp = 0, wrongRamp = 0; const seen = new Set(); const E = sim.d.road.edges;
  sim.onDayEnd = r => { const s = r.stats; console.log('  ' + r.label, '| flights', s.flights, 'pax', s.paxDep + s.paxArr, 'missed', s.missed, 'stranded', s.stranded, '| sat', r.sat.toFixed(0), '| cars up a ramp', onRamp, '(not for the deck: ' + wrongRamp + ')'); onRamp = 0; };
  while (sim.day < days) { sim.step(0.25); for (const c of sim.cars) if (!seen.has(c.id + c.stage)) { seen.add(c.id + c.stage); if (c.eids.some(e => e >= 0 && E[e] && sim.d.rampRefs.has(E[e].ref))) { onRamp++; if (c.curb?.zone.auto?.deck !== 'dep') wrongRamp++; } } }
  return sim;
};
const hall = (w, x, y, ww, h, site) => { const a = w.nextId++, b = w.nextId++; w.zones.push({ id: a, type: 'checkin', level: 1, x, y, w: ww, h, tier: 0, site, pair: b }, { id: b, type: 'claim', level: 0, x, y, w: ww, h, tier: 0, site, pair: a }); };

// the starter airport: only the approach roads, Terminal Drive and two roundabouts are drawn
run('sample (nothing drawn along the terminal)', () => {});

// a frontage road drawn by hand along the face takes over: the hall lays nothing
run('frontage road drawn by hand', w => {
  const R = (ax, ay, bx, by) => w.ways.push({ id: w.nextId++, kind: 'road', a: { x: ax, y: ay }, b: { x: bx, y: by }, cls: 0, lanes: 4 });
  R(2780, 2898, 3320, 2898); R(2780, 3230, 2780, 2898); R(3320, 2898, 3320, 3230);
});

// an older save: separate check-in and baggage claim modules, the claim reaching back under security
run('separate check-in and claim (older save)', w => {
  const site = w.sites[0].id;
  w.zones = w.zones.filter(z => z.type !== 'checkin' && z.type !== 'claim');
  w.zones.push({ id: w.nextId++, type: 'checkin', level: 1, x: 2880, y: 2810, w: 340, h: 60, tier: 0, units: 40, site });
  w.zones.push({ id: w.nextId++, type: 'claim', level: 0, x: 2950, y: 2650, w: 200, h: 220, tier: 0, units: 4, site });
});

// a road that stops short of the terminal, off to one side: the link comes straight out and turns once to meet it
run('road stops short, off to one side', w => {
  w.ways = w.ways.filter(q => !(q.kind === 'road' && q.a.y === q.b.y)); w.rounds = [];
  for (const q of w.ways) if (q.kind === 'road' && q.a.x === 2780) q.b.y = 3120;
  for (const q of w.ways) if (q.kind === 'road' && q.a.x === 3320) q.a.y = 3120;
  for (const q of w.ways) if (q.kind === 'road') { if (q.a.x === 2780) q.a.x = q.b.x = 2640; else if (q.a.x === 3320) q.a.x = q.b.x = 3460; }
});

// a second terminal out east with nothing but one road running east from the roundabout, 340 m south of it
run('second terminal beside a passing road', w => {
  const site = w.nextId++; w.sites.push({ id: site, x: 3680, y: 2600, w: 640, h: 300 });
  w.zones.push({ id: w.nextId++, type: 'concourse', level: 1, x: 3700, y: 2620, w: 600, h: 80, tier: 0, cls: 2, site });
  w.zones.push({ id: w.nextId++, type: 'security', level: 1, x: 3940, y: 2700, w: 120, h: 60, tier: 0, site });
  hall(w, 3830, 2760, 340, 100, site);
  w.ways.push({ id: w.nextId++, kind: 'road', a: { x: 3320, y: 3230 }, b: { x: 4500, y: 3230 }, cls: 0, lanes: 2 });
}, 3);

// v0.15, a terminal in one drag: on bare ground with a runway and a taxiway, a site's starter layout (concourse on
// the edge facing the taxiway, security, the hall) plus two roads is a working airport
run('terminal laid out from one rectangle', (w, sim) => {
  w.zones = []; w.sites = []; w.rounds = []; w.ways = w.ways.filter(q => q.kind === 'taxi');
  const site = { id: w.nextId++, x: 2780, y: 2600, w: 540, h: 290 }; w.sites.push(site);
  const air = airsideOf(site, w); const parts = planTerminal(site, air); const ids = parts.map(() => w.nextId++);
  parts.forEach((q, i) => w.zones.push({ id: ids[i], type: q.type, level: q.level, ...q.rect, tier: 0, site: site.id, cls: q.type === 'concourse' ? 2 : undefined,
    pair: q.type === 'checkin' ? ids[parts.findIndex(o => o.type === 'claim')] : q.type === 'claim' ? ids[parts.findIndex(o => o.type === 'checkin')] : undefined, units: q.type === 'checkin' ? 48 : undefined }));
  console.log('  airside edge:', air, '| parts:', parts.map(q => q.type + ' ' + q.rect.w + 'x' + q.rect.h).join(', '));
  const R = (ax, ay, bx, by) => w.ways.push({ id: w.nextId++, kind: 'road', a: { x: ax, y: ay }, b: { x: bx, y: by }, cls: 0, lanes: 2 });
  R(2600, 5700, 2600, 3200); R(2600, 3200, 3500, 3200);
});

// a hall with no road anywhere near: no forecourt, and the design check says so
run('hall with no road in reach', w => { w.ways = w.ways.filter(q => q.kind !== 'road'); w.rounds = []; }, 0);
`;
const dir = mkdtempSync(join(tmpdir(), 'halls-')); const out = join(dir, 'run.mjs');
await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' });
await import(out);
