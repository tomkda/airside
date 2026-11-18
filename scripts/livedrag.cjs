// v0.48: gates and holdrooms follow a taxiway as it is dragged. Drives the built page with the mouse (needs playwright;
// run npm run build first). Exits 1 if a check fails.
const { chromium } = require('playwright');
const path = require('path');
(async () => {
  // (software WebGL, so the 3D view renders headless for the v0.49 checks)
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 1500, height: 900 } });
  p.on('pageerror', e => console.log('ERR', e.message));
  await p.goto('file://' + path.resolve(__dirname, '../dist/index.html'));
  await p.waitForTimeout(800);
  let fails = 0; const check = (what, ok) => { console.log((ok ? '  ok: ' : '  FAIL: ') + what); if (!ok) fails++; };
  const state = () => p.evaluate(() => { const g = window.__game, d = g.sim.d;
    const A = g.sim.world.ways.find(w => w.kind === 'taxi' && Math.abs(w.a.y - w.b.y) < 1 && Math.abs(w.a.x - w.b.x) > 800);
    const gates = d.gateSlots.filter(s => s.zone.type === 'concourse');
    return { gates: gates.length, drawn: d.aprons.filter(a => !a.self).length, self: d.aprons.filter(a => a.self).length,
      holdY: Math.round(gates.reduce((t, s) => t + (s.stand?.y ?? s.pos?.y ?? 0), 0)), taxis: g.sim.world.ways.filter(w => w.kind === 'taxi').length,
      A: A && { a: A.a, b: A.b, c: A.c }, live: !!g.ui.live, sig: JSON.stringify(d.aprons.map(a => a.rect)) }; });
  // taxiway A, selected, and the screen point of its middle (its bend handle)
  const setup = await p.evaluate(() => { const g = window.__game, w = g.sim.world;
    const A = w.ways.find(q => q.kind === 'taxi' && Math.abs(q.a.y - q.b.y) < 1 && Math.abs(q.a.x - q.b.x) > 800);
    g.ctl.paused = true; g.ui.setTool('select'); g.ren.cam.x = (A.a.x + A.b.x) / 2; g.ren.cam.y = A.a.y - 60; g.ren.cam.zoom = 0.9;
    g.ren.selected = { kind: 'way', id: A.id }; const m = { x: (A.a.x + A.b.x) / 2, y: A.a.y };
    const [sx, sy] = g.ren.P(m.x, m.y); return { sx, sy, y: A.a.y, id: A.id }; });
  await p.waitForTimeout(300);
  const s0 = await state();
  console.log('before:', s0.gates, 'gates,', s0.drawn, 'drawn aprons,', s0.self, 'self-laid');
  // bend it 40 m towards the runway and hold
  await p.mouse.move(setup.sx, setup.sy); await p.mouse.down();
  for (let k = 1; k <= 8; k++) { await p.mouse.move(setup.sx, setup.sy - k * 5 * 0.9); await p.waitForTimeout(40); }
  await p.waitForTimeout(200);
  const s1 = await state();
  console.log('while bending:', s1.gates, 'gates,', s1.drawn, 'drawn aprons,', s1.self, 'self-laid | taxiway A middle', s1.A.c ? 'bent' : 'straight');
  check('the layout is rebuilt while the mouse is down', s1.live && s1.sig !== s0.sig);
  check('taxiway A is bent in the world while dragging', !!s1.A.c);
  // Esc puts it back
  await p.keyboard.press('Escape'); await p.mouse.up(); await p.waitForTimeout(200);
  const s2 = await state();
  check('Esc puts the taxiway and its gates back', !s2.live && !s2.A.c && s2.sig === s0.sig && s2.gates === s0.gates);
  // the same drag, let go: kept
  await p.mouse.move(setup.sx, setup.sy); await p.mouse.down();
  for (let k = 1; k <= 8; k++) { await p.mouse.move(setup.sx, setup.sy - k * 5 * 0.9); await p.waitForTimeout(40); }
  await p.waitForTimeout(150);
  const s3a = await state();
  await p.mouse.up(); await p.waitForTimeout(300);
  const s3 = await state();
  check('letting go keeps the bend, with the layout shown while dragging', !s3.live && !!s3.A.c && s3.sig === s3a.sig);
  // undo, then draw a new taxiway along the concourse's east end: its stands appear before the mouse is let go
  await p.keyboard.press('Control+z'); await p.waitForTimeout(300);
  const e = await p.evaluate(() => { const g = window.__game; const c = g.sim.world.zones.find(z => z.type === 'concourse');
    g.ui.setTool('taxi'); g.ren.selected = null; g.ren.cam.x = c.x + c.w + 60; g.ren.cam.y = c.y + c.h / 2; g.ren.cam.zoom = 0.8;
    const x = c.x + c.w + 120; const [ax, ay] = g.ren.P(x, c.y - 200); const [bx, by] = g.ren.P(x, c.y + c.h + 40); return { ax, ay, bx, by }; });
  await p.waitForTimeout(200);
  const s4 = await state();
  await p.mouse.move(e.ax, e.ay); await p.mouse.down();
  for (let k = 1; k <= 10; k++) { await p.mouse.move(e.ax + (e.bx - e.ax) * k / 10, e.ay + (e.by - e.ay) * k / 10); await p.waitForTimeout(40); }
  await p.waitForTimeout(200);
  const s5 = await state();
  // a save taken while drawing keeps nothing of the draft
  const sv = await p.evaluate(() => { const g = window.__game; g.ctl.save(); const k = Object.keys(localStorage).find(q => q.startsWith('airport-builder')); const j = JSON.parse(localStorage.getItem(k)); const w = j.world ?? j; return { n: w.ways.length, ids: w.ways.map(q => q.id), next: w.nextId, live: g.sim.world.ways.length }; });
  console.log('saved', sv.n, 'ways of', sv.live, 'in the world mid-draw, next id', sv.next);
  check('a save while drawing leaves the draft out', sv.n < sv.live && sv.ids.every(i => i < sv.next));
  console.log('drawing a taxiway along the east end:', s4.drawn, '→', s5.drawn, 'drawn aprons,', s4.taxis, '→', s5.taxis, 'taxiways in the world');
  check('a taxiway being drawn takes over a side before the mouse is let go', s5.live && s5.drawn > s4.drawn);
  await p.keyboard.press('Escape'); await p.mouse.up(); await p.waitForTimeout(200);
  const s6 = await state();
  check('Esc leaves no taxiway behind', !s6.live && s6.taxis === s4.taxis && s6.sig === s4.sig);
  // v0.49: in 3D, the selected building is grabbed by its roof and moved whole, with everything following
  const m = await p.evaluate(() => { const g = window.__game; g.ui.setTool('select'); g.ui.set3d(true);
    const z = g.sim.world.zones.find(q => q.type === 'concourse'); g.ren.selected = { kind: 'zone', id: z.id };
    return { id: z.id, x: z.x, y: z.y }; });
  await p.waitForTimeout(1500);
  const roof = await p.evaluate(id => { const g = window.__game; const z = g.sim.world.zones.find(q => q.id === id);
    const [sx, sy] = g.ren.P(z.x + z.w * 0.3, z.y + z.h / 2, 12); return { sx, sy }; }, m.id);   // (a little above the roof plane's height is fine: it is hit at the roof)
  const zxy = () => p.evaluate(id => { const g = window.__game; const z = g.sim.world.zones.find(q => q.id === id); return { x: z.x, y: z.y, live: !!g.ui.live, sig: JSON.stringify(g.sim.d.aprons.map(a => a.rect)) }; }, m.id);
  const before = await zxy();
  const drag3 = async () => { await p.mouse.move(roof.sx, roof.sy); await p.waitForTimeout(100); await p.mouse.down();
    for (let k = 1; k <= 8; k++) { await p.mouse.move(roof.sx - k * 6, roof.sy); await p.waitForTimeout(50); } await p.waitForTimeout(250); };
  await drag3();
  const mid = await zxy();
  console.log('3D: concourse at', before.x, before.y, '→ while dragging its roof', mid.x, mid.y);
  check('in 3D the selected building moves whole while its roof is dragged, with its stands following', mid.live && (mid.x !== before.x || mid.y !== before.y) && mid.sig !== before.sig);
  await p.keyboard.press('Escape'); await p.mouse.up(); await p.waitForTimeout(300);
  const back = await zxy();
  check('Esc puts it back', !back.live && back.x === before.x && back.y === before.y && back.sig === before.sig);
  await drag3(); const mid2 = await zxy(); await p.mouse.up(); await p.waitForTimeout(400);
  const kept = await zxy();
  check('letting go keeps it where it was shown', !kept.live && kept.x === mid2.x && kept.y === mid2.y && (kept.x !== before.x || kept.y !== before.y));
  const orbit = await p.evaluate(() => window.__game.ren.r3.controls.enabled);
  check('the view orbits again after the move', orbit);
  // a click (no drag) on the selected building's roof still selects: here a lot inside it, at terminal detail
  const lot = await p.evaluate(id => { const g = window.__game; g.ui.setLod?.('terminal'); g.ren.lod = 'terminal'; g.ren.focus = g.sim.world.zones.find(q => q.id === id).site ?? g.ren.focus;
    const z = g.sim.world.zones.find(q => q.id === id); g.ren.selected = { kind: 'zone', id }; const [sx, sy] = g.ren.P(z.x + z.w * 0.3, z.y + z.h / 2, 12); return { sx, sy }; }, m.id);
  await p.waitForTimeout(1200);
  const selBefore = await p.evaluate(() => JSON.stringify(window.__game.ren.selected));
  await p.mouse.move(lot.sx, lot.sy); await p.waitForTimeout(100); await p.mouse.down(); await p.mouse.up(); await p.waitForTimeout(300);
  const after = await p.evaluate(() => ({ sel: JSON.stringify(window.__game.ren.selected), drag: !!window.__game.ui.drag, live: !!window.__game.ui.live }));
  console.log('click on the roof: selection', selBefore, '→', after.sel);
  check('a click on the roof is a click: no move left hanging, and it picks again', !after.drag && !after.live && after.sel !== 'null');
  console.log(fails ? fails + ' CHECK(S) FAILED' : 'all checks passed');
  await b.close(); process.exit(fails ? 1 : 0);
})();
