import type { IcpInitiationCandidateStorePort } from './autonomy-store-ports.js';
import type { IcpInitiationSourceRuntime } from './initiation-source-runtime.js';
import { createComponentLogger } from '../../shared/logger.js';

const log = createComponentLogger('IcpCandidateLifecycleSupervisor');

export interface IcpCandidateLifecycleSupervisorOptions {
  store: IcpInitiationCandidateStorePort;
  sourceRuntime: IcpInitiationSourceRuntime;
  retryCadenceMs: number;
  claimLeaseMs: number;
  batchSize: number;
  now?: () => number;
}

interface IcpCandidateLifecycleSupervisorPass {
  claimed: number;
  completed: number;
  failed: number;
}

export interface IcpCandidateLifecycleSupervisor {
  runOnce(): Promise<IcpCandidateLifecycleSupervisorPass>;
  start(): void;
  stop(): Promise<void>;
}

function requirePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

/**
 * Owns candidate progress independently of every source producer. Durable
 * Postgres claims make startup recovery and concurrent replicas idempotent;
 * failed work remains leased until another bounded pass can safely reclaim it.
 */
export function createIcpCandidateLifecycleSupervisor(
  options: IcpCandidateLifecycleSupervisorOptions,
): IcpCandidateLifecycleSupervisor {
  const claimDueCandidates = options.store.claimDueCandidates;
  if (!options.store.createClaimedCandidate
    || !options.store.claimCandidate
    || !options.store.renewCandidateClaim
    || !options.store.releaseCandidateClaim
    || !claimDueCandidates
    || !options.store.transitionClaimedCandidate) {
    throw new Error('ICP candidate lifecycle supervisor requires a complete claim-capable store');
  }
  const retryCadenceMs = requirePositiveInteger(options.retryCadenceMs, 'retryCadenceMs');
  const claimLeaseMs = requirePositiveInteger(options.claimLeaseMs, 'claimLeaseMs');
  const batchSize = requirePositiveInteger(options.batchSize, 'batchSize');
  const now = options.now ?? Date.now;
  let timer: ReturnType<typeof setInterval> | undefined;
  let activePass: Promise<IcpCandidateLifecycleSupervisorPass> | undefined;

  const executePass = async (): Promise<IcpCandidateLifecycleSupervisorPass> => {
    const claims = await claimDueCandidates.call(options.store, {
      nowMs: now(),
      claimLeaseMs,
      limit: batchSize,
    });
    const outcomes = await Promise.all(claims.map(async claim => {
      try {
        await options.sourceRuntime.resumeClaim(claim);
        return 'completed' as const;
      } catch (error) {
        log.warn('ICP candidate lifecycle claim failed; durable lease will permit retry', {
          candidateId: claim.candidate.candidateId,
          status: claim.candidate.status,
          error: error instanceof Error ? error.message : String(error),
        });
        return 'failed' as const;
      }
    }));
    const completed = outcomes.filter(outcome => outcome === 'completed').length;
    const failed = outcomes.length - completed;
    return { claimed: claims.length, completed, failed };
  };

  const runOnce = async (): Promise<IcpCandidateLifecycleSupervisorPass> => {
    if (activePass) return await activePass;
    activePass = executePass();
    try {
      return await activePass;
    } finally {
      activePass = undefined;
    }
  };

  return {
    runOnce,
    start() {
      if (timer) return;
      void runOnce().catch((error: unknown) => {
        log.error('Initial ICP candidate lifecycle recovery failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      timer = setInterval(() => {
        void runOnce().catch((error: unknown) => {
          log.error('ICP candidate lifecycle supervisor pass failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, retryCadenceMs);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      if (activePass) await activePass;
    },
  };
}
