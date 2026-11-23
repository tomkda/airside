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
  // Show moves the plan to the thing
  const cam0 = await p.evaluate(() => ({ x: window.__game.ren.cam.x, y: window.__game.ren.cam.y }));
  const shown = await p.evaluate(() => { const e = document.querySelector('[data-advshow]'); if (!e) return false; e.click(); return true; }); await p.waitForTimeout(300);
  const cam1 = await p.evaluate(() => ({ x: window.__game.ren.cam.x, y: window.__game.ren.cam.y, heat: window.__game.ren.overlay }));
  check('Show takes the plan there with the overlay on', shown && cam1.heat && (cam1.x !== cam0.x || cam1.y !== cam0.y));
  const click = async key => { const n = await p.evaluate(k => { const e = [...document.querySelectorAll('[data-advrun]')].find(q => q.dataset.advrun.startsWith(k)); if (!e) return 0; e.click(); return 1; }, key); await p.waitForTimeout(300); return n; };
  if (await click('staff')) { const s = await st(); console.log('hired:', s0.screeners, '→', s.screeners, 'screeners'); check('Hire adds the screeners the busiest hour needed', s.screeners > s0.screeners && (s.screeners - s0.screeners) % 3 === 0); }
  else check('there is a staffing card for security', false);
  if (await click('par')) { const s = await st(); console.log('taxiways:', s0.taxi, '→', s.taxi); check('Lay it lays the parallel taxiway and charges for it', s.taxi === s0.taxi + 1 && s.money < s0.money); const again = await st(); check('its card is gone once laid', !again.buttons.some(t => t.startsWith('par'))); }
  else check('there is a parallel-taxiway card', false);
  const s1 = await st();
  if (s1.buttons.some(t => t.startsWith('stands'))) { await click('stands'); const s = await st(); console.log('gates:', s1.gates, '→', s.gates); check('Build builds the stands next to those already there', s.gates > s1.gates && s.money < s1.money); }
  else console.log('  (no flight was turned away for gates on this seed: no stands card)');
  const sA = await st();
  check('a card acted on is put away for the day (no second charge)', !sA.buttons.some(t => t.startsWith('staff') || t.startsWith('par') || t.startsWith('stands')));
  await p.keyboard.press('Control+z'); await p.waitForTimeout(300);
  const s2 = await st(); check('undo takes back the last upgrade alone', (sA.gates > s1.gates ? s2.gates === s1.gates : s2.taxi === sA.taxi - 1) && s2.screeners === sA.screeners);
  if (sA.gates > s1.gates) await p.keyboard.press('Control+z'); await p.keyboard.press('Control+z'); await p.waitForTimeout(300);
  const s3 = await st(); check('and undone back to the hire, the hired screeners go too', s3.screeners === s0.screeners && s3.taxi === s0.taxi);
  // a module with its dial set and the people already on the roll: nothing is hired, the dial is raised
  const dl = await p.evaluate(() => { const g = window.__game; const sec = g.sim.world.zones.find(z => z.type === 'security'); g.sim.staff.screeners = 24; sec.staff = 2; g.ui.changed();
    const d0 = g.sim.day; while (g.sim.day === d0) g.sim.step(0.25); g.ui.refresh(true);
    const b = [...document.querySelectorAll('[data-advrun]')].find(q => q.dataset.advrun.startsWith('staff')); const label = b ? b.textContent.trim() : ''; const n0 = g.sim.staff.screeners; if (b) b.click();
    return { label, hired: g.sim.staff.screeners - n0, dial: sec.staff, open: g.sim.procs.get(sec.id).servers }; });
  console.log('dial at 2 with 24 screeners:', JSON.stringify(dl));
  check('where the people are on the roll and the dial holds them back, the dial is raised and nobody is hired', /Staff them/.test(dl.label) && dl.hired === 0 && dl.dial > 2 && dl.open === dl.dial);
  // every stand built and flights still turned away: lengthen, and nothing built is lost
  const ex = await p.evaluate(() => { const g = window.__game, w = g.sim.world; const c = w.zones.find(z => z.type === 'concourse'); const sec = w.zones.find(z => z.type === 'security'); delete sec.staff;
    c.x = 3000; c.w = 200; c.stands = undefined; g.ui.changed(); const gates0 = g.sim.d.gates.length;
    const d0 = g.sim.day; while (g.sim.day === d0) g.sim.step(0.25); g.ui.refresh(true);
    // (asked directly: whether a flight is turned away for gates depends on the day's dice)
    const r = g.ui.resolveAdvice({ key: 'x', kind: 'stands', n: 2, zone: c.id, title: '', why: '', weight: 1 }); const label = r && r.run ? r.label : (r && r.why) || '(none)';
    const m = g.sim.money; if (r && r.run) r.run();
    return { label, gates0, gates: g.sim.d.gates.length, w: c.w, idle: g.ui.idleStands(c).length, offers: g.sim.d.gateSlots.filter(q => !q.on).length, paid: Math.round(m - g.sim.money) }; });
  console.log('a 200 m concourse with every stand built:', JSON.stringify(ex));
  check('lengthening keeps every built stand a gate and opens new places', /Lengthen/.test(ex.label) && ex.w > 200 && ex.gates >= ex.gates0 && ex.idle === 0 && ex.offers > 0 && ex.paid > 0);
  console.log(fails ? fails + ' CHECK(S) FAILED' : 'all checks passed');
  await b.close(); process.exit(fails ? 1 : 0);
})();
