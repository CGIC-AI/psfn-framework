import { isObjectRecord as isRecord } from '../../../../src/shared/utils/types.js';
import { hasExactKeys } from '../protocol/validation.js';

/** Redacted projection for the device attached to this companion connection. */
export interface BrowserEmbodimentStatus {
  readonly generation: number;
  readonly version: number;
  readonly primaryPresent: boolean;
  readonly currentDeviceIsPrimary: boolean;
  readonly lastDecision: Readonly<{
    decision: 'handoff' | 'invalidated';
    reason: 'user_requested' | 'device_replacement' | 'recovery' | 'device_revoked' | 'enrollment_revoked';
    decidedAt: string;
  }> | null;
}

export interface BrowserEmbodimentPort {
  read(): Promise<BrowserEmbodimentStatus>;
  handoff(expectedGeneration: number): Promise<BrowserEmbodimentStatus>;
}

export function parseBrowserEmbodimentStatus(value: unknown): BrowserEmbodimentStatus | undefined {
  if (!isRecord(value)
    || !hasExactKeys(value, ['generation', 'version', 'primaryPresent', 'currentDeviceIsPrimary', 'lastDecision'])
    || !Number.isSafeInteger(value.generation) || Number(value.generation) < 0
    || !Number.isSafeInteger(value.version) || Number(value.version) < 0
    || typeof value.primaryPresent !== 'boolean' || typeof value.currentDeviceIsPrimary !== 'boolean'
    || (value.currentDeviceIsPrimary && !value.primaryPresent)) return undefined;
  const last = value.lastDecision;
  if (last !== null) {
    if (!isRecord(last) || !hasExactKeys(last, ['decision', 'reason', 'decidedAt'])
      || (last.decision !== 'handoff' && last.decision !== 'invalidated')
      || typeof last.reason !== 'string'
      || !(last.decision === 'handoff'
        ? ['user_requested', 'device_replacement', 'recovery']
        : ['device_revoked', 'enrollment_revoked']).includes(last.reason)
      || typeof last.decidedAt !== 'string' || !Number.isFinite(Date.parse(last.decidedAt))
      || new Date(last.decidedAt).toISOString() !== last.decidedAt) return undefined;
  }
  return Object.freeze({
    generation: Number(value.generation),
    version: Number(value.version),
    primaryPresent: value.primaryPresent,
    currentDeviceIsPrimary: value.currentDeviceIsPrimary,
    lastDecision: last === null ? null : Object.freeze({
      decision: last.decision as NonNullable<BrowserEmbodimentStatus['lastDecision']>['decision'],
      reason: last.reason as NonNullable<BrowserEmbodimentStatus['lastDecision']>['reason'],
      decidedAt: last.decidedAt as string,
    }),
  });
}

/** One outstanding operation, scoped to the lifetime of one attached socket. */
export class BrowserEmbodimentRequests implements BrowserEmbodimentPort {
  private pending: {
    requestId: string;
    resource: 'embodiment.status' | 'embodiment.handoff';
    promise: Promise<BrowserEmbodimentStatus>;
    resolve(status: BrowserEmbodimentStatus): void;
    reject(error: Error): void;
    timeout: ReturnType<typeof globalThis.setTimeout>;
  } | null = null;

  constructor(private readonly options: {
    requestId(): string;
    timeoutMs: number;
    send(requestId: string, resource: 'embodiment.status' | 'embodiment.handoff', body: Record<string, unknown>): void;
    abandon(requestId: string): void;
  }) {}

  read(): Promise<BrowserEmbodimentStatus> {
    if (this.pending?.resource === 'embodiment.status') return this.pending.promise;
    return this.request('embodiment.status', {});
  }

  handoff(expectedGeneration: number): Promise<BrowserEmbodimentStatus> {
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) {
      return Promise.reject(new Error('Read the current embodiment status before switching devices.'));
    }
    return this.request('embodiment.handoff', {
      expectedGeneration,
      decisionId: globalThis.crypto.randomUUID(),
      reason: 'user_requested',
    });
  }

  consume(requestId: string, value: unknown): boolean {
    if (this.pending?.requestId !== requestId) return false;
    const status = parseBrowserEmbodimentStatus(value);
    if (!status) {
      this.reset(new Error('The embodiment status was invalid. Reconnect and try again.'));
      return false;
    }
    const pending = this.pending;
    this.pending = null;
    globalThis.clearTimeout(pending.timeout);
    pending.resolve(status);
    return true;
  }

  reset(error: Error): void {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    globalThis.clearTimeout(pending.timeout);
    this.options.abandon(pending.requestId);
    pending.reject(error);
  }

  private request(
    resource: 'embodiment.status' | 'embodiment.handoff',
    body: Record<string, unknown>,
  ): Promise<BrowserEmbodimentStatus> {
    if (this.pending) return Promise.reject(new Error('An embodiment request is already in progress.'));
    let resolve!: (status: BrowserEmbodimentStatus) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<BrowserEmbodimentStatus>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    const requestId = this.options.requestId();
    const timeout = globalThis.setTimeout(() => {
      this.reset(new Error('The embodiment request timed out. Refresh its status before trying again.'));
    }, this.options.timeoutMs);
    this.pending = { requestId, resource, promise, resolve, reject, timeout };
    try {
      this.options.send(requestId, resource, body);
    } catch {
      this.reset(new Error('The embodiment request could not be sent. Reconnect and try again.'));
    }
    return promise;
  }
}
