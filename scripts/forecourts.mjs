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
