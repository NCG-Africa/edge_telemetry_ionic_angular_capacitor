import type { EventAttributes } from '../index';
import { healthMonitor } from '../internal/health';

export interface InteractionsDeps {
  recordEvent: (eventName: 'user.interaction', attributes: EventAttributes) => void;
  getCurrentRoute: () => string;
  target?: Pick<Document, 'addEventListener' | 'removeEventListener'>;
}

export interface InteractionsHandle {
  dispose: () => void;
}

const DEDUP_WINDOW_MS = 50;
const MAX_FIELD_LEN = 64;

function truncate(value: string): string {
  if (value.length <= MAX_FIELD_LEN) return value;
  return value.slice(0, MAX_FIELD_LEN);
}

function readElementAttributes(el: Element | null): EventAttributes {
  const attrs: EventAttributes = {};
  if (!el || typeof el.tagName !== 'string') return attrs;
  attrs['interaction.target_tag'] = el.tagName.toUpperCase();
  if (typeof el.id === 'string' && el.id.length > 0) {
    attrs['interaction.target_id'] = truncate(el.id);
  }
  const className = (el as Element & { className?: unknown }).className;
  if (typeof className === 'string' && className.length > 0) {
    attrs['interaction.target_class'] = truncate(className);
  }
  if (typeof el.getAttribute === 'function') {
    const role = el.getAttribute('role') ?? el.getAttribute('aria-label');
    if (typeof role === 'string' && role.length > 0) {
      attrs['interaction.target_role'] = truncate(role);
    }
  }
  return attrs;
}

function makeDedupKey(attrs: EventAttributes): string {
  return [
    attrs['interaction.target_tag'] ?? '',
    attrs['interaction.target_id'] ?? '',
    attrs['interaction.target_class'] ?? '',
  ].join('|');
}

export function registerInteractionCapture(deps: InteractionsDeps): InteractionsHandle {
  const target =
    deps.target ??
    (typeof document !== 'undefined' ? (document as unknown as Document) : undefined);
  if (!target || typeof target.addEventListener !== 'function') {
    return { dispose: () => undefined };
  }

  let lastEmitAt = 0;
  let lastKey = '';

  const onClick = (event: Event): void => {
    try {
      const el = event.target as Element | null;
      const targetAttrs = readElementAttributes(el);
      if (!targetAttrs['interaction.target_tag']) return;

      const now = Date.now();
      const key = makeDedupKey(targetAttrs);
      if (key === lastKey && now - lastEmitAt < DEDUP_WINDOW_MS) return;
      lastKey = key;
      lastEmitAt = now;

      const attrs: EventAttributes = {
        'interaction.type': 'click',
        'interaction.screen': deps.getCurrentRoute(),
        'interaction.timestamp': new Date(now).toISOString(),
        ...targetAttrs,
      };

      deps.recordEvent('user.interaction', attrs);
    } catch (err) {
      healthMonitor.reportError('interactions.click', err);
    }
  };

  target.addEventListener('click', onClick as EventListener, { capture: true, passive: true });

  return {
    dispose: () => {
      try {
        target.removeEventListener('click', onClick as EventListener, true);
      } catch (err) {
        healthMonitor.reportError('interactions.dispose', err);
      }
    },
  };
}
