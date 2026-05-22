---
'@nathanclaire/rum': major
'@nathanclaire/rum-angular': major
'@nathanclaire/rum-capacitor': major
---

BREAKING: Align outbound payload with the EdgeTelemetryProcessor contract.

Envelope:
- `type` changes from `"batch"` to `"telemetry_batch"`.
- Top-level `device_id` field is removed (each event still carries `device.id` in `attributes`).
- New optional top-level `location` field, sourced from `EdgeRumConfig.location` (e.g. `"Nairobi/Kenya"`).
- `tenant_id` is added by the backend collector from the API key — the SDK no longer sends it.

Event renames:
- `network_request` → `http.request`. Attribute keys move from `network.*` to `http.*`:
  - `http.url`, `http.method`, `http.status_code`, `http.duration_ms`
  - new: `http.success` (boolean), `http.timestamp` (ISO 8601)
  - removed: `network.request_body_size`, `network.response_body_size`, `network.parent_screen`
  - `network.type` (wifi / cellular / etc.) stays on every event as part of the context block.
- `screen_view` is no longer emitted. The `navigation` event is the entry marker.
- `screen_timing` is replaced by `screen.duration`, emitted only on screen exit with full dwell time and `screen.exit_method` (currently always `"navigate"`).
- `navigation.duration_ms` removed from the `navigation` event (backend ignored it).

Config:
- `EdgeRumConfig.location?: string` added (optional).
