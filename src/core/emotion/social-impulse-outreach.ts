import { createHash } from 'node:crypto';
import { parseCompanionChannelId } from '../../shared/contracts/companion-channels.js';
import { isRfc4122Uuid } from '../../shared/utils/types.js';
import type { EmoSimProactivityImpulse } from './emosim-proactivity-port.js';

export const SOCIAL_IMPULSE_DISPOSITIONS = [
  'ignore',
  'defer',
  'contact-human',
  'contact-companion',
  'join-room',
  'other',
] as const;

export type SocialImpulseDisposition = typeof SOCIAL_IMPULSE_DISPOSITIONS[number];
export type SocialImpulseOutreachMode = 'off' | 'shadow' | 'on';

interface HumanDmDestination {
  kind: 'human_dm';
  destinationId: string;
  contactId: string;
  displayLabel: string;
  channelId: string;
  channelType: 'discord';
  dyadId: null;
}

interface OpenCompanionDyadDestination {
  kind: 'open_companion_dyad';
  destinationId: string;
  contactId: string;
  displayLabel: string;
  channelId: string;
  channelType: 'companion';
  dyadId: string;
}

interface CompanionFirstContactDestination {
  kind: 'companion_first_contact';
  destinationId: string;
  contactId: string;
  displayLabel: string;
  channelId: null;
  channelType: 'companion';
  dyadId: null;
}

interface RoomDestination {
  kind: 'room';
  destinationId: string;
  displayLabel: string;
  channelId: string;
  channelType: 'discord' | 'buzz';
  dyadId: null;
}

export type SocialImpulseOutreachDestination =
  | HumanDmDestination
  | OpenCompanionDyadDestination
  | CompanionFirstContactDestination
  | RoomDestination;

export type SocialImpulseOutreachState =
  | 'pending'
  | 'queued'
  | 'chosen'
  | 'off'
  | 'ignore'
  | 'defer'
  | 'other'
  | 'would_send'
  | 'delivered'
  | 'suppressed';

export interface SocialImpulseOutreachRecord {
  schemaVersion: 1;
  opportunityId: string;
  companionId: string;
  impulseDedupeKey: string;
  firstCrossingMs: number;
  firedAtMs: number;
  modeAtCreation: SocialImpulseOutreachMode;
  state: SocialImpulseOutreachState;
  disposition: SocialImpulseDisposition | null;
  destination: SocialImpulseOutreachDestination | null;
  /** Hash of the exact choice, target identity, and local-only intent. */
  bindingHash: string | null;
  /** Companion-private durable intent, retained only until execution settles. */
  executionIntent: string | null;
  originIcpRootInitiationId: string | null;
  reasonCode: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface SocialImpulseOutreachStorePort {
  createOpportunity(record: SocialImpulseOutreachRecord): Promise<{
    created: boolean;
    record: SocialImpulseOutreachRecord;
  }>;
  getOpportunity(opportunityId: string): Promise<SocialImpulseOutreachRecord | null>;
  /** At most one active and one terminal record for this exact companion/destination. */
  getDestinationStatus(companionId: string, destinationId: string): Promise<{
    pending: SocialImpulseOutreachRecord | null;
    latestTerminal: SocialImpulseOutreachRecord | null;
  }>;
  listRecoverable(companionId: string): Promise<SocialImpulseOutreachRecord[]>;
  beginExecution(opportunityId: string, bindingHash: string, atMs: number): Promise<boolean>;
  /** Release only a claimed execution proven not to have sent anything. */
  deferExecution(input: {
    opportunityId: string;
    bindingHash: string;
    reasonCode: string;
    deferredAtMs: number;
  }): Promise<SocialImpulseOutreachRecord>;
  claimDisposition(input: {
    opportunityId: string;
    disposition: SocialImpulseDisposition;
    destination: SocialImpulseOutreachDestination | null;
    bindingHash: string;
    executionIntent?: string;
    originIcpRootInitiationId?: string;
    claimedAtMs: number;
  }): Promise<
    | { outcome: 'claimed' | 'replayed' | 'conflict'; record: SocialImpulseOutreachRecord }
    | { outcome: 'unavailable' }
  >;
  finalize(input: {
    opportunityId: string;
    bindingHash: string;
    state: Exclude<SocialImpulseOutreachState, 'pending' | 'queued' | 'chosen'>;
    reasonCode?: string;
    finalizedAtMs: number;
  }): Promise<SocialImpulseOutreachRecord>;
}

interface SocialImpulseDispositionOpportunity {
  opportunityId: string;
  impulseKind: 'would_message';
  firedAtMs: number;
  dispositions: typeof SOCIAL_IMPULSE_DISPOSITIONS;
}

type SocialImpulseOutreachExecutionResult =
  | { outcome: 'delivered' }
  | { outcome: 'rescheduled'; reasonCode: string; rescheduleAt: number }
  | { outcome: 'suppressed'; reasonCode: string };

type SocialImpulseChoiceResult = {
  outcome: Exclude<SocialImpulseOutreachState, 'pending' | 'chosen' | 'off'>;
  record: SocialImpulseOutreachRecord;
  reasonCode?: string;
  rescheduleAt?: number;
};

export interface SocialImpulseOutreachRuntime {
  recoverPending(): Promise<void>;
  executeQueued(opportunityId: string): Promise<SocialImpulseChoiceResult>;
  onImpulse(impulse: EmoSimProactivityImpulse): Promise<
    { outcome: 'created' | 'replayed' | 'off'; record: SocialImpulseOutreachRecord }
  >;
  inspect(opportunityId: string): Promise<{
    record: SocialImpulseOutreachRecord;
    dispositions: typeof SOCIAL_IMPULSE_DISPOSITIONS;
    destinations: SocialImpulseOutreachDestination[];
  }>;
  choose(input: {
    opportunityId: string;
    disposition: SocialImpulseDisposition;
    destinationId?: string;
    intent?: string;
  }): Promise<SocialImpulseChoiceResult>;
}

interface SocialImpulseOutreachRuntimeOptions {
  companionId: string;
  store: SocialImpulseOutreachStorePort;
  getMode(): SocialImpulseOutreachMode;
  listDestinations(): Promise<SocialImpulseOutreachDestination[]>;
  runDispositionOpportunity(opportunity: SocialImpulseDispositionOpportunity): Promise<void>;
  enqueueExecution?(opportunityId: string): Promise<void>;
  getOriginIcpRootInitiationId?(): string | undefined;
  execute(input: {
    opportunityId: string;
    disposition: Extract<SocialImpulseDisposition,
      'contact-human' | 'contact-companion' | 'join-room'>;
    destination: SocialImpulseOutreachDestination;
    intent: string;
    bindingHash: string;
    originIcpRootInitiationId?: string;
  }): Promise<SocialImpulseOutreachExecutionResult>;
  onExecutionError?(error: unknown, context: {
    opportunityId: string;
    destinationKind: SocialImpulseOutreachDestination['kind'];
  }): void;
  now?: () => number;
}

const ACTION_DISPOSITIONS = new Set<SocialImpulseDisposition>([
  'contact-human', 'contact-companion', 'join-room',
]);

export function createSocialImpulseOutreachRuntime(
  options: SocialImpulseOutreachRuntimeOptions,
): SocialImpulseOutreachRuntime {
  const companionId = requireCompanionId(options.companionId);
  const now = options.now ?? Date.now;
  const activeExecutions = new Map<string, Promise<SocialImpulseChoiceResult>>();

  const finalize = async (
    opportunityId: string,
    bindingHash: string,
    state: Exclude<SocialImpulseOutreachState, 'pending' | 'queued' | 'chosen'>,
    reasonCode?: string,
  ): Promise<SocialImpulseOutreachRecord> => await options.store.finalize({
    opportunityId,
    bindingHash,
    state,
    ...(reasonCode ? { reasonCode } : {}),
    finalizedAtMs: now(),
  });

  const completedResult = (
    record: SocialImpulseOutreachRecord,
  ): SocialImpulseChoiceResult | null => {
    if (record.state === 'pending' || record.state === 'queued' || record.state === 'chosen' || record.state === 'off') {
      return null;
    }
    return {
      outcome: record.state,
      record,
      ...(record.reasonCode ? { reasonCode: record.reasonCode } : {}),
    };
  };

  const openDisposition = async (record: SocialImpulseOutreachRecord): Promise<void> => {
    await options.runDispositionOpportunity({
      opportunityId: record.opportunityId,
      impulseKind: 'would_message',
      firedAtMs: record.firedAtMs,
      dispositions: SOCIAL_IMPULSE_DISPOSITIONS,
    });
  };
  const executeAndFinalize = async (
    record: SocialImpulseOutreachRecord,
    intent: string,
  ): Promise<SocialImpulseChoiceResult> => {
    const bindingHash = record.bindingHash!;
    let execution: SocialImpulseOutreachExecutionResult;
    try {
      execution = await options.execute({
        opportunityId: record.opportunityId,
        disposition: record.disposition as 'contact-human' | 'contact-companion' | 'join-room',
        destination: record.destination!,
        intent,
        bindingHash,
        ...(record.originIcpRootInitiationId ? { originIcpRootInitiationId: record.originIcpRootInitiationId } : {}),
      });
    } catch (error) {
      options.onExecutionError?.(error, {
        opportunityId: record.opportunityId,
        destinationKind: record.destination!.kind,
      });
      execution = { outcome: 'suppressed', reasonCode: 'destination_execution_failed' };
    }
    if (execution.outcome === 'rescheduled') {
      const deferredAtMs = now();
      if (!Number.isSafeInteger(execution.rescheduleAt) || execution.rescheduleAt <= deferredAtMs) {
        throw new Error('Social outreach deferral requires an exact future execution time');
      }
      const deferred = await options.store.deferExecution({
        opportunityId: record.opportunityId, bindingHash,
        reasonCode: execution.reasonCode, deferredAtMs,
      });
      return { outcome: 'queued', record: deferred, reasonCode: execution.reasonCode, rescheduleAt: execution.rescheduleAt };
    }
    const reasonCode = execution.outcome === 'suppressed' ? execution.reasonCode : undefined;
    const finalized = await finalize(record.opportunityId, bindingHash, execution.outcome, reasonCode);
    return { outcome: execution.outcome, record: finalized, ...(reasonCode ? { reasonCode } : {}) };
  };
  const runtime: SocialImpulseOutreachRuntime = {
    async recoverPending() {
      for (const record of await options.store.listRecoverable(companionId)) {
        if (record.companionId !== companionId) throw new Error('Social outreach recovery owner mismatch');
        if (record.state === 'pending') await openDisposition(record);
        else if (record.state === 'queued') {
          if (!options.enqueueExecution) throw new Error('Social outreach execution queue is unavailable');
          await options.enqueueExecution(record.opportunityId);
        }
      }
    },
    async executeQueued(opportunityId) {
      const record = await requireOpportunity(options.store, opportunityId, companionId);
      const completed = completedResult(record);
      if (completed) return completed;
      if (!record.bindingHash || !record.destination || !record.disposition
        || !ACTION_DISPOSITIONS.has(record.disposition) || !record.executionIntent
        || hashBinding({ opportunityId, disposition: record.disposition,
          destinationId: record.destination.destinationId, intent: record.executionIntent,
          ...(record.originIcpRootInitiationId ? { originIcpRootInitiationId: record.originIcpRootInitiationId } : {}),
        }) !== record.bindingHash) {
        throw new Error('Social outreach queued execution lost its exact choice binding');
      }
      const active = activeExecutions.get(opportunityId);
      if (active) return active;
      if (record.state !== 'queued'
        || !await options.store.beginExecution(opportunityId, record.bindingHash, now())) {
        const updated = await requireOpportunity(options.store, opportunityId, companionId);
        const running = activeExecutions.get(opportunityId);
        if (running) return running;
        const settled = completedResult(updated);
        if (settled) return settled;
        const finalized = await finalize(opportunityId, record.bindingHash, 'suppressed', 'execution_outcome_unknown');
        return { outcome: 'suppressed', reasonCode: 'execution_outcome_unknown', record: finalized };
      }
      const execution = (async (): Promise<SocialImpulseChoiceResult> => {
        const mode = requireMode(options.getMode());
        const destinations = normalizeDestinations(await options.listDestinations());
        const available = destinations.some(candidate => JSON.stringify(candidate) === JSON.stringify(record.destination));
        if (mode !== 'on' || !available) {
          const state = mode === 'shadow' && available ? 'would_send' : 'suppressed';
          const reason = mode === 'off' ? 'outreach_off' : !available ? 'destination_unavailable' : undefined;
          const finalized = await finalize(opportunityId, record.bindingHash!, state, reason);
          return { outcome: state, record: finalized, ...(reason ? { reasonCode: reason } : {}) };
        }
        return executeAndFinalize(record, record.executionIntent!);
      })();
      activeExecutions.set(opportunityId, execution);
      try { return await execution; } finally { activeExecutions.delete(opportunityId); }
    },
    async onImpulse(impulse) {
      requireImpulse(impulse, companionId);
      const mode = requireMode(options.getMode());
      const createdAtMs = now();
      const state: SocialImpulseOutreachState = mode === 'off' ? 'off' : 'pending';
      const created = await options.store.createOpportunity({
        schemaVersion: 1,
        opportunityId: impulse.correlationId,
        companionId,
        impulseDedupeKey: impulse.dedupeKey,
        firstCrossingMs: impulse.firstCrossingMs,
        firedAtMs: impulse.firedAtMs,
        modeAtCreation: mode,
        state,
        disposition: null,
        destination: null,
        bindingHash: null,
        executionIntent: null,
        originIcpRootInitiationId: options.getOriginIcpRootInitiationId?.() ?? null,
        reasonCode: mode === 'off' ? 'outreach_off' : null,
        createdAtMs,
        updatedAtMs: createdAtMs,
      });
      if (created.record.state === 'off') return { outcome: 'off', record: created.record };
      if (created.record.state === 'pending') await openDisposition(created.record);
      if (created.record.state === 'queued' && options.enqueueExecution) {
        await options.enqueueExecution(created.record.opportunityId);
      }
      return { outcome: created.created ? 'created' : 'replayed', record: created.record };
    },

    async inspect(opportunityId) {
      const record = await requireOpportunity(options.store, opportunityId, companionId);
      const destinations = record.state === 'pending' || record.state === 'chosen'
        ? normalizeDestinations(await options.listDestinations())
        : [];
      return { record, dispositions: SOCIAL_IMPULSE_DISPOSITIONS, destinations };
    },

    async choose(input) {
      const record = await requireOpportunity(options.store, input.opportunityId, companionId);
      const disposition = requireDisposition(input.disposition);
      const action = ACTION_DISPOSITIONS.has(disposition);
      const destinationId = input.destinationId?.trim() || undefined;
      const intent = input.intent?.trim() || undefined;
      if (action && (!destinationId || !intent)) {
        throw new Error(`${disposition} requires an exact destination_id and intent`);
      }
      if (!action && (destinationId || intent)) {
        throw new Error(`${disposition} does not accept a destination or intent`);
      }

      const originIcpRootInitiationId = record.originIcpRootInitiationId
        ?? options.getOriginIcpRootInitiationId?.();
      const bindingHash = hashBinding({
        opportunityId: record.opportunityId,
        disposition,
        destinationId: destinationId ?? null,
        intent: intent ?? null,
        ...(originIcpRootInitiationId ? { originIcpRootInitiationId } : {}),
      });
      if (record.bindingHash && record.bindingHash !== bindingHash) {
        throw new Error('social impulse opportunity already has a different disposition');
      }
      const priorCompleted = completedResult(record);
      if (priorCompleted) return priorCompleted;

      let destination: SocialImpulseOutreachDestination | null = null;
      if (action) {
        const matches = normalizeDestinations(await options.listDestinations())
          .filter(candidate => candidate.destinationId === destinationId);
        if (matches.length !== 1 || !destinationMatchesDisposition(matches[0]!, disposition)) {
          const claim = await options.store.claimDisposition({
            opportunityId: record.opportunityId,
            disposition,
            destination: null,
            bindingHash,
            claimedAtMs: now(),
          });
          if (claim.outcome === 'conflict') {
            throw new Error('social impulse opportunity already has a different disposition');
          }
          if (claim.outcome === 'unavailable') throw new Error('social impulse opportunity is unavailable');
          const finalized = await finalize(
            record.opportunityId,
            bindingHash,
            'suppressed',
            'destination_unavailable',
          );
          return { outcome: 'suppressed', reasonCode: 'destination_unavailable', record: finalized };
        }
        destination = matches[0]!;
      }

      const claim = await options.store.claimDisposition({
        opportunityId: record.opportunityId,
        disposition,
        destination,
        bindingHash,
        ...(action && options.enqueueExecution ? { executionIntent: intent! } : {}),
        ...(originIcpRootInitiationId ? { originIcpRootInitiationId } : {}),
        claimedAtMs: now(),
      });
      if (claim.outcome === 'conflict') {
        throw new Error('social impulse opportunity already has a different disposition');
      }
      if (claim.outcome === 'unavailable') throw new Error('social impulse opportunity is unavailable');
      const claimedCompleted = completedResult(claim.record);
      if (claimedCompleted) return claimedCompleted;

      if (!action) {
        const state = disposition as 'ignore' | 'defer' | 'other';
        const finalized = await finalize(record.opportunityId, bindingHash, state);
        return { outcome: state, record: finalized };
      }

      const mode = requireMode(options.getMode());
      if (mode === 'off') {
        const finalized = await finalize(record.opportunityId, bindingHash, 'suppressed', 'outreach_off');
        return { outcome: 'suppressed', reasonCode: 'outreach_off', record: finalized };
      }
      if (mode === 'shadow') {
        const finalized = await finalize(record.opportunityId, bindingHash, 'would_send');
        return { outcome: 'would_send', record: finalized };
      }

      if (claim.record.state === 'queued' && options.enqueueExecution) {
        await options.enqueueExecution(record.opportunityId);
        return { outcome: 'queued', record: claim.record };
      }

      if (claim.outcome === 'replayed') {
        const active = activeExecutions.get(record.opportunityId);
        if (active) return await active;
        const finalized = await finalize(
          record.opportunityId,
          bindingHash,
          'suppressed',
          'execution_outcome_unknown',
        );
        return {
          outcome: 'suppressed',
          reasonCode: 'execution_outcome_unknown',
          record: finalized,
        };
      }

      const execution = executeAndFinalize(claim.record, intent!);
      activeExecutions.set(record.opportunityId, execution);
      try {
        return await execution;
      } finally {
        if (activeExecutions.get(record.opportunityId) === execution) {
          activeExecutions.delete(record.opportunityId);
        }
      }
    },
  };
  return runtime;
}

function requireCompanionId(value: string): string {
  const companionId = value.trim();
  if (!isRfc4122Uuid(companionId)) {
    throw new Error('social impulse outreach requires a lowercase RFC-4122 companionId');
  }
  return companionId;
}

function requireMode(value: unknown): SocialImpulseOutreachMode {
  if (value !== 'off' && value !== 'shadow' && value !== 'on') {
    throw new Error('social impulse outreach mode must be off, shadow, or on');
  }
  return value;
}

function requireDisposition(value: unknown): SocialImpulseDisposition {
  if (!(SOCIAL_IMPULSE_DISPOSITIONS as readonly unknown[]).includes(value)) {
    throw new Error('social impulse disposition is invalid');
  }
  return value as SocialImpulseDisposition;
}

async function requireOpportunity(
  store: SocialImpulseOutreachStorePort,
  opportunityId: string,
  companionId: string,
): Promise<SocialImpulseOutreachRecord> {
  const normalized = opportunityId.trim();
  if (!normalized) throw new Error('opportunity_id is required');
  const record = await store.getOpportunity(normalized);
  if (!record || record.companionId !== companionId) {
    throw new Error('social impulse opportunity is unavailable');
  }
  return record;
}

function requireImpulse(impulse: EmoSimProactivityImpulse, companionId: string): void {
  const boundary = impulse as { kind: unknown; authority: unknown };
  if (impulse.companionId !== companionId
    || boundary.kind !== 'would_message'
    || boundary.authority !== 'qualified_source_fire'
    || impulse.correlationId !== impulse.dedupeKey
    || !impulse.correlationId.startsWith('felt-impulse:would_message:')) {
    throw new Error('social impulse outreach requires an owned qualified would_message impulse');
  }
}

function normalizeDestinations(
  destinations: readonly SocialImpulseOutreachDestination[],
): SocialImpulseOutreachDestination[] {
  const seen = new Set<string>();
  return destinations.map(destination => {
    const boundary = destination as { channelType: unknown; dyadId: unknown };
    const destinationId = destination.destinationId.trim();
    const displayLabel = destination.displayLabel.trim();
    if (!destinationId || !displayLabel || seen.has(destinationId)) {
      throw new Error('social impulse destinations require unique non-empty identities and labels');
    }
    seen.add(destinationId);
    if (destination.kind === 'open_companion_dyad') {
      const parsedChannel = parseCompanionChannelId(destination.channelId);
      if (!isRfc4122Uuid(boundary.dyadId)
        || boundary.channelType !== 'companion'
        || parsedChannel?.kind !== 'dm') {
        throw new Error('open companion destination requires its durable dyad identity');
      }
    } else if (boundary.dyadId !== null) {
      throw new Error('only open companion DM destinations may carry dyad_id');
    }
    if (destination.kind === 'room'
      && boundary.channelType !== 'discord'
      && boundary.channelType !== 'buzz') {
      throw new Error('social impulse room destination must use a supported group contract');
    }
    return structuredClone({ ...destination, destinationId, displayLabel });
  });
}

function destinationMatchesDisposition(
  destination: SocialImpulseOutreachDestination,
  disposition: SocialImpulseDisposition,
): boolean {
  if (disposition === 'contact-human') return destination.kind === 'human_dm';
  if (disposition === 'contact-companion') {
    return destination.kind === 'open_companion_dyad'
      || destination.kind === 'companion_first_contact';
  }
  return disposition === 'join-room' && destination.kind === 'room';
}

function hashBinding(input: {
  opportunityId: string;
  disposition: SocialImpulseDisposition;
  destinationId: string | null;
  intent: string | null;
  originIcpRootInitiationId?: string;
}): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}
