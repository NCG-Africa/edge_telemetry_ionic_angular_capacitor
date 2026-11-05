import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const common = {
  entryPoints: [resolve(here, 'harness.ts')],
  bundle: true,
  format: 'iife',
  globalName: 'Rum',
  target: 'es2020',
  platform: 'browser',
  logLevel: 'info',
};

// Specs: readable, with source maps.
await build({ ...common, outfile: resolve(here, 'dist/harness.js'), sourcemap: 'inline' });
// L3 bench: minified like a production bundle, so eval cost is what ships.
await build({ ...common, outfile: resolve(here, 'dist/bench.js'), minify: true });
