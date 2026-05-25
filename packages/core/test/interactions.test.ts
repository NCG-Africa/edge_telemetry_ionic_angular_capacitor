import { beforeEach, describe, expect, it, vi } from 'vitest';

import { registerInteractionCapture } from '../src/instrumentation/interactions';

function makeTarget(): {
  addEventListener: (name: string, cb: EventListener, opts?: unknown) => void;
  removeEventListener: (name: string, cb: EventListener, capture?: boolean) => void;
  dispatch: (target: Element) => void;
} {
  const listeners: EventListener[] = [];
  return {
    addEventListener: (_name, cb) => {
      listeners.push(cb);
    },
    removeEventListener: () => undefined,
    dispatch: (target: Element) => {
      const ev = new Event('click');
      Object.defineProperty(ev, 'target', { value: target });
      for (const l of listeners) l(ev);
    },
  };
}

function makeElement(tag: string, attrs: Record<string, string> = {}): Element {
  const el = {
    tagName: tag,
    id: attrs.id ?? '',
    className: attrs.className ?? '',
    getAttribute: (name: string) => attrs[name] ?? null,
  } as unknown as Element;
  return el;
}

describe('registerInteractionCapture', () => {
  let recorded: Array<{ name: string; attrs: Record<string, string | number | boolean> }>;
  let route: string;

  beforeEach(() => {
    recorded = [];
    route = '/home';
  });

  it('emits user.interaction on click with tag/id/class/role', () => {
    const target = makeTarget();
    registerInteractionCapture({
      target: target as unknown as Document,
      recordEvent: (name, attrs) => recorded.push({ name, attrs }),
      getCurrentRoute: () => route,
    });

    target.dispatch(makeElement('button', { id: 'buy', className: 'primary lg', role: 'button' }));

    expect(recorded).toHaveLength(1);
    const e = recorded[0]!;
    expect(e.name).toBe('user.interaction');
    expect(e.attrs['interaction.type']).toBe('click');
    expect(e.attrs['interaction.target_tag']).toBe('BUTTON');
    expect(e.attrs['interaction.target_id']).toBe('buy');
    expect(e.attrs['interaction.target_class']).toBe('primary lg');
    expect(e.attrs['interaction.target_role']).toBe('button');
    expect(e.attrs['interaction.screen']).toBe('/home');
    expect(e.attrs['interaction.timestamp']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('falls back to aria-label when role is absent', () => {
    const target = makeTarget();
    registerInteractionCapture({
      target: target as unknown as Document,
      recordEvent: (name, attrs) => recorded.push({ name, attrs }),
      getCurrentRoute: () => route,
    });

    target.dispatch(makeElement('div', { 'aria-label': 'Open menu' }));

    expect(recorded[0]!.attrs['interaction.target_role']).toBe('Open menu');
  });

  it('does NOT capture inner text', () => {
    const target = makeTarget();
    registerInteractionCapture({
      target: target as unknown as Document,
      recordEvent: (name, attrs) => recorded.push({ name, attrs }),
      getCurrentRoute: () => route,
    });

    const el = makeElement('button', { id: 'b' });
    (el as unknown as { textContent: string }).textContent = 'Secret PIN 1234';
    target.dispatch(el);

    const e = recorded[0]!;
    expect(e.attrs).not.toHaveProperty('interaction.target_text');
    for (const v of Object.values(e.attrs)) {
      expect(String(v)).not.toContain('Secret PIN 1234');
    }
  });

  it('dedupes identical clicks within 50ms', () => {
    const target = makeTarget();
    registerInteractionCapture({
      target: target as unknown as Document,
      recordEvent: (name, attrs) => recorded.push({ name, attrs }),
      getCurrentRoute: () => route,
    });

    const el = makeElement('button', { id: 'rapid' });
    target.dispatch(el);
    target.dispatch(el);

    expect(recorded).toHaveLength(1);
  });

  it('does not emit if target has no tagName', () => {
    const target = makeTarget();
    registerInteractionCapture({
      target: target as unknown as Document,
      recordEvent: (name, attrs) => recorded.push({ name, attrs }),
      getCurrentRoute: () => route,
    });

    target.dispatch(makeElement(''));
    expect(recorded).toHaveLength(0);
  });

  it('truncates long class names to 64 chars', () => {
    const target = makeTarget();
    registerInteractionCapture({
      target: target as unknown as Document,
      recordEvent: (name, attrs) => recorded.push({ name, attrs }),
      getCurrentRoute: () => route,
    });

    const longClass = 'c'.repeat(200);
    target.dispatch(makeElement('span', { className: longClass }));
    expect((recorded[0]!.attrs['interaction.target_class'] as string).length).toBe(64);
  });
});
