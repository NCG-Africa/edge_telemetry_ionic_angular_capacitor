// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerInteractionCapture } from '../src/instrumentation/interactions';
import type { EventAttributes } from '../src/core';

// happy-dom delivers MutationObserver records on a real timer, taken before timers are faked.
const realTick = ((t) => () => new Promise<void>((r) => t(r, 0)))(globalThis.setTimeout);

let recorded: Array<{ attrs: EventAttributes; at: string }>;
let dispose: () => void;
let activity: number;

function start(extra: { mintRoot?: () => EventAttributes } = {}) {
  dispose = registerInteractionCapture({
    record: (attrs, at) => recorded.push({ attrs, at }),
    getCurrentRoute: () => '/products/:id',
    activity: () => activity,
    ...extra,
  }).dispose;
}

function html(markup: string): void {
  document.body.innerHTML = markup;
}

function tap(selector: string, init: MouseEventInit = {}): void {
  document.querySelector(selector)!.dispatchEvent(new MouseEvent('click', { bubbles: true, ...init }));
}

/** The `ui.target` / `ui.name_source` a tap on `selector` gets, after its dead window. */
function nameOf(selector: string): [unknown, unknown] {
  tap(selector);
  vi.advanceTimersByTime(1000);
  const a = recorded.at(-1)!.attrs;
  return [a['ui.target'], a['ui.name_source']];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  recorded = [];
  activity = 0;
  start();
});

afterEach(() => {
  dispose();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('P4 ui.target naming', () => {
  it('chain: data-edge-action → aria-label → id → visible text → tag', () => {
    html(`
      <button id="a" data-edge-action="Checkout" aria-label="Buy">Pay</button>
      <button id="b" aria-label="Open menu">Menu</button>
      <button id="c">Go</button>
      <a class="d">Read more</a>
      <div class="e">Plain text</div>`);
    expect(nameOf('#a')).toEqual(['Checkout', 'edge_action']);
    expect(nameOf('#b')).toEqual(['Open menu', 'aria_label']);
    expect(nameOf('#c')).toEqual(['c', 'id']);
    expect(nameOf('.d')).toEqual(['Read more', 'text']);
    expect(nameOf('.e')).toEqual(['div', 'none']);
  });

  it('names the control a tap lands inside, not the inner node', () => {
    html('<button aria-label="Save"><span class="icon">x</span></button>');
    expect(nameOf('.icon')).toEqual(['Save', 'aria_label']);
  });

  it('text only for button, a and role=button|link|tab|menuitem', () => {
    html(`
      <div role="tab" class="t">Profile</div>
      <span class="s">Hello</span>
      <label class="l">Name</label>`);
    expect(nameOf('.t')).toEqual(['Profile', 'text']);
    expect(nameOf('.s')).toEqual(['span', 'none']);
    expect(nameOf('.l')).toEqual(['label', 'none']);
  });

  it('never input / textarea / select values', () => {
    html('<input class="i" value="4111 1111"><textarea class="x">secret</textarea>');
    expect(nameOf('.i')).toEqual(['input', 'none']);
    expect(nameOf('.x')).toEqual(['textarea', 'none']);
    expect(JSON.stringify(recorded)).not.toMatch(/4111|secret/);
  });

  it('no text from or around contenteditable', () => {
    html('<button class="b"><span contenteditable>draft</span></button><div contenteditable><a class="a">typed</a></div>');
    expect(nameOf('.b')).toEqual(['button', 'none']);
    expect(nameOf('.a')).toEqual(['a', 'none']);
  });

  it('trims, collapses whitespace, caps at 64, digits → #', () => {
    html(`<button class="b">  Pay   KES 1,250
      now ${'x'.repeat(80)}</button>`);
    const [name] = nameOf('.b');
    expect(name).toBe(`Pay KES #,### now ${'x'.repeat(46)}`);
    expect((name as string).length).toBe(64);
  });

  it('[data-edge-private]: anything inside gets no name, not even data-edge-action', () => {
    html(`
      <section data-edge-private>
        <button id="pin" data-edge-action="Reveal" aria-label="PIN 1234">1234</button>
      </section>
      <button class="p"><span data-edge-private>Jane Doe</span></button>`);
    expect(nameOf('#pin')).toEqual(['button', 'none']);
    // A private descendant rules visible text out (textContent would read it).
    expect(nameOf('.p')).toEqual(['button', 'none']);
    expect(JSON.stringify(recorded)).not.toMatch(/Reveal|1234|Jane/);
  });

  it('carries type, screen, coordinates; ISO timestamp from the tap itself', () => {
    html('<button class="b">Go</button>');
    vi.setSystemTime(new Date('2026-11-06T10:00:00.000Z'));
    tap('.b', { clientX: 10.4, clientY: 20.6 });
    vi.advanceTimersByTime(1000);
    const { attrs, at } = recorded[0]!;
    expect(at).toBe('2026-11-06T10:00:00.000Z');
    expect(attrs).toMatchObject({ 'ui.type': 'tap', 'ui.screen': '/products/:id', 'ui.x': 10, 'ui.y': 21 });
    for (const v of Object.values(attrs)) expect(['string', 'number', 'boolean']).toContain(typeof v);
  });

});

describe('E25 rage / dead', () => {
  it('rage: the 3rd tap on the same control within 1 s, not before', () => {
    html('<button class="b">Go</button><button class="c">Other</button>');
    tap('.b');
    vi.advanceTimersByTime(100);
    tap('.c');
    vi.advanceTimersByTime(100);
    tap('.b');
    vi.advanceTimersByTime(100);
    tap('.b');
    vi.advanceTimersByTime(1000);
    expect(recorded.map((r) => r.attrs['ui.rage'] === true)).toEqual([false, false, false, true]);
  });

  it('rage: taps spread over more than 1 s are not rage', () => {
    html('<button class="b">Go</button>');
    for (let i = 0; i < 3; i++) {
      tap('.b');
      vi.advanceTimersByTime(600);
    }
    vi.advanceTimersByTime(1000);
    expect(recorded.some((r) => r.attrs['ui.rage'])).toBe(false);
  });

  it('a repeat click within 50 ms is one tap (no second event, no second root)', () => {
    html('<button class="b">Go</button>');
    dispose();
    const mintRoot = vi.fn(() => ({ 'trace.id': 't' }));
    start({ mintRoot });
    tap('.b');
    tap('.b');
    vi.advanceTimersByTime(1000);
    expect(recorded).toHaveLength(1);
    expect(mintRoot).toHaveBeenCalledTimes(1);
    expect(recorded[0]!.attrs['trace.id']).toBe('t');
  });

  it('dead: a control tap with no DOM change, navigation or request within 1 s', () => {
    html('<button class="b">Go</button>');
    tap('.b');
    vi.advanceTimersByTime(999);
    expect(recorded).toHaveLength(0); // judged at the end of the window
    vi.advanceTimersByTime(1);
    expect(recorded[0]!.attrs['ui.dead']).toBe(true);
  });

  it('not dead: a navigation or request bumps activity', () => {
    html('<button class="b">Go</button>');
    tap('.b');
    activity++;
    vi.advanceTimersByTime(1000);
    expect(recorded[0]!.attrs).not.toHaveProperty('ui.dead');
  });

  it('not dead: the DOM changed', async () => {
    html('<button class="b">Go</button>');
    tap('.b');
    document.body.append(document.createElement('p'));
    await realTick();
    vi.advanceTimersByTime(1000);
    expect(recorded[0]!.attrs).not.toHaveProperty('ui.dead');
  });

  it('never dead off a control (whitespace, text fields): emitted at once', () => {
    html('<div class="w">space</div><input class="i">');
    tap('.w');
    tap('.i');
    expect(recorded.map((r) => r.attrs['ui.target'])).toEqual(['div', 'input']);
    expect(recorded.some((r) => r.attrs['ui.dead'])).toBe(false);
  });

  it('page hidden: open taps go out now, unjudged, and are flushed', () => {
    html('<button class="b">Go</button>');
    dispose();
    const flush = vi.fn();
    start({ flush } as never);
    tap('.b');
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.attrs).not.toHaveProperty('ui.dead');
    expect(flush).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(recorded).toHaveLength(1);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });
});

describe('P6 breadcrumb', () => {
  it('is left at the tap, before its dead window ends', () => {
    html('<button class="b">Pay 100</button>');
    dispose();
    const crumbs: string[] = [];
    start({ breadcrumb: (n: string) => crumbs.push(n) } as never);
    tap('.b');
    expect(crumbs).toEqual(['tap Pay ###']);
    expect(recorded).toHaveLength(0);
  });
});
