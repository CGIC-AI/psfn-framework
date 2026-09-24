// decide(): the single typed-decision entry (epic psfn-framework-4lf3r).
//
// Every decision site calls `DecisionRuntime.decide` with a stable site id, a
// JSON state and typed questions. The runtime chooses the backend from
// settings.json `decisionBackend`:
//
// - `local` (default, and whenever the block is absent): only the local path
//   runs. No remote backend is touched.
// - `jev`: the remote backend answers; on any failure, timeout, oversize state
//   or unavailable backend the local path answers (`backend: local-fallback`).
// - `shadow`: both run; the caller receives the local outcome as soon as it is
//   ready, and a content-free comparison record is written once both settle.
//
// Privacy is enforced here, not at call sites: a `companion_private` site, or a
// call whose correlation is companion-private, always answers locally.
//
// A site that already had a model call before this primitive existed passes
// that exact call as its `localStrategy`, so its local path is byte-identical
// to the pre-migration behaviour; new sites use the generic local backend.

import { createComponentLogger } from '../../../shared/logger.js';
import {
  resolveDecisionSiteMode,
  type DecisionBackendMode,
  type DecisionBackendSettings,
  type DecisionSiteId,
  type DecisionSiteSettings,
} from '../../../system/config/decision-backend-config.js';
import type { LocalDecisionBackend } from './local-backend.js';
import { buildDecisionShadowRecord, type DecisionShadowSink } from './shadow-record.js';
import { decisionSitePrivacy } from './sites.js';
import type { DecisionOutcome, DecisionQuestionSet, DecisionRequest } from './types.js';

const log = createComponentLogger('decision-runtime');

interface DecideOptions {
  /**
   * The site's own local implementation. When present it replaces the generic
   * local backend, so a migrated site's local behaviour is unchanged.
   */
  localStrategy?: () => Promise<DecisionOutcome>;
}

/** What a remote backend receives: no work spec, no correlation. */
interface RemoteDecisionRequest {
  siteId: DecisionSiteId;
  state: DecisionRequest['state'];
  questions: DecisionQuestionSet;
}

export interface RemoteDecisionBackend {
  decide(request: RemoteDecisionRequest, signal: AbortSignal): Promise<DecisionOutcome>;
}

export interface DecisionRuntime {
  decide(request: DecisionRequest, options?: DecideOptions): Promise<DecisionOutcome>;
  /** Effective mode for a site after privacy enforcement. */
  effectiveMode(siteId: DecisionSiteId): DecisionBackendMode;
  /** The site's owner-configured knobs (threshold, topN, ...), read live. */
  siteSettings(siteId: DecisionSiteId): DecisionSiteSettings | undefined;
}

export interface DecisionRuntimeOptions {
  local: LocalDecisionBackend;
  /** Remote backend; absent when not wired (then jev/shadow degrade to local). */
  jev?: RemoteDecisionBackend;
  /** Read per call so a settings reload applies without a restart. */
  resolveSettings: () => DecisionBackendSettings | undefined;
  shadowSink?: DecisionShadowSink;
  now?: () => number;
}

export function createDecisionRuntime(options: DecisionRuntimeOptions): DecisionRuntime {
  const now = options.now ?? Date.now;

  function effectiveMode(siteId: DecisionSiteId, request?: DecisionRequest): DecisionBackendMode {
    if (decisionSitePrivacy(siteId) === 'companion_private') return 'local';
    if (request?.workSpec.correlation?.telemetryVisibility === 'companion_private') return 'local';
    return resolveDecisionSiteMode(options.resolveSettings(), siteId);
  }

  async function runLocal(request: DecisionRequest, decideOptions?: DecideOptions): Promise<DecisionOutcome> {
    if (decideOptions?.localStrategy) return await decideOptions.localStrategy();
    return await options.local.decide(request);
  }

  async function runRemote(request: DecisionRequest): Promise<DecisionOutcome> {
    const startedAt = now();
    const settings = options.resolveSettings();
    const jev = options.jev;
    if (!jev || !settings) {
      return { ok: false, reason: 'error', backend: 'jev', latencyMs: 0 };
    }
    const remoteRequest: RemoteDecisionRequest = {
      siteId: request.siteId,
      state: request.state,
      questions: request.questions,
    };
    if (JSON.stringify(remoteRequest).length > settings.jev.maxRequestChars) {
      return { ok: false, reason: 'invalid_output', backend: 'jev', latencyMs: 0 };
    }
    const controller = new AbortController();
    const abortFromCaller = (): void => controller.abort();
    request.signal?.addEventListener('abort', abortFromCaller, { once: true });
    const timer = setTimeout(() => controller.abort(), settings.jev.timeoutMs);
    try {
      return await jev.decide(remoteRequest, controller.signal);
    } catch (error) {
      log.warn('Remote decision backend failed; answering locally', {
        siteId: request.siteId,
        aborted: controller.signal.aborted,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      return {
        ok: false,
        reason: controller.signal.aborted ? 'aborted' : 'error',
        backend: 'jev',
        latencyMs: now() - startedAt,
      };
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', abortFromCaller);
    }
  }

  function recordShadow(request: DecisionRequest, local: DecisionOutcome, remote: DecisionOutcome): void {
    if (!options.shadowSink) return;
    try {
      options.shadowSink.record(buildDecisionShadowRecord({
        siteId: request.siteId,
        questions: request.questions,
        local,
        jev: remote,
        recordedAtMs: now(),
      }));
    } catch (error) {
      log.warn('Failed to write decision shadow record', {
        siteId: request.siteId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    effectiveMode: (siteId) => effectiveMode(siteId),
    siteSettings: (siteId) => options.resolveSettings()?.sites[siteId],
    async decide(request, decideOptions) {
      const mode = effectiveMode(request.siteId, request);
      if (mode === 'local') return await runLocal(request, decideOptions);

      if (mode === 'jev') {
        const remote = await runRemote(request);
        if (remote.ok) return remote;
        const local = await runLocal(request, decideOptions);
        return { ...local, backend: 'local-fallback' };
      }

      // shadow: act on local; compare once both settle, without delaying the caller.
      const remotePromise = runRemote(request);
      const local = await runLocal(request, decideOptions);
      void remotePromise.then((remote) => recordShadow(request, local, remote));
      return local;
    },
  };
}
