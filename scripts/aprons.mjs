// Self-laid aprons and reshaping (v0.19): a concourse face with no taxiway alongside lays its own stands, taxilane
// and link to the airfield; and a built shape is stretched, swung and resized by its grips.
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
const entry = `
import { derive, newWorld, canPlaceWay } from './src/world';
import { sampleWorld } from './src/sample';
import { Sim } from './src/sim';
import { regrip, gripsOf, toWorld } from './src/shapes';
import { segsIntersect } from './src/geom';
let bad = 0;
const check = (what, ok) => { if (!ok) { bad++; console.log('   FAIL: ' + what); } };
const rep = (name, w) => {
  const d = derive(w);
  const by = {}; for (const g of d.gates) { const k = g.zone.id + ':' + g.key.replace(/[0-9]+$/, '') + (g.apron.self ? '*' : ''); by[k] = (by[k] || 0) + 1; }
  const reach = d.gates.filter(g => g.rwys[0].size > 0).length;
  const sides = Object.entries(by).map(([k, n]) => k + ' ' + n).join(', ');
  console.log(name + ':', d.gates.length, 'gates,', reach, 'reach a runway |', d.aprons.filter(a => a.self).length, 'self-laid aprons,', d.airExtra.length, 'generated taxilane pieces |', d.terminals.map(t => t.name + (t.active ? ' open' : ' closed')).join(', '));
  console.log('   by side (* = self-laid):', sides);
  return { d, by, reach };
};
const conc = (w, x, y, ww, h, extra = {}) => { const z = { id: w.nextId++, type: 'concourse', level: 1, x, y, w: ww, h, tier: 0, cls: 2, ...extra }; w.zones.push(z); return z; };
const pier = (w, cx, cy, len, wid, deg) => conc(w, cx - len / 2, cy - wid / 2, len, wid, { rot: deg * Math.PI / 180 });
const runway = w => w.runways.push({ id: w.nextId++, a: { x: 1900, y: 2300 }, b: { x: 4500, y: 2300 } });

{ const r = rep('sample', sampleWorld());
  check('the sample gains an end stand each side', r.d.gates.length === 14 && r.reach === 14);
  check('no stands on the landside face', !Object.keys(r.by).some(k => k.includes(':s')));
  check('the landside face is marked', r.d.gateGuides.some(g => g.side === 's' && g.land)); }
{ const w = sampleWorld(); const z = pier(w, 3568, 2718, 400, 50, 20); const r = rep('a 20° pier drawn into the concourse, no taxiway drawn', w);
  const mine = r.d.gates.filter(g => g.zone.id === z.id);
  check('the pier has stands on both long sides and its end', mine.length >= 14 && mine.every(g => g.apron.self));
  check('every pier gate reaches a runway', mine.every(g => g.rwys[0].size > 0)); }
{ const w = sampleWorld(); const z = conc(w, 2900, 1800, 400, 50); const r = rep('a satellite north of the runway', w);
  const mine = r.d.gates.filter(g => g.zone.id === z.id);
  check('stands on all four sides', ['n', 'e', 's', 'w'].every(s => mine.some(g => g.key[0] === s)));
  check('all reach a runway', mine.every(g => g.rwys[0].size > 0));
  check('paved corners where the aprons meet', r.d.pads.length >= 4); }
{ const w = sampleWorld(); const z = conc(w, 3500, 2700, 200, 200, { sides: 32 }); const r = rep('a round hub', w);
  const mine = r.d.gates.filter(g => g.zone.id === z.id);
  check('twelve stands round it, nose in', mine.length === 12);
  check('a ring taxilane linked to the airfield', mine.every(g => g.rwys[0].size > 0)); }
{ const w = sampleWorld(); const z = conc(w, 3500, 2700, 240, 240, { sides: 6 }); const r = rep('a hexagonal hub', w);
  check('two stands a facet', r.d.gates.filter(g => g.zone.id === z.id).length === 12 && r.reach === r.d.gates.length); }
{ const w = newWorld(); runway(w); conc(w, 2800, 2620, 600, 60); const r = rep('a runway and a concourse, nothing else', w);
  check('stands on every side, linked straight to the runway', r.d.gates.length === 26 && r.reach === 26); }
{ const w = newWorld(); runway(w); conc(w, 2800, 2900, 300, 300, { sides: 32 }); const r = rep('a hub 500 m from the runway (out of reach)', w);
  check('stands but no way out, said once', r.d.gates.length === 12 && r.reach === 0 && r.d.issues.filter(i => /no clear way/.test(i.text)).length === 1); }
{ const w = sampleWorld(); const z = pier(w, 3568, 2718, 400, 50, 20); const before = derive(w).gates.filter(g => g.zone.id === z.id).length;
  w.ways.push({ id: w.nextId++, kind: 'road', a: { x: 3700, y: 2760 }, b: { x: 3700, y: 3100 }, cls: 0, lanes: 2 });
  const r = rep('the same pier with a road drawn up to its south side', w);
  const road = w.ways[w.ways.length - 1];
  check('stands give way to the road', r.d.gates.filter(g => g.zone.id === z.id).length < before);
  check('no generated taxilane crosses it', !r.d.airExtra.some(l => segsIntersect(l.a, l.b, road.a, road.b)));
  check('a road may be drawn across a self-laid apron', canPlaceWay(w, 'road', { x: 3600, y: 2800 }, { x: 3600, y: 3000 }, derive(w).aprons).ok); }
{ const w = sampleWorld(); w.ways.push({ id: w.nextId++, kind: 'taxi', a: { x: 3480, y: 2490 }, b: { x: 3480, y: 2760 }, cls: 2, lanes: 0 });
  const r = rep('a taxiway drawn along the east end', w);
  check('the drawn taxiway takes over that side', r.by['9:e'] === 1 && !r.by['9:e*']); }
{ // two days of flying from a pier nobody drew a taxiway to
  const sim = new Sim(sampleWorld(), 7); const z = pier(sim.world, 3568, 2718, 400, 50, 20);
  // the main concourse's own gates are switched off, so every flight has to use the pier
  const main = sim.world.zones.find(q => q.type === 'concourse' && q !== z); main.off = [...Array(12).keys()].map(i => 'n' + i).concat(['e0', 'w0']);
  sim.relayout(); sim.startDay();
  const used = new Set(); let st = null;
  sim.onDayEnd = r => { st = r.stats; console.log('flying:', r.label, '| flights', st.flights, '(' + used.size + ' at the pier\\'s self-laid gates)', 'missed', st.missed, 'stranded', st.stranded, 'cancelled', st.cancelled); };
  while (sim.day < 2) { sim.step(0.25); for (const f of sim.flights) if (f.gate && f.gate.zone.id === z.id) used.add(f.id); }
  check('every flight uses the self-laid gates', used.size >= st.flights && st.flights > 10);
  check('nobody missed or stranded', st && st.missed === 0 && st.stranded === 0); }
{ // grips
  const lim = { minLen: 60, minWide: 30, maxWide: 120, minDia: 60, maxDia: 400, snapDeg: 5 };
  const z0 = { x: 3368, y: 2693, w: 400, h: 50, rot: 20 * Math.PI / 180 };
  const west = gripsOf(z0, true).find(g => g.grip === 'a').p;
  const g1 = regrip(z0, 'b', { x: west.x + 300, y: west.y - 300 }, true, lim);
  const west1 = gripsOf(g1, true).find(g => g.grip === 'a').p;
  console.log('grips: a 400 m pier at 20° swung by its east end →', Math.round(g1.w) + ' m at ' + Math.round(g1.rot * 180 / Math.PI) + '°, far end moved', Math.hypot(west1.x - west.x, west1.y - west.y).toFixed(2), 'm');
  check('the far end stays where it is', Math.hypot(west1.x - west.x, west1.y - west.y) < 0.01);
  check('length and angle follow the cursor', Math.abs(g1.w - 425) < 3 && Math.abs(g1.rot * 180 / Math.PI + 45) < 0.5);
  const n0 = gripsOf(z0, true).find(g => g.grip === 'n').p; const s0 = gripsOf(z0, true).find(g => g.grip === 's').p;
  const g2 = regrip(z0, 's', { x: s0.x + (s0.x - n0.x), y: s0.y + (s0.y - n0.y) }, true, lim);
  const n2 = gripsOf(g2, true).find(g => g.grip === 'n').p;
  check('widening keeps the opposite side', g2.h === 100 && Math.hypot(n2.x - n0.x, n2.y - n0.y) < 0.01);
  const up = { x: 1000, y: 1000, w: 200, h: 60 };
  const g3 = regrip(up, 'e', { x: 1300, y: 1010 }, false, lim);
  check('an upright module resizes by its edge', g3.x === 1000 && g3.w === 300 && g3.h === 60 && !g3.rot);
  const hub = { x: 0, y: 0, w: 200, h: 200, sides: 6, rot: 1e-4 };
  const g4 = regrip(hub, 'r', { x: 100 + 150, y: 100 }, false, lim);
  check('a hub resizes about its centre', g4.w === 300 && g4.x === -50 && g4.y === -50);
  const tall = { x: 1000, y: 1000, w: 50, h: 300, off: ['e2'] };
  const g5 = regrip(tall, 'b', { x: 1025 + 200, y: 1000 + 200 }, true, lim);
  check('an upright satellite swung off the grid keeps its switched-off gate on the same wall', !!g5.rot && g5.off[0] === 'n2'); }
console.log(bad ? bad + ' CHECK(S) FAILED' : 'all checks passed');
if (bad) process.exit(1);
`;
const dir = mkdtempSync(join(tmpdir(), 'aprons-'));
const out = join(dir, 'run.mjs');
await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' });
await import(out);
