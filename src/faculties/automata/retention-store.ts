import { isDeepStrictEqual } from 'node:util';
import type {
  AutomataRetentionAuditEvent,
  AutomataRetentionStorePort,
} from './retention-contract.js';
import type {
  AutomataSessionClassification,
  SessionClassification,
} from './session-classification.js';

function classificationKey(companionId: string, sessionId: string): string {
  return `${companionId}\u0000${sessionId}`;
}

function cloneClassification(classification: SessionClassification): SessionClassification {
  return { ...classification };
}

function cloneAuditEvent(event: AutomataRetentionAuditEvent): AutomataRetentionAuditEvent {
  return {
    ...event,
    ...(event.removedCounts ? { removedCounts: { ...event.removedCounts } } : {}),
  };
}

/** Test and single-process adapter. Production uses the Postgres adapter. */
export class InMemoryAutomataRetentionStore implements AutomataRetentionStorePort {
  private readonly classifications = new Map<string, SessionClassification>();
  private readonly auditEvents = new Map<string, AutomataRetentionAuditEvent>();

  async recordClassification(classification: SessionClassification): Promise<void> {
    const key = classificationKey(classification.companionId, classification.sessionId);
    const current = this.classifications.get(key);
    if (current) {
      if (!isDeepStrictEqual(current, classification)) {
        throw new Error(`Session classification is immutable for ${classification.sessionId}`);
      }
      return;
    }
    this.classifications.set(key, cloneClassification(classification));
  }

  async listDueAutomataSessions(
    companionId: string,
    nowMs: number,
    limit: number,
  ): Promise<AutomataSessionClassification[]> {
    return [...this.classifications.values()]
      .filter((record): record is AutomataSessionClassification => (
        record.companionId === companionId
        && record.ownership === 'automata'
        && record.retentionDeadlineMs <= nowMs
      ))
      .sort((left, right) => (
        left.retentionDeadlineMs - right.retentionDeadlineMs
        || left.sessionId.localeCompare(right.sessionId)
      ))
      .slice(0, limit)
      .map(record => ({ ...record }));
  }

  async hasPurgeReceipt(companionId: string, sessionId: string): Promise<boolean> {
    return [...this.auditEvents.values()].some(event => (
      event.companionId === companionId
      && event.sessionId === sessionId
      && event.kind === 'purged'
    ));
  }

  async appendAuditEvent(event: AutomataRetentionAuditEvent): Promise<void> {
    const current = this.auditEvents.get(event.eventId);
    if (current) {
      if (!isDeepStrictEqual(current, event)) {
        throw new Error(`Automata retention audit event ${event.eventId} is immutable`);
      }
      return;
    }
    this.auditEvents.set(event.eventId, cloneAuditEvent(event));
  }

  listClassifications(): SessionClassification[] {
    return [...this.classifications.values()].map(cloneClassification);
  }

  listAuditEvents(): AutomataRetentionAuditEvent[] {
    return [...this.auditEvents.values()].map(cloneAuditEvent);
  }
}
