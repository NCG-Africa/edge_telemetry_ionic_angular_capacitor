import '@angular/compiler'; // partial-compiled @angular/common needs JIT in Node
import { HttpClient, HttpXhrBackend } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { expect, it } from 'vitest';

// E6: the 4.x gap — Angular `HttpClient` on its default XHR backend. The global XHR must exist
// before init so the SDK patches it, as WebView's does.
class FakeXhr extends EventTarget {
  status = 0;
  statusText = '';
  responseType = '';
  response = '';
  responseText = '';
  responseURL = '';
  readyState = 0;
  open(_method: string, url: string): void {
    this.responseURL = url;
  }
  setRequestHeader(): void {}
  getAllResponseHeaders(): string {
    return 'content-type: application/json\r\ncontent-length: 11\r\n';
  }
  getResponseHeader(name: string): string | null {
    return name.toLowerCase() === 'content-length' ? '11' : null;
  }
  send(): void {
    setTimeout(() => {
      this.status = 200;
      this.statusText = 'OK';
      this.readyState = 4;
      this.response = this.responseText = '{"ok":true}';
      this.dispatchEvent(new Event('load'));
      this.dispatchEvent(new Event('loadend'));
    });
  }
  abort(): void {}
}
(globalThis as Record<string, unknown>).XMLHttpRequest = FakeXhr;

const { fakeNative } = await import('./fake-native');
const native = fakeNative();

it('captures an Angular HttpClient request made over XHR', async () => {
  const http = new HttpClient(new HttpXhrBackend({ build: () => new XMLHttpRequest() }));

  expect(await firstValueFrom(http.post('https://api.example.com/v1/orders/42?token=t', { a: 1 }))).toEqual({ ok: true });

  const rows = (await native.handedOff()).filter((r) => r.eventName === 'http.request');
  expect(rows).toHaveLength(1);
  expect(rows[0]?.attributes).toMatchObject({
    'http.url': 'api.example.com/v1/orders/{id}',
    'http.method': 'POST',
    'http.status_code': 200,
    'http.success': true,
    'http.request_size': 7,
    'http.response_size': 11,
  });
});
