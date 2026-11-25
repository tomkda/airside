// v0.60: banks of flights and connecting passengers. Exits 1 if a check fails.
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
const entry = `
import { derive } from './src/world';
import { sampleWorld } from './src/sample';
import { Sim } from './src/sim';
import { advise } from './src/advisor';
import { BANK } from './src/config';
let bad = 0;
const check = (what, ok) => { if (!ok) { bad++; console.log('   FAIL: ' + what); } };
const run = (w, prep) => { const sim = new Sim(w, 7); sim.moneyOn = false; sim.relayout(); if (prep) prep(sim); sim.startDay();
  let together = 0, landside = 0, peakGround = 0; const d0 = sim.day; let st = null; sim.onDayEnd = r => { st = r.stats; };
  const plan = sim.plan; const flights = sim.flights.slice();
  while (sim.day === d0) { sim.step(0.25);
    const B = sim.flights.filter(f => f.bank !== undefined && (f.state === 'stand' || f.state === 'taxiIn' || f.state === 'waitGate' || f.state === 'taxiOut' || f.state === 'holdDep'));
    together = Math.max(together, sim.flights.filter(f => f.bank !== undefined && f.state === 'stand').length); peakGround = Math.max(peakGround, B.length);
    for (const p of sim.pax) if (p.xfer && p.stage !== 'done' && (p.steps[0] === 'checkin' || p.steps[0] === 'security' || p.steps[0] === 'claim' || p.steps[0] === 'curb')) landside++; }
  return { sim, st, plan, flights, together, landside }; };
const line = (name, r) => console.log(name + ':', r.plan.scheduled, 'flights (bank', r.plan.bankAsked - r.plan.bankLost, 'of', r.plan.bankAsked + ') | on stand together at most', r.together, '| connected', r.st.xfer, 'missed their connection', r.st.xferMissed, '| missed', r.st.missed, 'stranded', r.st.stranded, 'cancelled', r.st.cancelled, '| held on the ground', (r.st.ground.hold + r.st.ground.gate).toFixed(0), 'min, stand-offs', r.st.ground.standoffs);

// 1. the sample with no bank is the day it always was (the other sims check the figures); with a morning bank:
const A = run(sampleWorld()); line('sample, no bank', A);
check('with no bank nobody connects and no flight is in one', A.st.xfer === 0 && A.plan.bankAsked === 0 && A.flights.every(f => f.bank === undefined));
const B = run(sampleWorld(), s => s.addBank('meridian', 7)); line('sample, a morning bank of ' + BANK.n, B);
const bf = B.flights.filter(f => f.bank !== undefined);
check('the bank is scheduled on top of the day: ' + BANK.n + ' more flights', B.plan.bankAsked === BANK.n && bf.length === BANK.n && B.plan.scheduled >= A.plan.scheduled + BANK.n - 2);
check('its flights land within the window and leave after the last has been down ' + BANK.connect + ' minutes', bf.every(f => f.schedArr >= 7 * 60 && f.schedArr <= 7 * 60 + BANK.window && f.schedDep >= 7 * 60 + BANK.window + BANK.connect));
check('they stand together', B.together >= BANK.n - 1);
const out = bf.reduce((t, f) => t + f.paxArr, 0);
console.log('   ' + B.st.xfer + ' of ' + out + ' arriving on the bank connected (' + Math.round(100 * B.st.xfer / out) + '%); seats filled by connections:', bf.map(f => (f.xferIn ?? 0) + '/' + f.paxDep).join(' '));
check('about a third of its arriving passengers change aircraft, and no departure is more than ' + BANK.maxIn * 100 + '% connections', B.st.xfer > out * 0.25 && B.st.xfer < out * 0.4 && bf.every(f => (f.xferIn ?? 0) <= f.paxDep * BANK.maxIn + 1));
check('connecting passengers never go landside', B.landside === 0);
check('nearly all make their connection, nobody is stranded and nothing is cancelled', B.st.xferMissed <= B.st.xfer * 0.05 && B.st.stranded === 0 && B.st.cancelled === 0);

// 2. six stands: the bank does not fit, and the advisor says to build stands
{ const w = sampleWorld(); const d = derive(w); const c = w.zones.find(z => z.type === 'concourse');
  c.stands = d.gateSlots.filter(s => s.zone.id === c.id && s.on).slice(0, 6).map(s => ({ x: s.door.x, y: s.door.y, paid: 0, cls: s.cls }));
  const C = run(w, s => s.addBank('meridian', 7)); line('six stands, a morning bank', C);
  check('with six stands part of the bank is turned away', C.plan.bankLost >= 2 && C.plan.rejectedGates >= C.plan.bankLost);
  const A2 = advise(C.sim); console.log('   advisor:', A2.map(a => a.kind + ' "' + a.title + '"').join(' | '));
  check('and the advisor says to build stands', A2.some(a => a.kind === 'stands')); }

// 3. a bank ends, and a save keeps the ones in force
{ const sim = new Sim(sampleWorld(), 7); sim.moneyOn = false; sim.relayout(); sim.addBank('meridian', 7); sim.addBank('larkspur', 17.5);
  const id = sim.banks[0].id; sim.endBank(id); sim.startDay();
  check('an ended bank leaves the schedule; the other stays', sim.banks.length === 1 && sim.flights.filter(f => f.bank !== undefined).length === BANK.n && sim.flights.every(f => f.bank !== id)); }
// 4. asking twice, and what asking pays
{ const sim = new Sim(sampleWorld(), 7); sim.relayout(); const m = sim.money;
  const a = sim.addBank('meridian', 7), b = sim.addBank('meridian', 7), c = sim.addBank('aurora', 7);
  check('one bank an airline and hour, none for an international carrier, and no signing bonus for a bank you asked for', a === true && b === false && c === false && sim.banks.length === 1 && sim.money === m);
  sim.offer = { airline: 'larkspur', kind: 'bank', bank: { hour: 12.5, n: BANK.n }, title: '', text: '', mult: 1, feeMult: 1, bonus: BANK.bonus, days: BANK.days }; sim.acceptOffer();
  check('an airline that came asking pays its bonus once', sim.money === m + BANK.bonus && sim.banks.length === 2 && new Set(sim.banks.map(q => q.id)).size === 2); }

// 5. every connection is to a gate in the same terminal, and nobody is left at a belt for a bag that was never loaded
{ const tOf = id => B.sim.d.termOf.get(id);
  check('connections are shared out only between gates of one terminal', bf.every(f => f.xferIn === undefined || true) && bf.every(f => tOf(f.gate.zone.id) === tOf(bf[0].gate.zone.id)));
  const sim = new Sim(sampleWorld(), 7); sim.relayout(); sim.startDay(); let stuck = 0;
  while (sim.t < 22 * 60) sim.step(0.25);
  for (const p of sim.pax) if (p.stage === 'waitBag' && sim.t - p.since > 60) stuck++;
  console.log('sample at 22:00: passengers who have waited over an hour for a bag:', stuck);
  check('no passenger waits for a bag that was never loaded', stuck === 0); }
// v0.70: the minimum connecting time: a fixed part and the walk between the two gates
{ const s0 = new Sim(sampleWorld(), 7); s0.relayout(); const T = s0.d.terminals[0]; const m = s0.terminalMct(T);
  console.log('minimum connecting time, sample:', Math.round(m.min), 'min between its furthest gates (' + m.walk.toFixed(1) + ' min of it on foot) | a bank leaves', BANK.window + BANK.connect, 'at most');
  check('the sample changes between its furthest gates in the fixed ' + BANK.mct + ' min and a walk of 3 to 12 min, well inside a bank', m.walk > 3 && m.walk < 12 && Math.abs(m.min - BANK.mct - m.walk) < 1e-9 && m.min < BANK.window + BANK.connect);
  const R0 = run(sampleWorld(), s => { s.addBank('meridian', 7); });
  check('so every connection of its morning bank is sold, as before', R0.plan.bankTooFar === 0 && R0.st.xfer > 300);
  // the same bank with no time on the ground between its last arrival and first departure: the walk no longer fits
  const keep = { connect: BANK.connect, window: BANK.window }; BANK.connect = 0; BANK.window = 20;
  const R1 = run(sampleWorld(), s => { s.addBank('meridian', 7); }); const A1 = advise(R1.sim).find(a => a.key === 'mct');
  // (the advice reads today's plan: the day after, with the same bank)
  const sim2 = new Sim(sampleWorld(), 7); sim2.moneyOn = false; sim2.relayout(); sim2.addBank('meridian', 7); sim2.startDay(); const A2 = advise(sim2).find(a => a.key === 'mct');
  BANK.connect = keep.connect; BANK.window = keep.window;
  console.log('   a bank with no time on the ground:', R1.plan.bankTooFar, 'connections not sold |', R1.st.xfer, 'connected (', R0.st.xfer, 'with the usual 40 min) | advice:', A2 ? A2.title : 'none');
  check('connections whose walk does not fit are not sold, fewer change aircraft, and the advisor says the gates are too far apart', R1.plan.bankTooFar > 0 && R1.st.xfer < R0.st.xfer && !!A2 && /furthest gates/.test(A2.why)); }
console.log(bad ? bad + ' CHECK(S) FAILED' : 'all checks passed');
if (bad) process.exit(1);
`;
const dir = mkdtempSync(join(tmpdir(), 'banks-'));
const out = join(dir, 'run.mjs');
await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' });
await import(out);
