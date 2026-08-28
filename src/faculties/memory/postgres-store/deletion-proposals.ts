import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import type {
  CreateMemoryDeletionProposalInput,
  MemoryDeletionActorRole,
  MemoryDeletionAuditEvent,
  MemoryDeletionAuditEventType,
  MemoryDeletionProposal,
  MemoryDeletionProposalStatus,
  MemoryDeletionProposalStorePort,
} from '../deletion-proposals.js';
import type { MemoryDeleteVersion } from '../memory-store-port.js';
import type { PurrMemory } from '../types.js';
import {
  decodeEmbedding,
  tryFromMemoryRow,
  parsePgNumber,
  type MemoryRow,
} from './rows.js';
import { MEMORY_SUBJECT_SELECT_COLUMNS } from './subject-queries.js';

interface MemoryDeletionProposalRow {
  id: string;
  memory_id: string;
  memory_authorization_revision: number | string;
  justification_category: string;
  explanation: string;
  status: string;
  proposed_at: number | string;
  proposed_by: string;
  partner_alerted_at: number | string | null;
  operator_decided_at: number | string | null;
  operator_id: string | null;
  delete_id: string | null;
  restored_at: number | string | null;
  restored_by: string | null;
}

interface MemoryDeletionAuditEventRow {
  sequence: number | string;
  id: string;
  proposal_id: string;
  event_type: string;
  actor_role: string;
  actor_id: string | null;
  occurred_at: number | string;
  delete_id: string | null;
}

export interface PostgresMemoryDeletionProposalDependencies {
  runInTransaction<T>(handler: () => Promise<T>): Promise<T>;
  queryWrite<T extends QueryResultRow>(text: string, values: readonly unknown[]): Promise<T[]>;
  queryRead<T extends QueryResultRow>(text: string, values: readonly unknown[]): Promise<T[]>;
  hasActiveTransaction(): boolean;
  upsertDeleteVersion(version: MemoryDeleteVersion): Promise<void>;
  persistClassifiedMemoryRow(memory: PurrMemory, embedding?: Float32Array): Promise<void>;
  validateEmbedding(embedding: Float32Array, operation: string): void;
  assertJustification(categoryId: string, explanation: string): void;
  onApproved(version: MemoryDeleteVersion, deletedMemory: PurrMemory): void;
}

const PROPOSAL_STATUSES = new Set<MemoryDeletionProposalStatus>([
  'pending_partner_alert',
  'pending_operator_validation',
  'approved',
  'denied',
  'restored',
]);
const AUDIT_EVENT_TYPES = new Set<MemoryDeletionAuditEventType>([
  'proposed',
  'partner_alerted',
  'approved',
  'denied',
  'deleted',
  'restored',
]);
const ACTOR_ROLES = new Set<MemoryDeletionActorRole>([
  'Companion',
  'Partner',
  'Operator',
]);

function fromProposalRow(row: MemoryDeletionProposalRow): MemoryDeletionProposal {
  if (!PROPOSAL_STATUSES.has(row.status as MemoryDeletionProposalStatus)) {
    throw new Error(`Invalid memory deletion proposal status: ${row.status}`);
  }
  if (row.proposed_by !== 'Companion') {
    throw new Error(`Invalid memory deletion proposal actor: ${row.proposed_by}`);
  }
  return {
    id: row.id,
    memoryId: row.memory_id,
    memoryAuthorizationRevision: parsePgNumber(
      row.memory_authorization_revision,
      'memory_deletion_proposals.memory_authorization_revision',
    ),
    justificationCategory: row.justification_category,
    explanation: row.explanation,
    status: row.status as MemoryDeletionProposalStatus,
    proposedAt: parsePgNumber(row.proposed_at, 'memory_deletion_proposals.proposed_at'),
    proposedBy: 'Companion',
    ...(row.partner_alerted_at === null ? {} : {
      partnerAlertedAt: parsePgNumber(row.partner_alerted_at, 'memory_deletion_proposals.partner_alerted_at'),
    }),
    ...(row.operator_decided_at === null ? {} : {
      operatorDecidedAt: parsePgNumber(row.operator_decided_at, 'memory_deletion_proposals.operator_decided_at'),
    }),
    ...(row.operator_id ? { operatorId: row.operator_id } : {}),
    ...(row.delete_id ? { deleteId: row.delete_id } : {}),
    ...(row.restored_at === null ? {} : {
      restoredAt: parsePgNumber(row.restored_at, 'memory_deletion_proposals.restored_at'),
    }),
    ...(row.restored_by ? { restoredBy: row.restored_by } : {}),
  };
}

function fromAuditRow(row: MemoryDeletionAuditEventRow): MemoryDeletionAuditEvent {
  if (!AUDIT_EVENT_TYPES.has(row.event_type as MemoryDeletionAuditEventType)) {
    throw new Error(`Invalid memory deletion audit event type: ${row.event_type}`);
  }
  if (!ACTOR_ROLES.has(row.actor_role as MemoryDeletionActorRole)) {
    throw new Error(`Invalid memory deletion audit actor role: ${row.actor_role}`);
  }
  return {
    sequence: parsePgNumber(row.sequence, 'memory_deletion_audit_events.sequence'),
    id: row.id,
    proposalId: row.proposal_id,
    eventType: row.event_type as MemoryDeletionAuditEventType,
    actorRole: row.actor_role as MemoryDeletionActorRole,
    ...(row.actor_id ? { actorId: row.actor_id } : {}),
    occurredAt: parsePgNumber(row.occurred_at, 'memory_deletion_audit_events.occurred_at'),
    ...(row.delete_id ? { deleteId: row.delete_id } : {}),
  };
}

function assertTimestamp(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
}

export class PostgresMemoryDeletionProposalStore implements MemoryDeletionProposalStorePort {
  constructor(private readonly deps: PostgresMemoryDeletionProposalDependencies) {}

  private async lockProposal(proposalId: string): Promise<MemoryDeletionProposal | undefined> {
    const rows = await this.deps.queryWrite<MemoryDeletionProposalRow>(`
      SELECT id, memory_id, memory_authorization_revision, justification_category,
        explanation, status, proposed_at, proposed_by, partner_alerted_at,
        operator_decided_at, operator_id, delete_id, restored_at, restored_by
      FROM memory_deletion_proposals
      WHERE id = $1
      FOR UPDATE
    `, [proposalId]);
    const row = rows.at(0);
    return row ? fromProposalRow(row) : undefined;
  }

  private async insertAudit(input: {
    proposalId: string;
    eventType: MemoryDeletionAuditEventType;
    actorRole: MemoryDeletionActorRole;
    actorId?: string;
    occurredAt: number;
    deleteId?: string;
  }): Promise<void> {
    if (!this.deps.hasActiveTransaction()) {
      throw new Error('Memory deletion audit writes require a memory-store transaction');
    }
    await this.deps.queryWrite(`
      INSERT INTO memory_deletion_audit_events (
        id, proposal_id, event_type, actor_role, actor_id, occurred_at, delete_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7)
    `, [
      randomUUID(),
      input.proposalId,
      input.eventType,
      input.actorRole,
      input.actorId ?? null,
      input.occurredAt,
      input.deleteId ?? null,
    ]);
  }

  async createMemoryDeletionProposal(
    input: CreateMemoryDeletionProposalInput,
  ): Promise<MemoryDeletionProposal> {
    const memoryId = input.memoryId.trim();
    const justificationCategory = input.justificationCategory.trim();
    const explanation = input.explanation.trim();
    const proposalId = input.proposalId?.trim() || randomUUID();
    const proposedAt = input.proposedAt ?? Date.now();
    if (!memoryId) throw new Error('Memory deletion proposal requires a memory id');
    if (!justificationCategory) throw new Error('Memory deletion proposal requires a justification category');
    if (!explanation) throw new Error('Memory deletion proposal requires a written explanation');
    this.deps.assertJustification(justificationCategory, explanation);
    assertTimestamp(proposedAt, 'Memory deletion proposal proposedAt');

    return await this.deps.runInTransaction(async () => {
      const pendingRows = await this.deps.queryWrite<MemoryDeletionProposalRow>(`
        SELECT id, memory_id, memory_authorization_revision, justification_category,
          explanation, status, proposed_at, proposed_by, partner_alerted_at,
          operator_decided_at, operator_id, delete_id, restored_at, restored_by
        FROM memory_deletion_proposals
        WHERE memory_id = $1
          AND status IN ('pending_partner_alert', 'pending_operator_validation')
        ORDER BY proposed_at, id
        LIMIT 1
        FOR UPDATE
      `, [memoryId]);
      const pendingRow = pendingRows.at(0);
      if (pendingRow) {
        const pending = fromProposalRow(pendingRow);
        if (pending.justificationCategory !== justificationCategory
          || pending.explanation !== explanation) {
          throw new Error(
            `Memory ${memoryId} already has pending deletion proposal ${pending.id} with different justification`,
          );
        }
        return pending;
      }
      const memoryRows = await this.deps.queryWrite<{
        id: string;
        authorization_revision: number | string;
      }>(`
        SELECT id, authorization_revision
        FROM l2_memories
        WHERE id = $1 AND superseded_by IS NULL AND deleted_at IS NULL
        FOR UPDATE
      `, [memoryId]);
      const memoryRow = memoryRows.at(0);
      if (!memoryRow) throw new Error(`Memory not found or no longer active: ${memoryId}`);
      const memoryAuthorizationRevision = parsePgNumber(
        memoryRow.authorization_revision,
        'l2_memories.authorization_revision',
      );
      await this.deps.queryWrite(`
        INSERT INTO memory_deletion_proposals (
          id, memory_id, memory_authorization_revision, justification_category,
          explanation, status, proposed_at, proposed_by
        ) VALUES ($1,$2,$3,$4,$5,'pending_partner_alert',$6,'Companion')
      `, [proposalId, memoryId, memoryAuthorizationRevision, justificationCategory, explanation, proposedAt]);
      await this.insertAudit({
        proposalId,
        eventType: 'proposed',
        actorRole: 'Companion',
        occurredAt: proposedAt,
      });
      return {
        id: proposalId,
        memoryId,
        memoryAuthorizationRevision,
        justificationCategory,
        explanation,
        status: 'pending_partner_alert',
        proposedAt,
        proposedBy: 'Companion',
      };
    });
  }

  async markMemoryDeletionPartnerAlerted(
    proposalIdInput: string,
    alertedAt = Date.now(),
  ): Promise<MemoryDeletionProposal> {
    const proposalId = proposalIdInput.trim();
    if (!proposalId) throw new Error('Memory deletion proposal id is required');
    assertTimestamp(alertedAt, 'Memory deletion proposal alertedAt');
    return await this.deps.runInTransaction(async () => {
      const proposal = await this.lockProposal(proposalId);
      if (!proposal) throw new Error(`Memory deletion proposal not found: ${proposalId}`);
      if (proposal.status === 'pending_operator_validation') return proposal;
      if (proposal.status !== 'pending_partner_alert') {
        throw new Error(`Memory deletion proposal ${proposalId} cannot alert the Partner from ${proposal.status}`);
      }
      await this.deps.queryWrite(`
        UPDATE memory_deletion_proposals
        SET status = 'pending_operator_validation', partner_alerted_at = $2
        WHERE id = $1
      `, [proposalId, alertedAt]);
      await this.insertAudit({
        proposalId,
        eventType: 'partner_alerted',
        actorRole: 'Partner',
        occurredAt: alertedAt,
      });
      return { ...proposal, status: 'pending_operator_validation', partnerAlertedAt: alertedAt };
    });
  }

  async approveMemoryDeletionProposal(
    proposalIdInput: string,
    operatorIdInput: string,
    decidedAt = Date.now(),
  ): Promise<MemoryDeletionProposal> {
    const proposalId = proposalIdInput.trim();
    const operatorId = operatorIdInput.trim();
    if (!proposalId) throw new Error('Memory deletion proposal id is required');
    if (!operatorId) throw new Error('Memory deletion proposal approval requires an authenticated Operator id');
    assertTimestamp(decidedAt, 'Memory deletion proposal decidedAt');

    const outcome = await this.deps.runInTransaction(async () => {
      const proposal = await this.lockProposal(proposalId);
      if (!proposal) throw new Error(`Memory deletion proposal not found: ${proposalId}`);
      if (proposal.status === 'approved'
        && proposal.operatorId === operatorId
        && proposal.deleteId) {
        return { proposal, committed: false as const };
      }
      if (proposal.status !== 'pending_operator_validation') {
        throw new Error(`Memory deletion proposal ${proposalId} cannot be approved from ${proposal.status}`);
      }
      this.deps.assertJustification(proposal.justificationCategory, proposal.explanation);
      const memoryRows = await this.deps.queryWrite<MemoryRow & { authorization_revision: number | string }>(`
        SELECT ${MEMORY_SUBJECT_SELECT_COLUMNS}, memory.authorization_revision
        FROM l2_memories memory
        WHERE memory.id = $1
          AND memory.superseded_by IS NULL
          AND memory.deleted_at IS NULL
        FOR UPDATE
      `, [proposal.memoryId]);
      const memoryRow = memoryRows.at(0);
      if (!memoryRow) {
        throw new Error(`Memory deletion proposal target is no longer active: ${proposal.memoryId}`);
      }
      const currentRevision = parsePgNumber(
        memoryRow.authorization_revision,
        'l2_memories.authorization_revision',
      );
      if (currentRevision !== proposal.memoryAuthorizationRevision) {
        throw new Error(`Memory deletion proposal ${proposalId} is stale because its target changed after proposal`);
      }

      const memory = tryFromMemoryRow(memoryRow);
      if (!memory) {
        throw new Error(`Memory deletion proposal target is no longer active: ${proposal.memoryId}`);
      }
      const embedding = decodeEmbedding(memoryRow.embedding);
      if (embedding) this.deps.validateEmbedding(embedding, 'approved proposal delete');
      const deleteId = randomUUID();
      const deleteReason = `${proposal.justificationCategory}: ${proposal.explanation}`;
      const version: MemoryDeleteVersion = {
        deleteId,
        proposalId,
        memoryId: proposal.memoryId,
        snapshot: memory,
        deletedAt: decidedAt,
        deletedBy: operatorId,
        deleteReason,
      };
      const deletedMemory: PurrMemory = {
        ...memory,
        deletedAt: decidedAt,
        deletedBy: operatorId,
        deleteReason,
      };
      await this.insertAudit({
        proposalId,
        eventType: 'approved',
        actorRole: 'Operator',
        actorId: operatorId,
        occurredAt: decidedAt,
      });
      await this.deps.upsertDeleteVersion(version);
      await this.deps.persistClassifiedMemoryRow(deletedMemory, embedding);
      await this.deps.queryWrite(`
        UPDATE memory_deletion_proposals
        SET status = 'approved', operator_decided_at = $2, operator_id = $3, delete_id = $4
        WHERE id = $1
      `, [proposalId, decidedAt, operatorId, deleteId]);
      await this.insertAudit({
        proposalId,
        eventType: 'deleted',
        actorRole: 'Operator',
        actorId: operatorId,
        occurredAt: decidedAt,
        deleteId,
      });
      return {
        committed: true as const,
        proposal: {
          ...proposal,
          status: 'approved' as const,
          operatorDecidedAt: decidedAt,
          operatorId,
          deleteId,
        },
        version,
        deletedMemory,
      };
    });
    if (outcome.committed) {
      this.deps.onApproved(outcome.version, outcome.deletedMemory);
    }
    return outcome.proposal;
  }

  async denyMemoryDeletionProposal(
    proposalIdInput: string,
    operatorIdInput: string,
    decidedAt = Date.now(),
  ): Promise<MemoryDeletionProposal> {
    const proposalId = proposalIdInput.trim();
    const operatorId = operatorIdInput.trim();
    if (!proposalId) throw new Error('Memory deletion proposal id is required');
    if (!operatorId) throw new Error('Memory deletion proposal denial requires an authenticated Operator id');
    assertTimestamp(decidedAt, 'Memory deletion proposal decidedAt');
    return await this.deps.runInTransaction(async () => {
      const proposal = await this.lockProposal(proposalId);
      if (!proposal) throw new Error(`Memory deletion proposal not found: ${proposalId}`);
      if (proposal.status === 'denied' && proposal.operatorId === operatorId) return proposal;
      if (proposal.status !== 'pending_operator_validation') {
        throw new Error(`Memory deletion proposal ${proposalId} cannot be denied from ${proposal.status}`);
      }
      await this.deps.queryWrite(`
        UPDATE memory_deletion_proposals
        SET status = 'denied', operator_decided_at = $2, operator_id = $3
        WHERE id = $1
      `, [proposalId, decidedAt, operatorId]);
      await this.insertAudit({
        proposalId,
        eventType: 'denied',
        actorRole: 'Operator',
        actorId: operatorId,
        occurredAt: decidedAt,
      });
      return { ...proposal, status: 'denied', operatorDecidedAt: decidedAt, operatorId };
    });
  }

  async markRestored(input: {
    proposalId: string;
    deleteId: string;
    restoredAt: number;
    restoredBy: string;
    actorRole: 'Companion' | 'Operator' | undefined;
  }): Promise<void> {
    if (!input.actorRole) {
      throw new Error('Proposal-linked memory restoration requires a canonical Companion or Operator actor role');
    }
    const proposal = await this.lockProposal(input.proposalId);
    if (!proposal) throw new Error(`Memory deletion proposal not found: ${input.proposalId}`);
    if (proposal.status !== 'approved' || proposal.deleteId !== input.deleteId) {
      throw new Error(`Memory deletion proposal ${input.proposalId} is not eligible for restoration`);
    }
    await this.deps.queryWrite(`
      UPDATE memory_deletion_proposals
      SET status = 'restored', restored_at = $2, restored_by = $3
      WHERE id = $1
    `, [input.proposalId, input.restoredAt, input.restoredBy]);
    await this.insertAudit({
      proposalId: input.proposalId,
      eventType: 'restored',
      actorRole: input.actorRole,
      actorId: input.restoredBy,
      occurredAt: input.restoredAt,
      deleteId: input.deleteId,
    });
  }

  async getMemoryDeletionProposal(
    proposalIdInput: string,
  ): Promise<MemoryDeletionProposal | undefined> {
    const proposalId = proposalIdInput.trim();
    if (!proposalId) return undefined;
    const rows = await this.deps.queryRead<MemoryDeletionProposalRow>(`
      SELECT id, memory_id, memory_authorization_revision, justification_category,
        explanation, status, proposed_at, proposed_by, partner_alerted_at,
        operator_decided_at, operator_id, delete_id, restored_at, restored_by
      FROM memory_deletion_proposals
      WHERE id = $1
    `, [proposalId]);
    const row = rows.at(0);
    return row ? fromProposalRow(row) : undefined;
  }

  async listPendingMemoryDeletionProposals(): Promise<MemoryDeletionProposal[]> {
    const rows = await this.deps.queryRead<MemoryDeletionProposalRow>(`
      SELECT id, memory_id, memory_authorization_revision, justification_category,
        explanation, status, proposed_at, proposed_by, partner_alerted_at,
        operator_decided_at, operator_id, delete_id, restored_at, restored_by
      FROM memory_deletion_proposals
      WHERE status IN ('pending_partner_alert', 'pending_operator_validation')
      ORDER BY proposed_at, id
    `, []);
    return rows.map(fromProposalRow);
  }

  async listRecoverableMemoryDeletionProposals(): Promise<MemoryDeletionProposal[]> {
    const rows = await this.deps.queryRead<MemoryDeletionProposalRow>(`
      SELECT id, memory_id, memory_authorization_revision, justification_category,
        explanation, status, proposed_at, proposed_by, partner_alerted_at,
        operator_decided_at, operator_id, delete_id, restored_at, restored_by
      FROM memory_deletion_proposals
      WHERE status IN (
        'pending_partner_alert', 'pending_operator_validation', 'approved', 'denied'
      )
      ORDER BY proposed_at, id
    `, []);
    return rows.map(fromProposalRow);
  }

  async listMemoryDeletionAuditEvents(
    proposalIdInput: string,
  ): Promise<MemoryDeletionAuditEvent[]> {
    const proposalId = proposalIdInput.trim();
    if (!proposalId) return [];
    const rows = await this.deps.queryRead<MemoryDeletionAuditEventRow>(`
      SELECT sequence, id, proposal_id, event_type, actor_role, actor_id, occurred_at, delete_id
      FROM memory_deletion_audit_events
      WHERE proposal_id = $1
      ORDER BY sequence
    `, [proposalId]);
    return rows.map(fromAuditRow);
  }
}
