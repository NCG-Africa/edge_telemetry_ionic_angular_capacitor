import { defaultCaptures as coreDefaults, type Capture } from '@nathanclaire/rum';

/** Native plugin call timings. */
// ponytail: stub until 5.0 impl 16 (#122) wraps Capacitor.nativePromise (E18).
export const bridge = (): Capture => ({ name: 'bridge', start: () => {} });

/** The standard set: vitals, interactions, frames, long tasks, console errors, native plugin calls. */
export const defaultCaptures = (): Capture[] => [...coreDefaults(), bridge()];
