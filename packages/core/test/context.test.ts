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
      context.setAppAttributes({ apiKey: 'edge_x' });
      const attrs = context.getContextAttributes();
      expect(attrs['app.environment']).toBe('production');
    });

    it('uses the specified environment', () => {
      context.setAppAttributes({ apiKey: 'edge_x', environment: 'staging' });
      const attrs = context.getContextAttributes();
      expect(attrs['app.environment']).toBe('staging');
    });

    it('sets app.name, app.version, app.package when provided', () => {
      context.setAppAttributes({
        apiKey: 'edge_x',
        appName: 'MyApp',
        appVersion: '2.1.0',
        appPackage: 'com.example.myapp',
      });
      const attrs = context.getContextAttributes();
      expect(attrs['app.name']).toBe('MyApp');
      expect(attrs['app.version']).toBe('2.1.0');
      expect(attrs['app.package']).toBe('com.example.myapp');
    });

    it('omits app.name, app.version, app.package when not provided', () => {
      context.setAppAttributes({ apiKey: 'edge_x' });
      const attrs = context.getContextAttributes();
      expect(attrs['app.name']).toBeUndefined();
      expect(attrs['app.version']).toBeUndefined();
      expect(attrs['app.package']).toBeUndefined();
    });
  });

  describe('setUserAttributes — PII blocking', () => {
    it('does not emit user.email even when passed', () => {
      context.setAppAttributes({ apiKey: 'edge_x' });
      context.setUserAttributes({ id: 'u1', email: 'alice@example.com' });
      const attrs = context.getContextAttributes();
      expect(attrs['user.email']).toBeUndefined();
      expect(JSON.stringify(attrs)).not.toContain('alice@example.com');
    });

    it('does not emit user.phone, user.name, user.username, user.password', () => {
      context.setAppAttributes({ apiKey: 'edge_x' });
      context.setUserAttributes({
        id: 'u1',
        phone: '+1-555-0100',
        name: 'Alice Example',
        username: 'alice',
        password: 'hunter2',
      });
      const attrs = context.getContextAttributes();
      expect(attrs['user.phone']).toBeUndefined();
      expect(attrs['user.name']).toBeUndefined();
      expect(attrs['user.username']).toBeUndefined();
      expect(attrs['user.password']).toBeUndefined();
      const serialised = JSON.stringify(attrs);
      expect(serialised).not.toContain('+1-555-0100');
      expect(serialised).not.toContain('Alice Example');
      expect(serialised).not.toContain('alice');
      expect(serialised).not.toContain('hunter2');
    });

    it('preserves non-PII custom user attributes', () => {
      context.setAppAttributes({ apiKey: 'edge_x' });
      context.setUserAttributes({ id: 'u1', plan: 'pro', seats: 5 });
      const attrs = context.getContextAttributes();
      expect(attrs['user.plan']).toBe('pro');
      expect(attrs['user.seats']).toBe(5);
    });

    it('sets user.id when provided', () => {
      context.setAppAttributes({ apiKey: 'edge_x' });
      context.setUserAttributes({ id: 'u1' });
      const attrs = context.getContextAttributes();
      expect(attrs['user.id']).toBe('u1');
    });

    it('auto-generates user.id when identify called without an id', () => {
      context.setAppAttributes({ apiKey: 'edge_x' });
      context.setUserAttributes({});
      const attrs = context.getContextAttributes();
      expect(attrs['user.id']).toMatch(/^user_\d+_[0-9a-f]{8}$/);
    });
  });

  describe('getContextAttributes', () => {
    it('includes sdk.version and sdk.platform', () => {
      const attrs = context.getContextAttributes();
      expect(attrs['sdk.platform']).toBe('ionic-angular-capacitor');
      expect(attrs['sdk.version']).toMatch(/^\d/);
    });

    it('produces only primitive values', () => {
      context.setAppAttributes({ apiKey: 'edge_x', appName: 'x', environment: 'production' });
      context.setUserAttributes({ id: 'u1' });
      const attrs = context.getContextAttributes();
      for (const v of Object.values(attrs)) {
        expect(typeof v).toMatch(/^(string|number|boolean)$/);
      }
    });
  });
});
