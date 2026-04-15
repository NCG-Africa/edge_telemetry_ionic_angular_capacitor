import { ErrorHandler, Injectable } from '@angular/core';
import { EdgeRum } from '@edgemetrics/rum';

const TEMPLATE_PATTERN = /([A-Z][A-Za-z0-9_]*)_Template_/;
const HOST_BINDING_PATTERN = /([A-Z][A-Za-z0-9_]*)_HostBindings/;

function extractComponentName(stack: string | undefined): string | null {
  if (!stack) {
    return null;
  }
  const templateMatch = TEMPLATE_PATTERN.exec(stack);
  if (templateMatch && templateMatch[1]) {
    return templateMatch[1];
  }
  const hostMatch = HOST_BINDING_PATTERN.exec(stack);
  if (hostMatch && hostMatch[1]) {
    return hostMatch[1];
  }
  return null;
}

function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === 'string') {
    return new Error(value);
  }
  if (value && typeof value === 'object' && 'message' in value) {
    const message = (value as { message?: unknown }).message;
    const err = new Error(typeof message === 'string' ? message : 'Unknown error');
    const stack = (value as { stack?: unknown }).stack;
    if (typeof stack === 'string') {
      err.stack = stack;
    }
    return err;
  }
  return new Error('Unknown error');
}

function currentRoute(): string {
  if (typeof window !== 'undefined' && window.location) {
    return `${window.location.pathname}${window.location.search}`;
  }
  return '';
}

@Injectable()
export class EdgeRumErrorCapture extends ErrorHandler {
  private readonly routeProvider: () => string;

  constructor(routeProvider: () => string = currentRoute) {
    super();
    this.routeProvider = routeProvider;
  }

  override handleError(error: unknown): void {
    try {
      const err = toError(error);
      const component = extractComponentName(err.stack);
      const route = this.routeProvider();
      const context: Record<string, string | number | boolean> = {
        cause: 'AngularError',
        error_context: `screen:${route}`,
        handled: true,
      };
      if (component !== null) {
        context['component'] = component;
      }
      EdgeRum.captureError(err, context);
    } catch {
      // Never let capture path break the host app.
    }
    super.handleError(error);
  }
}
