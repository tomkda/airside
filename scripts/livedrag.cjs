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
  // v0.50: a runway's end stretches live, with the taxiways that follow it
  const rr = await p.evaluate(() => { const g = window.__game; g.ui.setTool('select'); const rw = g.sim.world.runways[0];
    g.ren.selected = { kind: 'runway', id: rw.id }; g.ren.cam.x = rw.b.x - 200; g.ren.cam.y = rw.b.y; g.ren.cam.zoom = 0.6;
    const L = Math.hypot(rw.b.x - rw.a.x, rw.b.y - rw.a.y), u = { x: (rw.b.x - rw.a.x) / L, y: (rw.b.y - rw.a.y) / L };
    const [sx, sy] = g.ren.P(rw.b.x, rw.b.y); const [tx, ty] = g.ren.P(rw.b.x + u.x * 300, rw.b.y + u.y * 300);
    return { sx, sy, tx, ty, L: Math.round(L) }; });
  await p.waitForTimeout(300);
  const rwState = () => p.evaluate(() => { const g = window.__game; const r = g.sim.d.runways[0]; const w = g.sim.world;
    return { len: Math.round(r.length), world: Math.round(Math.hypot(w.runways[0].b.x - w.runways[0].a.x, w.runways[0].b.y - w.runways[0].a.y)), live: !!g.ui.live,
      taxi: JSON.stringify(w.ways.filter(q => q.kind === 'taxi').map(q => [q.a, q.b])), n: w.ways.length }; });
  const r0 = await rwState();
  const pull = async () => { await p.mouse.move(rr.sx, rr.sy); await p.mouse.down();
    for (let k = 1; k <= 10; k++) { await p.mouse.move(rr.sx + (rr.tx - rr.sx) * k / 10, rr.sy + (rr.ty - rr.sy) * k / 10); await p.waitForTimeout(40); } await p.waitForTimeout(200); };
  await pull();
  const r1 = await rwState();
  console.log('runway', r0.len, 'm → while dragging its end', r1.len, 'm');
  check('the runway is longer in the layout before the mouse is let go', r1.live && r1.len > r0.len + 200);
  check('the taxiways that follow its end follow it while dragging', r1.taxi !== r0.taxi);
  await p.keyboard.press('Escape'); await p.mouse.up(); await p.waitForTimeout(250);
  const r2 = await rwState();
  check('Esc puts the runway and its taxiways back', !r2.live && r2.len === r0.len && r2.world === r0.world && r2.taxi === r0.taxi && r2.n === r0.n);
  await pull(); const r3a = await rwState(); await p.mouse.up(); await p.waitForTimeout(300);
  const r3 = await rwState();
  check('letting go keeps the runway as shown', !r3.live && r3.len === r3a.len && r3.taxi === r3a.taxi && r3.n === r3a.n);
  await p.keyboard.press('Control+z'); await p.waitForTimeout(300);
  // v0.52: taxiway A moved whole by its body, the ways joined to its ends stretching to stay joined
  const wmv = await p.evaluate(() => { const g = window.__game; g.ui.setTool('select'); const w = g.sim.world;
    const A = w.ways.find(q => q.kind === 'taxi' && Math.abs(q.a.y - q.b.y) < 1 && Math.abs(q.a.x - q.b.x) > 800);
    g.ren.selected = { kind: 'way', id: A.id }; g.ren.cam.x = (A.a.x + A.b.x) / 2; g.ren.cam.y = A.a.y; g.ren.cam.zoom = 0.6;
    const x = A.a.x + (A.b.x - A.a.x) * 0.3; const [sx, sy] = g.ren.P(x, A.a.y); const [tx, ty] = g.ren.P(x, A.a.y - 20); return { id: A.id, sx, sy, tx, ty }; });
  await p.waitForTimeout(300);
  const wst = () => p.evaluate(id => { const g = window.__game, w = g.sim.world; const A = w.ways.find(q => q.id === id);
    const joined = w.ways.filter(q => q !== A && q.kind === 'taxi' && [q.a, q.b].some(e => [A.a, A.b].some(f => Math.hypot(e.x - f.x, e.y - f.y) < 1))).length;
    return { y: A.a.y, joined, live: !!g.ui.live, sig: JSON.stringify(g.sim.d.aprons.map(a => a.rect)), n: w.ways.length }; }, wmv.id);
  const w0 = await wst();
  const slide = async () => { await p.mouse.move(wmv.sx, wmv.sy); await p.mouse.down(); for (let k = 1; k <= 8; k++) { await p.mouse.move(wmv.sx, wmv.sy + (wmv.ty - wmv.sy) * k / 8); await p.waitForTimeout(40); } await p.waitForTimeout(200); };
  await slide(); const w1 = await wst();
  console.log('taxiway A moved whole: y', w0.y, '→', w1.y, '| ways joined to its ends', w0.joined, '→', w1.joined);
  check('a taxiway moves whole while its body is dragged, with the gates following', w1.live && w1.y === w0.y - 20 && w1.sig !== w0.sig);
  check('the ways joined to its ends stay joined', w1.joined === w0.joined && w0.joined > 0);
  await p.keyboard.press('Escape'); await p.mouse.up(); await p.waitForTimeout(250);
  const w2 = await wst();
  check('Esc puts it back', !w2.live && w2.y === w0.y && w2.sig === w0.sig && w2.joined === w0.joined);
  await slide(); const w3a = await wst(); await p.mouse.up(); await p.waitForTimeout(300); const w3 = await wst();
  check('letting go keeps it, still joined', !w3.live && w3.y === w3a.y && w3.joined === w0.joined && w3.n === w0.n);
  await p.keyboard.press('Control+z'); await p.waitForTimeout(300);
  // a road whose ends meet roundabouts (Terminal Drive) does not slide off them: the move is refused and says why
  const td = await p.evaluate(() => { const g = window.__game; const w = g.sim.world;
    const T = w.ways.find(q => q.kind === 'road' && Math.abs(q.a.y - 3230) < 1 && Math.abs(q.b.y - 3230) < 1);
    g.ren.selected = { kind: 'way', id: T.id }; g.ren.cam.x = 3050; g.ren.cam.y = 3230; g.ren.cam.zoom = 0.8;
    const [sx, sy] = g.ren.P(2900, 3230); const [tx, ty] = g.ren.P(2900, 3190); return { id: T.id, sx, sy, tx, ty, roads: JSON.stringify(w.ways.filter(q => q.kind === 'road').map(q => [q.a, q.b])) }; });
  await p.waitForTimeout(300);
  await p.mouse.move(td.sx, td.sy); await p.mouse.down();
  for (let k = 1; k <= 8; k++) { await p.mouse.move(td.sx, td.sy + (td.ty - td.sy) * k / 8); await p.waitForTimeout(40); }
  await p.waitForTimeout(200);
  const tdm = await p.evaluate(() => ({ roads: JSON.stringify(window.__game.sim.world.ways.filter(q => q.kind === 'road').map(q => [q.a, q.b])), hint: document.querySelector('.hint, #hint')?.textContent ?? '' }));
  await p.mouse.up(); await p.waitForTimeout(300);
  const tdu = await p.evaluate(() => JSON.stringify(window.__game.sim.world.ways.filter(q => q.kind === 'road').map(q => [q.a, q.b])));
  console.log('Terminal Drive dragged:', tdm.hint.slice(0, 90));
  check('a road whose ends meet roundabouts is not slid off them, and says why', tdm.roads === td.roads && tdu === td.roads && /roundabout/.test(tdm.hint));
  // v0.53: the runway moved whole by its pavement, every taxiway on it carried along
  const rmv = await p.evaluate(() => { const g = window.__game; g.ui.setTool('select'); const rw = g.sim.world.runways[0];
    g.ren.selected = { kind: 'runway', id: rw.id }; const m = { x: (rw.a.x + rw.b.x) / 2 - 300, y: (rw.a.y + rw.b.y) / 2 };
    g.ren.cam.x = m.x; g.ren.cam.y = m.y + 100; g.ren.cam.zoom = 0.5;
    const [sx, sy] = g.ren.P(m.x, m.y); const [tx, ty] = g.ren.P(m.x, m.y - 60); return { sx, sy, tx, ty }; });
  await p.waitForTimeout(300);
  const rms = () => p.evaluate(() => { const g = window.__game, w = g.sim.world, rw = w.runways[0];
    const L = Math.hypot(rw.b.x - rw.a.x, rw.b.y - rw.a.y), hw = 30;
    const on = w.ways.filter(q => q.kind === 'taxi' && [q.a, q.b].some(e => { const t = Math.max(0, Math.min(1, ((e.x - rw.a.x) * (rw.b.x - rw.a.x) + (e.y - rw.a.y) * (rw.b.y - rw.a.y)) / (L * L))); return Math.hypot(e.x - (rw.a.x + t * (rw.b.x - rw.a.x)), e.y - (rw.a.y + t * (rw.b.y - rw.a.y))) < hw; })).length;
    return { y: rw.a.y, L: Math.round(L), on, live: !!g.ui.live, gates: g.sim.d.gateSlots.length, reach: g.sim.d.gateSlots.filter(s => s.reach !== false).length }; });
  const m0 = await rms();
  const pullR = async () => { await p.mouse.move(rmv.sx, rmv.sy); await p.mouse.down(); for (let k = 1; k <= 8; k++) { await p.mouse.move(rmv.sx, rmv.sy + (rmv.ty - rmv.sy) * k / 8); await p.waitForTimeout(40); } await p.waitForTimeout(200); };
  await pullR(); const m1 = await rms();
  console.log('runway moved whole: y', m0.y, '→', m1.y, '| taxiways on it', m0.on, '→', m1.on, '| length', m0.L, '→', m1.L);
  check('the runway moves whole while its pavement is dragged, keeping its length', m1.live && m1.y === m0.y - 60 && m1.L === m0.L);
  check('every taxiway that was on it is still on it', m1.on === m0.on && m0.on > 0);
  await p.keyboard.press('Escape'); await p.mouse.up(); await p.waitForTimeout(250);
  const m2 = await rms();
  check('Esc puts the runway back', !m2.live && m2.y === m0.y && m2.on === m0.on);
  await pullR(); const m3a = await rms(); await p.mouse.up(); await p.waitForTimeout(300); const m3 = await rms();
  check('letting go keeps it, with its taxiways on it', !m3.live && m3.y === m3a.y && m3.on === m0.on);
  // moved onto its own parallel taxiway it is refused; an aircraft rolling out on it as it moves goes with it
  const bad = await p.evaluate(() => { const g = window.__game, rw = g.sim.world.runways[0];
    const r = g.ui.slideRunway(rw, { a: { ...rw.a }, b: { ...rw.b } }, { x: 0, y: 170 }, false); return { ok: r.ok, reason: r.reason ?? '', y: rw.a.y }; });
  console.log('runway slid 170 m onto taxiway A:', bad.ok ? 'ACCEPTED' : 'refused: ' + bad.reason);
  check('a runway moved onto its parallel taxiway is refused, naming it', !bad.ok && /taxiway A/.test(bad.reason));
  const roll = await p.evaluate(() => { const g = window.__game, sim = g.sim, rw = sim.world.runways[0];
    let f = null; for (let i = 0; i < 6000 && !f; i++) { sim.step(0.25); f = sim.flights.find(q => q.state === 'roll' && q.rw?.rw.id === rw.id); }
    if (!f) return { found: false };
    const d = { x: 0, y: -20 }; const r = g.ui.slideRunway(rw, { a: { ...rw.a }, b: { ...rw.b } }, d, true); if (!r.ok) return { found: true, moved: false, reason: r.reason };
    sim.runwayMoved(rw.id, d); g.ui.changed();
    const id = f.id; for (let i = 0; i < 200; i++) { sim.step(0.25); const q = sim.flights.find(x => x.id === id); if (!q || q.state !== 'roll') break; }
    const q = sim.flights.find(x => x.id === id); return { found: true, moved: true, state: q ? q.state : 'gone' }; });
  console.log('an aircraft rolling out as the runway moves:', JSON.stringify(roll));
  check('an aircraft rolling out on a moved runway is not cancelled', roll.found && roll.moved && roll.state !== 'cancelled');
  await p.keyboard.press('Control+z'); await p.waitForTimeout(300);
  const fly = await p.evaluate(() => { const g = window.__game, sim = g.sim; const c0 = sim.stats.cancelled, l0 = sim.stats.flights;
    for (let i = 0; i < 2400; i++) sim.step(0.25); return { cxl: sim.stats.cancelled - c0, landed: sim.stats.flights - l0, issues: sim.d.issues.filter(i => i.level !== 'info').map(i => i.text) }; });
  console.log('flying 10 hours on the moved runway:', fly.landed, 'flights,', fly.cxl, 'cancelled', fly.issues.length ? '| ' + fly.issues.join('; ') : '');
  check('aircraft use the moved runway: none cancelled, no design issue', fly.cxl === 0 && fly.landed > 0 && fly.issues.length === 0);
  await p.keyboard.press('Control+z'); await p.waitForTimeout(300);
  // v0.49: in 3D, the selected building is grabbed by its roof and moved whole, with everything following
  const m = await p.evaluate(() => { const g = window.__game; g.ui.setTool('select');
    const z = g.sim.world.zones.find(q => q.type === 'concourse'); g.ren.cam.x = z.x + z.w / 2; g.ren.cam.y = z.y + z.h / 2 + 60; g.ren.cam.zoom = 0.8;
    g.ui.set3d(true); g.ren.selected = { kind: 'zone', id: z.id };
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
  // v0.52: in 3D, a selected taxiway is bent by its middle handle
  await p.keyboard.press('Escape'); await p.waitForTimeout(100);
  const tb = await p.evaluate(() => { const g = window.__game; g.ui.setTool('select'); const w = g.sim.world;
    const A = w.ways.find(q => q.kind === 'taxi' && Math.abs(q.a.y - q.b.y) < 1 && Math.abs(q.a.x - q.b.x) > 800);
    g.ren.selected = { kind: 'way', id: A.id }; const m = { x: (A.a.x + A.b.x) / 2, y: A.a.y };
    const [sx, sy] = g.ren.P(m.x, m.y, 0); const [tx, ty] = g.ren.P(m.x, m.y - 40, 0); return { id: A.id, sx, sy, tx, ty }; });
  await p.waitForTimeout(500);
  await p.mouse.move(tb.sx, tb.sy); await p.waitForTimeout(100); await p.mouse.down();
  for (let k = 1; k <= 8; k++) { await p.mouse.move(tb.sx + (tb.tx - tb.sx) * k / 8, tb.sy + (tb.ty - tb.sy) * k / 8); await p.waitForTimeout(60); }
  await p.waitForTimeout(300);
  const tb1 = await p.evaluate(id => { const g = window.__game; const A = g.sim.world.ways.find(q => q.id === id); return { bent: !!A.c, live: !!g.ui.live }; }, tb.id);
  check('in 3D a taxiway bends by its middle handle while dragged', tb1.bent && tb1.live);
  await p.keyboard.press('Escape'); await p.mouse.up(); await p.waitForTimeout(300);
  const tb2 = await p.evaluate(id => { const g = window.__game; const A = g.sim.world.ways.find(q => q.id === id); return { bent: !!A.c, live: !!g.ui.live, orbit: g.ren.r3.controls.enabled }; }, tb.id);
  check('Esc straightens it again, and the view orbits again', !tb2.bent && !tb2.live && tb2.orbit);
  // v0.51: in 3D, a satellite concourse being drawn stands there with its stands before the mouse is let go
  await p.keyboard.press('Escape'); await p.waitForTimeout(100);
  await p.evaluate(() => { const g = window.__game; g.ui.set3d(false); g.ren.cam.x = 4100; g.ren.cam.y = 2700; g.ren.cam.zoom = 0.8; g.ui.set3d(true); });
  await p.waitForTimeout(1500);
  const sat = await p.evaluate(() => { const g = window.__game; g.ren.selected = null; g.ui.setTool('satellite');
    const [ax, ay] = g.ren.P(3900, 2620, 9); const [bx, by] = g.ren.P(4300, 2680, 9);
    return { ax, ay, bx, by, n: g.sim.world.zones.length, aprons: g.sim.d.aprons.length }; });
  await p.waitForTimeout(400);
  await p.mouse.move(sat.ax, sat.ay); await p.mouse.down();
  for (let k = 1; k <= 10; k++) { await p.mouse.move(sat.ax + (sat.bx - sat.ax) * k / 10, sat.ay + (sat.by - sat.ay) * k / 10); await p.waitForTimeout(60); }
  await p.waitForTimeout(400);
  const sd = await p.evaluate(() => { const g = window.__game; return { live: !!g.ui.live, zones: g.sim.world.zones.length, aprons: g.sim.d.aprons.length, hint: document.querySelector('.hint, #hint')?.textContent ?? '' }; });
  console.log('3D: drawing a satellite:', sat.aprons, '→', sd.aprons, 'aprons mid-draw |', sd.hint.slice(0, 90));
  check('in 3D a module being drawn stands there, with its stands, before the mouse is let go', sd.live && sd.zones === sat.n + 1 && sd.aprons > sat.aprons);
  await p.keyboard.press('Escape'); await p.mouse.up(); await p.waitForTimeout(300);
  const se = await p.evaluate(() => ({ live: !!window.__game.ui.live, zones: window.__game.sim.world.zones.length }));
  check('Esc leaves nothing drawn', !se.live && se.zones === sat.n);
  // v0.51: a free area is clicked out corner by corner in 3D, its outline following the pointer
  const fa = await p.evaluate(() => { const g = window.__game; g.ui.setTool('area');
    return [[3950, 2800], [4250, 2800], [4250, 2950], [3950, 2950]].map(([x, y]) => g.ren.P(x, y, 9)); });
  for (const [x, y] of fa.slice(0, 3)) { await p.mouse.click(x, y); await p.waitForTimeout(150); }
  await p.mouse.move(fa[3][0], fa[3][1]); await p.waitForTimeout(400);
  const fs = await p.evaluate(() => { const g = window.__game; return { path: g.ui.path?.length ?? 0, live: !!g.ui.live, zones: g.sim.world.zones.length, d: g.sim.d.zones.filter(z => z.poly).length }; });
  console.log('3D: free area:', fs.path, 'corners clicked, draft shapes with an outline:', fs.d);
  check('in 3D a free area is clicked out corner by corner, standing there as it is drawn', fs.path === 3 && fs.live && fs.d >= 1);
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  const fe = await p.evaluate(() => ({ path: window.__game.ui.path, live: !!window.__game.ui.live, d: window.__game.sim.d.zones.filter(z => z.poly).length }));
  check('Esc gives the free area up', !fe.path && !fe.live && fe.d === 0);
  console.log(fails ? fails + ' CHECK(S) FAILED' : 'all checks passed');
  await b.close(); process.exit(fails ? 1 : 0);
})();
