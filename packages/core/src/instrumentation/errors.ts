import { healthMonitor } from '../internal/health';
import { breadcrumbs } from '../internal/breadcrumbs';

export type ErrorEventAttributes = {
  exception_type: string;
  message: string;
  stacktrace: string;
  is_fatal: boolean;
  handled: boolean;
  error_context: string;
  cause: string;
  runtime: 'webview';
  'crash.breadcrumbs'?: string;
  'crash.breadcrumb_count'?: number;
};

export interface ErrorsDeps {
  recordEvent: (eventName: 'app.crash', attributes: ErrorEventAttributes) => void;
  flushPipeline: () => void;
  getCurrentRoute: () => string;
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}

export interface ErrorsHandle {
  dispose: () => void;
}

function safeString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return fallback;
  try {
    return String(value);
  } catch {
    return fallback;
  }
}

function resolveContext(getCurrentRoute: () => string): string {
  try {
    return 'screen:' + getCurrentRoute();
  } catch {
    return 'screen:unknown';
  }
}

export function registerErrorCapture(deps: ErrorsDeps): ErrorsHandle {
  const target = deps.target ?? (typeof window !== 'undefined' ? window : undefined);
  if (!target) {
    return { dispose: () => undefined };
  }

  const emit = (attributes: ErrorEventAttributes): void => {
    try {
      const crumbs = breadcrumbs.snapshot();
      const withCrumbs = {
        ...attributes,
        'crash.breadcrumbs': JSON.stringify(crumbs),
        'crash.breadcrumb_count': crumbs.length,
      } as ErrorEventAttributes;
      deps.recordEvent('app.crash', withCrumbs);
      deps.flushPipeline();
    } catch (err) {
      healthMonitor.reportError('errors.capture', err);
    }
  };

  const onError = (event: ErrorEvent): void => {
    try {
      const err = event.error as { name?: unknown; stack?: unknown } | null | undefined;
      const exceptionType = safeString(err?.name, 'Error');
      const message = safeString(event.message, safeString(err, ''));
      const stacktrace = safeString(err?.stack, '');
      emit({
        exception_type: exceptionType,
        message,
        stacktrace,
        is_fatal: false,
        handled: false,
        error_context: resolveContext(deps.getCurrentRoute),
        cause: 'UnhandledError',
        runtime: 'webview',
      });
    } catch (err) {
      healthMonitor.reportError('errors.capture', err);
    }
  };

  const onRejection = (event: PromiseRejectionEvent): void => {
    try {
      const reason = event.reason as { name?: unknown; message?: unknown; stack?: unknown } | unknown;
      const reasonObj =
        reason && typeof reason === 'object'
          ? (reason as { name?: unknown; message?: unknown; stack?: unknown })
          : undefined;
      const message = reasonObj
        ? safeString(reasonObj.message, safeString(reason, ''))
        : safeString(reason, '');
      const stacktrace = reasonObj ? safeString(reasonObj.stack, '') : '';
      emit({
        exception_type: 'UnhandledRejection',
        message,
        stacktrace,
        is_fatal: false,
        handled: false,
        error_context: resolveContext(deps.getCurrentRoute),
        cause: 'PromiseRejection',
        runtime: 'webview',
      });
    } catch (err) {
      healthMonitor.reportError('errors.capture', err);
    }
  };

  target.addEventListener('error', onError as EventListener);
  target.addEventListener('unhandledrejection', onRejection as EventListener);

  return {
    dispose: () => {
      try {
        target.removeEventListener('error', onError as EventListener);
        target.removeEventListener('unhandledrejection', onRejection as EventListener);
      } catch (err) {
        healthMonitor.reportError('errors.dispose', err);
      }
    },
  };
}

export interface ConsoleErrorDeps {
  recordEvent: (eventName: 'app.crash', attributes: ErrorEventAttributes) => void;
  getCurrentRoute: () => string;
  consoleTarget?: Console;
  captureWarn?: boolean;
}

export interface ConsoleErrorHandle {
  dispose: () => void;
}

function stringifyArgs(args: unknown[]): { message: string; stacktrace: string; exceptionType: string } {
  for (const a of args) {
    if (a instanceof Error) {
      return {
        message: safeString(a.message, ''),
        stacktrace: safeString(a.stack, ''),
        exceptionType: safeString(a.name, 'Error'),
      };
    }
  }
  const joined = args
    .map((a) => {
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a);
      } catch {
        return safeString(a);
      }
    })
    .join(' ');
  return { message: joined, stacktrace: '', exceptionType: 'Error' };
}

export function registerConsoleErrorCapture(deps: ConsoleErrorDeps): ConsoleErrorHandle {
  const consoleObj = deps.consoleTarget ?? (typeof console !== 'undefined' ? console : undefined);
  if (!consoleObj || typeof consoleObj.error !== 'function') {
    return { dispose: () => undefined };
  }

  const captureWarn = deps.captureWarn !== false;
  const originalError = consoleObj.error.bind(consoleObj);
  const originalWarn = captureWarn ? consoleObj.warn.bind(consoleObj) : undefined;

  const emitConsole = (level: 'error' | 'warn', args: unknown[]): void => {
    try {
      const { message, stacktrace, exceptionType } = stringifyArgs(args);
      deps.recordEvent('app.crash', {
        exception_type: exceptionType,
        message,
        stacktrace,
        is_fatal: false,
        handled: true,
        error_context: resolveContext(deps.getCurrentRoute),
        cause: level === 'error' ? 'ConsoleError' : 'ConsoleWarn',
        runtime: 'webview',
      });
    } catch (err) {
      healthMonitor.reportError('console.emit', err);
    }
  };

  consoleObj.error = ((...args: unknown[]) => {
    emitConsole('error', args);
    try {
      originalError(...args);
    } catch (err) {
      healthMonitor.reportError('console.original-error', err);
    }
  }) as Console['error'];

  if (captureWarn && originalWarn) {
    consoleObj.warn = ((...args: unknown[]) => {
      emitConsole('warn', args);
      try {
        originalWarn(...args);
      } catch (err) {
        healthMonitor.reportError('console.original-warn', err);
      }
    }) as Console['warn'];
  }

  return {
    dispose: () => {
      try {
        consoleObj.error = originalError;
        if (originalWarn) consoleObj.warn = originalWarn;
      } catch (err) {
        healthMonitor.reportError('console.dispose', err);
      }
    },
  };
}
