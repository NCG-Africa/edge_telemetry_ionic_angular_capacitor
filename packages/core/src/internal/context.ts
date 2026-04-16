import type { EdgeRumConfig, EventAttributes, UserContext } from '../index';
import { SDK_VERSION, SDK_PLATFORM } from '../index';
import type { SessionManager } from '../session/SessionManager';
import { generateUserId } from '../session/SessionIdGenerator';

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
    if (config.appPackage) this.appAttributes['app.package'] = config.appPackage;
    if (config.environment) this.appAttributes['app.environment'] = config.environment;
  }

  setDeviceAttributes(attrs: EventAttributes): void {
    this.deviceAttributes = { ...attrs };
  }

  setNetworkAttributes(attrs: EventAttributes): void {
    this.networkAttributes = { ...attrs };
  }

  setUserAttributes(user: UserContext): void {
    this.userAttributes = {};
    if (user.id) {
      this.userAttributes['user.id'] = user.id;
    } else {
      this.userAttributes['user.id'] = generateUserId();
    }
    for (const [key, value] of Object.entries(user)) {
      if (key === 'id' || key === 'email') continue;
      if (value !== undefined) {
        this.userAttributes[`user.${key}`] = value;
      }
    }
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
}
