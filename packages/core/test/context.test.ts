import { describe, it, expect, beforeEach } from 'vitest';
import { ContextManager } from '../src/internal/context';
import { SessionManager } from '../src/session/SessionManager';

describe('ContextManager', () => {
  let session: SessionManager;
  let context: ContextManager;

  beforeEach(() => {
    session = new SessionManager({ platform: 'web' });
    context = new ContextManager(session);
  });

  describe('setAppAttributes', () => {
    it('defaults app.environment to "production" when not specified', () => {
      context.setAppAttributes({ apiKey: 'edge_x', endpoint: 'https://example.com/collector/telemetry' });
      const attrs = context.getContextAttributes();
      expect(attrs['app.environment']).toBe('production');
    });

    it('uses the specified environment', () => {
      context.setAppAttributes({ apiKey: 'edge_x', endpoint: 'https://example.com/collector/telemetry', environment: 'staging' });
      const attrs = context.getContextAttributes();
      expect(attrs['app.environment']).toBe('staging');
    });

    it('sets app.name, app.version, app.package_name when provided', () => {
      context.setAppAttributes({
        apiKey: 'edge_x',
        endpoint: 'https://example.com/collector/telemetry',
        appName: 'MyApp',
        appVersion: '2.1.0',
        appPackage: 'com.example.myapp',
      });
      const attrs = context.getContextAttributes();
      expect(attrs['app.name']).toBe('MyApp');
      expect(attrs['app.version']).toBe('2.1.0');
      expect(attrs['app.package_name']).toBe('com.example.myapp');
      expect(attrs['app.package']).toBeUndefined();
    });

    it('omits app.name, app.version, app.package_name when not provided', () => {
      context.setAppAttributes({ apiKey: 'edge_x', endpoint: 'https://example.com/collector/telemetry' });
      const attrs = context.getContextAttributes();
      expect(attrs['app.name']).toBeUndefined();
      expect(attrs['app.version']).toBeUndefined();
      expect(attrs['app.package_name']).toBeUndefined();
    });

    it('omits app.build_number when neither config.appBuild nor setAppBuildNumber has provided one', () => {
      context.setAppAttributes({ apiKey: 'edge_x', endpoint: 'https://example.com/collector/telemetry' });
      const attrs = context.getContextAttributes();
      expect(attrs).not.toHaveProperty('app.build_number');
    });

    it('sets app.build_number from config.appBuild when provided', () => {
      context.setAppAttributes({
        apiKey: 'edge_x',
        endpoint: 'https://example.com/collector/telemetry',
        appBuild: '42',
      });
      const attrs = context.getContextAttributes();
      expect(attrs['app.build_number']).toBe('42');
    });

    it('treats empty/whitespace config.appBuild the same as missing', () => {
      context.setAppAttributes({
        apiKey: 'edge_x',
        endpoint: 'https://example.com/collector/telemetry',
        appBuild: '   ',
      });
      const attrs = context.getContextAttributes();
      expect(attrs).not.toHaveProperty('app.build_number');
    });
  });

  describe('setAppBuildNumber', () => {
    it('overlays app.build_number after setAppAttributes', () => {
      context.setAppAttributes({ apiKey: 'edge_x', endpoint: 'https://example.com/collector/telemetry' });
      context.setAppBuildNumber('42');
      const attrs = context.getContextAttributes();
      expect(attrs['app.build_number']).toBe('42');
    });

    it('ignores empty strings (never overwrites a real build with "")', () => {
      context.setAppAttributes({
        apiKey: 'edge_x',
        endpoint: 'https://example.com/collector/telemetry',
        appBuild: '42',
      });
      context.setAppBuildNumber('');
      const attrs = context.getContextAttributes();
      expect(attrs['app.build_number']).toBe('42');
    });

    it('ignores whitespace-only strings', () => {
      context.setAppAttributes({ apiKey: 'edge_x', endpoint: 'https://example.com/collector/telemetry' });
      context.setAppBuildNumber('   ');
      const attrs = context.getContextAttributes();
      expect(attrs).not.toHaveProperty('app.build_number');
    });
  });

  describe('setAnonymousUserId', () => {
    it('sets user.id to the provided anonymous id', () => {
      context.setAnonymousUserId('user_123_abcd1234');
      const attrs = context.getContextAttributes();
      expect(attrs['user.id']).toBe('user_123_abcd1234');
    });

    it('keeps user.id when identify() is called afterwards (id is SDK-owned)', () => {
      context.setAnonymousUserId('user_123_abcd1234');
      context.setUserAttributes({ name: 'Alice', email: 'alice@example.com' });
      const attrs = context.getContextAttributes();
      expect(attrs['user.id']).toBe('user_123_abcd1234');
    });
  });

  describe('setUserAttributes', () => {
    it('sets user.name, user.email, user.phone when provided', () => {
      context.setAppAttributes({ apiKey: 'edge_x', endpoint: 'https://example.com/collector/telemetry' });
      context.setUserAttributes({ name: 'Alice', email: 'alice@example.com', phone: '+1-555-0100' });
      const attrs = context.getContextAttributes();
      expect(attrs['user.name']).toBe('Alice');
      expect(attrs['user.email']).toBe('alice@example.com');
      expect(attrs['user.phone']).toBe('+1-555-0100');
    });

    it('omits a field when its value is undefined (does not clear existing)', () => {
      context.setUserAttributes({ name: 'Alice' });
      context.setUserAttributes({ email: 'alice@example.com' });
      const attrs = context.getContextAttributes();
      expect(attrs['user.name']).toBe('Alice');
      expect(attrs['user.email']).toBe('alice@example.com');
    });

    it('clears a field when its value is explicitly null', () => {
      context.setUserAttributes({ name: 'Alice', email: 'alice@example.com' });
      context.setUserAttributes({ email: null });
      const attrs = context.getContextAttributes();
      expect(attrs['user.name']).toBe('Alice');
      expect(attrs['user.email']).toBeUndefined();
    });

    it('does not set user.id (id is SDK-owned)', () => {
      context.setUserAttributes({ name: 'Alice' });
      const attrs = context.getContextAttributes();
      expect(attrs['user.id']).toBeUndefined();
    });
  });

  describe('getContextAttributes', () => {
    it('includes sdk.version and sdk.platform', () => {
      const attrs = context.getContextAttributes();
      expect(attrs['sdk.platform']).toBe('ionic-angular-capacitor');
      expect(attrs['sdk.version']).toMatch(/^\d/);
    });

    it('produces only primitive values', () => {
      context.setAppAttributes({ apiKey: 'edge_x', endpoint: 'https://example.com/collector/telemetry', appName: 'x', environment: 'production' });
      context.setAnonymousUserId('user_1_abcd1234');
      context.setUserAttributes({ name: 'Alice' });
      const attrs = context.getContextAttributes();
      for (const v of Object.values(attrs)) {
        expect(typeof v).toMatch(/^(string|number|boolean)$/);
      }
    });
  });

  describe('getStableContextAttributes', () => {
    it('returns app.*, device.*, and sdk.* but not session.* or user.* or network.*', () => {
      context.setAppAttributes({
        apiKey: 'edge_x',
        endpoint: 'https://example.com/collector/telemetry',
        appName: 'MyApp',
      });
      context.setDeviceAttributes({ 'device.id': 'device_1_abcd_web', 'device.platform': 'web' });
      context.setNetworkAttributes({ 'network.type': 'wifi' });
      context.setAnonymousUserId('user_1_abcd1234');
      const stable = context.getStableContextAttributes();
      expect(stable['app.name']).toBe('MyApp');
      expect(stable['device.id']).toBe('device_1_abcd_web');
      expect(stable['sdk.platform']).toBe('ionic-angular-capacitor');
      expect(stable['session.id']).toBeUndefined();
      expect(stable['user.id']).toBeUndefined();
      expect(stable['network.type']).toBeUndefined();
    });
  });
});
