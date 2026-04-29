# @nathanclaire/rum

Core Real User Monitoring SDK for Ionic Angular Capacitor apps.

This is the core package that handles event capture, batching, offline queuing, and transport. For most apps, you'll also want [`@nathanclaire/rum-angular`](https://www.npmjs.com/package/@nathanclaire/rum-angular) and [`@nathanclaire/rum-capacitor`](https://www.npmjs.com/package/@nathanclaire/rum-capacitor).

## Install

```bash
npm install @nathanclaire/rum @nathanclaire/rum-angular @nathanclaire/rum-capacitor
```

## Usage

See the [quick start guide](https://github.com/mktowett/edge_telemetry_ionic_angular_capacitor/blob/main/docs/quick-start.md) for full setup instructions.

## API

```typescript
EdgeRum.init(config)        // Initialize the SDK
EdgeRum.identify(user)      // Attach a user ID to events
EdgeRum.track(name, attrs)  // Record a custom event
EdgeRum.time(name)          // Start a timer (returns { end() })
EdgeRum.captureError(err)   // Record a handled error
EdgeRum.disable()           // Pause capture and clear queue
EdgeRum.enable()            // Resume capture
EdgeRum.getSessionId()      // Get the current session ID
```

## License

[MIT](../../LICENSE)
