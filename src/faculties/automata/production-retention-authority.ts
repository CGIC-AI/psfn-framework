import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { AutomataBusEvent } from './bus/contract.js';
import type { PostgresAutomataBusRuntimeStore } from './bus/runtime-store.js';
import type { AutomataRunRecord } from './registry-contract.js';
import type { AutomataRunRegistry } from './run-registry.js';
import type {
  AutomataRetentionProof,
  AutomataRetentionProofPort,
  ExactSessionPurgeInput,
  PermanentReferenceCustodyPort,
} from './retention-contract.js';
import type { AutomataSessionClassification } from './session-classification.js';
import type {
  ExactSessionPurgeResolvedTarget,
  ExactSessionPurgeTargetAuthorityPort,
} from './production-exact-session-purge.js';
import type { PostgresAutomataRetentionStore } from './retention-postgres-store.js';
import {
  CHANNEL_INDEX_FILENAME,
  type ChannelIndexEntry,
} from '../../persistence/sessions/store-primitives.js';
import { loadChannelIndex } from '../../persistence/sessions/store/channel-index.js';
import { indexedChannelId } from '../../persistence/sessions/store/session-index-keys.js';
import { SENSITIVITY_LEVELS } from '../../system/trust/types.js';

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function hashRevision(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function terminalEvents(events: readonly AutomataBusEvent[]): AutomataBusEvent[] {
  return events.filter(event => (
    event.type === 'finding'
    && (event.body.source === 'subagent-terminal-handoff'
      || event.body.source === 'background-work-terminal-handoff'
      || event.body.source === 'automata-reviewer-outcome')
  ));
}

function eventEvidenceReferences(events: readonly AutomataBusEvent[]): string[] {
  return [...new Set(events.flatMap(event => (
    event.type === 'finding'
      ? event.body.evidence.map(evidence => evidence.reference)
      : event.body.replacement?.evidence.map(evidence => evidence.reference) ?? []
  )))].sort();
}

function exactRun(
  registry: AutomataRunRegistry,
  classification: AutomataSessionClassification,
): AutomataRunRecord | null {
  const run = registry.getRun(classification.runId);
  if (!run
    || run.companionId !== classification.companionId
    || run.automatonClass !== classification.automatonClass
    || run.workerGeneration !== classification.workerGeneration
    || !run.sessionIds.includes(classification.sessionId)) {
    return null;
  }
  return run;
}

/** Durable run + Bus projection used by both eligibility and last-moment revalidation. */
export class ProductionAutomataRetentionProofSource implements AutomataRetentionProofPort {
  constructor(private readonly options: {
    companionId: string;
    registry: AutomataRunRegistry;
    bus: PostgresAutomataBusRuntimeStore;
  }) {}

  async loadProof(
    classification: AutomataSessionClassification,
  ): Promise<AutomataRetentionProof | null> {
    if (classification.companionId !== this.options.companionId) return null;
    const run = exactRun(this.options.registry, classification);
    if (!run) return null;
    const history = (await this.options.bus.readHistory({
      companionId: this.options.companionId,
      audience: 'operator',
      maxSensitivity: SENSITIVITY_LEVELS.at(-1)!,
    })).filter(event => event.context.runId === run.runId);
    const terminal = terminalEvents(history);
    const evidenceRefs = eventEvidenceReferences(history);
    const receiptRefs = terminal.map(event => event.eventId).sort();
    const reviewState = history.some(event => (
      event.type === 'finding' && event.body.verification.status === 'pending'
    )) ? 'pending' : 'clear';
    const proofBase = {
      run,
      history: history.map(event => ({
        eventId: event.eventId,
        sequence: event.sequence,
        type: event.type,
        verification: event.type === 'finding' ? event.body.verification.status : undefined,
      })),
      receiptRefs,
      evidenceRefs,
    };
    return {
      companionId: classification.companionId,
      sessionId: classification.sessionId,
      runId: run.runId,
      automatonClass: run.automatonClass,
      workerGeneration: run.workerGeneration,
      generationState: TERMINAL_RUN_STATUSES.has(run.status) ? 'terminal' : 'active',
      runStatus: run.status,
      pendingWorkCount: TERMINAL_RUN_STATUSES.has(run.status) ? 0 : 1,
      handoffState: receiptRefs.length > 0 ? 'recorded' : 'pending',
      artifacts: run.artifacts.map(artifact => ({ ...artifact })),
      ...(receiptRefs.length > 0
        ? {
            promotionReceipt: {
              disposition: 'promoted' as const,
              receiptRefs,
              copiedEvidenceRefs: evidenceRefs,
            },
          }
        : {}),
      reviewState,
      foldState: run.foldState,
      targetRevision: hashRevision(proofBase),
    };
  }
}

/** Resolves only references already present in durable run or Bus authority. */
export class ProductionAutomataPermanentReferenceCustody implements PermanentReferenceCustodyPort {
  constructor(private readonly options: {
    companionId: string;
    registry: AutomataRunRegistry;
    bus: PostgresAutomataBusRuntimeStore;
  }) {}

  async assertResolvable(references: readonly string[]): Promise<void> {
    const history = await this.options.bus.readHistory({
      companionId: this.options.companionId,
      audience: 'operator',
      maxSensitivity: SENSITIVITY_LEVELS.at(-1)!,
    });
    const resolvable = new Set<string>([
      ...history.map(event => event.eventId),
      ...eventEvidenceReferences(history),
      ...this.options.registry.listRetainedRunsForRuntime().flatMap(run => [
        `automata-run:${run.runId}`,
        ...run.artifacts.filter(artifact => artifact.custody === 'durable').map(artifact => artifact.ref),
      ]),
    ]);
    for (const reference of references) {
      if (!resolvable.has(reference)) {
        throw new Error('Automata retention permanent reference is not durably resolvable');
      }
    }
  }
}

/** Exact classification/proof/index resolver; protected and ambiguous targets fail closed. */
export class ProductionExactSessionPurgeTargetAuthority implements ExactSessionPurgeTargetAuthorityPort {
  constructor(private readonly options: {
    companionId: string;
    sessionsDir: string;
    classifications: Pick<PostgresAutomataRetentionStore, 'loadClassification'>;
    proofs: AutomataRetentionProofPort;
  }) {}

  async resolveAndAuthorize(input: ExactSessionPurgeInput): Promise<ExactSessionPurgeResolvedTarget> {
    const classification = await this.loadExactClassification(input);
    await this.assertRevision(input, classification);
    const index = new Map<string, ChannelIndexEntry>();
    loadChannelIndex(join(this.options.sessionsDir, CHANNEL_INDEX_FILENAME), index, {
      persistMigration: false,
    });
    const entry = index.get(input.sessionId);
    if (!entry || entry.filenames.length === 0 || entry.filename !== entry.filenames.at(-1)) {
      throw new Error('Exact-session purge requires one unambiguous channel-index target');
    }
    const channelId = indexedChannelId(input.sessionId, entry);
    return {
      classification,
      channelId,
      tailChannelKey: input.sessionId,
      turnRecordChannelId: channelId,
      activeJournalFilename: entry.filename,
      rolledJournalFilenames: entry.filenames.slice(0, -1),
    };
  }

  async revalidate(
    input: ExactSessionPurgeInput,
    target: ExactSessionPurgeResolvedTarget,
  ): Promise<void> {
    const classification = await this.loadExactClassification(input);
    if (JSON.stringify(classification) !== JSON.stringify(target.classification)) {
      throw new Error('Exact-session purge immutable classification changed');
    }
    await this.assertRevision(input, classification);
  }

  private async loadExactClassification(
    input: ExactSessionPurgeInput,
  ): Promise<AutomataSessionClassification> {
    if (input.companionId !== this.options.companionId) {
      throw new Error('Exact-session purge companion scope mismatch');
    }
    const classification = await this.options.classifications.loadClassification(
      input.companionId,
      input.sessionId,
    );
    if (!classification || classification.ownership !== 'automata') {
      throw new Error('Exact-session purge refuses unknown or protected session');
    }
    if (classification.runId !== input.runId) {
      throw new Error('Exact-session purge run identity mismatch');
    }
    return classification;
  }

  private async assertRevision(
    input: ExactSessionPurgeInput,
    classification: AutomataSessionClassification,
  ): Promise<void> {
    const proof = await this.options.proofs.loadProof(classification);
    if (!proof || proof.targetRevision !== input.targetRevision) {
      throw new Error('Exact-session purge targetRevision changed');
    }
  }
}
