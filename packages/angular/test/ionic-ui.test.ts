// @vitest-environment happy-dom
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { fakeNative } from './fake-native';

import { ionicUi } from '../src/ionicUi';

const native = fakeNative();
const stop = ionicUi().start();

async function taps() {
  return (await native.handedOff()).filter((r) => r.eventName === 'ui.interaction').map((r) => r.attributes);
}

beforeEach(async () => {
  await native.handedOff();
  document.body.innerHTML = '';
});

afterAll(() => stop?.());

describe('E33 ionicUi()', () => {
  it('overlay present / dismiss → overlay_open / overlay_dismiss, target = component tag', async () => {
    document.body.innerHTML = '<ion-modal><p>Card 4111 1111</p></ion-modal><ion-action-sheet></ion-action-sheet>';
    document.querySelector('ion-modal')!.dispatchEvent(new CustomEvent('didPresent', { bubbles: true }));
    document.querySelector('ion-action-sheet')!.dispatchEvent(new CustomEvent('didDismiss', { bubbles: true, detail: { role: 'cancel' } }));
    const rows = await taps();
    expect(rows).toEqual([
      expect.objectContaining({ 'ui.type': 'overlay_open', 'ui.target': 'ion-modal' }),
      expect.objectContaining({ 'ui.type': 'overlay_dismiss', 'ui.target': 'ion-action-sheet' }),
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/4111|cancel/);
  });

  it('tab change (non-bubbling) → tab_change on ion-tabs, tab name not sent', async () => {
    document.body.innerHTML = '<ion-tabs></ion-tabs>';
    document.querySelector('ion-tabs')!.dispatchEvent(new CustomEvent('ionTabsDidChange', { bubbles: false, detail: { tab: 'account-42' } }));
    const rows = await taps();
    expect(rows).toEqual([expect.objectContaining({ 'ui.type': 'tab_change', 'ui.target': 'ion-tabs' })]);
    expect(JSON.stringify(rows)).not.toContain('account');
  });

  it('hardware back → back on ion-app', async () => {
    document.dispatchEvent(new CustomEvent('ionBackButton', { detail: { register: () => {} } }));
    expect(await taps()).toEqual([expect.objectContaining({ 'ui.type': 'back', 'ui.target': 'ion-app' })]);
  });

  it('keyboard shown → keyboard_show on the focused field component, never its value', async () => {
    document.body.innerHTML = '<ion-input><input value="jane@example.com"></ion-input>';
    document.querySelector('input')!.focus();
    window.dispatchEvent(new CustomEvent('ionKeyboardDidShow', { detail: { keyboardHeight: 300 } }));
    const rows = await taps();
    expect(rows).toEqual([expect.objectContaining({ 'ui.type': 'keyboard_show', 'ui.target': 'ion-input' })]);
    expect(JSON.stringify(rows)).not.toContain('jane');
  });

  it('flat attributes with the current screen', async () => {
    document.body.innerHTML = '<ion-popover></ion-popover>';
    document.querySelector('ion-popover')!.dispatchEvent(new CustomEvent('didPresent', { bubbles: true }));
    const [row] = await taps();
    expect(row).toHaveProperty('ui.screen');
    for (const v of Object.values(row!)) expect(['string', 'number', 'boolean']).toContain(typeof v);
  });
});
