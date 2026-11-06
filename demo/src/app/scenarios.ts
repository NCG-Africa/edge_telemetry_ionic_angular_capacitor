import { registerPlugin } from '@capacitor/core';

/** The demo's own native plugin (`demo/scenarios`). Its calls are what `bridge.summary` times. */
export const DemoScenarios = registerPlugin<{
  listen(): Promise<{ scenario: string }>;
  slow(o: { ms: number }): Promise<void>;
  hang(o: { ms: number }): Promise<void>;
  crash(): Promise<void>;
  killRenderer(): Promise<void>;
}>('DemoScenarios');

export const later = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Spec Q1 (Cordova Q5 list): one route, button and deep link each. */
export const SCENARIOS = [
  'happy', 'js-error', 'native-crash', 'renderer-kill', 'hang', 'slow-bridge',
  'offline', 'rage-tap', 'mark-ready', 'task', 'caps',
] as const;
export type Scenario = (typeof SCENARIOS)[number];
export const isScenario = (s: unknown): s is Scenario => SCENARIOS.includes(s as Scenario);
