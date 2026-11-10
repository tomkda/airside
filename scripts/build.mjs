// Bundles src/ into single-file HTML pages:
//   dist/index.html     standalone page (open directly in a browser)
//   dist/artifact.html  same page without the document skeleton (for hosts that add their own)
import { build, context } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');
mkdirSync('dist', { recursive: true });

function emit(js) {
  const css = readFileSync('src/styles.css', 'utf8');
  const tpl = readFileSync('src/index.html', 'utf8');
  const body = tpl.replace('/*__CSS__*/', () => css).replace('/*__JS__*/', () => js.replace(/<\/script/gi, '<\\/script'));
  writeFileSync('dist/artifact.html', body);
  writeFileSync('dist/index.html', `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body>\n${body}\n</body>\n</html>\n`);
  console.log(`built dist/index.html (${(body.length / 1024).toFixed(0)} KB)`);
}

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const opts = { define: { __VERSION__: JSON.stringify(version) }, entryPoints: ['src/main.ts'], bundle: true, format: 'iife', target: 'es2020', minify: !watch, write: false, logLevel: 'warning' };

if (watch) {
  const ctx = await context({ ...opts, plugins: [{ name: 'emit', setup(b) { b.onEnd(r => { if (r.outputFiles?.[0]) emit(r.outputFiles[0].text); }); } }] });
  await ctx.watch();
  console.log('watching src/ …');
} else {
  const r = await build(opts);
  emit(r.outputFiles[0].text);
}
