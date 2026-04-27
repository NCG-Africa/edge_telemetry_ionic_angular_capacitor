# @edgemetrics/rum-capacitor

Capacitor integration for the edge-rum SDK. Collects native device information, monitors network connectivity, and tracks app lifecycle events.

## Install

```bash
npm install @edgemetrics/rum @edgemetrics/rum-angular @edgemetrics/rum-capacitor
```

## What it provides

- **Device context** — model, OS, screen size, battery level, platform detection
- **Network capture** — connectivity changes, connection type (wifi/cellular/none)
- **Lifecycle capture** — foreground/background transitions, session timeout handling

## Usage

If you're using `EdgeRumModule.forRoot()` from `@edgemetrics/rum-angular`, Capacitor capture is wired automatically. For manual setup:

```typescript
import { startCapacitorCapture } from '@edgemetrics/rum-capacitor';

await startCapacitorCapture();
```

## Peer dependencies

- `@capacitor/core` >= 5
- `@capacitor/device` >= 5
- `@capacitor/network` >= 5
- `@capacitor/app` >= 5

## License

[MIT](../../LICENSE)
