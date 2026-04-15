export type ErrorEventAttributes = {
  exception_type: string;
  message: string;
  stacktrace: string;
  is_fatal: boolean;
  handled: boolean;
  error_context: string;
  cause: string;
  runtime: 'webview';
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
      deps.recordEvent('app.crash', attributes);
      deps.flushPipeline();
    } catch {
      // Never let capture errors escape into consumer code.
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
    } catch {
      // Never let capture errors escape into consumer code.
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
    } catch {
      // Never let capture errors escape into consumer code.
    }
  };

  target.addEventListener('error', onError as EventListener);
  target.addEventListener('unhandledrejection', onRejection as EventListener);

  return {
    dispose: () => {
      try {
        target.removeEventListener('error', onError as EventListener);
        target.removeEventListener('unhandledrejection', onRejection as EventListener);
      } catch {
        // ignore
      }
    },
  };
}
