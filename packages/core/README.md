# @edgemetrics/rum

Core Real User Monitoring SDK for Ionic Angular Capacitor apps.

This is the core package that handles event capture, batching, offline queuing, and transport. For most apps, you'll also want [`@edgemetrics/rum-angular`](https://www.npmjs.com/package/@edgemetrics/rum-angular) and [`@edgemetrics/rum-capacitor`](https://www.npmjs.com/package/@edgemetrics/rum-capacitor).

## Install

```bash
npm install @edgemetrics/rum @edgemetrics/rum-angular @edgemetrics/rum-capacitor
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
