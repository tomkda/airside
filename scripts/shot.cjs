// Screenshot the built game: node scripts/shot.cjs out.png <camX> <camY> <zoom> [js run with g = window.__game]
// DSF=2 for a retina image. Run npm run build first.
const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const [,, out, x, y, zoom, extra] = process.argv;
  // GL3D=1: software WebGL so the 3D view renders headless (slower for plan shots, so only when asked)
  const b = await chromium.launch(process.env.GL3D ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] } : {});
  const p = await b.newPage({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: Number(process.env.DSF || 1) });
  p.on('pageerror', e => console.log('ERR', e.message));
  await p.goto('file://' + path.resolve(__dirname, '../dist/index.html'));
  await p.waitForTimeout(800);
  await p.evaluate(([x, y, z, extra]) => { const g = window.__game; g.ren.cam.x = x; g.ren.cam.y = y; g.ren.cam.zoom = z; if (extra) (new Function('g', extra))(g); }, [Number(x), Number(y), Number(zoom), extra || '']);
  await p.waitForTimeout(1500);
  await p.screenshot({ path: out });
  await b.close();
})();
