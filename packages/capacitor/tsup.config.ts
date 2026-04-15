import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  outExtension: ({ format }) => ({ js: format === 'esm' ? '.mjs' : '.cjs' }),
  dts: true,
  treeshake: true,
  clean: true,
  sourcemap: true,
  external: [
    '@capacitor/core',
    '@capacitor/device',
    '@capacitor/network',
    '@capacitor/app',
  ],
  noExternal: [/@opentelemetry\/.*/],
});
