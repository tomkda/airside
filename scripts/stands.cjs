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
  check('Terminal 1 is open throughout', s5.open);
  console.log(fails ? fails + ' CHECK(S) FAILED' : 'all checks passed');
  await b.close(); process.exit(fails ? 1 : 0);
})();
