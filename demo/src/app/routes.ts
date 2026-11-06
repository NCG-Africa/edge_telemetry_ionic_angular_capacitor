import type { Routes } from '@angular/router';

import { HomePage } from './home.page';
import { later, SCENARIOS } from './scenarios';

// E19: a lazy chunk, a guard and a resolver on every scenario route, so `navigation` has all three phase keys.
export const routes: Routes = [
  { path: '', component: HomePage },
  ...SCENARIOS.map((path) => ({
    path,
    loadComponent: () => import('./scenario.page').then((m) => m.ScenarioPage),
    canActivate: [() => later(20).then(() => true)],
    resolve: { ready: () => later(20) },
  })),
];
