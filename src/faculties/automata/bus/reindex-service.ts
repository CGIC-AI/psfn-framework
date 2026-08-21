import type { AutomataBusCanonicalFinding } from './query-ports.js';
import { requireAutomataBusPositiveInteger } from './postgres-query-sql.js';

export interface AutomataBusReindexSourcePort {
  readCurrent(input: {
    companionId: string;
    limit: number;
    snapshotSequence: number;
  }): Promise<{
    companionId: string;
    findings: readonly AutomataBusCanonicalFinding[];
    hasMore: boolean;
  }>;
}

export interface AutomataBusReindexLease {
  companionId: string;
  leaseToken: string;
  snapshotSequence: number;
  mutationFence: number;
}

export interface AutomataBusReindexRuntimePort {
  begin(input: { companionId: string }): Promise<AutomataBusReindexLease>;
  index(finding: AutomataBusCanonicalFinding): Promise<{ status: 'indexed' | 'lagging' }>;
  complete(input: AutomataBusReindexLease & { eventIds: readonly string[] }): Promise<void>;
  fail(input: AutomataBusReindexLease): Promise<void>;
}

export interface AutomataBusReindexResult {
  companionId: string;
  status: 'completed';
  processed: number;
  indexed: number;
  lagging: number;
}

function requireCompanionId(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must be non-empty`);
  return normalized;
}

function requireFence(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function requireLease(
  value: AutomataBusReindexLease,
  companionId: string,
): AutomataBusReindexLease {
  if (value.companionId !== companionId) {
    throw new Error('Automata Bus reindex acquired a cross-companion lease');
  }
  return {
    companionId,
    leaseToken: requireCompanionId(value.leaseToken, 'Automata Bus reindex leaseToken'),
    snapshotSequence: requireFence(value.snapshotSequence, 'Automata Bus reindex snapshotSequence'),
    mutationFence: requireFence(value.mutationFence, 'Automata Bus reindex mutationFence'),
  };
}

/**
 * Bounded rebuild coordinator for one companion's disposable vector index.
 * Canonical Bus rows remain authority and are never mutated by this operation.
 */
export class AutomataBusReindexService {
  private readonly companionId: string;
  private readonly maxFindings: number;
  private inFlight = false;

  constructor(private readonly options: {
    companionId: string;
    maxFindings: number;
    source: AutomataBusReindexSourcePort;
    runtime: AutomataBusReindexRuntimePort;
  }) {
    this.companionId = requireCompanionId(options.companionId, 'Automata Bus reindex companionId');
    this.maxFindings = requireAutomataBusPositiveInteger(options.maxFindings, 'maxFindings');
  }

  async reindex(input: { companionId: string }): Promise<AutomataBusReindexResult> {
    const requestedCompanionId = requireCompanionId(input.companionId, 'Automata Bus reindex companionId');
    if (requestedCompanionId !== this.companionId) {
      throw new Error('Automata Bus reindex companion scope mismatch');
    }
    if (this.inFlight) throw new Error('Automata Bus reindex is already running');

    this.inFlight = true;
    let lease: AutomataBusReindexLease | undefined;
    try {
      lease = requireLease(
        await this.options.runtime.begin({ companionId: this.companionId }),
        this.companionId,
      );
      const page = await this.options.source.readCurrent({
        companionId: this.companionId,
        limit: this.maxFindings,
        snapshotSequence: lease.snapshotSequence,
      });
      if (page.companionId !== this.companionId) {
        throw new Error('Automata Bus reindex returned a cross-companion source');
      }
      if (page.hasMore || page.findings.length > this.maxFindings) {
        throw new Error(`Automata Bus current state exceeds the owner reindex bound (${this.maxFindings})`);
      }
      const eventIds = new Set<string>();
      for (const finding of page.findings) {
        if (finding.companionId !== this.companionId) {
          throw new Error(`Automata Bus reindex returned cross-companion finding "${finding.eventId}"`);
        }
        if (eventIds.has(finding.eventId)) {
          throw new Error(`Automata Bus reindex returned duplicate finding "${finding.eventId}"`);
        }
        eventIds.add(finding.eventId);
      }
      let indexed = 0;
      let lagging = 0;
      for (const finding of page.findings) {
        const result = await this.options.runtime.index(finding);
        if (result.status === 'indexed') indexed += 1;
        else lagging += 1;
      }
      if (lagging > 0) {
        throw new Error(`Automata Bus reindex left ${lagging} finding lagging`);
      }
      await this.options.runtime.complete({
        ...lease,
        eventIds: [...eventIds],
      });
      return {
        companionId: this.companionId,
        status: 'completed',
        processed: page.findings.length,
        indexed,
        lagging,
      };
    } catch (error) {
      if (lease) {
        try {
          await this.options.runtime.fail(lease);
        } catch (failError) {
          throw new AggregateError(
            [error, failError],
            'Automata Bus reindex failed and its degraded state could not be persisted',
          );
        }
      }
      throw error;
    } finally {
      this.inFlight = false;
    }
  }
}
