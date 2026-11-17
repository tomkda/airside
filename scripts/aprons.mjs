// Self-laid aprons and reshaping (v0.19): a concourse face with no taxiway alongside lays its own stands, taxilane
// and link to the airfield; and a built shape is stretched, swung and resized by its grips.
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
const entry = `
import { derive, newWorld, canPlaceWay, canPlaceTurned, gripsFor, canPlacePier, migrateWorld } from './src/world';
import { zonePts, zonesOverlap, inZone, centreOf, frameOf } from './src/shapes';
import { facesOf } from './src/frontage';
import { shellsOf } from './src/shell';
import { sampleWorld } from './src/sample';
import { Sim } from './src/sim';
import { regrip, gripsOf, toWorld } from './src/shapes';
import { segsIntersect } from './src/geom';
import { wayPts } from './src/ways';
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
const cen4 = q => ({ x: (q[0].x + q[2].x) / 2, y: (q[0].y + q[2].y) / 2 });
const pier = (w, cx, cy, len, wid, deg) => conc(w, cx - len / 2, cy - wid / 2, len, wid, { rot: deg * Math.PI / 180 });
const runway = w => w.runways.push({ id: w.nextId++, a: { x: 1900, y: 2300 }, b: { x: 4500, y: 2300 } });

{ const r = rep('sample', sampleWorld());
  // v0.28: each deck ramp meets its approach road as a built ramp does: beside it, never on top of it
  const dk = r.d.decks[0]; const links = r.d.autoRoads.filter(w => w.fore === 'link');
  const offLink = p => Math.min(...links.map(w => { const dx = w.b.x - w.a.x, dy = w.b.y - w.a.y, L = Math.hypot(dx, dy), t = ((p.x - w.a.x) * dx + (p.y - w.a.y) * dy) / (L * L); return t < -0.02 || t > 1.02 ? Infinity : Math.abs((p.x - w.a.x) * dy - (p.y - w.a.y) * dx) / L; }));
  const near = dk.pts.map((p, i) => ({ p, w: dk.ws[i], z: dk.zs[i], off: offLink(p) })).filter(q => q.off < 40);
  check('no part of a ramp lies on its approach road (closest ' + Math.min(...near.map(q => q.off - q.w / 2)).toFixed(2) + ' m from the centreline, the road is 8 m each side)', near.length > 20 && near.every(q => q.off - q.w / 2 >= 7.99));
  check('a ramp stays at grade until it is 2 m clear of the road', near.every(q => q.z === 0 || q.off - q.w / 2 - 8 >= 1.99));
  const rps = r.d.autoRoads.filter(w => w.fore === 'ramp'); const geo = rps.filter(w => w.rg).map(w => w.rg);
  const len = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  check('each ramp is a taper, a speed-change lane and a curve, one-way', geo.length === 2 && rps.length === 8 && rps.every(w => w.oneway) && geo.every(g => len(g.T, g.P) >= 30 && len(g.P, g.N) >= 30));
  check('one goes up, from the right of traffic coming in; the other comes down, onto the right of traffic going out', geo.filter(g => g.up).length === 1 && geo.every(g => (g.u.y * g.n.x - g.u.x * g.n.y > 0) === g.up));
  check('the taper starts on the approach road and the lane runs alongside it', geo.every(g => offLink(g.T) < 0.01 && Math.abs(offLink(g.P) - 9.9) < 0.01 && Math.abs(offLink(g.N) - 9.9) < 0.01));
  check('each ramp has a painted gore and a broken line along its lane', dk.gores.length === 2 && dk.seams.length === 2 && dk.arrows.length === 4);
  const top = dk.zs.indexOf(1); check('it widens as it climbs and is as wide as the deck where it lands', top > 5 && dk.ws.slice(0, top + 1).every((w, i, a) => !i || w >= a[i - 1] - 1e-9) && Math.abs(dk.ws[top] - dk.width) < 0.01);
  // v0.28: the ground road curves round each forecourt corner, and the frontage road and links stop short of it
  const cs = r.d.autoRoads.filter(w => w.fore === 'corner'), fc = r.d.autoRoads.find(w => w.fore === 'face');
  check('the ground road rounds both forecourt corners on a 35 m curve', cs.length === 2 && cs.every(k => k.c && Math.abs(Math.hypot(k.a.x - k.c.x, k.a.y - k.c.y) - 35) < 0.01 && Math.abs(Math.hypot(k.b.x - k.c.x, k.b.y - k.c.y) - 35) < 0.01));
  check('the frontage road and its links meet the curves end to end', cs.every(k => [fc.a, fc.b].some(p => Math.hypot(p.x - k.a.x, p.y - k.a.y) < 0.01) && links.some(w => Math.hypot(w.a.x - k.b.x, w.a.y - k.b.y) < 0.01)));
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
  const lots = [...r.d.shops.values()].flat().filter(sh => !sh.court).map(sh => ({ x: sh.pts.reduce((n, q) => n + q.x, 0) / sh.pts.length, y: sh.pts.reduce((n, q) => n + q.y, 0) / sh.pts.length }));
  check('the merged building keeps a junction space (' + js.map(j => j.kind + ' ' + Math.round(j.area) + ' m2').join(', ') + ')', js.length >= 1 && js.every(j => j.seeds.length > 0));
  check('no shop lot stands in a junction space', lots.length > 20 && !lots.some(c => js.some(j => ins(c, j))));
  // v0.26: the pieces' own fit-out stops at the space, and the lots round it front it
  const its = [...r.d.frames.entries()].filter(([id]) => r.d.zones.find(q => q.id === id)?.type === 'concourse').flatMap(([, f]) => f.items);
  const mid = q => ({ x: q.reduce((n, v) => n + v.x, 0) / q.length, y: q.reduce((n, v) => n + v.y, 0) / q.length });
  check('no holdroom seat, counter or restroom stands in a junction space', its.length > 50 && !its.filter(it => it.closed || (it.k !== 'spine' && it.k !== 'lane')).some(it => js.some(j => ins(mid(it.pts), j))));
  check('the spine breaks off at the space and starts again beyond it', !its.filter(it => it.k === 'spine' || it.k === 'lane').some(it => it.pts.some((q, i) => i + 1 < it.pts.length && js.some(j => ins({ x: (q.x + it.pts[i + 1].x) / 2, y: (q.y + it.pts[i + 1].y) / 2 }, j)))));
  const fronting = [...r.d.shops.values()].flat().filter(sh => sh.plaza);
  check('lots round the space front it (' + fronting.length + ': ' + [...new Set(fronting.map(sh => sh.plaza))].join(', ') + ')', fronting.length >= 2 && fronting.length < lots.length / 3);
  // v0.31: the space trades: counters round its edge, let as food, clear of the pieces' own lots and of the spine's way in
  const cts = [...r.d.shops.values()].flat().filter(sh => sh.court); const own = [...r.d.shops.values()].flat().filter(sh => !sh.court);
  const cen = q => ({ x: (q[0].x + q[2].x) / 2, y: (q[0].y + q[2].y) / 2 });
  check('the junction space has food counters round its edge (' + cts.length + ')', cts.length >= 2 && cts.every(sh => sh.type === 'food' && js.some(j => (j.kind === 'hall' || j.kind === 'food') && ins(cen(sh.pts), j))));
  check('no counter stands on a lot of the building\u2019s own plan', !cts.some(c => own.some(o => ins(cen(c.pts), { rings: [o.pts] }) || ins(cen(o.pts), { rings: [c.pts] }))));
  check('no counter stands by a gate door', !cts.some(c => r.d.gates.some(g => Math.hypot(g.door.x - cen(c.pts).x, g.door.y - cen(c.pts).y) < 14)));
  { const w2 = sampleWorld(); pier(w2, 3568, 2718, 400, 50, 20); conc(w2, 5000, 2600, 400, 50); conc(w2, 5175, 2450, 50, 400); const d2 = derive(w2);
    const keys = d => [...d.shops.values()].flat().filter(sh => sh.court && sh.zone.id === cts[0]?.zone.id).map(sh => sh.key).sort().join(' ');
    check('a counter keeps its name when an unrelated building is put up', cts.length > 0 && keys(r.d) === keys(d2)); }
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
  check('courtyards and gardens have no counters', ![...r.d.shops.values()].flat().some(sh => sh.court && js.some(j => (j.kind === 'court' || j.kind === 'garden') && j.rings.some(q => inPoly(cen4(sh.pts), q)))));
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
// v0.28: ramps on approach roads of other lengths, and what they end at (cases found by review)
const hallAt = (w, x, y, ww, hh) => { const a = w.nextId++, b = w.nextId++; w.zones.push({ id: a, type: 'checkin', level: 1, x, y, w: ww, h: hh, tier: 0, pair: b }, { id: b, type: 'claim', level: 0, x, y, w: ww, h: hh, tier: 0, pair: a }); };
const road = (w, a, b) => w.ways.push({ id: w.nextId++, kind: 'road', a, b, cls: 0, lanes: 4 });
{ const w = newWorld(); hallAt(w, 2850, 2960, 300, 80); road(w, { x: 2500, y: 3268 }, { x: 3500, y: 3268 });
  w.rounds = [2766, 3234].map(x => ({ id: w.nextId++, x, y: 3268, size: 1 }));
  const d = derive(w); const geo = d.autoRoads.filter(q => q.rg).map(q => q.rg);
  const clear = Math.min(...geo.map(g => Math.min(...w.rounds.map(r => Math.hypot(g.T.x - r.x, g.T.y - r.y) - 28))));
  check('approach roads that end at a large roundabout: the taper ends well clear of its outer kerb (' + clear.toFixed(0) + ' m)', geo.length === 2 && clear >= 29.9); }
{ const w = newWorld(); hallAt(w, 2850, 2960, 300, 80); road(w, { x: 2500, y: 3200 }, { x: 3500, y: 3200 });
  const d = derive(w); const geo = d.autoRoads.filter(q => q.rg).map(q => q.rg); const face = d.autoRoads.find(q => q.fore === 'face'); const dk = d.decks[0];
  const runs = d.autoRoads.filter(q => q.fore === 'link').map(q => Math.hypot(q.b.x - q.a.x, q.b.y - q.a.y));
  check('a road 160 m off the hall (links ' + runs.map(v => v.toFixed(0)).join(' and ') + ' m) still gets a ramp at each end, beside the road', geo.length === 2 && geo.every(g => Math.hypot(g.T.x - g.N.x, g.T.y - g.N.y) >= 40));
  const lo = Math.min(face.a.x, face.b.x), hi = Math.max(face.a.x, face.b.x);
  check('every point of its deck is over its frontage road or on its own ramps', dk.pts.every(p => (p.x >= lo - 0.5 && p.x <= hi + 0.5) || geo.some(g => Math.min(Math.abs(p.x - g.T.x), Math.abs(p.x - g.D.x)) < 80))); }
{ const w = newWorld(); hallAt(w, 2850, 5392, 300, 80);
  const d = derive(w); const ramps = d.road.edges.filter(e => d.rampRefs.has(e.ref));
  check('beside the highway: every piece of a ramp is one-way, and none is a stub to the highway', ramps.length > 0 && ramps.every(e => e.ow)); }
// v0.29: a turned hall (check-in over claim): its forecourt, curbs, deck and fit-out follow its face
for (const deg of [12, -20]) {
  const w = sampleWorld(); for (const z of w.zones) if (z.type === 'checkin' || z.type === 'claim') z.rot = deg * Math.PI / 180;
  const d = derive(w); const hall = d.zones.find(z => z.type === 'checkin'); const curbs = d.zones.filter(z => z.auto);
  const fr = d.frames.get(hall.id); const ang = a => ((a % Math.PI) + Math.PI) % Math.PI; const along = Math.atan2(fr.along.y, fr.along.x);
  check('hall turned ' + deg + '°: Terminal 1 opens, with a forecourt link, a corner curve and a ramp at each end', d.terminals[0].active && d.autoRoads.filter(q => q.fore === 'link').length === 2 && d.autoRoads.filter(q => q.fore === 'corner').length === 2 && d.autoRoads.filter(q => q.rg).length === 2);
  check('hall turned ' + deg + '°: its curbs and its check-in counters are turned with it', curbs.length === 2 && curbs.every(c => Math.abs(Math.sin(c.rot - hall.rot)) < 1e-6) && Math.abs(Math.sin(along - hall.rot)) < 1e-6);
  const doors = d.ped.filter(n => n.zones.length === 2 && n.zones.some(id => curbs.some(c => c.id === id))).length;
  check('hall turned ' + deg + '°: people walk between the hall and its curbs (' + doors + ' doors, ' + d.cores.filter(k => k.frontage).length + ' frontage stairs)', doors >= 4 && d.cores.filter(k => k.frontage).length >= 2);
}
// v0.29: the turn handle, and where a turned module may go (cases found by review)
{ const w = sampleWorld(); const hall = w.zones.find(z => z.type === 'checkin'); const c = { x: hall.x + hall.w / 2, y: hall.y + hall.h / 2 };
  const lim = { minLen: 60, minWide: 24, maxWide: 120, minDia: 60, maxDia: 400, snapDeg: 5 }; const at = deg => ({ x: c.x + 200 * Math.cos(deg * Math.PI / 180), y: c.y + 200 * Math.sin(deg * Math.PI / 180) });
  const t12 = regrip(hall, 't', at(12), false, lim), t0 = regrip({ ...hall, ...t12 }, 't', at(1), false, lim), t90 = regrip(hall, 't', at(91), false, lim);
  check('the turn handle turns a hall about its centre in 5° steps, and square again it is upright, not nearly so', Math.abs(t12.rot * 180 / Math.PI - 10) < 1e-6 && Math.abs(t12.x + t12.w / 2 - c.x) < 1e-6 && t0.rot === undefined && t0.w === hall.w && t90.rot === undefined && t90.w === hall.h && t90.h === hall.w);
  check('a hall keeps its four edge grips and has a turn handle (and, since v0.34, a bend grip)', gripsFor(hall).map(g => g.grip).sort().join('') === 'emnstw');
  const deep = regrip(hall, 's', { x: c.x, y: hall.y + 150 }, false, lim);
  check('an upright hall keeps its own edge limits (150 m deep is allowed)', deep.h === 150);
  const w2 = sampleWorld(); w2.ways.push({ id: w2.nextId++, kind: 'taxi', a: { x: 2900, y: 2500 }, b: { x: 2900, y: 3100 }, cls: 2, lanes: 0 });
  const sec = w2.zones.find(z => z.type === 'security');
  check('a turned security block may not cross a taxiway on the departures level', !canPlaceTurned(w2, { ...sec, x: 2860, rot: 0.2, level: 1 }, 'security', [sec.id]).ok); }
// v0.32: a free-drawn area and a cut-out
{ const w = sampleWorld(); const pts = [[3250, 2655], [3400, 2655], [3440, 2720], [3380, 2800], [3270, 2780]].map(([x, y]) => ({ x, y }));
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const z = { id: w.nextId++, type: 'concourse', level: 1, x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), tier: 0, cls: 2, poly: pts };
  check('a free area overlapping the concourse may be placed', canPlacePier(w, z).ok);
  check('a free area whose edges cross may not', !canPlacePier(w, { ...z, poly: [pts[0], pts[2], pts[1], pts[3]] }).ok);
  w.zones.push(z);
  const cut = { id: w.nextId++, level: 1, pts: [[2950, 2635], [3050, 2635], [3050, 2665], [2950, 2665]].map(([x, y]) => ({ x, y })) }; w.cuts = [cut];
  const sim = new Sim(w, 7); sim.relayout(); const d = sim.d; const conc0 = w.zones.find(q => q.type === 'concourse' && !q.poly);
  const sh = d.shellOf.get(z.id); const free = d.gates.filter(g => g.zone.id === z.id).length;
  check('the free area and the concourse are one building, with stands on the free area (' + free + ')', sh && sh === d.shellOf.get(conc0.id) && sh.cut && free >= 4 && d.terminals[0].active);
  check('a 30 m cut-out makes a courtyard, and the free area a hall', d.junctions.some(j => j.kind === 'court' && Math.abs(j.area - 3000) < 300) && d.junctions.some(j => j.kind === 'hall' && j.ids.includes(z.id)));
  const under = [...d.shops.values()].flat().filter(sh => { const c = sh.pts.reduce((a, p) => ({ x: a.x + p.x / sh.pts.length, y: a.y + p.y / sh.pts.length }), { x: 0, y: 0 }); return inPoly(c, cut.pts); });
  check('no lot stands in the cut-out', under.length === 0);
  const big = d.junctions.find(j => j.ids.includes(z.id)); const cs = [...d.shops.values()].flat().filter(s => s.court);
  check('a large hall gets counters in proportion to its floor, and planting and seating on only part of it (' + cs.length + ' counters, ' + big.seeds.length + ' trees and tables)', cs.length <= Math.max(6, Math.floor(big.area / 900)) + 12 && big.seeds.length < big.area / 30);
  const m = migrateWorld(JSON.parse(JSON.stringify({ ...w, cuts: [cut, { id: 99, level: 1, pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }], zones: [...w.zones, { ...conc0, id: 98, poly: [pts[0], pts[2], pts[1], pts[3]] }] })));
  check('a saved world keeps good outlines and drops broken ones', m.cuts.length === 1 && m.zones.find(q => q.id === z.id).poly.length === 5 && !m.zones.find(q => q.id === 98).poly);
  let missed = 0, stranded = 0; sim.onDayEnd = r => { missed += r.stats.missed; stranded += r.stats.stranded; }; sim.startDay(); while (sim.day < 1) sim.step(0.25);   // (one day: on its second the sample's security, close to capacity, can miss some at the far gates)
  check('it flies a day with 0 missed and 0 stranded (' + missed + ', ' + stranded + ')', missed === 0 && stranded === 0); }
// v0.32 (cases found by review): cut-outs that cover a piece's middle, split a building, or cross it with no corner inside
{ const P = a => a.map(([x, y]) => ({ x, y })); const A = r => { let t = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; t += p.x * q.y - q.x * p.y; } return Math.abs(t / 2); };
  const w = sampleWorld(); const c = w.zones.find(q => q.type === 'concourse'); const full = A(shellsOf(w.zones)[0].outer);
  const sh = cuts => shellsOf(w.zones, cuts.map((pts, i) => ({ id: 900 + i, level: 1, pts: P(pts) })));
  const notch = sh([[[c.x + c.w / 2 - 20, c.y - 20], [c.x + c.w / 2 + 20, c.y - 20], [c.x + c.w / 2 + 20, c.y + c.h / 2 + 10], [c.x + c.w / 2 - 20, c.y + c.h / 2 + 10]]]);
  check('a notch over the middle of the concourse keeps its building', notch.length === 1 && notch[0].ids.includes(c.id) && notch[0].cuts.length === 1);
  const split = sh([[[c.x + 100, c.y - 20], [c.x + 140, c.y - 20], [c.x + 140, c.y + c.h + 20], [c.x + 100, c.y + c.h + 20]]]);
  const kept = split.reduce((t, q) => t + A(q.outer), 0);
  check('a cut-out across the concourse leaves two buildings, both with the concourse in them (' + Math.round(kept) + ' of ' + Math.round(full) + ' m²)', split.length === 2 && split.every(q => q.ids.includes(c.id)) && kept > full - 40 * c.h - 400);
  const w2 = sampleWorld(); const c2 = w2.zones.find(q => q.type === 'concourse'); w2.cuts = [{ id: 950, level: 1, pts: P([[c2.x + 100, c2.y - 20], [c2.x + 140, c2.y - 20], [c2.x + 140, c2.y + c2.h + 20], [c2.x + 100, c2.y + c2.h + 20]]) }];
  const d2 = derive(w2); check('... and the shell takes it, with no lot under it', d2.shells.some(q => q.cuts?.includes(950)) && ![...d2.shops.values()].flat().some(sh => { const m = sh.pts.reduce((a, p) => ({ x: a.x + p.x / sh.pts.length, y: a.y + p.y / sh.pts.length }), { x: 0, y: 0 }); return m.x > c2.x + 100 && m.x < c2.x + 140; }));
  const w3 = sampleWorld(); w3.cuts = [{ id: 951, level: 1, pts: P([[100, 100], [200, 100], [200, 200]]) }]; const d3 = derive(w3), d0 = derive(sampleWorld());
  check('a cut-out over nothing takes nothing', [...d3.shops.values()].flat().length === [...d0.shops.values()].flat().length);
  check('a new world starts with an empty list of cut-outs (so undo can put it back)', Array.isArray(newWorld().cuts) && newWorld().cuts.length === 0);
  // a thin L whose middle misses the grid: it still has a point inside and joins the concourse it overlaps
  const L = P([[c.x + 200, c.y + 30], [c.x + 500, c.y + 30], [c.x + 500, c.y + 46], [c.x + 216, c.y + 46], [c.x + 216, c.y + 330], [c.x + 200, c.y + 330]]);
  const lz = { id: 990, type: 'concourse', level: 1, x: c.x + 200, y: c.y + 30, w: 300, h: 300, tier: 0, cls: 2, poly: L };
  const ls = shellsOf([...w.zones, lz]); check('a thin L-shaped free area joins the concourse it overlaps', ls.some(q => q.ids.includes(990) && q.ids.includes(c.id)));
  const tri = { id: 991, type: 'concourse', level: 1, x: 3300, y: 3700, w: 200, h: 200, tier: 0, cls: 2, poly: P([[3300, 3700], [3500, 3700], [3300, 3900]]) };
  const w4 = sampleWorld(); w4.zones.push(tri);
  check('a taxiway may run through the empty half of the box round a triangular free area', canPlaceWay(w4, 'taxi', { x: 3420, y: 3880 }, { x: 3520, y: 3780 }, []).ok || console.log('   ', canPlaceWay(w4, 'taxi', { x: 3420, y: 3880 }, { x: 3520, y: 3780 }, []).reason)); }
// v0.33: a free area is planned from its walls in: holdrooms behind its gates, lots behind them and on its gateless walls
{ const w = sampleWorld(); const pts = [[3250, 2655], [3400, 2655], [3440, 2720], [3380, 2800], [3270, 2780]].map(([x, y]) => ({ x, y }));
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const z = { id: w.nextId++, type: 'concourse', level: 1, x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), tier: 0, cls: 2, poly: pts }; w.zones.push(z);
  const sim = new Sim(w, 7); sim.relayout(); const d = sim.d;
  const holds = (d.frames.get(z.id)?.items ?? []).filter(it => it.k === 'hold'); const lots = (d.shops.get(z.id) ?? []).filter(sh => !sh.court); const mine = d.gates.filter(g => g.zone.id === z.id);
  const segD = (p, a, b) => { const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / ((b.x - a.x) ** 2 + (b.y - a.y) ** 2 || 1))); return Math.hypot(p.x - a.x - t * (b.x - a.x), p.y - a.y - t * (b.y - a.y)); };
  // (a door stands 7 m in from the wall, as on any concourse; near a corner that can be just past a 9 m holdroom, or between two holdrooms that meet there)
  const behind = g => holds.some(h => inPoly(g.door, h.pts) || h.pts.some((a, i) => segD(g.door, a, h.pts[(i + 1) % h.pts.length]) < 3));
  check('every gate on the free area has a holdroom behind it (' + mine.length + ' gates, ' + holds.length + ' holdrooms)', mine.length >= 4 && mine.every(behind));
  check('it has lots behind its holdrooms and window lots on its gateless walls (' + lots.filter(l => !l.window).length + ' and ' + lots.filter(l => l.window).length + ')', lots.filter(l => !l.window).length >= 3 && lots.filter(l => l.window).length >= 3);
  check('every lot and holdroom is inside the area, each lot with four corners', [...lots.map(l => l.pts), ...holds.map(h => h.pts)].every(q => q.every(p => inPoly(p, pts) || Math.min(...pts.map((a, i) => { const b = pts[(i + 1) % pts.length]; const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / ((b.x - a.x) ** 2 + (b.y - a.y) ** 2))); return Math.hypot(p.x - a.x - t * (b.x - a.x), p.y - a.y - t * (b.y - a.y)); })) < 0.7)) && lots.every(l => l.pts.length === 4));
  const hall = d.junctions.find(j => j.ids.includes(z.id) && j.kind === 'hall');
  const box = q => { const c = q.reduce((a, p) => ({ x: a.x + p.x / q.length, y: a.y + p.y / q.length }), { x: 0, y: 0 }); return c; };
  check('the hall is in the middle, with no lot or holdroom in it', hall && ![...lots.map(l => l.pts), ...holds.map(h => h.pts)].some(q => inPoly(box(q), hall.outer)));
  let missed = 0, stranded = 0; sim.onDayEnd = r => { missed += r.stats.missed; stranded += r.stats.stranded; }; sim.startDay(); while (sim.day < 2) sim.step(0.25);
  check('the planned free area flies a day with 0 missed and 0 stranded (' + missed + ', ' + stranded + ')', missed === 0 && stranded === 0); }
// v0.34: a hall that bends, with its forecourt, curbs and deck following the curve
{ const w = sampleWorld(); const hall = w.zones.find(z => z.type === 'checkin'); const c = { x: hall.x + hall.w / 2, y: hall.y + hall.h / 2 };
  const lim = { minLen: 60, minWide: 30, maxWide: 120, minDia: 60, maxDia: 400, snapDeg: 5 };
  check('an upright hall has a bend grip in its middle', gripsFor(hall).some(g => g.grip === 'm'));
  const bent = regrip(hall, 'm', { x: c.x, y: c.y - 30 }, false, lim), back = regrip({ ...hall, ...bent }, 'm', { x: c.x, y: c.y + 1 }, false, lim);
  check('the bend grip bends it, and pulled straight it is an upright rectangle again', bent.bend === -30 && back.bend === undefined && !back.rot && back.w === hall.w && back.h === hall.h && back.x === hall.x && back.y === hall.y);
  check('a bent hall has its ends, long walls, middle and turn handle as grips, and never tapers', gripsFor({ ...hall, bend: -30 }).map(g => g.grip).sort().join('') === 'abmnst');
  for (const z of w.zones) if (z.type === 'checkin' || z.type === 'claim') z.bend = -30;
  check('a bent hall may overlap security (it joins it there)', canPlaceTurned(w, { ...hall, bend: -30, level: 1 }, 'checkin', w.zones.filter(z => z.type === 'checkin' || z.type === 'claim').map(z => z.id)).ok);
  const sim = new Sim(w, 7); sim.relayout(); const d = sim.d;
  const dep = d.zones.filter(z => z.auto?.deck === 'dep'), arr = d.zones.filter(z => z.auto?.deck === 'arr');
  const outline = zonePts(d.zones.find(z => z.type === 'checkin'));
  const segD = (p, a, b) => { const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / ((b.x - a.x) ** 2 + (b.y - a.y) ** 2 || 1))); return Math.hypot(p.x - a.x - t * (b.x - a.x), p.y - a.y - t * (b.y - a.y)); };
  const wallGap = z => Math.min(...zonePts(z).map(p => Math.min(...outline.map((a, i) => segD(p, a, outline[(i + 1) % outline.length])))));
  check('Terminal 1 opens with the hall bent 30 m (' + (d.terminals[0].problems.join('; ') || 'open') + ')', d.terminals[0].active);
  check('its curbs follow the curved face, a piece at a time on both levels (' + dep.length + ' and ' + arr.length + '), each against the wall', dep.length >= 6 && arr.length === dep.length && [...dep, ...arr].every(z => wallGap(z) < 1.5) && new Set(dep.map(z => Math.round(z.rot * 100))).size >= 4);
  check('the frontage road follows it as a chain of chords, with one deck the length of it and a ramp at each end', d.autoRoads.filter(r => r.fore === 'face').length >= 6 && d.decks.length === 1 && d.decks[0].pts.length > dep.length + 20 && d.autoRoads.filter(r => r.rg).length === 2);
  const m = migrateWorld(JSON.parse(JSON.stringify(w)));
  check('a saved world keeps the hall bent', m.zones.filter(z => z.type === 'checkin' || z.type === 'claim').every(z => z.bend === -30));
  let missed = 0, stranded = 0; sim.onDayEnd = r => { missed += r.stats.missed; stranded += r.stats.stranded; }; sim.startDay(); while (sim.day < 1) sim.step(0.25);
  check('the bent hall flies a day with 0 missed and 0 stranded (' + missed + ', ' + stranded + ')', missed === 0 && stranded === 0); }
// v0.34 (cases found by review): a tight bend with the road on its inside, straightening after an end grip, the turn handle
{ const w = newWorld(); const ci = w.nextId++, cl = w.nextId++;
  w.zones.push({ id: ci, type: 'checkin', level: 1, x: 1000, y: 1000, w: 250, h: 40, tier: 0, units: 10, pair: cl, bend: 100 });
  w.zones.push({ id: cl, type: 'claim', level: 0, x: 1000, y: 1000, w: 250, h: 40, tier: 0, pair: ci, bend: 100 });
  w.ways.push({ id: w.nextId++, kind: 'road', a: { x: 600, y: 820 }, b: { x: 1700, y: 820 }, cls: 0, lanes: 4 });
  w.ways.push({ id: w.nextId++, kind: 'road', a: { x: 600, y: 820 }, b: { x: 600, y: 5700 }, cls: 0, lanes: 4 });
  const d = derive(w); const hall = w.zones[0]; const fs = facesOf(hall).filter(f => f.chain);
  check('every piece of a tightly bent wall faces out of the hall', fs.length >= 6 && fs.every(f => !inZone({ x: (f.a.x + f.b.x) / 2 + f.out.x * 3, y: (f.a.y + f.b.y) / 2 + f.out.y * 3 }, hall)));
  const faces = d.autoRoads.filter(r => r.fore === 'face'); const curbs = d.zones.filter(z => z.auto);
  check('its frontage road runs outside it, on the inside of the bend', faces.length >= 5 && faces.every(r => !inZone(r.a, hall, 1) && !inZone(r.b, hall, 1)));
  check('every piece of the inside wall has curbs, each reaching into the hall (' + curbs.length + ')', curbs.length === 2 * fs.filter(f => f.chain.endsWith(':n')).length && curbs.every(z => zonesOverlap(z, w.zones.find(q => q.id === z.auto.module), 4))); }
{ const w = sampleWorld(); const z = w.zones.find(q => q.type === 'checkin'); const lim = { minLen: 60, minWide: 30, maxWide: 120, minDia: 60, maxDia: 400, snapDeg: 5 };
  const c = { x: z.x + z.w / 2, y: z.y + z.h / 2 }; const g1 = regrip(z, 'm', { x: c.x, y: c.y - 30 }, false, lim);
  const F = frameOf(g1); const g2 = regrip(g1, 'b', toWorld(g1, { x: F.x + F.w, y: c.y }), false, lim), g3 = regrip(g2, 'm', centreOf(g2), false, lim);
  check('a bent hall whose end grip is dropped where it was, then pulled straight, is the upright hall again', !g3.rot && !g3.bend && g3.x === z.x && g3.y === z.y && g3.w === z.w && g3.h === z.h);
  for (const b of [-30, -100]) { const t = gripsFor({ ...z, bend: b }).find(q => q.grip === 't'); const tb = gripsFor({ ...z, bend: b }).find(q => q.grip === 'b');
    check('the turn handle of a bent hall (' + b + ') stands off the end of its chord, clear of its end grip, and grabbing it turns nothing', !inZone(t.p, { ...z, bend: b }) && Math.hypot(t.p.x - tb.p.x, t.p.y - tb.p.y) >= 8 && !regrip({ ...z, bend: b }, 't', t.p, false, lim).rot); } }
// v0.35: security bends too; bent so that it overlaps both the hall and the concourse, the terminal opens and flies
{ const w = sampleWorld(); const sec = w.zones.find(z => z.type === 'security');
  check('security has a bend grip', gripsFor(sec).some(g => g.grip === 'm'));
  // (deepened to overlap both, then bent sideways through its grip as the editor does: its long axis is then its frame's x)
  Object.assign(sec, { y: sec.y - 15, h: sec.h + 30 }); const sc = { x: sec.x + sec.w / 2, y: sec.y + sec.h / 2 };
  const sg = regrip(sec, 'm', { x: sc.x + 20, y: sc.y }, false, { minLen: 60, minWide: 30, maxWide: 120, minDia: 60, maxDia: 400, snapDeg: 5 }); Object.assign(sec, sg);
  check('bent sideways by its grip, its long axis is the frame it bends in (bend ' + sg.bend.toFixed(1) + ')', !!sg.bend && Math.abs(sg.w - 160) < 1e-6 && Math.abs(sg.h - 120) < 1e-6);
  check('a bent security block may overlap the hall and the concourse', canPlaceTurned(w, { ...sec, level: 1 }, 'security', [sec.id]).ok);
  const m = migrateWorld(JSON.parse(JSON.stringify(w)));
  check('a saved world keeps security bent', m.zones.find(z => z.type === 'security').bend === sg.bend);
  const sim = new Sim(w, 7); sim.relayout(); let missed = 0, stranded = 0; sim.onDayEnd = r => { missed += r.stats.missed; stranded += r.stats.stranded; };
  check('Terminal 1 opens with security bent (' + (sim.d.terminals[0].problems.join('; ') || 'open') + ')', sim.d.terminals[0].active);
  sim.startDay(); while (sim.day < 1) sim.step(0.25);
  check('and flies a day with 0 missed and 0 stranded (' + missed + ', ' + stranded + ')', missed === 0 && stranded === 0); }
// v0.36: no one walks across a courtyard or a notch, or waits in one
{ const P = a => a.map(([x, y]) => ({ x, y })); const w = sampleWorld();
  const court = P([[2950, 2635], [3050, 2635], [3050, 2665], [2950, 2665]]), notch = P([[3200, 2600], [3300, 2600], [3300, 2660], [3250, 2672], [3200, 2660]]);
  w.cuts = [{ id: w.nextId++, level: 1, pts: court }, { id: w.nextId++, level: 1, pts: notch }];
  const sim = new Sim(w, 7); sim.relayout(); const d = sim.d;
  const a = { x: 3000, y: 2628 }, b = { x: 3000, y: 2672 }, r = d.pedRoute(a, 1, b, 1); const legs = [a, ...r.pts];
  const crosses = (p, q, poly) => poly.some((u, i) => segsIntersect(p, q, u, poly[(i + 1) % poly.length]));
  check('a walk from one side of a courtyard to the other goes round it, never off the floor (' + Math.round(r.len) + ' m against ' + Math.round(Math.hypot(b.x - a.x, b.y - a.y)) + ' m straight across)', r.len > 60 && !legs.some((p, i) => i > 0 && Array.from({ length: 40 }, (_, k) => d.inCut({ x: legs[i - 1].x + (p.x - legs[i - 1].x) * (k + 0.5) / 40, y: legs[i - 1].y + (p.y - legs[i - 1].y) * (k + 0.5) / 40 }, 1)).some(Boolean)));
  let seen = 0, off = 0, missed = 0, stranded = 0, k = 0; sim.onDayEnd = q => { missed += q.stats.missed; stranded += q.stats.stranded; };
  sim.startDay(); while (sim.day < 1) { sim.step(0.25); if (k++ % 8 === 0) for (const p of sim.pax) if (p.level === 1 && p.stage !== 'done') { seen++; if (d.inCut(p, 1)) off++; } }
  check('a day with a courtyard and a deep notch: nobody stands in either (' + off + ' of ' + seen + ' sightings), 0 missed and 0 stranded (' + missed + ', ' + stranded + ')', seen > 10000 && off === 0 && missed === 0 && stranded === 0); }
// v0.36 (cases found by review): an L-shaped courtyard, two close together, a narrow strip filled back, a cut right across
{ const P = a => a.map(([x, y]) => ({ x, y })); const mk = cs => { const w = sampleWorld(); w.cuts = cs.map(pts => ({ id: w.nextId++, level: 1, pts: P(pts) })); return derive(w); };
  const clean = (d, a, b) => { const r = d.pedRoute(a, 1, b, 1); if (!r) return null; const L = [a, ...r.pts]; return L.every((p, i) => !i || Array.from({ length: 40 }, (_, k) => !d.inCut({ x: L[i - 1].x + (p.x - L[i - 1].x) * (k + 0.5) / 40, y: L[i - 1].y + (p.y - L[i - 1].y) * (k + 0.5) / 40 }, 1)).every(Boolean)) ? r : false; };
  const dL = mk([[[2900, 2632], [3000, 2632], [3000, 2648], [2930, 2648], [2930, 2670], [2900, 2670]]]);
  const rL = clean(dL, { x: 2950, y: 2626 }, { x: 2950, y: 2675 });
  check('a walk across an L-shaped courtyard goes round it on the floor', rL && rL.len > 60);
  const d2 = mk([[[2900, 2632], [2960, 2632], [2960, 2668], [2900, 2668]], [[2962, 2632], [3020, 2632], [3020, 2668], [2962, 2668]]]);
  const r2 = clean(d2, { x: 2961, y: 2626 }, { x: 2961, y: 2674 });
  check('two courtyards 2 m apart: the gap between them is not floor, and a walk goes round both', r2 && r2.len > 100 && d2.inCut({ x: 2961, y: 2650 }, 1));
  const d3 = mk([[[3150, 2630], [3153, 2630], [3153, 2670], [3150, 2670]]]); const r3 = clean(d3, { x: 3130, y: 2650 }, { x: 3170, y: 2650 });
  check('a 3 m slot inside the floor, closed again by the rounding, takes none: a walk goes straight across it', r3 && r3.len < 41 && !d3.inCut({ x: 3151.5, y: 2650 }, 1));
  const d4 = mk([[[3200, 2590], [3220, 2590], [3220, 2700], [3200, 2700]]]);
  check('a cut-out right across the concourse: no walk across it, and the design check says so', d4.pedRoute({ x: 3150, y: 2650 }, 1, { x: 3260, y: 2650 }, 1) === null && d4.issues.some(q => q.text.startsWith('A cut-out cuts'))); }
// v0.37: a taxilane link that finds its way round what is in the way
{ const w = newWorld(); runway(w); const c = conc(w, 2800, 2700, 300, 60);
  w.zones.push({ id: w.nextId++, type: 'parking', level: 0, x: 2650, y: 2480, w: 600, h: 90, tier: 0 });
  const d = derive(w); const g = d.gates.filter(q => q.zone.id === c.id);
  const crossesLot = d.airExtra.some(l => { for (let t = 0.05; t < 1; t += 0.05) { const p = { x: l.a.x + (l.b.x - l.a.x) * t, y: l.a.y + (l.b.y - l.a.y) * t }; if (p.x > 2650 && p.x < 3250 && p.y > 2480 && p.y < 2570) return true; } return false; });
  check('a car park wider than the concourse between it and the runway: its taxilanes go round it, and every gate reaches the runway (' + g.filter(q => q.rwys[0].size > 0).length + ' of ' + g.length + ')', g.length >= 12 && g.every(q => q.rwys[0].size > 0) && !crossesLot && !d.issues.some(i => /no clear way/.test(i.text))); }
// v0.37 (cases found by review): clear of roads, at the class's own clearance, round a road's end
{ const segD = (p, a, b) => { const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / ((b.x - a.x) ** 2 + (b.y - a.y) ** 2 || 1))); return Math.hypot(p.x - a.x - t * (b.x - a.x), p.y - a.y - t * (b.y - a.y)); };
  const along = (l, f) => { let m = Infinity; for (let t = 0; t <= 1; t += 0.02) m = Math.min(m, f({ x: l.a.x + (l.b.x - l.a.x) * t, y: l.a.y + (l.b.y - l.a.y) * t })); return m; };
  const w = newWorld(); runway(w); const c = conc(w, 2800, 2700, 300, 60);
  w.zones.push({ id: w.nextId++, type: 'parking', level: 0, x: 2650, y: 2480, w: 600, h: 90, tier: 0 });
  const roads = [{ a: { x: 3268, y: 2420 }, b: { x: 3268, y: 2700 } }, { a: { x: 2632, y: 2420 }, b: { x: 2632, y: 2700 } }];
  for (const r of roads) w.ways.push({ id: w.nextId++, kind: 'road', ...r, cls: 0, lanes: 2 });
  const d = derive(w); const g = d.gates.filter(q => q.zone.id === c.id); const links = d.airExtra.filter(l => l.link);
  const gap = Math.min(...links.map(l => Math.min(...roads.map(r => along(l, p => segD(p, r.a, r.b))))));
  check('roads either side of the car park: the way round goes past a road end, every gate reaches the runway, and no link comes within 30 m of a road (' + Math.round(gap) + ' m)', g.length >= 12 && g.every(q => q.rwys[0].size > 0) && gap >= 30);
  const w3 = newWorld(); runway(w3); const c3 = conc(w3, 2800, 2700, 300, 60, { cls: 3 });
  w3.zones.push({ id: w3.nextId++, type: 'parking', level: 0, x: 2600, y: 2420, w: 700, h: 60, tier: 0 });
  const d3 = derive(w3); const g3 = d3.gates.filter(q => q.zone.id === c3.id);
  const lot = { x: 2600, y: 2420, w: 700, h: 60 }; const boxD = p => Math.hypot(Math.max(0, lot.x - p.x, p.x - lot.x - lot.w), Math.max(0, lot.y - p.y, p.y - lot.y - lot.h));
  const g3d = Math.min(...d3.airExtra.filter(l => l.link).map(l => along(l, boxD)));
  check('an A380 concourse behind a car park: its way round keeps 47.5 m off the lot (' + Math.round(g3d) + ' m), and its gates reach the runway', g3.length > 0 && g3.every(q => q.rwys[0].size > 0) && g3d >= 47); }
// v0.38: restroom cores along a free area's walls
{ const w = sampleWorld(); const pts = [[3350, 2600], [3560, 2600], [3560, 2470], [3700, 2470], [3700, 2650], [3380, 2650]].map(([x, y]) => ({ x, y }));
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const z = { id: w.nextId++, type: 'concourse', level: 1, x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), tier: 0, cls: 2, poly: pts }; w.zones.push(z);
  const d = derive(w); const items = d.frames.get(z.id)?.items ?? []; const wc = items.filter(i => i.k === 'wc'), holds = items.filter(i => i.k === 'hold');
  const mid = q => q.reduce((a, p) => ({ x: a.x + p.x / q.length, y: a.y + p.y / q.length }), { x: 0, y: 0 });
  const far = Math.max(...holds.map(h => Math.min(...wc.map(c => Math.hypot(mid(h.pts).x - mid(c.pts).x, mid(h.pts).y - mid(c.pts).y)))));
  check('a large free area has restroom cores along its walls (' + wc.length + '), every holdroom within 130 m of one (' + Math.round(far) + ' m), each inside the area', wc.length >= 3 && far <= 130 && wc.every(c => c.pts.every(p => inPoly(p, pts) || Math.min(...pts.map((a, i) => { const b = pts[(i + 1) % pts.length]; const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / ((b.x - a.x) ** 2 + (b.y - a.y) ** 2))); return Math.hypot(p.x - a.x - t * (b.x - a.x), p.y - a.y - t * (b.y - a.y)); })) < 0.7))); }
// v0.39: a road drawn by hand along a curved face
{ const w = sampleWorld(); for (const z of w.zones) if (z.type === 'checkin' || z.type === 'claim') z.bend = -30;
  const road = { id: w.nextId++, kind: 'road', a: { x: 2830, y: 2898 }, b: { x: 3270, y: 2898 }, c: { x: 3050, y: 2835 }, cls: 0, lanes: 4 }; w.ways.push(road);
  w.ways.push({ id: w.nextId++, kind: 'road', a: { x: 2830, y: 2898 }, b: { x: 2830, y: 3230 }, cls: 0, lanes: 4 }, { id: w.nextId++, kind: 'road', a: { x: 3270, y: 2898 }, b: { x: 3270, y: 3230 }, cls: 0, lanes: 4 });
  const sim = new Sim(w, 7); sim.relayout(); const d = sim.d;
  const dep = d.zones.filter(z => z.auto?.deck === 'dep' && z.auto.road === road.id), arr = d.zones.filter(z => z.auto?.deck === 'arr' && z.auto.road === road.id);
  const outline = zonePts(d.zones.find(z => z.type === 'checkin'));
  const segD = (p, a, b) => { const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / ((b.x - a.x) ** 2 + (b.y - a.y) ** 2 || 1))); return Math.hypot(p.x - a.x - t * (b.x - a.x), p.y - a.y - t * (b.y - a.y)); };
  const wallGap = z => Math.min(...zonePts(z).map(p => Math.min(...outline.map((a, i) => segD(p, a, outline[(i + 1) % outline.length])))));
  const pl = wayPts(road); const onRoad = p => Math.min(...pl.slice(1).map((q, i) => segD(p, pl[i], q)));
  check('a curved road drawn along the bent hall: no forecourt is laid (' + d.autoRoads.filter(r => r.fore).length + ' generated pieces)', !d.autoRoads.some(r => r.fore));
  check('its curbs follow the wall a piece at a time on both levels (' + dep.length + ' and ' + arr.length + '), each against the wall', dep.length >= 6 && arr.length === dep.length && [...dep, ...arr].every(z => wallGap(z) < 1.5));
  const dk = d.decks.filter(k => k.road === road.id);
  check('one deck runs over the curved road and comes down along the curve at each end', dk.length === 1 && dk[0].zs[0] === 0 && dk[0].zs[dk[0].zs.length - 1] === 0 && dk[0].pts.slice(0, 3).concat(dk[0].pts.slice(-3)).every(p => onRoad(p) < 1));
  check('Terminal 1 opens on the curved road (' + (d.terminals[0].problems.join('; ') || 'open') + ')', d.terminals[0].active);
  let missed = 0, stranded = 0; sim.onDayEnd = r => { missed += r.stats.missed; stranded += r.stats.stranded; }; sim.startDay(); while (sim.day < 1) sim.step(0.25);
  check('and flies a day with 0 missed and 0 stranded (' + missed + ', ' + stranded + ')', missed === 0 && stranded === 0); }
{ const w = sampleWorld(); const road = { id: w.nextId++, kind: 'road', a: { x: 2830, y: 2898 }, b: { x: 3270, y: 2898 }, c: { x: 3050, y: 2906 }, cls: 0, lanes: 4 }; w.ways.push(road);
  w.ways.push({ id: w.nextId++, kind: 'road', a: { x: 2830, y: 2898 }, b: { x: 2830, y: 3230 }, cls: 0, lanes: 4 }, { id: w.nextId++, kind: 'road', a: { x: 3270, y: 2898 }, b: { x: 3270, y: 3230 }, cls: 0, lanes: 4 });
  const d = derive(w);
  check('a gently curved road along the upright hall is its frontage too: curbs on both levels and no forecourt', !d.autoRoads.some(r => r.fore) && d.zones.some(z => z.auto?.deck === 'dep' && z.auto.road === road.id) && d.zones.some(z => z.auto?.deck === 'arr' && z.auto.road === road.id));
  { const dk = d.decks.filter(k => k.road === road.id); const pl = wayPts(road); const sd = (p, a, b) => { const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / ((b.x - a.x) ** 2 + (b.y - a.y) ** 2 || 1))); return Math.hypot(p.x - a.x - t * (b.x - a.x), p.y - a.y - t * (b.y - a.y)); };
    check('and its deck follows the road the whole way', dk.length === 1 && dk[0].pts.length > 12 && dk[0].pts.every(p => Math.min(...pl.slice(1).map((q, i) => sd(p, pl[i], q))) < 3.5)); }
  { const w2 = sampleWorld(); const ci = w2.zones.find(z => z.type === 'checkin'), cl = w2.zones.find(z => z.type === 'claim'); delete ci.pair; delete cl.pair; cl.x = 2950; cl.w = 200;
    const r2 = { ...road, id: w2.nextId++, c: { x: 3050, y: 2904 } }; w2.ways.push(r2, { id: w2.nextId++, kind: 'road', a: { x: 2830, y: 2898 }, b: { x: 2830, y: 3230 }, cls: 0, lanes: 4 }, { id: w2.nextId++, kind: 'road', a: { x: 3270, y: 2898 }, b: { x: 3270, y: 3230 }, cls: 0, lanes: 4 });
    const d4 = derive(w2); const kinds = d4.zones.filter(z => z.auto?.road === r2.id).map(z => (z.level ? 'L1 ' : 'G ') + z.auto.deck).sort().join(', ');
    check('with separate check-in and claim it splits into departures over arrivals as a straight road does (' + kinds + ')', kinds === 'G arr, L1 dep' && d4.decks.filter(k => k.road === r2.id).length === 1); }
  road.c = { x: 3050, y: 2990 };
  const d2 = derive(w);
  check('one that swings away from the face grows no curb, and the hall lays its own forecourt', !d2.zones.some(z => z.auto?.road === road.id) && d2.autoRoads.some(r => r.fore === 'face')); }
console.log(bad ? bad + ' CHECK(S) FAILED' : 'all checks passed');
if (bad) process.exit(1);
`;
const dir = mkdtempSync(join(tmpdir(), 'aprons-'));
const out = join(dir, 'run.mjs');
await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' });
await import(out);
