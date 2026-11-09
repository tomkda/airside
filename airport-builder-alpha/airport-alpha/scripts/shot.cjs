const { chromium } = require('playwright');
(async () => {
  const [,, out, x, y, zoom, extra] = process.argv;
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: Number(process.env.DSF || 1) });
  p.on('pageerror', e => console.log('ERR', e.message));
  await p.goto('file:///home/claude/airport-alpha/dist/index.html');
  await p.waitForTimeout(800);
  await p.evaluate(([x, y, z, extra]) => { const g = window.__game; g.ren.cam.x = x; g.ren.cam.y = y; g.ren.cam.zoom = z; if (extra) (new Function('g', extra))(g); }, [Number(x), Number(y), Number(zoom), extra || '']);
  await p.waitForTimeout(1500);
  await p.screenshot({ path: out });
  await b.close();
})();
