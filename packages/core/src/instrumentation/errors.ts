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
  'crash.breadcrumbs': string;
  'crash.breadcrumb_count': number;
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
    return getCurrentRoute();
  } catch {
    return 'unknown';
  }
}

// Y3 (= Cordova Y2): the origins Capacitor serves the app from. Path kept, query/hash dropped,
// line:col kept. The lazy path stops at the first `:line(:col)` that ends the frame. Ports aren't
// ours (a live-reload dev server keeps its URL).
const SAME_ORIGIN = /(?:https?|capacitor|ionic):\/\/localhost\/([^\s()?#]*?)(?:[?#][^\s()]*?)?(?=(?::\d+){1,2}(?![^\s)])|[\s)]|$)/g;

/** Y3: rewrite same-origin frames to `app:///<path>`; other origins untouched. */
export const normaliseStack = (stack: string): string => stack.replace(SAME_ORIGIN, 'app:///$1');

const text = (v: unknown): string => {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return safeString(v);
  }
};

/**
 * E9–E11: one JS `app.crash`'s keys. P6: message and stack unscrubbed, frames normalised (Y3, no
 * raw copy). `where` is a fallback frame when there is no stack; `type` names non-Error throws.
 * `release` and Tier-2 trace keys are stamped by `record()`.
 */
export function crashAttributes(
  err: unknown,
  handled: boolean,
  cause: string,
  route: string,
  { where, type = 'Error' }: { where?: string; type?: string } = {},
): ErrorEventAttributes {
  // Duck-typed, not `instanceof`: errors from another realm (iframe) are still errors.
  const e = err && typeof err === 'object' ? (err as { name?: unknown; message?: unknown; stack?: unknown }) : undefined;
  const isError = typeof e?.message === 'string';
  const stack = (typeof e?.stack === 'string' && e.stack) || where || '';
  const crumbs = breadcrumbs.snapshot();
  return {
    exception_type: isError && typeof e?.name === 'string' && e.name ? e.name : type,
    message: normaliseStack(isError ? (e?.message as string) : text(err)),
    stacktrace: normaliseStack(stack),
    is_fatal: !handled,
    handled,
    error_context: `screen:${route}`,
    cause,
    runtime: 'webview',
    'crash.breadcrumbs': JSON.stringify(crumbs),
    'crash.breadcrumb_count': crumbs.length,
  };
}

export function registerErrorCapture(deps: ErrorsDeps): ErrorsHandle {
  const target = deps.target ?? (typeof window !== 'undefined' ? window : undefined);
  if (!target) {
    return { dispose: () => undefined };
  }

  const emit = (err: unknown, cause: string, opts?: { where?: string; type?: string }): void => {
    try {
      deps.recordEvent('app.crash', crashAttributes(err, false, cause, resolveContext(deps.getCurrentRoute), opts));
      deps.flushPipeline();
      healthMonitor.reportSuccess('errors.capture');
    } catch (err) {
      healthMonitor.reportError('errors.capture', err);
    }
  };

  // A non-Error throw (`throw 'x'`) is the value itself; cross-origin "Script error." has none.
  const onError = (event: ErrorEvent): void => {
    const where = event.filename ? `at ${event.filename}:${event.lineno}:${event.colno}` : undefined;
    emit(event.error ?? event.message, 'UnhandledError', { where });
  };

  const onRejection = (event: PromiseRejectionEvent): void => {
    emit(event.reason, 'PromiseRejection', { type: 'UnhandledRejection' });
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
  consoleTarget?: Console;
  // ADR-029: console.error lines become crash breadcrumbs, not events. Defaults to
  // the shared ring; injectable for tests.
  pushBreadcrumb?: (message: string) => void;
}

export interface ConsoleErrorHandle {
  dispose: () => void;
}

function messageFromArgs(args: unknown[]): string {
  for (const a of args) {
    if (a instanceof Error) return safeString(a.message, safeString(a.name, 'Error'));
  }
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a);
      } catch {
        return safeString(a);
      }
    })
    .join(' ');
}

export function registerConsoleErrorCapture(deps: ConsoleErrorDeps): ConsoleErrorHandle {
  const consoleObj = deps.consoleTarget ?? (typeof console !== 'undefined' ? console : undefined);
  if (!consoleObj || typeof consoleObj.error !== 'function') {
    return { dispose: () => undefined };
  }

  const pushBreadcrumb = deps.pushBreadcrumb ?? ((message: string) => breadcrumbs.pushConsole(message));
  const originalError = consoleObj.error.bind(consoleObj);

  consoleObj.error = ((...args: unknown[]) => {
    try {
      pushBreadcrumb(messageFromArgs(args));
      healthMonitor.reportSuccess('console.emit');
    } catch (err) {
      healthMonitor.reportError('console.emit', err);
    }
    try {
      originalError(...args);
    } catch (err) {
      healthMonitor.reportError('console.original-error', err);
    }
  }) as Console['error'];

  return {
    dispose: () => {
      try {
        consoleObj.error = originalError;
      } catch (err) {
        healthMonitor.reportError('console.dispose', err);
      }
    },
  };
}
