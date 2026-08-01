import { describe, expect, it, vi } from 'vitest';
import type { QueryResultRow } from 'pg';
import type { MemoryDeleteVersion } from '../memory-store-port.js';
import type { PurrMemory } from '../types.js';
import {
  PostgresMemoryDeletionProposalStore,
  type PostgresMemoryDeletionProposalDependencies,
} from './deletion-proposals.js';
import type { MemoryRow } from './rows.js';

function makeMemoryRow(id: string): MemoryRow & { authorization_revision: string } {
  return {
    id,
    text: `Memory ${id}`,
    type: 'semantic',
    importance: 0.8,
    confidence: 0.9,
    emotional_valence: 0,
    formation_vad: null,
    emotional_texture: null,
    salience: 0.7,
    salience_decay_anchor_at: 1,
    source_ref: 'test',
    source_type: null,
    provenance_json: {},
    extracted_at: 1,
    last_accessed: 1,
    access_count: 0,
    superseded_by: null,
    tags: [],
    scope_ref_kind: null,
    scope_ref_id: null,
    scope_ref_label: null,
    scope_tags: [],
    provenance_refs: [],
    retention_class: null,
    sensitivity: 'personal',
    consent_flags: {},
    contact_id: null,
    deleted_at: null,
    deleted_by: null,
    delete_reason: null,
    embedding: '[0.1,0.2]',
    authorization_revision: '1',
  };
}

function createHarness() {
  const memories = new Map([
    ['memory-approved', makeMemoryRow('memory-approved')],
    ['memory-denied', makeMemoryRow('memory-denied')],
  ]);
  const proposals = new Map<string, Record<string, unknown>>();
  const audits: Array<Record<string, unknown>> = [];
  const deleteVersions = new Map<string, MemoryDeleteVersion>();
  let inTransaction = false;
  const onApproved = vi.fn();

  const query = async <T extends QueryResultRow>(
    text: string,
    values: readonly unknown[],
  ): Promise<T[]> => {
    const sql = text.replace(/\s+/g, ' ').trim().toLowerCase();
    if (sql.startsWith('select id, authorization_revision from l2_memories')) {
      const row = memories.get(String(values[0]));
      return (row && row.deleted_at === null && row.superseded_by === null
        ? [{ id: row.id, authorization_revision: row.authorization_revision }]
        : []) as T[];
    }
    if (sql.startsWith('insert into memory_deletion_proposals')) {
      proposals.set(String(values[0]), {
        id: values[0],
        memory_id: values[1],
        memory_authorization_revision: values[2],
        justification_category: values[3],
        explanation: values[4],
        status: 'pending_partner_alert',
        proposed_at: values[5],
        proposed_by: 'Companion',
        partner_alerted_at: null,
        operator_decided_at: null,
        operator_id: null,
        delete_id: null,
        restored_at: null,
        restored_by: null,
      });
      return [];
    }
    if (sql.includes('from memory_deletion_proposals') && sql.includes('where status in')) {
      const recoverable = sql.includes("'approved'") && sql.includes("'denied'");
      return [...proposals.values()]
        .filter(row => row.status === 'pending_partner_alert'
          || row.status === 'pending_operator_validation'
          || (recoverable && (row.status === 'approved' || row.status === 'denied')))
        .sort((left, right) => Number(left.proposed_at) - Number(right.proposed_at)) as T[];
    }
    if (sql.includes('from memory_deletion_proposals') && sql.includes('where memory_id =')) {
      return [...proposals.values()]
        .filter(row => row.memory_id === values[0]
          && (row.status === 'pending_partner_alert' || row.status === 'pending_operator_validation'))
        .slice(0, 1) as T[];
    }
    if (sql.includes('from memory_deletion_proposals')) {
      const row = proposals.get(String(values[0]));
      return (row ? [{ ...row }] : []) as T[];
    }
    if (sql.startsWith('update memory_deletion_proposals')) {
      const row = proposals.get(String(values[0]));
      if (!row) return [];
      if (sql.includes("status = 'pending_operator_validation'")) {
        row.status = 'pending_operator_validation';
        row.partner_alerted_at = values[1];
      } else if (sql.includes("status = 'approved'")) {
        row.status = 'approved';
        row.operator_decided_at = values[1];
        row.operator_id = values[2];
        row.delete_id = values[3];
      } else if (sql.includes("status = 'denied'")) {
        row.status = 'denied';
        row.operator_decided_at = values[1];
        row.operator_id = values[2];
      } else if (sql.includes("status = 'restored'")) {
        row.status = 'restored';
        row.restored_at = values[1];
        row.restored_by = values[2];
      }
      return [];
    }
    if (sql.startsWith('insert into memory_deletion_audit_events')) {
      audits.push({
        sequence: String(audits.length + 1),
        id: values[0],
        proposal_id: values[1],
        event_type: values[2],
        actor_role: values[3],
        actor_id: values[4],
        occurred_at: values[5],
        delete_id: values[6],
      });
      return [];
    }
    if (sql.includes('from memory_deletion_audit_events')) {
      return audits.filter(row => row.proposal_id === values[0]) as T[];
    }
    if (sql.includes('from l2_memories memory') && sql.includes('authorization_revision')) {
      const row = memories.get(String(values[0]));
      return (row && row.deleted_at === null ? [{ ...row }] : []) as T[];
    }
    throw new Error(`Unhandled test SQL: ${sql}`);
  };

  const deps: PostgresMemoryDeletionProposalDependencies = {
    runInTransaction: async handler => {
      inTransaction = true;
      try {
        return await handler();
      } finally {
        inTransaction = false;
      }
    },
    queryWrite: query,
    queryRead: query,
    hasActiveTransaction: () => inTransaction,
    upsertDeleteVersion: async version => { deleteVersions.set(version.deleteId, version); },
    persistClassifiedMemoryRow: async (memory: PurrMemory) => {
      const row = memories.get(memory.id);
      if (row) {
        row.deleted_at = memory.deletedAt ?? null;
        row.deleted_by = memory.deletedBy ?? null;
        row.delete_reason = memory.deleteReason ?? null;
      }
    },
    validateEmbedding: () => undefined,
    assertJustification: (categoryId, explanation) => {
      if (categoryId === 'negative_valence_only' || explanation.includes('dislike')) {
        throw new Error('Dislike, embarrassment, discomfort, or negative valence alone are insufficient grounds.');
      }
      if (categoryId !== 'privacy_or_consent' && categoryId !== 'duplicate_or_superseded') {
        throw new Error(`Unknown memory deletion justification category "${categoryId}"`);
      }
    },
    onApproved,
  };
  return {
    audits,
    deleteVersions,
    memories,
    onApproved,
    proposals,
    store: new PostgresMemoryDeletionProposalStore(deps),
    transact: deps.runInTransaction,
  };
}

describe('PostgresMemoryDeletionProposalStore', () => {
  it('links proposed, Partner-alerted, approved, deleted, and restored events by proposal id', async () => {
    const h = createHarness();
    const proposed = await h.store.createMemoryDeletionProposal({
      proposalId: 'proposal-approved',
      memoryId: 'memory-approved',
      justificationCategory: 'privacy_or_consent',
      explanation: 'Consent was withdrawn.',
      proposedBy: 'Companion',
      proposedAt: 10,
    });
    expect(proposed.status).toBe('pending_partner_alert');
    expect(h.memories.get('memory-approved')?.deleted_at).toBeNull();

    await h.store.markMemoryDeletionPartnerAlerted(proposed.id, 20);
    await expect(h.store.createMemoryDeletionProposal({
      memoryId: proposed.memoryId,
      justificationCategory: proposed.justificationCategory,
      explanation: proposed.explanation,
      proposedBy: 'Companion',
    })).resolves.toMatchObject({ id: proposed.id, status: 'pending_operator_validation' });
    expect(h.audits.filter(event => event.event_type === 'proposed')).toHaveLength(1);
    await expect(h.store.listPendingMemoryDeletionProposals()).resolves.toEqual([
      expect.objectContaining({ id: proposed.id, status: 'pending_operator_validation' }),
    ]);
    const approved = await h.store.approveMemoryDeletionProposal(proposed.id, 'operator-1', 30);
    expect(approved).toMatchObject({ status: 'approved', operatorId: 'operator-1' });
    expect(approved.deleteId).toBeTruthy();
    expect(h.deleteVersions.get(approved.deleteId!)).toMatchObject({ proposalId: proposed.id });
    expect(h.onApproved).toHaveBeenCalledOnce();
    await expect(h.store.listPendingMemoryDeletionProposals()).resolves.toEqual([]);
    await expect(h.store.listRecoverableMemoryDeletionProposals()).resolves.toEqual([
      expect.objectContaining({ id: proposed.id, status: 'approved' }),
    ]);

    await h.transact(() => h.store.markRestored({
      proposalId: proposed.id,
      deleteId: approved.deleteId!,
      restoredAt: 40,
      restoredBy: 'tool:memory|action:restore',
      actorRole: 'Companion',
    }));
    await expect(h.store.getMemoryDeletionProposal(proposed.id))
      .resolves.toMatchObject({ status: 'restored', deleteId: approved.deleteId });
    expect(await h.store.listMemoryDeletionAuditEvents(proposed.id)).toEqual([
      expect.objectContaining({ proposalId: proposed.id, eventType: 'proposed', actorRole: 'Companion' }),
      expect.objectContaining({ proposalId: proposed.id, eventType: 'partner_alerted', actorRole: 'Partner' }),
      expect.objectContaining({ proposalId: proposed.id, eventType: 'approved', actorRole: 'Operator' }),
      expect.objectContaining({ proposalId: proposed.id, eventType: 'deleted', actorRole: 'Operator' }),
      expect.objectContaining({ proposalId: proposed.id, eventType: 'restored', actorRole: 'Companion' }),
    ]);
  });

  it('records authenticated Operator denial without creating a delete checkpoint', async () => {
    const h = createHarness();
    const proposed = await h.store.createMemoryDeletionProposal({
      proposalId: 'proposal-denied',
      memoryId: 'memory-denied',
      justificationCategory: 'duplicate_or_superseded',
      explanation: 'A canonical replacement exists.',
      proposedBy: 'Companion',
    });
    await h.store.markMemoryDeletionPartnerAlerted(proposed.id);
    await expect(h.store.denyMemoryDeletionProposal(proposed.id, 'operator-2'))
      .resolves.toMatchObject({ status: 'denied', operatorId: 'operator-2' });
    expect(h.deleteVersions.size).toBe(0);
    expect(h.memories.get('memory-denied')?.deleted_at).toBeNull();
    expect((await h.store.listMemoryDeletionAuditEvents(proposed.id)).map(event => event.eventType))
      .toEqual(['proposed', 'partner_alerted', 'denied']);
    await expect(h.store.listRecoverableMemoryDeletionProposals()).resolves.toEqual([
      expect.objectContaining({ id: proposed.id, status: 'denied' }),
    ]);
  });

  it('rejects an ineligible settings-owned category before writing a proposal', async () => {
    const h = createHarness();
    await expect(h.store.createMemoryDeletionProposal({
      proposalId: 'proposal-rejected',
      memoryId: 'memory-approved',
      justificationCategory: 'negative_valence_only',
      explanation: 'I dislike remembering it.',
      proposedBy: 'Companion',
    })).rejects.toThrow(/dislike.*embarrassment.*discomfort.*negative valence alone/iu);
    expect(h.proposals.has('proposal-rejected')).toBe(false);
    expect(h.audits).toHaveLength(0);
  });

  it('rejects an unknown category at the durable persistence boundary', async () => {
    const h = createHarness();
    await expect(h.store.createMemoryDeletionProposal({
      proposalId: 'proposal-unknown',
      memoryId: 'memory-approved',
      justificationCategory: 'invented_category',
      explanation: 'An invented category should not persist.',
      proposedBy: 'Companion',
    })).rejects.toThrow(/unknown memory deletion justification category/iu);
    expect(h.proposals.has('proposal-unknown')).toBe(false);
    expect(h.audits).toHaveLength(0);
  });
});
