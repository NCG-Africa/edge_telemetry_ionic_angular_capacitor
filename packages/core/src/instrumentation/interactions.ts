import type { EventAttributes } from '../index';
import { healthMonitor } from '../internal/health';

export interface InteractionsDeps {
  /** One `ui.interaction`, stamped `at` the tap (not at the end of its dead window). */
  record: (attributes: EventAttributes, at: string) => void;
  /** P6: `<ui.type> <ui.target>`, left at the tap. */
  breadcrumb?: (name: string) => void;
  getCurrentRoute: () => string;
  /** X2: mint the `interaction` root (before the app's handler: capture phase); its Tier-1 keys. */
  mintRoot?: () => EventAttributes;
  /** E25 dead: bumped by navigations and requests; DOM mutations are watched here. */
  activity?: () => number;
  /** The page may not come back: hand drained taps off now. */
  flush?: () => void;
  target?: Document;
}

export interface InteractionsHandle {
  dispose: () => void;
}

const WINDOW_MS = 1000; // E25: rage and dead windows
const RAGE_TAPS = 3;
const DEDUP_WINDOW_MS = 50; // X2: a ghost click (touch + synthetic click) is one tap
// P4: the elements whose visible text may name them.
const TEXT_OK = 'button, a, [role=button], [role=link], [role=tab], [role=menuitem]';
const EDITABLE = '[contenteditable]:not([contenteditable=false])';

/** P4: trim, collapse, 64-char cap, digits → `#`. */
const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, 64).replace(/\d/g, '#');

/** P4 name chain. `el` is the control the tap is about (nearest text-eligible ancestor, else the target). */
function nameOf(target: Element, el: Element): [string, string] {
  if (!target.closest('[data-edge-private]')) {
    const action = clean(target.closest('[data-edge-action]')?.getAttribute('data-edge-action'));
    if (action) return [action, 'edge_action'];
    const aria = clean(el.getAttribute('aria-label'));
    if (aria) return [aria, 'aria_label'];
    const id = clean(el.id);
    if (id) return [id, 'id'];
    // textContent reads descendants too: any private or editable one rules text out.
    const text = el.matches(TEXT_OK) && !el.closest(EDITABLE) && !el.querySelector(`[data-edge-private], ${EDITABLE}`) ? clean(el.textContent) : '';
    if (text) return [text, 'text'];
  }
  return [el.tagName.toLowerCase(), 'none'];
}

export function registerInteractionCapture(deps: InteractionsDeps): InteractionsHandle {
  const doc = deps.target ?? (typeof document !== 'undefined' ? document : undefined);
  if (!doc || typeof doc.addEventListener !== 'function') {
    return { dispose: () => undefined };
  }
  const external = deps.activity ?? (() => 0);
  let mutations = 0;
  const activity = () => mutations + external();

  // E25 touch: a tap's click is often a plain MouseEvent (no `pointerType`), so a touch just before marks it.
  let touchedAt = -Infinity;
  let recent: { el: Element; at: number }[] = [];
  const pending = new Set<{ attrs: EventAttributes; at: string; timer: ReturnType<typeof setTimeout> }>();

  // Watching the DOM only while a dead-tap window is open: a whole-document observer is not free.
  let observer: MutationObserver | undefined;
  const watch = (on: boolean) => {
    if (on && !observer && typeof MutationObserver !== 'undefined') {
      observer = new MutationObserver(() => mutations++);
      observer.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    } else if (!on) {
      observer?.disconnect();
      observer = undefined;
    }
  };

  const onTap = (ev: MouseEvent): void => {
    try {
      const target = ev.target as Element | null;
      if (typeof target?.closest !== 'function') return;
      const control = target.closest(`${TEXT_OK}, [data-edge-action]`);
      const el = control ?? target;
      const t = performance.now();
      const last = recent[recent.length - 1];
      if (last && last.el === el && t - last.at < DEDUP_WINDOW_MS) return;
      // ≥ 3 taps on the same control within the window, this one included.
      recent = recent.filter((r) => t - r.at < WINDOW_MS);
      recent.push({ el, at: t });
      const rage = recent.filter((r) => r.el === el).length >= RAGE_TAPS;

      const [label, source] = nameOf(target, el);
      const at = new Date().toISOString();
      const type = (ev as PointerEvent).pointerType === 'touch' || t - touchedAt < WINDOW_MS ? 'tap' : 'click';
      deps.breadcrumb?.(`${type} ${label}`);
      const attrs: EventAttributes = {
        'ui.type': type,
        'ui.target': label,
        'ui.name_source': source,
        'ui.x': Math.round(ev.clientX),
        'ui.y': Math.round(ev.clientY),
        'ui.screen': deps.getCurrentRoute(),
        ...(rage && { 'ui.rage': true }),
        ...deps.mintRoot?.(),
      };
      // Dead is judged on controls only: a tap on whitespace or into a text field rightly does nothing.
      if (!control) {
        deps.record(attrs, at);
        return healthMonitor.reportSuccess('interactions.click');
      }
      const tick = activity();
      const entry = {
        attrs,
        at,
        timer: setTimeout(() => {
          try {
            pending.delete(entry);
            if (!pending.size) watch(false);
            deps.record(activity() === tick ? { ...attrs, 'ui.dead': true } : attrs, at);
          } catch (err) {
            healthMonitor.reportError('interactions.dead', err);
          }
        }, WINDOW_MS),
      };
      pending.add(entry);
      watch(true);
      healthMonitor.reportSuccess('interactions.click');
    } catch (err) {
      healthMonitor.reportError('interactions.click', err);
    }
  };

  const onTouch = () => (touchedAt = performance.now());

  /** Emit open taps now, unjudged (absent `ui.dead` never accuses). */
  const drain = () => {
    try {
      if (!pending.size) return;
      for (const p of pending) {
        clearTimeout(p.timer);
        deps.record(p.attrs, p.at);
      }
      pending.clear();
      watch(false);
      deps.flush?.();
    } catch (err) {
      healthMonitor.reportError('interactions.drain', err);
    }
  };
  const onHidden = () => doc.visibilityState === 'hidden' && drain();

  // E25: capture phase, so the tap is seen before the host's handler navigates or stops it.
  doc.addEventListener('click', onTap, true);
  doc.addEventListener('touchstart', onTouch, { capture: true, passive: true });
  doc.addEventListener('visibilitychange', onHidden);
  globalThis.addEventListener?.('pagehide', drain);

  return {
    dispose: () => {
      drain();
      doc.removeEventListener('click', onTap, true);
      doc.removeEventListener('touchstart', onTouch, true);
      doc.removeEventListener('visibilitychange', onHidden);
      globalThis.removeEventListener?.('pagehide', drain);
    },
  };
}
