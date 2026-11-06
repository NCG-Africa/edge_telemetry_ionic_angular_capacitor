import type { CapacitorConfig } from '@capacitor/cli';

// Spec C1: native config. EDGE_RUM_ENDPOINT defaults to mock-ingest on the host, which the simulator
// reaches as localhost and the emulator through `adb reverse tcp:4319 tcp:4319`; on a real phone set
// it to http://<laptop LAN ip>:4319/collector/telemetry.
const config: CapacitorConfig = {
  appId: 'com.nathanclaire.rum.demo',
  appName: 'EdgeRumDemo',
  webDir: 'www',
  plugins: {
    EdgeRum: {
      apiKey: process.env.EDGE_RUM_API_KEY ?? 'demo-key',
      endpoint: process.env.EDGE_RUM_ENDPOINT ?? 'http://localhost:4319/collector/telemetry',
    },
  },
};

export default config;
