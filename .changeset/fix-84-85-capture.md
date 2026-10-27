---
"@nathanclaire/rum": patch
"@nathanclaire/rum-angular": patch
---

Fix `screen.duration` never firing in real Ionic apps: lifecycle listeners now register in the capture phase, since Ionic dispatches `ionViewDidEnter`/`ionViewDidLeave` without bubbling (#84). Capture `XMLHttpRequest` requests alongside `fetch`, so Angular `HttpClient` traffic (XHR by default up to Angular 21) produces `http.request` events (#85).
