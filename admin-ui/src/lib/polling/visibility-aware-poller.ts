export interface VisibilityDocument {
  readonly hidden: boolean;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export interface VisibilityAwarePoller {
  start(): void;
  stop(): void;
  requestRefresh(): void;
  setPollingEnabled(enabled: boolean): void;
}

export interface VisibilityAwarePollerOptions {
  refresh: () => void | Promise<unknown>;
  intervalMs: number;
  documentRef?: VisibilityDocument;
  pollingEnabled?: boolean;
  onError?: (error: unknown) => void;
}

function defaultErrorReporter(error: unknown): void {
  if (typeof globalThis.reportError === 'function') {
    globalThis.reportError(error);
    return;
  }
  console.error('Visibility-aware poll refresh failed', error);
}

export function createVisibilityAwarePoller(
  options: VisibilityAwarePollerOptions,
): VisibilityAwarePoller {
  if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
    throw new Error('Visibility-aware poll interval must be a positive number');
  }

  const documentRef = options.documentRef
    ?? (typeof document === 'undefined' ? undefined : document);
  const reportError = options.onError ?? defaultErrorReporter;

  let running = false;
  let pollingEnabled = options.pollingEnabled ?? true;
  let interval: ReturnType<typeof setInterval> | undefined;
  let refreshScheduled = false;
  let refreshInFlight = false;
  let refreshPending = false;
  let lastHidden = documentRef?.hidden ?? false;

  function isHidden(): boolean {
    return documentRef?.hidden ?? false;
  }

  function clearPollingInterval(): void {
    if (interval === undefined) return;
    clearInterval(interval);
    interval = undefined;
  }

  function ensurePollingInterval(): void {
    if (!running || !pollingEnabled || isHidden() || interval !== undefined) return;
    interval = setInterval(() => requestRefresh(), options.intervalMs);
  }

  function finishRefresh(): void {
    refreshInFlight = false;
    if (!running || !refreshPending) return;
    refreshPending = false;
    requestRefresh();
  }

  function runScheduledRefresh(): void {
    refreshScheduled = false;
    if (!running) return;
    if (isHidden()) {
      refreshPending = true;
      return;
    }
    if (refreshInFlight) {
      refreshPending = true;
      return;
    }

    refreshInFlight = true;
    let result: void | Promise<unknown>;
    try {
      result = options.refresh();
    } catch (error) {
      reportError(error);
      finishRefresh();
      return;
    }

    void Promise.resolve(result).then(
      () => finishRefresh(),
      (error: unknown) => {
        reportError(error);
        finishRefresh();
      },
    );
  }

  function requestRefresh(): void {
    if (!running) return;
    if (isHidden() || refreshInFlight) {
      refreshPending = true;
      return;
    }
    if (refreshScheduled) return;
    refreshScheduled = true;
    queueMicrotask(runScheduledRefresh);
  }

  function handleVisibilityChange(): void {
    if (!running) return;
    const hidden = isHidden();
    if (hidden === lastHidden) return;
    lastHidden = hidden;

    if (hidden) {
      clearPollingInterval();
      refreshPending = true;
      return;
    }

    refreshPending = false;
    requestRefresh();
    ensurePollingInterval();
  }

  function start(): void {
    if (running) return;
    running = true;
    lastHidden = isHidden();
    documentRef?.addEventListener('visibilitychange', handleVisibilityChange);
    if (lastHidden) {
      refreshPending = true;
      return;
    }
    requestRefresh();
    ensurePollingInterval();
  }

  function stop(): void {
    if (!running) return;
    running = false;
    documentRef?.removeEventListener('visibilitychange', handleVisibilityChange);
    clearPollingInterval();
    refreshScheduled = false;
    refreshPending = false;
  }

  function setPollingEnabled(enabled: boolean): void {
    if (pollingEnabled === enabled) return;
    pollingEnabled = enabled;
    if (!enabled) {
      clearPollingInterval();
      return;
    }
    if (!running || isHidden()) return;
    requestRefresh();
    ensurePollingInterval();
  }

  return {
    start,
    stop,
    requestRefresh,
    setPollingEnabled,
  };
}
