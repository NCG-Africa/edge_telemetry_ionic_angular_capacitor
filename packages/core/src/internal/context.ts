import type { EdgeRumConfig, EventAttributes, UserContext } from '../index';
import { SDK_VERSION, SDK_PLATFORM } from '../index';
import type { SessionManager } from '../session/SessionManager';

const DEFAULT_ENVIRONMENT = 'production' as const;

export class ContextManager {
  private appAttributes: EventAttributes = {};
  private deviceAttributes: EventAttributes = {};
  private networkAttributes: EventAttributes = {};
  private userAttributes: EventAttributes = {};
  private readonly session: SessionManager;

  constructor(session: SessionManager) {
    this.session = session;
  }

  setAppAttributes(config: EdgeRumConfig): void {
    this.appAttributes = {};
    if (config.appName) this.appAttributes['app.name'] = config.appName;
    if (config.appVersion) this.appAttributes['app.version'] = config.appVersion;
    if (config.appPackage) this.appAttributes['app.package_name'] = config.appPackage;
    this.appAttributes['app.environment'] = config.environment ?? DEFAULT_ENVIRONMENT;
    this.appAttributes['app.build_number'] = '';
  }

  setAppBuildNumber(build: string): void {
    this.appAttributes['app.build_number'] = build;
  }

  setDeviceAttributes(attrs: EventAttributes): void {
    this.deviceAttributes = { ...attrs };
  }

  setNetworkAttributes(attrs: EventAttributes): void {
    this.networkAttributes = { ...attrs };
  }

  // SDK-owned. Set once at init() to the persisted anonymous ID; identify()
  // does not change it. Backend correlates pre-login and post-login events
  // by user.id.
  setAnonymousUserId(id: string): void {
    this.userAttributes['user.id'] = id;
  }

  // identify() attaches user details. user.id is owned by the SDK and
  // cannot be set here. Passing null for a field clears it.
  setUserAttributes(user: UserContext): void {
    this.applyUserField('user.name', user.name);
    this.applyUserField('user.email', user.email);
    this.applyUserField('user.phone', user.phone);
  }

  private applyUserField(key: string, value: string | null | undefined): void {
    if (value === null) {
      delete this.userAttributes[key];
    } else if (typeof value === 'string') {
      this.userAttributes[key] = value;
    }
    // undefined: leave existing value untouched
  }

  getContextAttributes(): EventAttributes {
    return {
      ...this.appAttributes,
      ...this.deviceAttributes,
      ...this.networkAttributes,
      ...this.session.getSessionAttributes(),
      ...this.userAttributes,
      'sdk.version': SDK_VERSION,
      'sdk.platform': SDK_PLATFORM,
    };
  }

  // Stable context = attrs that don't change for the session lifetime
  // (app.*, device.*, sdk.*). Used by Pipeline.flush to back-fill events
  // that were recorded before device context was loaded.
  getStableContextAttributes(): EventAttributes {
    return {
      ...this.appAttributes,
      ...this.deviceAttributes,
      'sdk.version': SDK_VERSION,
      'sdk.platform': SDK_PLATFORM,
    };
  }
}
