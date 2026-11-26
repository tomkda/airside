// Forecourts (v0.80): the ramp to the departures deck in every road layout. Each layout is the sample airport with its
// roads redrawn; each must open Terminal 1 with one deck, a built ramp up and a built ramp down (no deck end that just
// comes down along the road beneath it), every ramp at grade where it leaves its road and at deck height where it lands.
// Exits 1 if a check fails.
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
const entry = `
import { Sim } from './src/sim';
import { derive } from './src/world';
import { sampleWorld } from './src/sample';
import { planTerminal } from './src/terminalplan';
let failed = 0; const check = (name, ok) => { if (!ok) { failed++; console.log('   FAIL: ' + name); } };
const R = (w, id) => w.ways.find(q => q.id === id);
const bare = w => { w.rounds = []; w.zones = w.zones.filter(z => z.type !== 'parking'); };
const hall = (w, f) => { for (const z of w.zones) if (z.type === 'checkin' || z.type === 'claim') f(z); };
const through = (w, y, x0 = 2200, x1 = 3900) => { bare(w); R(w, 14).a = { x: x0, y: 5700 }; R(w, 14).b = { x: x0, y }; R(w, 15).a = { x: x0, y }; R(w, 15).b = { x: x1, y }; R(w, 16).a = { x: x1, y }; R(w, 16).b = { x: x1, y: 5700 }; };
const road = (w, a, b, c) => w.ways.push({ id: w.nextId++, kind: 'road', a, b, ...(c ? { c } : {}), cls: 0, lanes: 4 });
// name, how the roads are drawn, and (where it is not two ramps) what is expected instead
const layouts = [
  ['the sample: an approach road each side, Terminal Drive beyond the car park', w => {}],
  ['one approach road', w => { w.ways = w.ways.filter(q => q.id !== 16); w.rounds = w.rounds.filter(q => q.x !== 3320); R(w, 15).b = { x: 2800, y: 3230 }; }],
  ['a frontage road drawn by hand, turning away 100 m past each end', w => { bare(w); R(w, 14).b = { x: 2780, y: 2900 }; R(w, 15).a = { x: 2780, y: 2900 }; R(w, 15).b = { x: 3320, y: 2900 }; R(w, 16).a = { x: 3320, y: 2900 }; }],
  ['the same with a roundabout at each corner', w => { w.zones = w.zones.filter(z => z.type !== 'parking'); w.rounds[0].y = 2900; w.rounds[1].y = 2900; R(w, 14).b = { x: 2780, y: 2900 }; R(w, 15).a = { x: 2780, y: 2900 }; R(w, 15).b = { x: 3320, y: 2900 }; R(w, 16).a = { x: 3320, y: 2900 }; }],
  ['a road drawn straight through along the face', w => through(w, 2900)],
  ['the same, two lanes', w => { through(w, 2900); for (const r of w.ways) if (r.kind === 'road') r.lanes = 2; }],
  ['a road through 70 m off the face', w => through(w, 2940)],
  ['a road through 110 m off the face', w => through(w, 2980)],
  ['a road through 150 m off the face', w => through(w, 3020)],
  ['a road through 230 m off the face', w => through(w, 3100)],
  ['a short road that stops short of the hall, off its middle', w => { bare(w); w.ways = w.ways.filter(q => q.id !== 16); R(w, 14).a = { x: 3050, y: 5700 }; R(w, 14).b = { x: 3050, y: 3230 }; R(w, 15).a = { x: 2900, y: 3230 }; R(w, 15).b = { x: 3200, y: 3230 }; }],
  ['one road that ends in front of the middle of the hall', w => { bare(w); w.ways = w.ways.filter(q => q.id !== 16 && q.id !== 15); R(w, 14).a = { x: 3050, y: 5700 }; R(w, 14).b = { x: 3050, y: 3060 }; }],
  ['one road that runs past the west end of the hall', w => { bare(w); w.ways = w.ways.filter(q => q.id !== 16 && q.id !== 15); R(w, 14).a = { x: 2600, y: 5700 }; R(w, 14).b = { x: 2600, y: 2500 }; }],
  ['a road that comes in along the line of the frontage from the west', w => { bare(w); w.ways = w.ways.filter(q => q.id !== 16); R(w, 14).a = { x: 2300, y: 5700 }; R(w, 14).b = { x: 2300, y: 2898 }; R(w, 15).a = { x: 2300, y: 2898 }; R(w, 15).b = { x: 2700, y: 2898 }; }],
  ['a drawn frontage fed from its middle, 250 m each way', w => { bare(w); w.ways = w.ways.filter(q => q.id !== 16); R(w, 14).a = { x: 3050, y: 5700 }; R(w, 14).b = { x: 3050, y: 2900 }; R(w, 15).a = { x: 2500, y: 2900 }; R(w, 15).b = { x: 3600, y: 2900 }; }],
  ['a drawn frontage no longer than the hall, fed from its middle', w => { bare(w); w.ways = w.ways.filter(q => q.id !== 16); R(w, 14).a = { x: 3050, y: 5700 }; R(w, 14).b = { x: 3050, y: 2900 }; R(w, 15).a = { x: 2840, y: 2900 }; R(w, 15).b = { x: 3260, y: 2900 }; }],
  ['a drawn frontage that stops dead at the east end of the hall', w => { bare(w); w.ways = w.ways.filter(q => q.id !== 16); R(w, 14).a = { x: 2400, y: 5700 }; R(w, 14).b = { x: 2400, y: 2900 }; R(w, 15).a = { x: 2400, y: 2900 }; R(w, 15).b = { x: 3260, y: 2900 }; }],
  ['a drawn frontage whose approach roads turn away 20 m past each end of the hall', w => { bare(w); R(w, 14).a = { x: 2860, y: 5700 }; R(w, 14).b = { x: 2860, y: 2900 }; R(w, 15).a = { x: 2860, y: 2900 }; R(w, 15).b = { x: 3240, y: 2900 }; R(w, 16).a = { x: 3240, y: 2900 }; R(w, 16).b = { x: 3240, y: 5700 }; }],
  ['a drawn frontage whose approach roads turn away at the very ends of the hall', w => { bare(w); R(w, 14).a = { x: 2880, y: 5700 }; R(w, 14).b = { x: 2880, y: 2900 }; R(w, 15).a = { x: 2880, y: 2900 }; R(w, 15).b = { x: 3220, y: 2900 }; R(w, 16).a = { x: 3220, y: 2900 }; R(w, 16).b = { x: 3220, y: 5700 }; }],
  ['a drawn frontage whose approach roads turn away 40 m past each end of the hall', w => { bare(w); R(w, 14).a = { x: 2840, y: 5700 }; R(w, 14).b = { x: 2840, y: 2900 }; R(w, 15).a = { x: 2840, y: 2900 }; R(w, 15).b = { x: 3260, y: 2900 }; R(w, 16).a = { x: 3260, y: 2900 }; R(w, 16).b = { x: 3260, y: 5700 }; }],
  ['the sample with its hall turned 12 degrees', w => hall(w, z => { z.rot = 12 * Math.PI / 180; })],
  ['the sample with its hall turned -20 degrees', w => hall(w, z => { z.rot = -20 * Math.PI / 180; })],
  ['the sample with its hall bent', w => hall(w, z => { z.bend = 30; })],
  ['a bent hall with a curved road drawn along it, turning away at each end', w => { hall(w, z => { z.bend = -30; }); w.zones = w.zones.filter(z => z.type !== 'parking'); road(w, { x: 2830, y: 2898 }, { x: 3270, y: 2898 }, { x: 3050, y: 2835 }); road(w, { x: 2830, y: 2898 }, { x: 2830, y: 3230 }); road(w, { x: 3270, y: 2898 }, { x: 3270, y: 3230 }); }],
  ['a gently curved road along the upright hall, turning away at each end', w => { w.zones = w.zones.filter(z => z.type !== 'parking'); road(w, { x: 2830, y: 2898 }, { x: 3270, y: 2898 }, { x: 3050, y: 2906 }); road(w, { x: 2830, y: 2898 }, { x: 2830, y: 3230 }); road(w, { x: 3270, y: 2898 }, { x: 3270, y: 3230 }); }],
  ['a long road curving gently past the hall', w => { through(w, 2960); R(w, 15).c = { x: 3050, y: 2840 }; }],
  ['a hall turned 12 degrees with a road drawn through along its turned face', w => { bare(w); hall(w, z => { z.rot = 12 * Math.PI / 180; }); const c = { x: 3050, y: 2840 }, u = { x: Math.cos(12 * Math.PI / 180), y: Math.sin(12 * Math.PI / 180) }, n = { x: -u.y, y: u.x }; const P = t => ({ x: c.x + n.x * 57 + u.x * t, y: c.y + n.y * 57 + u.y * t });
    R(w, 15).a = P(-800); R(w, 15).b = P(800); R(w, 14).a = { x: P(-800).x, y: 5700 }; R(w, 14).b = P(-800); R(w, 16).a = P(800); R(w, 16).b = { x: P(800).x, y: 5700 }; }],
  ['a road through along the face with a car park on the hall side past the east end', w => { through(w, 2900); w.zones.push({ id: 950, type: 'parking', level: 0, x: 3300, y: 2760, w: 300, h: 120, tier: 0 }); }, 'any'],
  ['a one-way road drawn through along the face', w => { through(w, 2900); R(w, 15).oneway = true; const t = R(w, 15).a; R(w, 15).a = R(w, 15).b; R(w, 15).b = t; }, 'any'],
  ['a curved road that swings away from the hall', w => { bare(w); R(w, 14).b = { x: 2780, y: 2960 }; R(w, 15).a = { x: 2780, y: 2960 }; R(w, 15).b = { x: 3320, y: 2960 }; R(w, 15).c = { x: 3050, y: 2840 }; R(w, 16).a = { x: 3320, y: 2960 }; }, 'none'],
];
let two = 0;
for (const [name, edit, expect] of layouts) {
  const w = sampleWorld(); edit(w); const d = derive(w);
  const g = d.autoRoads.filter(q => q.rg).map(q => q.rg); const decks = d.decks.filter(q => !q.branch); const dk = decks[0];
  const kind = q => (q.up ? 'up' : 'down') + ' by ' + (q.path ? (q.top === 16 ? 'a loop' : 'a slip ramp') : q.fly ? 'a turn-over' : 'a corner ramp');
  const f = d.autoRoads.find(q => q.fore === 'face'); const flat = dk ? (dk.flat ?? 0) : 2;
  console.log(name + ':', f ? 'forecourt ' + f.scheme : 'drawn frontage', '|', g.map(kind).join(', ') || 'no ramp', '|', d.terminals.map(t => t.name + (t.active ? ' open' : ' closed')).join(', '), flat ? '| ' + flat + ' deck end(s) with no ramp' : '');
  check(name + ': Terminal 1 opens with one departures deck', d.terminals[0]?.active && decks.length === 1);
  if (g.length === 2 && g.filter(q => q.up).length === 1 && flat === 0) two++;
  if (expect === 'none') { check(name + ': no ramp fits', g.length === 0); continue; }
  if (expect === 'any') { check(name + ': at least one built ramp', g.length >= 1); }
  else check(name + ': a built ramp up and a built ramp down, and no deck end without one', g.length === 2 && g.filter(q => q.up).length === 1 && flat === 0);
  // the deck: at grade at both ends, level at deck height over the kerb
  if (dk && g.length === 2 && flat === 0) check(name + ': the deck is at grade where its ramps leave their roads and level between', (f?.scheme === 'trumpet' ? [dk.zs[0], dk.zs[dk.zs.length - 1]].sort().join() === '0,1' : dk.zs[0] === 0 && dk.zs[dk.zs.length - 1] === 0) && Math.max(...dk.zs) === 1);   // (a trumpet's deck stays level at its far end, where it is a turning head)
}
console.log(two + ' of ' + layouts.length + ' layouts have a built ramp up and a built ramp down');
check('all the layouts but one have both ramps (' + two + ' of ' + layouts.length + ')', two >= layouts.length - 1);
// a day's flying on four of them, one of each kind of ramp
for (const i of [0, 4, 7, 15]) { const [name, edit] = layouts[i]; const w = sampleWorld(); edit(w); const sim = new Sim(w, 7); sim.relayout(); let ms = 0, st = 0, px = 0; sim.onDayEnd = r => { ms += r.stats.missed; st += r.stats.stranded; px += r.stats.paxDep; }; sim.startDay(); while (sim.day < 1) sim.step(0.25);
  console.log('   a day on ' + name + ': departing', px, 'missed', ms, 'stranded', st); check('a day on ' + name + ' flies with 0 missed and 0 stranded', ms === 0 && st === 0 && px > 1000); }
// v0.82 (from a review): cars for the deck drive the ramps, on every layout that has turnarounds; and three faults found then
const byRamp = (name, edit) => { const w = sampleWorld(); edit(w); const sim = new Sim(w, 7); sim.relayout(); const E = sim.d.road.edges; const ramps = sim.d.rampRefs; let inN = 0, inR = 0, outN = 0, outR = 0; const deckCars = new Set();
  const sp = sim.spawnCar.bind(sim); sim.spawnCar = (party, pick, pts, eids, stage, curb, entry) => { const on = eids.some(e => e >= 0 && ramps.has(E[e].ref));
    if (stage === 'in' && curb && curb.zone.auto && curb.zone.auto.deck === 'dep') { inN++; if (on) inR++; deckCars.add(party); } else if (stage === 'out' && deckCars.has(party)) { outN++; if (on) outR++; }
    return sp(party, pick, pts, eids, stage, curb, entry); };
  const lv = sim.exitRoute.bind(sim); sim.exitRoute = (from, zoneId, avoid) => { const r = lv(from, zoneId, avoid); const z = sim.d.zones.find(q => q.id === zoneId); if (z && z.auto && z.auto.deck === 'dep') { outN++; if (r.eids.some(e => e >= 0 && ramps.has(E[e].ref))) outR++; } return r; };
  let st = 0, ms = 0; sim.onDayEnd = r => { st += r.stats.stranded; ms += r.stats.missed; }; sim.startDay(); while (sim.day < 1) sim.step(0.25);
  console.log('   ' + name + ': to the deck by its ramp', inR, 'of', inN, '| from it by its ramp', outR, 'of', outN, '| turnarounds', sim.d.heads.length, '| missed', ms, 'stranded', st);
  return { inN, inR, outN, outR, st, ms, sim }; };
for (const i of [15, 16, 17, 14]) { const [name, edit] = layouts[i]; const r = byRamp(name, edit);
  check(name + ': nine in ten cars for the deck climb its ramp and nine in ten leave by its ramp, with nobody stranded', r.inN > 500 && r.inR >= r.inN * 0.9 && r.outN > 500 && r.outR >= r.outN * 0.9 && r.st === 0); }
// a drive that joins a turnaround too does not confuse which way round it is
{ const w = sampleWorld(); layouts[1][1](w); w.zones.push({ id: 960, type: 'parking', level: 0, x: 3345, y: 2850, w: 120, h: 100, tier: 0 });
  const sim = new Sim(w, 7); sim.relayout(); const hd = sim.d.heads[0]; const far = hd ? sim.ringFar(hd) : -1; const p = far >= 0 ? sim.d.road.nodes[far] : null;
  console.log('one approach road with a car park by the turnaround:', hd ? 'turnaround at ' + hd.x.toFixed(0) + ', the way round passes ' + (p ? p.x.toFixed(0) + ',' + p.y.toFixed(0) : '-') : 'no turnaround');
  check('with a car park whose drive joins the turnaround, the way round still passes its far side', !!hd && !!p && p.x > hd.x + 10); }
// a second hall on the same drawn road: no ramp is laid along its face
for (const gap of [150, 250]) { const w = sampleWorld(); through(w, 2900, 1500, 3900); const x = 2880 - gap - 330;
  w.zones.push({ id: 970, type: 'checkin', level: 1, x, y: 2810, w: 330, h: 60, tier: 0, pair: 971, site: w.sites[0].id }, { id: 971, type: 'claim', level: 0, x, y: 2810, w: 330, h: 60, tier: 0, pair: 970, site: w.sites[0].id });
  const d = derive(w); const low = d.decks.flatMap(dk => dk.pts.filter((q, i) => dk.zs[i] < 0.99 || dk.ws[i] < 12)); const kerbs = d.zones.filter(z => z.type === 'curb' && z.auto);
  const hit = low.filter(q => kerbs.some(z => q.x > z.x - 1 && q.x < z.x + z.w + 1 && q.y > z.y - 1 && q.y < z.y + z.h + 1)).length;
  console.log('a second hall ' + gap + ' m west on the same drawn road:', d.autoRoads.filter(q => q.rg).length, 'ramps,', hit, 'ramp points on a kerb');
  check('with a second hall ' + gap + ' m along the same road, no ramp lies on either hall kerb', hit === 0); }
// (v0.84: and the two other faults of that review)
{ const cross = (a, b, c, d) => { const o = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x); return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0; };
  // a second hall just past the end of a road the first hall ran on: its forecourt does not cross the added stretch or stand on the turnaround
  const w = sampleWorld(); layouts[16][1](w);
  w.zones.push({ id: 980, type: 'checkin', level: 1, x: 3420, y: 2810, w: 300, h: 60, tier: 0, pair: 981, site: w.sites[0].id }, { id: 981, type: 'claim', level: 0, x: 3420, y: 2810, w: 300, h: 60, tier: 0, pair: 980, site: w.sites[0].id });
  const d = derive(w); const mine = q => q.id >= 800000 + 11 * 4 && q.id < 800000 + 11 * 4 + 4; const ext = d.autoRoads.filter(q => q.fore === 'link' && mine(q)); const other = d.autoRoads.filter(q => (q.fore === 'face' || q.fore === 'link') && !mine(q));
  const x = other.filter(q => ext.some(e => cross(q.a, q.b, e.a, e.b))).length; const onHead = other.filter(q => d.heads.some(h => { const t = Math.max(0, Math.min(1, ((h.x - q.a.x) * (q.b.x - q.a.x) + (h.y - q.a.y) * (q.b.y - q.a.y)) / ((q.b.x - q.a.x) ** 2 + (q.b.y - q.a.y) ** 2 || 1))); return Math.hypot(h.x - q.a.x - t * (q.b.x - q.a.x), h.y - q.a.y - t * (q.b.y - q.a.y)) < 20; })).length;
  console.log('a second hall past the end of a road the first ran on:', ext.length, 'added stretch(es),', other.length, 'forecourt roads of the second hall,', x, 'crossing a stretch,', onHead, 'through a turnaround');
  check('a hall is not run on along a second hall face: the second lays its own forecourt, and nothing of it crosses an added stretch or a turnaround', other.length >= 3 && x === 0 && onHead === 0); }
{ // a taxiway stub beside where the turnaround would go: no turnaround on its pavement
  const w = sampleWorld(); layouts[16][1](w); w.ways.push({ id: w.nextId++, kind: 'taxi', a: { x: 3470, y: 2700 }, b: { x: 3470, y: 2882 }, cls: 2 });
  const d = derive(w); const near = d.heads.filter(h => Math.abs(h.x - 3470) < 52 && h.y > 2690 && h.y < 2940).length;
  console.log('a taxiway stub ending beside the run-on:', d.heads.length, 'turnaround(s),', near, 'within reach of the taxiway');
  check('no turnaround is laid on or beside a taxiway', near === 0); }
// v0.81: a terminal facing each way (its airside to the north, east, south, west), on bare ground: a road drawn through
// along the hall's landside face, and one running past 110 m off it
for (const air of ['n', 'e', 's', 'w']) for (const off of [27, 110]) {
  const w = sampleWorld(); w.zones = []; w.sites = []; w.rounds = []; w.ways = [];
  const site = { id: w.nextId++, x: 4200, y: 3600, w: air === 'n' || air === 's' ? 540 : 290, h: air === 'n' || air === 's' ? 290 : 540 }; w.sites.push(site);
  const parts = planTerminal(site, air); const ids = parts.map(() => w.nextId++);
  parts.forEach((q, i) => w.zones.push({ id: ids[i], type: q.type, level: q.level, ...q.rect, tier: 0, site: site.id, cls: q.type === 'concourse' ? 2 : undefined,
    pair: q.type === 'checkin' ? ids[parts.findIndex(o => o.type === 'claim')] : q.type === 'claim' ? ids[parts.findIndex(o => o.type === 'checkin')] : undefined }));
  const h = w.zones.find(z => z.type === 'checkin'); const out = { n: { x: 0, y: 1 }, s: { x: 0, y: -1 }, e: { x: -1, y: 0 }, w: { x: 1, y: 0 } }[air]; const al = { x: -out.y, y: out.x };
  const c = { x: h.x + h.w / 2, y: h.y + h.h / 2 }; const half = (out.x ? h.w : h.h) / 2; const P = t => ({ x: c.x + out.x * (half + off) + al.x * t, y: c.y + out.y * (half + off) + al.y * t });
  road(w, P(-900), P(900)); road(w, P(-900), { x: P(-900).x + out.x * 60, y: P(-900).y + out.y * 60 });
  const d = derive(w); const g = d.autoRoads.filter(q => q.rg).map(q => q.rg); const dk = d.decks.find(q => !q.branch); const f = d.autoRoads.find(q => q.fore === 'face');
  const name = 'airside to the ' + { n: 'north', e: 'east', s: 'south', w: 'west' }[air] + ', a road ' + (off === 27 ? 'drawn along the landside face' : 'running past 110 m off it');
  console.log(name + ':', f ? 'forecourt ' + f.scheme : dk ? 'drawn frontage' : 'no deck', '|', g.map(q => (q.up ? 'up' : 'down') + (q.path ? ' slip' : ' other')).join(', ') || 'no ramp');
  check(name + ': one deck with a slip ramp up and a slip ramp down, on the hall side of the road', !!dk && !dk.flat && g.length === 2 && g.filter(q => q.up).length === 1 && g.every(q => q.path && q.n.x * out.x + q.n.y * out.y < -0.9));
}
console.log(failed ? failed + ' CHECK(S) FAILED' : 'all checks passed'); if (failed) process.exit(1);
`;
const dir = mkdtempSync(join(tmpdir(), 'forecourts-')); const out = join(dir, 'run.mjs');
await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' });
await import(out);
