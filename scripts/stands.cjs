// v0.56: stands are built, not given. Drives the built page (needs playwright; run npm run build first). Exits 1 if a check fails.
const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1500, height: 900 } });
  p.on('pageerror', e => console.log('ERR', e.message));
  await p.goto('file://' + path.resolve(__dirname, '../dist/index.html'));
  await p.waitForTimeout(800);
  let fails = 0; const check = (what, ok) => { console.log((ok ? '  ok: ' : '  FAIL: ') + what); if (!ok) fails++; };
  const st = () => p.evaluate(() => { const g = window.__game, d = g.sim.d, w = g.sim.world;
    const sat = w.zones.filter(z => z.type === 'concourse').pop();
    const mine = d.gateSlots.filter(s => s.zone.id === sat.id);
    return { gates: d.gates.length, aprons: d.aprons.length, money: Math.round(g.sim.money), concs: w.zones.filter(z => z.type === 'concourse').length,
      satId: sat.id, satStands: sat.stands ? sat.stands.length : -1, offered: mine.filter(s => !s.on).length, built: mine.filter(s => s.on).length,
      satAprons: d.aprons.filter(a => a.zone.id === sat.id).length, satShops: (d.shops.get(sat.id) || []).length, open: d.terminals[0].active }; });
  const s0 = await st();
  console.log('sample:', s0.gates, 'gates, its concourse lists', s0.satStands, 'built stands');
  check('the sample keeps its 14 gates, now as built stands', s0.gates === 14 && s0.satStands === 14 && s0.offered === 0);
  // draw a satellite concourse: no stand appears with it
  const d = await p.evaluate(() => { const g = window.__game; g.ctl.paused = true; g.ui.setTool('satellite'); g.ren.cam.x = 4100; g.ren.cam.y = 2700; g.ren.cam.zoom = 0.8;
    const [ax, ay] = g.ren.P(3900, 2620); const [bx, by] = g.ren.P(4300, 2680); return { ax, ay, bx, by }; });
  await p.waitForTimeout(200);
  await p.mouse.move(d.ax, d.ay); await p.mouse.down();
  for (let k = 1; k <= 8; k++) { await p.mouse.move(d.ax + (d.bx - d.ax) * k / 8, d.ay + (d.by - d.ay) * k / 8); await p.waitForTimeout(30); }
  await p.mouse.up(); await p.waitForTimeout(400);
  const s1 = await st();
  console.log('a satellite drawn:', s1.concs, 'concourses,', s1.gates, 'gates |', s1.offered, 'places for a stand offered, 0 paved:', s1.satAprons, 'aprons there');
  check('a new concourse has no gates and no apron: its walls only offer places for stands', s1.concs === s0.concs + 1 && s1.gates === s0.gates && s1.satStands === 0 && s1.offered > 0 && s1.satAprons === 0);
  check('it is fitted out all the same (window walls with seating and shops)', s1.satShops > 0);
  // build one side: paid for, paved, gated
  const r = await p.evaluate(id => { const g = window.__game; const side = g.sim.d.gateSlots.find(s => s.zone.id === id).side;
    const sls = g.sim.d.gateSlots.filter(s => s.zone.id === id && s.side === side); const m0 = g.sim.money;
    g.ui.buildStands(sls, true); return { n: sls.length, paid: Math.round(m0 - g.sim.money), side }; }, s1.satId);
  const s2 = await st();
  console.log('built the', r.side, 'side:', r.n, 'stands for $' + r.paid.toLocaleString(), '|', s2.gates, 'gates,', s2.satAprons, 'apron(s) there');
  check('building a side pays for its stands and paves them', s2.built === r.n && s2.gates === s0.gates + r.n && r.paid > 0 && s2.satAprons >= 1 && s2.offered === s1.offered - r.n);
  // click one of the dashed places on the map: the inspector offers to build it
  const c = await p.evaluate(id => { const g = window.__game; g.ui.setTool('select'); const sl = g.sim.d.gateSlots.find(s => s.zone.id === id && !s.on);
    const m = { x: (sl.door.x + sl.front.x) / 2, y: (sl.door.y + sl.front.y) / 2 }; const [x, y] = g.ren.P(m.x, m.y); return { x, y, key: sl.key }; }, s1.satId);
  await p.mouse.click(c.x, c.y); await p.waitForTimeout(300);
  const btn = await p.evaluate(() => [...document.querySelectorAll('[data-act="gateOn"]')].map(e => e.textContent).join('|'));
  check('clicking a dashed place offers to build a stand there, with its price', /Build a stand here/.test(btn) && /\$/.test(btn));
  await p.click('[data-act="gateOn"]'); await p.waitForTimeout(300);
  const s3 = await st();
  check('one click builds it', s3.built === s2.built + 1 && s3.money < s2.money);
  // remove it again: 40% back; undo brings it back
  const m3 = s3.money; await p.click('[data-act="gateOff"]'); await p.waitForTimeout(300);
  const s4 = await st();
  check('removing a stand gives part of its cost back and un-paves it', s4.built === s2.built && s4.money > m3 && s4.money < s2.money);
  await p.keyboard.press('Control+z'); await p.waitForTimeout(300);
  const s5 = await st();
  check('undo puts the stand back', s5.built === s3.built);
  // move the satellite whole: its stands go with it
  const mv = await p.evaluate(id => { const g = window.__game; const z = g.sim.world.zones.find(q => q.id === id); g.ui.select({ kind: 'zone', zone: z });
    const [x, y] = g.ren.P(z.x + z.w * 0.35, z.y + z.h / 2); const [x2, y2] = g.ren.P(z.x + z.w * 0.35 + 64, z.y + z.h / 2 + 32); return { x, y, x2, y2, zx: z.x }; }, s1.satId);
  await p.mouse.move(mv.x, mv.y); await p.mouse.down();
  for (let k = 1; k <= 8; k++) { await p.mouse.move(mv.x + (mv.x2 - mv.x) * k / 8, mv.y + (mv.y2 - mv.y) * k / 8); await p.waitForTimeout(30); }
  await p.mouse.up(); await p.waitForTimeout(400);
  const s6 = await st(); const moved = await p.evaluate(id => window.__game.sim.world.zones.find(q => q.id === id).x, s1.satId);
  console.log('satellite moved', Math.round(moved - mv.zx), 'm east:', s6.built, 'stands still built of', s6.satStands);
  check('a concourse moved whole takes its built stands with it', moved !== mv.zx && s6.built === s5.built && s6.satStands === s5.satStands);
  // a pier drawn into the sample's concourse: the stands it does not stand on are still gates, the rest are kept and can be refunded
  const pr = await p.evaluate(() => { const g = window.__game, w = g.sim.world; const c = w.zones.find(z => z.type === 'concourse');
    const m0 = g.sim.money; const id = w.nextId++;
    w.zones.push({ id, type: 'concourse', level: 1, x: c.x + c.w - 40, y: c.y, w: 200, h: c.h, tier: 0, cls: c.cls, stands: [] }); g.ui.changed();
    const idle = g.ui.idleStands(c).length; const gates = g.sim.d.gates.filter(q => c.stands.some(t => Math.hypot(t.x - q.door.x, t.y - q.door.y) < 15)).length;
    return { id, cid: c.id, idle, gates, n: c.stands.length, m0 }; });
  console.log('a pier joined to the sample concourse:', pr.gates, 'of its', pr.n, 'stands are gates,', pr.idle, 'have no place');
  check('joining a pier keeps the stands it does not stand on (their keys change, their places do not)', pr.n === 14 && pr.gates + pr.idle === 14 && pr.gates >= 12);
  const rf = await p.evaluate(a => { const g = window.__game, w = g.sim.world; const c = w.zones.find(z => z.id === a.cid); const m = g.sim.money;
    g.ui.refundIdle(c); return { n: c.stands.length, back: g.sim.money - m, idle: g.ui.idleStands(c).length }; }, pr);
  check('stands with no place can be taken up (the sample\'s were paid for by nobody: nothing back)', rf.n === 14 - pr.idle && rf.idle === 0 && rf.back === 0);
  // every place the joined building offers, built one at a time: charged only where a gate comes of it
  const lone = await p.evaluate(a => { const g = window.__game; let built = 0, refused = 0, wrong = 0;
    const doors = g.sim.d.gateSlots.filter(s => !s.on && (s.zone.id === a.id || s.zone.id === a.cid)).map(s => s.door);
    for (const dr of doors.slice(0, 14)) { const sl = g.sim.d.gateSlots.find(s => !s.on && Math.hypot(s.door.x - dr.x, s.door.y - dr.y) < 1); if (!sl) continue;
      const m = g.sim.money, n = g.sim.d.gates.length; const ok = g.ui.buildStands([sl], true);
      if (ok) { built++; if (g.sim.d.gates.length !== n + 1 || g.sim.money >= m) wrong++; } else { refused++; if (g.sim.money !== m || g.sim.d.gates.length !== n) wrong++; } }
    const idle = g.sim.world.zones.reduce((t, z) => t + (z.stands ? g.ui.idleStands(z).length : 0), 0);
    return { built, refused, wrong, idle, offers: doors.length }; }, pr);
  console.log('one at a time on the joined building:', lone.built, 'built,', lone.refused, 'refused with nothing charged, of', lone.offers, 'offered');
  check('a stand is charged only where it becomes a gate, and none is left without a place', lone.wrong === 0 && lone.idle === 0 && lone.built + lone.refused > 0);
  // a larger aircraft size: smaller stands do not serve it for nothing
  const cl = await p.evaluate(a => { const g = window.__game, w = g.sim.world; const z = w.zones.find(q => q.id === a.id);
    const mine = () => g.sim.d.gates.filter(q => q.zone.id === z.id).length; const n0 = mine(), st0 = z.stands.length;
    z.cls = 3; g.ui.changed(); const n1 = mine(), idle = g.ui.idleStands(z).length; const m = g.sim.money; g.ui.refundIdle(z);
    return { n0, st0, n1, idle, back: g.sim.money - m, paid: 0.4 }; }, pr);
  console.log('the pier resized for the A380:', cl.n0, '→', cl.n1, 'gates,', cl.idle, 'smaller stands idle, taken up for $' + Math.round(cl.back).toLocaleString());
  check('smaller stands are not gates at a larger size, and are taken up at the usual part of their price', cl.n1 === 0 && cl.idle === cl.st0 && (cl.st0 === 0 || cl.back > 0));
  // undo right back to the start, then remove one of the sample's stands: the others stay
  for (let k = 0; k < 50; k++) { await p.keyboard.press('Control+z'); await p.waitForTimeout(60); }
  const u = await p.evaluate(() => { const g = window.__game, c = g.sim.world.zones.find(z => z.type === 'concourse');
    const before = g.sim.d.gates.length, n0 = (c.stands || []).length, m = g.sim.money;
    g.ui.buildStands([g.sim.d.gateSlots.find(s => s.zone.id === c.id && s.on)], false);
    return { before, n0, after: g.sim.d.gates.length, back: g.sim.money - m, concs: g.sim.world.zones.filter(z => z.type === 'concourse').length }; });
  console.log('undone to the start:', u.concs, 'concourse,', u.before, 'gates; one stand removed:', u.after);
  check('after undoing everything the sample still has its 14 built stands, and removing one leaves 13', u.before === 14 && u.n0 === 14 && u.after === 13 && u.back === 0);
  check('Terminal 1 is open throughout', s5.open);
  console.log(fails ? fails + ' CHECK(S) FAILED' : 'all checks passed');
  await b.close(); process.exit(fails ? 1 : 0);
})();
