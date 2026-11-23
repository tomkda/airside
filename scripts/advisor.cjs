// v0.59: the advisor's buttons, driven on the built page (needs playwright; run npm run build first). Exits 1 if a check fails.
const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1500, height: 900 } });
  p.on('pageerror', e => console.log('ERR', e.message));
  await p.goto('file://' + path.resolve(__dirname, '../dist/index.html'));
  await p.waitForTimeout(800);
  let fails = 0; const check = (what, ok) => { console.log((ok ? '  ok: ' : '  FAIL: ') + what); if (!ok) fails++; };
  // an airport with three things wrong: six stands, one link to the runway, three security lanes staffed
  await p.evaluate(() => { const g = window.__game, w = g.sim.world; g.ctl.paused = true;
    const links = w.ways.filter(q => q.kind === 'taxi' && Math.abs(q.a.y - 2300) < 1); const keep = links.find(q => q.a.x === 3200);
    w.ways = w.ways.filter(q => !links.includes(q) || q === keep);
    const c = w.zones.find(z => z.type === 'concourse'); c.stands = c.stands.slice(0, 6); g.sim.staff.screeners = 9; g.ui.changed();
    while (g.sim.day < 2) g.sim.step(0.25);
    g.ui.tab = 'ops'; document.body.classList.add('panel-open'); g.ui.refresh(true); });
  await p.waitForTimeout(300);
  const st = () => p.evaluate(() => { const g = window.__game; return { cards: [...document.querySelectorAll('.advice li b')].map(e => e.textContent), buttons: [...document.querySelectorAll('[data-advrun]')].map(e => e.dataset.advrun + ': ' + e.textContent.trim()),
    gates: g.sim.d.gates.length, taxi: g.sim.world.ways.filter(q => q.kind === 'taxi').length, screeners: g.sim.staff.screeners, money: Math.round(g.sim.money), conc: g.sim.world.zones.find(z => z.type === 'concourse').w }; });
  const s0 = await st(); console.log('advice:', s0.cards.join(' | ')); console.log('buttons:', s0.buttons.join(' | '));
  check('the advisor lists what is wrong, each with a priced button', s0.cards.length >= 2 && s0.buttons.length >= 2 && s0.buttons.every(t => /\$|Fit/.test(t)));
  const click = async key => { const n = await p.evaluate(k => { const e = [...document.querySelectorAll('[data-advrun]')].find(q => q.dataset.advrun.startsWith(k)); if (!e) return 0; e.click(); return 1; }, key); await p.waitForTimeout(300); return n; };
  if (await click('staff')) { const s = await st(); console.log('hired:', s0.screeners, '→', s.screeners, 'screeners'); check('Hire adds the screeners the busiest hour needed', s.screeners > s0.screeners && (s.screeners - s0.screeners) % 3 === 0); }
  else check('there is a staffing card for security', false);
  if (await click('par')) { const s = await st(); console.log('taxiways:', s0.taxi, '→', s.taxi); check('Lay it lays the parallel taxiway and charges for it', s.taxi === s0.taxi + 1 && s.money < s0.money); const again = await st(); check('its card is gone once laid', !again.buttons.some(t => t.startsWith('par'))); }
  else check('there is a parallel-taxiway card', false);
  const s1 = await st();
  if (s1.buttons.some(t => t.startsWith('stands'))) { await click('stands'); const s = await st(); console.log('gates:', s1.gates, '→', s.gates); check('Build builds the stands next to those already there', s.gates > s1.gates && s.money < s1.money); }
  else console.log('  (no flight was turned away for gates on this seed: no stands card)');
  await p.keyboard.press('Control+z'); await p.waitForTimeout(300);
  const s2 = await st(); check('each upgrade is one undo step', s2.gates === s1.gates || s2.taxi === s1.taxi - 1);
  // Show moves the plan to the thing
  const cam0 = await p.evaluate(() => ({ x: window.__game.ren.cam.x, y: window.__game.ren.cam.y }));
  const shown = await p.evaluate(() => { const e = document.querySelector('[data-advshow]'); if (!e) return false; e.click(); return true; }); await p.waitForTimeout(300);
  const cam1 = await p.evaluate(() => ({ x: window.__game.ren.cam.x, y: window.__game.ren.cam.y, heat: window.__game.ren.overlay }));
  check('Show takes the plan there with the overlay on', shown && cam1.heat && (cam1.x !== cam0.x || cam1.y !== cam0.y));
  console.log(fails ? fails + ' CHECK(S) FAILED' : 'all checks passed');
  await b.close(); process.exit(fails ? 1 : 0);
})();
