// size-limit entry for the deduped full-stack budget (spec L1). One entry, because size-limit keys
// multi-path outputs by basename and core + capacitor are both `index.mjs` (one silently drops).
export * from '../packages/core/dist/index.mjs';
export * from '../packages/capacitor/dist/index.mjs';
export * from '../packages/angular/dist/fesm2022/nathanclaire-rum-angular.mjs';
