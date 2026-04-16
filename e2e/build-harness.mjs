import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [resolve(here, 'harness.ts')],
  outfile: resolve(here, 'dist/harness.js'),
  bundle: true,
  format: 'iife',
  target: 'es2020',
  platform: 'browser',
  sourcemap: 'inline',
  logLevel: 'info',
  // @capacitor/* are native-only peer deps — exclude so the bundle runs in a plain browser.
  external: ['@capacitor/preferences', '@capacitor/core', '@capacitor/device', '@capacitor/network', '@capacitor/app'],
});
