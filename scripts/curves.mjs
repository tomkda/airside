// Bent piers (v0.20): a pier bent into an arc by its middle grip. Its stands, taxilanes, interior and walking routes
// follow the curve.
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
const entry = `
import { derive, canPlacePier } from './src/world';
import { sampleWorld } from './src/sample';
import { Sim } from './src/sim';
import { inZone, zonePts, arcOf, frameOf, toLocal, toWorld, polyArea, regrip, gripsOf, maxBend, minBendRadius, heart } from './src/shapes';
let bad = 0;
const check = (what, ok) => { if (!ok) { bad++; console.log('   FAIL: ' + what); } };
const lim = { minLen: 60, minWide: 30, maxWide: 120, minDia: 60, maxDia: 400, snapDeg: 5 };
const mk = (bend, o = {}) => { const w = sampleWorld(); const z = { id: w.nextId++, type: 'concourse', level: 1, x: 3368, y: 2693, w: 500, h: 50, tier: 0, cls: 2, rot: 20 * Math.PI / 180, bend, ...o }; w.zones.push(z); return { w, z }; };
const rnd = (() => { let s = 12345; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();

{ // the geometry itself
  const z = { x: 1000, y: 1000, w: 500, h: 50, rot: 0.35, bend: 120 }; const A = arcOf(z); const F = frameOf(z);
  let err = 0; for (let i = 0; i < 200; i++) { const p = { x: F.x + rnd() * F.w, y: F.y + rnd() * F.h }; const q = toLocal(z, toWorld(z, p)); err = Math.max(err, Math.hypot(q.x - p.x, q.y - p.y)); }
  console.log('geometry: a 500 m chord bent 120 m is', Math.round(A.La), 'm round the bend, centreline radius', Math.round(A.R), 'm | there and back error', err.toExponential(1), 'm');
  check('straighten and bend back is exact', err < 1e-6);
  const straight = { x: 1000, y: 1000, w: 500, h: 50, rot: 0.35 };
  const ends0 = gripsOf(straight, true).filter(g => g.grip === 'a' || g.grip === 'b').map(g => g.p);
  const m0 = gripsOf(straight, true).find(g => g.grip === 'm').p;
  const perp = { x: -Math.sin(0.35), y: Math.cos(0.35) };
  const g1 = regrip(straight, 'm', { x: m0.x + perp.x * 100, y: m0.y + perp.y * 100 }, true, lim);
  const ends1 = gripsOf(g1, true).filter(g => g.grip === 'a' || g.grip === 'b').map(g => g.p);
  const moved = Math.max(...ends0.map((p, i) => Math.hypot(p.x - ends1[i].x, p.y - ends1[i].y)));
  const m1 = gripsOf(g1, true).find(g => g.grip === 'm').p;
  console.log('bend grip: pulled 100 m sideways → bend', g1.bend, '| ends moved', moved.toFixed(3), 'm | the middle is now', Math.hypot(m1.x - m0.x, m1.y - m0.y).toFixed(1), 'm from where it was');
  check('both ends stay where they are', moved < 0.01);
  check('the middle follows the cursor', g1.bend === 100 && Math.abs(Math.hypot(m1.x - m0.x, m1.y - m0.y) - 100) < 0.5);
  const g2 = regrip(g1, 'm', m0, true, lim);
  check('pulled back to the line it is straight again', !g2.bend && g2.w === 500);
  const g3 = regrip(straight, 'm', { x: m0.x + perp.x * 900, y: m0.y + perp.y * 900 }, true, lim);
  check('a bend stops at the tightest radius the width allows', Math.abs(g3.bend - maxBend(500, 50)) < 1e-9 && arcOf(g3).R >= minBendRadius(50) - 1e-6);
  const g4 = regrip(g1, 'b', { x: ends1[0].x + 300, y: ends1[0].y + 20 }, true, lim);
  const a4 = gripsOf(g4, true).find(g => g.grip === 'a').p;
  check('a bent pier still stretches and swings by its end, far end fixed', !!g4.bend && Math.hypot(a4.x - ends1[0].x, a4.y - ends1[0].y) < 0.05);
  const g5 = regrip(g1, 's', toWorld(g1, { x: frameOf(g1).x + frameOf(g1).w / 2, y: g1.y + g1.h / 2 + 40 }), true, lim);
  const h5 = heart(g5), h1 = heart(g1);
  check('a bent pier widens about its centreline', g5.h === 80 && Math.hypot(h5.x - h1.x, h5.y - h1.y) < 0.01); }

for (const bend of [120, -120]) {
  const { w, z } = mk(bend); const d = derive(w);
  const mine = d.gates.filter(g => g.zone.id === z.id); const n = mine.filter(g => g.key[0] === 'n').length, s = mine.filter(g => g.key[0] === 's').length;
  const shops = d.shops.get(z.id) ?? []; const out = shops.filter(sh => sh.pts.some(p => !inZone(p, z, 0.6))).length;
  const T = d.termOf.get(z.id);
  console.log('a 500 m pier bent', bend > 0 ? 'south' : 'north', 'by 120 m:', mine.length, 'gates (north wall', n + ', south wall', s + '),', mine.filter(g => g.rwys[0].size).length, 'reach a runway |', shops.length, 'lots,', out, 'outside the building |', T ? T.name + (T.active ? ' open' : ' closed') + ', ' + T.gateAreas + ' concourses' : 'no terminal', '| people movers', d.trainLinks.filter(l => l.apm).length);
  check('it is a valid place for a pier', canPlacePier(w, z, z.id).ok);
  // (bent north, the outside faces taxiway A and the concourse's own apron, which take some of its stands)
  if (bend > 0) check('more stands on the outside of the bend than the inside', s > n);
  check('every stand reaches a runway', mine.length >= 15 && mine.every(g => g.rwys[0].size > 0));
  check('every shop lot is inside the building', shops.length > 40 && out === 0);
  check('each stand faces square off its own piece of wall', mine.every(g => Math.abs(Math.hypot(g.outward.x, g.outward.y) - 1) < 1e-6) && new Set(mine.filter(g => g.key[0] === 's').map(g => g.ang.toFixed(3))).size === s);
  check('it joins the terminal it was bent out of (no people mover)', T && T.active && T.gateAreas === 2 && d.trainLinks.filter(l => l.apm).length === 0);
}
{ const { w, z } = mk(undefined, { w: 180, h: 50 }); z.bend = maxBend(180, 50); const d = derive(w);
  const mine = d.gates.filter(g => g.zone.id === z.id);
  console.log('a short pier bent as far as it goes (radius', Math.round(arcOf(z).R) + ' m):', mine.length, 'gates,', mine.filter(g => g.key[0] === 'n').length, 'on the inside |', d.gateGuides.find(g => g.zone.id === z.id && g.side === 'n')?.note ?? '');
  check('no stands on the inside of a bend too tight for them', mine.filter(g => g.key[0] === 'n').length === 0 && mine.length > 0); }
{ // a straight pier drawn into the bent one joins it
  const { w, z } = mk(120); const tip = toWorld(z, { x: frameOf(z).x + frameOf(z).w - 20, y: z.y + z.h / 2 });
  const p2 = { id: w.nextId++, type: 'concourse', level: 1, x: tip.x - 10, y: tip.y - 25, w: 300, h: 50, tier: 0, cls: 2, rot: -0.9 }; w.zones.push(p2);
  const c = { x: p2.x + 150, y: p2.y + 25 }; p2.x += tip.x - (c.x - 150 * Math.cos(-0.9)) - 0; p2.y += tip.y - (c.y - 150 * Math.sin(-0.9));
  const d = derive(w); const T = d.termOf.get(p2.id);
  console.log('a straight pier drawn out of the bent one:', T ? T.name + (T.active ? ' open' : ' closed') + ', ' + T.gateAreas + ' concourses' : 'no terminal', '| people movers', d.trainLinks.filter(l => l.apm).length);
  check('it is one terminal of three concourses, joined by overlap', T && T.active && T.gateAreas === 3 && d.trainLinks.filter(l => l.apm).length === 0); }
{ // a round hub set on the tip of the bent pier joins it too
  const { w, z } = mk(120); const tip = toWorld(z, { x: frameOf(z).x + frameOf(z).w - 10, y: z.y + z.h / 2 });
  const hub = { id: w.nextId++, type: 'concourse', level: 1, x: tip.x - 70, y: tip.y - 70, w: 140, h: 140, tier: 0, cls: 2, sides: 32 }; w.zones.push(hub);
  const d = derive(w); const T = d.termOf.get(hub.id);
  console.log('a round hub on the tip of the bent pier:', T ? T.name + (T.active ? ' open' : ' closed') + ', ' + T.gateAreas + ' concourses' : 'no terminal', '| people movers', d.trainLinks.filter(l => l.apm).length, '| hub lots', (d.shops.get(hub.id) ?? []).length);
  check('the hub is part of the same terminal, joined by overlap', T && T.active && T.gateAreas === 3 && d.trainLinks.filter(l => l.apm).length === 0); }
{ // two days of flying from the bent pier alone
  const { w, z } = mk(-110, { w: 420 });
  const sim = new Sim(w, 7); const main = sim.world.zones.find(q => q.type === 'concourse' && q !== z); main.off = [...Array(12).keys()].map(i => 'n' + i).concat(['e0', 'w0']);
  sim.relayout(); sim.startDay(); let outside = 0, seen = 0, tick = 0; const used = new Set(); let st = null;
  sim.onDayEnd = r => { st = r.stats; console.log('flying:', r.label, '| flights', st.flights, '(' + used.size + ' at the bent pier so far)', 'missed', st.missed, 'stranded', st.stranded, '| people seen in the pier', seen, '(outside any building: ' + outside + ')'); };
  while (sim.day < 2) { sim.step(0.25); for (const f of sim.flights) if (f.gate && f.gate.zone.id === z.id) used.add(f.id);
    if (tick++ % 8 === 0) for (const p of sim.pax) if (p.level === 1 && !p.ride) { if (inZone(p, z, 1)) seen++; else if (!sim.d.zones.some(q => q.level === 1 && inZone(p, q, 4))) outside++; } }
  check('every flight uses the bent pier', used.size >= st.flights && st.flights > 10);
  check('nobody stranded and nobody outside a building', st.stranded === 0 && outside === 0 && seen > 1000);
  check('nobody misses a flight', st.missed === 0); }
console.log(bad ? bad + ' CHECK(S) FAILED' : 'all checks passed');
if (bad) process.exit(1);
`;
const dir = mkdtempSync(join(tmpdir(), 'curves-'));
const out = join(dir, 'run.mjs');
await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' });
await import(out);
