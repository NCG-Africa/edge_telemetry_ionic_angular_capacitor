import { __getCurrentRoute, __recordEvent, type Capture } from '@nathanclaire/rum';

// E33 / P4: `ui.target` is the component tag only, never its content or event detail.
const FIELDS = 'ion-input, ion-textarea, ion-searchbar';

/** Ionic overlays, tab changes, hardware back and the keyboard, as taps. Off unless listed. */
export const ionicUi = (): Capture => ({
  name: 'ionicUi',
  start: () => {
    if (typeof document === 'undefined') return;
    const emit = (type: string, target: string) =>
      __recordEvent('ui.interaction', { 'ui.type': type, 'ui.target': target, 'ui.screen': __getCurrentRoute() });
    const tagOf = (t: EventTarget | null) => (t as Element | null)?.tagName?.toLowerCase();
    // Capture phase: `ionTabsDidChange` doesn't bubble.
    const on: [EventTarget, string, (e: Event) => void][] = [
      [document, 'didPresent', (e) => emit('overlay_open', tagOf(e.target) ?? 'overlay')],
      [document, 'didDismiss', (e) => emit('overlay_dismiss', tagOf(e.target) ?? 'overlay')],
      [document, 'ionTabsDidChange', () => emit('tab_change', 'ion-tabs')],
      // Hardware back has no component of its own: ion-app owns Ionic's handler.
      [document, 'ionBackButton', () => emit('back', 'ion-app')],
      [globalThis, 'ionKeyboardDidShow', () => {
        const el = document.activeElement;
        emit('keyboard_show', tagOf(el?.closest(FIELDS) ?? el) ?? 'unknown');
      }],
    ];
    for (const [t, name, f] of on) t.addEventListener(name, f, true);
    return () => {
      for (const [t, name, f] of on) t.removeEventListener(name, f, true);
    };
  },
});
