# @nathanclaire/rum-capacitor

Capacitor integration for the edge-rum SDK. Collects native device information, monitors network connectivity, and tracks app lifecycle events.

## Install

```bash
npm install @nathanclaire/rum @nathanclaire/rum-angular @nathanclaire/rum-capacitor
```

## What it provides

- **Device context** — model, OS, screen size, battery level, platform detection
- **Network capture** — connectivity changes, connection type (wifi/cellular/none)
- **Lifecycle capture** — foreground/background transitions, session timeout handling

## Usage

If you're using `EdgeRumModule.forRoot()` from `@nathanclaire/rum-angular`, Capacitor capture is wired automatically. For manual setup:

```typescript
import { startCapacitorCapture } from '@nathanclaire/rum-capacitor';

await startCapacitorCapture();
```

## Peer dependencies

- `@capacitor/core` >= 5
- `@capacitor/device` >= 5
- `@capacitor/network` >= 5
- `@capacitor/app` >= 5

## License

[MIT](../../LICENSE)
