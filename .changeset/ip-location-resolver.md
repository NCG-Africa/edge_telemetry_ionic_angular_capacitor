---
'@nathanclaire/rum': minor
'@nathanclaire/rum-angular': minor
'@nathanclaire/rum-capacitor': minor
---

Add opt-in IP-based location resolution.

Two new optional fields on `EdgeRumConfig`:

- `resolveLocation?: boolean` — default `false`. When `true` and `location` is not explicitly set, the SDK calls `locationProviderUrl` once on init, parses the response into a `"City/Country"` string, caches it in `localStorage` for 24h, and stamps it into every batch envelope.
- `locationProviderUrl?: string` — default `"https://ipapi.co/json/"`. Provider response must include `city` and either `country_name` (ipapi.co) or `country` (ipinfo.io and most others).

Explicit `config.location` always wins. The provider URL is auto-added to `ignoreUrls` so HTTP capture never records the resolver's own request. All failures swallowed (debug-logged). Off by default because enabling it sends the device IP to a third-party provider.
