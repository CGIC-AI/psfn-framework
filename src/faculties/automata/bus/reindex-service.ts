import type { AutomataBusCanonicalFinding } from './query-ports.js';
import { requireAutomataBusPositiveInteger } from './postgres-query-sql.js';

export interface AutomataBusReindexSourcePort {
  readCurrent(input: {
    companionId: string;
    limit: number;
  }): Promise<{
    companionId: string;
    findings: readonly AutomataBusCanonicalFinding[];
    hasMore: boolean;
  }>;
}

export interface AutomataBusReindexRuntimePort {
  begin(input: { companionId: string }): Promise<void>;
  index(finding: AutomataBusCanonicalFinding): Promise<{ status: 'indexed' | 'lagging' }>;
  complete(input: { companionId: string; eventIds: readonly string[] }): Promise<void>;
  fail(input: { companionId: string }): Promise<void>;
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

    const page = await this.options.source.readCurrent({
      companionId: this.companionId,
      limit: this.maxFindings,
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

    this.inFlight = true;
    let began = false;
    try {
      await this.options.runtime.begin({ companionId: this.companionId });
      began = true;
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
        companionId: this.companionId,
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
      if (began) {
        try {
          await this.options.runtime.fail({ companionId: this.companionId });
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
