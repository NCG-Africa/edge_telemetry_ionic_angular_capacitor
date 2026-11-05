// The SDK as an app would ship it (core + -capacitor), exposed as `window.Rum` for the specs.
export * from '../packages/core/dist/index.mjs';
export { bridge, defaultCaptures } from '../packages/capacitor/dist/index.mjs';
