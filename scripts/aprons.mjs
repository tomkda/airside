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
const inPoly = (p, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) c = !c; } return c; };
const pier = (w, cx, cy, len, wid, deg) => conc(w, cx - len / 2, cy - wid / 2, len, wid, { rot: deg * Math.PI / 180 });
const runway = w => w.runways.push({ id: w.nextId++, a: { x: 1900, y: 2300 }, b: { x: 4500, y: 2300 } });

{ const r = rep('sample', sampleWorld());
  // v0.27: the deck's ramps peel off the approach roads as a lane and widen as they climb
  const dk = r.d.decks[0]; const n = dk.pts.length;
  const links = r.d.autoRoads.filter(w => w.fore === 'link'); const offLink = p => Math.min(...links.map(w => { const dx = w.b.x - w.a.x, dy = w.b.y - w.a.y, L = Math.hypot(dx, dy); return Math.abs((p.x - w.a.x) * dy - (p.y - w.a.y) * dx) / L; }));
  const linkX = [offLink(dk.pts[0]), offLink(dk.pts[n - 1])];
  check('each ramp leaves its approach road one lane wide, off the centreline (' + dk.ws[0].toFixed(1) + ' m wide, ' + linkX[0].toFixed(1) + ' m off)', r.d.decks.length === 1 && Math.abs(dk.ws[0] - 3.8) < 0.01 && Math.abs(dk.ws[n - 1] - 3.8) < 0.01 && Math.min(...linkX) > 3 && Math.min(...linkX) < 7 && dk.zs[0] === 0 && dk.zs[n - 1] === 0);
  const top = dk.zs.indexOf(1); check('it widens as it climbs and is as wide as the deck where it lands', top > 5 && dk.ws.slice(0, top + 1).every((w, i, a) => !i || w >= a[i - 1] - 1e-9) && Math.abs(dk.ws[top] - dk.width) < 0.01);
  check('a one-piece building has no junction spaces', r.d.junctions.length === 0 && ![...r.d.shops.values()].flat().some(sh => sh.plaza));
  check('the sample gains an end stand each side', r.d.gates.length === 14 && r.reach === 14);
  check('no stands on the landside face', !Object.keys(r.by).some(k => k.includes(':s')));
  check('the landside face is marked', r.d.gateGuides.some(g => g.side === 's' && g.land)); }
{ const w = sampleWorld(); const z = pier(w, 3568, 2718, 400, 50, 20); const r = rep('a 20° pier drawn into the concourse, no taxiway drawn', w);
  const mine = r.d.gates.filter(g => g.zone.id === z.id);
  check('the pier has stands on both long sides and its end', mine.length >= 14 && mine.every(g => g.apron.self));
  check('every pier gate reaches a runway', mine.every(g => g.rwys[0].size > 0));
  // v0.24: the pier and the concourse are one building, and its stands are laid along the one outline
  const sl = r.d.gateSlots; let near = Infinity;
  for (let i = 0; i < sl.length; i++) for (let j = i + 1; j < sl.length; j++) near = Math.min(near, Math.hypot(sl[i].stand.x - sl[j].stand.x, sl[i].stand.y - sl[j].stand.y));
  check('no two stands of the merged building share ground (nearest pair ' + near.toFixed(0) + ' m apart)', near >= 30);
  // v0.25: where the pier runs into the concourse the building keeps a space for itself, and no lot stands in it
  const js = r.d.junctions, ins = (p, j) => j.rings.reduce((n, q) => n + (inPoly(p, q) ? 1 : 0), 0) % 2 === 1;
  const lots = [...r.d.shops.values()].flat().map(sh => ({ x: sh.pts.reduce((n, q) => n + q.x, 0) / sh.pts.length, y: sh.pts.reduce((n, q) => n + q.y, 0) / sh.pts.length }));
  check('the merged building keeps a junction space (' + js.map(j => j.kind + ' ' + Math.round(j.area) + ' m2').join(', ') + ')', js.length >= 1 && js.every(j => j.seeds.length > 0));
  check('no shop lot stands in a junction space', lots.length > 20 && !lots.some(c => js.some(j => ins(c, j))));
  // v0.26: the pieces' own fit-out stops at the space, and the lots round it front it
  const its = [...r.d.frames.entries()].filter(([id]) => r.d.zones.find(q => q.id === id)?.type === 'concourse').flatMap(([, f]) => f.items);
  const mid = q => ({ x: q.reduce((n, v) => n + v.x, 0) / q.length, y: q.reduce((n, v) => n + v.y, 0) / q.length });
  check('no holdroom seat, counter or restroom stands in a junction space', its.length > 50 && !its.filter(it => it.closed || (it.k !== 'spine' && it.k !== 'lane')).some(it => js.some(j => ins(mid(it.pts), j))));
  check('the spine breaks off at the space and starts again beyond it', !its.filter(it => it.k === 'spine' || it.k === 'lane').some(it => it.pts.some((q, i) => i + 1 < it.pts.length && js.some(j => ins({ x: (q.x + it.pts[i + 1].x) / 2, y: (q.y + it.pts[i + 1].y) / 2 }, j)))));
  const fronting = [...r.d.shops.values()].flat().filter(sh => sh.plaza);
  check('lots round the space front it (' + fronting.length + ': ' + [...new Set(fronting.map(sh => sh.plaza))].join(', ') + ')', fronting.length >= 2 && fronting.length < lots.length / 3);
  check('every gate of the merged building has its own name', new Set(sl.map(q => q.zone.id + ':' + q.key)).size === sl.length && new Set(r.d.gates.map(g => g.id)).size === r.d.gates.length); }
{ const w = sampleWorld(); const z = pier(w, 3568, 2718, 400, 40, 20); const r = rep('a 40 m pier (too narrow for a stand on its end)', w);
  const mine = r.d.gates.filter(g => g.zone.id === z.id);
  check('its two taxilanes meet round the end, so both sides reach a runway', mine.length >= 14 && mine.every(g => g.rwys[0].size > 0)); }
{ const w = newWorld(); runway(w); const z = conc(w, 2800, 2700, 700, 50, { cls: 3 }); const r = rep('a runway and a 50 m A380 concourse', w);
  check('the side away from the runway reaches it too', r.d.gates.length >= 14 && r.reach === r.d.gates.length); }
{ const w = newWorld(); runway(w); for (let i = 0; i < 12; i++) conc(w, 1700 + (i % 6) * 480, 2700 + Math.floor(i / 6) * 420, 300, 60);
  const r = rep('twelve satellites in two rows', w);
  check('every one finds a way out, however many there are', r.reach === r.d.gates.length); }
{ const w = sampleWorld(); pier(w, 3568, 2718, 400, 50, 20); w.zones.push({ id: w.nextId++, type: 'parking', level: 0, x: 3780, y: 2950, w: 200, h: 120, tier: 0 });
  const r = rep('a car park beside the pier', w);
  const walks = r.d.autoWalks.flatMap(x => [[x.a, x.b]]);
  check('no generated taxilane crosses a sidewalk or drive a lot laid for itself', !r.d.airExtra.some(l => [...r.d.autoWalks, ...r.d.autoRoads].some(x => segsIntersect(l.a, l.b, x.a, x.b)))); }
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
  const main = sim.world.zones.find(q => q.type === 'concourse' && q !== z); sim.relayout(); main.off = sim.d.gateSlots.filter(q => q.zone.id === main.id).map(q => q.key);   // every stand of the main concourse, whatever it is called
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
  const wide = { x: 1000, y: 1000, w: 300, h: 150 };
  const g6 = regrip(wide, 's', { x: 1150, y: 1156 }, true, lim);
  check('a limit never shrinks what is already built', g6.h >= 150);
  const up = { x: 1000, y: 1000, w: 200, h: 60 };
  const g3 = regrip(up, 'e', { x: 1300, y: 1010 }, false, lim);
  check('an upright module resizes by its edge', g3.x === 1000 && g3.w === 300 && g3.h === 60 && !g3.rot);
  const hub = { x: 0, y: 0, w: 200, h: 200, sides: 6, rot: 1e-4 };
  const g4 = regrip(hub, 'r', { x: 100 + 150, y: 100 }, false, lim);
  check('a hub resizes about its centre', g4.w === 300 && g4.x === -50 && g4.y === -50);
  const tall = { x: 1000, y: 1000, w: 50, h: 300, off: ['e2'] };
  const g5 = regrip(tall, 'b', { x: 1025 + 200, y: 1000 + 200 }, true, lim);
  check('an upright satellite swung off the grid keeps its switched-off gate on the same wall', !!g5.rot && g5.off[0] === 'n2'); }
// v0.25: four concourses round a square: the hole in the middle is a courtyard, and each corner a space of the building's own
{ const w = newWorld(); runway(w);
  conc(w, 3000, 2700, 400, 50); conc(w, 3000, 3000, 400, 50); conc(w, 3000, 2700, 50, 350); conc(w, 3350, 2700, 50, 350);
  const r = rep('four concourses round a courtyard', w); const js = r.d.junctions;
  check('the enclosed square is one courtyard with trees', js.filter(j => j.kind === 'court').length === 1 && js.find(j => j.kind === 'court').seeds.every(t => t.t === 'tree') && js.find(j => j.kind === 'court').area > 50000);
  check('each corner where two concourses cross is a space of its own', js.filter(j => j.kind !== 'court' && j.ids.length === 2).length === 4);
  check('no stand is laid in the courtyard', !r.d.gateSlots.some(q => inPoly(q.stand, js.find(j => j.kind === 'court').outer))); }
{ const w = newWorld(); runway(w); conc(w, 3000, 2700, 400, 50); conc(w, 3300, 2700, 400, 50);
  const r = rep('a concourse lengthened by drawing over its end', w);
  check('one piece drawn along another is more concourse, not a hall', r.d.junctions.length === 0); }
{ const w = newWorld(); runway(w);
  // two legs of a path meeting at (3400, 2800), with the round hall the Pier tool puts on the corner
  conc(w, 3000, 2780, 400, 40); conc(w, 3400 - 200, 2800 - 20 + 200, 400, 40, { rot: Math.PI / 2 }); conc(w, 3360, 2760, 80, 80, { sides: 32 });
  const r = rep('two legs and their corner hall', w);
  check('the corner hall keeps its own middle: no junction space is laid over it', !r.d.junctions.some(j => Math.hypot(j.c.x - 3400, j.c.y - 2800) < 30 && j.kind !== 'garden')); }
{ const w = newWorld(); runway(w); conc(w, 3000, 2700, 500, 50); conc(w, 3100, 2700, 40, 300); conc(w, 3160, 2700, 40, 300);
  const r = rep('two fingers 20 m apart off one concourse', w); const js = r.d.junctions;
  check('each finger has its own junction space, not one strip between them (' + js.map(j => j.kind + ' ' + Math.round(j.area)).join(', ') + ')', js.filter(j => j.ids.length === 2).length === 2 && !js.some(j => j.ids.length > 2)); }
console.log(bad ? bad + ' CHECK(S) FAILED' : 'all checks passed');
if (bad) process.exit(1);
`;
const dir = mkdtempSync(join(tmpdir(), 'aprons-'));
const out = join(dir, 'run.mjs');
await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' });
await import(out);
