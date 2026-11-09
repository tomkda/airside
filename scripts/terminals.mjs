// Terminals: build T2 without claim (closed), add claim (opens), extend T1 with a second gate area.
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
const entry = `
import { Sim } from './src/sim';
import { sampleWorld } from './src/sample';
const sim = new Sim(sampleWorld(), 5); const w = sim.world;
const Z = (type, level, x, y, ww, h, extra = {}) => w.zones.push({ id: w.nextId++, type, level, x, y, w: ww, h, tier: 0, ...extra });
const R = (ax, ay, bx, by, lanes = 4) => w.ways.push({ id: w.nextId++, kind: 'road', a: { x: ax, y: ay }, b: { x: bx, y: by }, cls: 0, lanes });
const show = (tag) => console.log(tag, sim.d.terminals.map(t => t.name + (t.active ? ' OPEN' : ' CLOSED (' + t.problems.join('; ') + ')') + ' areas ' + t.gateAreas + ' gates ' + t.gates).join(' | '));
const perTerm = () => { const m = {}; for (const f of sim.flights) { const t = sim.d.termOf.get(f.gate.zone.id); m[t ? t.name : '?'] = (m[t ? t.name : '?'] || 0) + 1; } return JSON.stringify(m); };
show('start:');
// T2 east, no claim
Z('concourse', 1, 3700, 2620, 600, 80, { cls: 2 }); Z('security', 1, 3940, 2700, 120, 60); Z('checkin', 1, 3830, 2760, 340, 60); Z('curb', 0, 3780, 2820, 440, 30);
R(3730, 5700, 3730, 2835); R(3730, 2835, 3780, 2835); R(4220, 2835, 4270, 2835); R(4270, 2835, 4270, 5700);
sim.relayout(); sim.startDay(); show('T2 without claim:'); console.log('  flights by terminal', perTerm());
while (sim.day < 1) sim.step(0.25);
Z('claim', 0, 3900, 2650, 200, 170, { units: 4 }); sim.relayout(); sim.startDay(); show('T2 with claim:'); console.log('  flights by terminal', perTerm());
const d0 = sim.day; const st = new Map(); const o2 = sim.stuck.bind(sim);
sim.stuck = (p, why) => { if (!p.stranded) { const k = why + ' | ' + sim.d.termOf.get(p.flight.gate.zone.id)?.name + ' dep=' + p.dep + ' zone=' + (sim.d.zoneAt({x:p.x,y:p.y}, p.level)?.type); st.set(k, (st.get(k)||0)+1); } o2(p, why); };
sim.onDayEnd = r => console.log('  day', r.label, 'flights', r.stats.flights, 'cxl', r.stats.cancelled, 'missed', r.stats.missed, 'stranded', r.stats.stranded, 'sat', r.sat.toFixed(0), 'concessions $', Math.round(r.stats.rev.shops + r.stats.rev.food + r.stats.rev.lounges));
while (sim.day < d0 + 2) sim.step(0.25);
Z('concourse', 1, 2400, 2620, 400, 80, { cls: 1 }); sim.relayout(); sim.startDay(); show('T1 + second gate area (E175):'); console.log('  flights by terminal', perTerm());
Z('concourse', 1, 4600, 2620, 300, 80, { cls: 2 }); sim.relayout(); show('lone gate area:');
console.log('stranded reasons:', JSON.stringify([...st.entries()]));
while (sim.day < d0 + 3) sim.step(0.25);
// v0.8 frontage: curbs grow from the road along Terminal 1's face; the road's offset decides.
const front = w.ways.find(x => x.kind === 'road' && x.a.y === 2898 && x.b.y === 2898);
const curbs = () => sim.d.zones.filter(z => z.auto && sim.d.termOf.get(z.auto.module)?.id === 1).map(z => (z.level ? 'L1 ' : 'G ') + z.auto.deck).join(', ') || 'none';
const t1 = () => (sim.d.terminals[0].active ? 'open' : 'closed: ' + sim.d.terminals[0].problems.join('; ')) + ' | decks ' + sim.d.decks.length;
const sideA = w.ways.find(x => x.kind === 'road' && x.a.x === front.a.x && x.b.y === 2898), sideB = w.ways.find(x => x.kind === 'road' && x.a.x === front.b.x && x.a.y === 2898);
const at = y => { front.a.y = front.b.y = y; sideA.b.y = y; sideB.a.y = y; sim.relayout(); };
console.log('frontage 20 m:', curbs(), '|', t1());
at(2920); console.log('frontage 42 m:', curbs(), '|', t1());
at(2960); console.log('frontage 82 m:', curbs(), '|', t1());
at(2898); console.log('frontage back:', curbs(), '|', t1());
`;
const dir = mkdtempSync(join(tmpdir(), 'term-')); const out = join(dir, 'run.mjs');
await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' });
await import(out);
