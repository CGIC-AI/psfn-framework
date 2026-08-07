import { JSONRPCErrorException } from 'json-rpc-2.0';
import { Worker } from 'node:worker_threads';
import type { JournalEntry } from '../../../core/session/types.js';
import type { JournalIntegrityVerificationResult } from '../../../persistence/journals/journal-utils.js';
import type { SessionIntegrityProvider } from '../../../persistence/sessions/store.js';
import type { CompanionId } from '../../../shared/routing/companion-id.js';
import { createComponentLogger } from '../../../shared/logger.js';
import type { SessionHmacSignResult, SessionHmacVerifyResult } from '../protocol.js';
import type { GatewayRpcEndpoint } from '../transport.js';
import {
  SESSION_INTEGRITY_RESPONSE_BUFFER_BYTES,
  SESSION_INTEGRITY_VERIFY_CACHE_MAX_ENTRIES,
  SESSION_INTEGRITY_WORKER_SOURCE,
} from '../session-integrity-worker-source.js';

const log = createComponentLogger('GatewayClient');

export interface GatewayClientSessionIntegrityRuntimeOptions {
  endpoint: GatewayRpcEndpoint | null;
  rpcTimeoutMs: number;
  signMaxRetries?: number;
  signRetryBaseDelayMs?: number;
  companionId?: CompanionId;
  authToken?: string;
}

export type SessionIntegritySyncRequest = <T>(
  method: 'session.hmac.sign' | 'session.hmac.verify',
  params: Record<string, unknown>,
) => T;

/** Owns the synchronous session-integrity worker, retry loop, and verify cache. */
export class GatewayClientSessionIntegrityRuntime {
  private worker: Worker | null = null;
  private requestCounter = 0;
  private readonly verifyCache = new Map<string, JournalIntegrityVerificationResult>();

  constructor(private readonly options: GatewayClientSessionIntegrityRuntimeOptions) {}

  createProvider(
    requestSync: SessionIntegritySyncRequest = <T>(method: 'session.hmac.sign' | 'session.hmac.verify', params: Record<string, unknown>) => this.requestSync<T>(method, params),
  ): SessionIntegrityProvider {
    return {
      sign: (entry, previousHmac) => {
        const result = this.requestSignWithRetry(entry, previousHmac, requestSync);
        return result.entry;
      },
      verify: (entry, previousHmac) => {
        const cacheKey = buildVerifyCacheKey(entry, previousHmac);
        const cached = this.verifyCache.get(cacheKey);
        if (cached) {
          this.verifyCache.delete(cacheKey);
          this.verifyCache.set(cacheKey, cached);
          return { ...cached };
        }

        const result = requestSync<SessionHmacVerifyResult>('session.hmac.verify', {
          entry,
          previousHmac,
        });
        this.verifyCache.set(cacheKey, { ...result });
        while (this.verifyCache.size > SESSION_INTEGRITY_VERIFY_CACHE_MAX_ENTRIES) {
          const oldestKey = this.verifyCache.keys().next().value;
          if (oldestKey === undefined) break;
          this.verifyCache.delete(oldestKey);
        }
        return result;
      },
    };
  }

  destroy(): void {
    this.verifyCache.clear();
    if (this.worker) {
      void this.worker.terminate();
      this.worker = null;
    }
  }

  private requestSignWithRetry(
    entry: JournalEntry,
    previousHmac: string | null,
    requestSync: SessionIntegritySyncRequest,
  ): SessionHmacSignResult {
    const maxRetries = this.options.signMaxRetries;
    let remainingRetries = maxRetries;
    for (;;) {
      try {
        return requestSync<SessionHmacSignResult>('session.hmac.sign', {
          entry,
          previousHmac,
        });
      } catch (error) {
        const timedOut = error instanceof Error && (
          error.message === 'Session integrity RPC timed out' // ubs:ignore — public error label
          // ubs:ignore — public error label
          || error.message === 'Session integrity RPC timed out for session.hmac.sign'
        );
        if (!timedOut
          || typeof maxRetries !== 'number'
          || typeof remainingRetries !== 'number'
          || typeof this.options.signRetryBaseDelayMs !== 'number'
          || remainingRetries <= 0) {
          throw error;
        }
        const retryCount = maxRetries - remainingRetries + 1;
        remainingRetries -= 1;
        log.warn('Session integrity sign RPC timed out; retrying idempotent signing request', {
          retryCount,
          maxRetries,
          backoffMs: this.options.signRetryBaseDelayMs,
        });
        const backoffState = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
        Atomics.wait(backoffState, 0, 0, this.options.signRetryBaseDelayMs);
      }
    }
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    if (!this.options.endpoint) {
      throw new Error('Session integrity provider requires a gateway socket path or gateway RPC endpoint');
    }
    const worker = new Worker(SESSION_INTEGRITY_WORKER_SOURCE, { eval: true });
    worker.on('error', (error) => {
      log.error('Session integrity worker error', { error: error.message });
    });
    this.worker = worker;
    return worker;
  }

  requestSync<T>(
    method: 'session.hmac.sign' | 'session.hmac.verify',
    params: Record<string, unknown>,
  ): T {
    const worker = this.ensureWorker();
    const stateBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const payloadBuffer = new SharedArrayBuffer(SESSION_INTEGRITY_RESPONSE_BUFFER_BYTES);
    const state = new Int32Array(stateBuffer);
    const requestId = ++this.requestCounter;

    worker.postMessage({
      stateBuffer,
      payloadBuffer,
      endpoint: this.options.endpoint,
      method,
      params,
      companionId: this.options.companionId,
      companionAuthToken: this.options.authToken,
      requestId,
      timeoutMs: this.options.rpcTimeoutMs,
    });

    const wait = Atomics.wait(state, 0, 0, this.options.rpcTimeoutMs + 250);
    if (wait === 'timed-out') {
      throw new Error(`Session integrity RPC timed out for ${method}`);
    }
    const payloadSize = Atomics.load(state, 1);
    if (!Number.isInteger(payloadSize)
      || payloadSize <= 0
      || payloadSize > SESSION_INTEGRITY_RESPONSE_BUFFER_BYTES) {
      throw new Error('Session integrity RPC returned an invalid payload');
    }

    const raw = Buffer.from(new Uint8Array(payloadBuffer, 0, payloadSize)).toString('utf8');
    const parsed = JSON.parse(raw) as {
      ok: boolean;
      response?: { result?: unknown; error?: { code: number; message: string } };
      error?: string;
    };
    if (!parsed.ok) {
      throw new Error(parsed.error ?? `Session integrity RPC failed for ${method}`);
    }
    const rpcResponse = parsed.response;
    if (!rpcResponse) {
      throw new Error(`Session integrity RPC missing response for ${method}`);
    }
    if (rpcResponse.error) {
      throw new JSONRPCErrorException(rpcResponse.error.message, rpcResponse.error.code);
    }
    return rpcResponse.result as T;
  }
}

function buildVerifyCacheKey(entry: JournalEntry, previousHmac: string | null): string {
  return JSON.stringify({
    previousHmac,
    type: entry.type,
    id: entry.id,
    channelId: entry.channelId,
    role: entry.role ?? null,
    content: entry.content ?? null,
    authorId: entry.authorId ?? null,
    authorName: entry.authorName ?? null,
    timestamp: entry.timestamp,
    discordMessageId: entry.discordMessageId ?? null,
    metadata: entry.metadata ?? null,
    originChannelId: entry.originChannelId ?? null,
    channelVisibility: entry.channelVisibility ?? null,
    summary: entry.summary ?? null,
    coveredUpTo: entry.coveredUpTo ?? null,
    marker: entry.marker ?? null,
    tombstoneTargetType: entry.tombstoneTargetType ?? null,
    tombstoneTargetId: entry.tombstoneTargetId ?? null,
    tombstoneAction: entry.tombstoneAction ?? null,
    tombstoneActor: entry.tombstoneActor ?? null,
    tombstoneReason: entry.tombstoneReason ?? null,
    _hmac: entry._hmac ?? null,
    _hmacKeyVersion: entry._hmacKeyVersion ?? null,
  });
}
