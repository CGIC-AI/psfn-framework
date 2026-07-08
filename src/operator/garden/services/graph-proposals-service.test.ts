import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  Contact,
  SocialGraphEntity,
  SocialGraphEntityUpsertInput,
  SocialRelationshipEdge,
  SocialRelationshipEdgeUpsertInput,
} from '../../../core/contacts/types.js';
import {
  createFileSocialGraphProposalStore,
  type SocialGraphProposalCreateInput,
  type SocialGraphProposalStore,
} from '../../../faculties/memory/social-graph/proposals.js';
import { createAdminGraphProposalsService } from './graph-proposals-service.js';

const ALICE = 'c-alice';
const BOB = 'c-bob';

function makeContact(id: string, displayName: string): Contact {
  return {
    id,
    displayName,
    trustLevel: 'personal',
    relationshipType: 'acquaintance',
    firstSeen: '2026-01-01T00:00:00.000Z',
    lastSeen: '2026-01-02T00:00:00.000Z',
  };
}

function makeEntity(contactId: string, displayName: string): SocialGraphEntity {
  return {
    id: `contact:${contactId}`,
    entityKind: 'person',
    displayName,
    contactId,
    sensitivity: 'personal',
    provenanceRefs: [],
    confidence: 1,
    source: 'contact',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function baseProposalInput(
  overrides?: Partial<SocialGraphProposalCreateInput>,
): SocialGraphProposalCreateInput {
  return {
    evidenceClass: 'named_relationship',
    sourceContactId: ALICE,
    targetContactId: BOB,
    sourceDisplayName: 'Alice',
    targetDisplayName: 'Bob',
    relationshipType: 'sibling',
    directional: false,
    confidence: 0.7,
    sensitivity: 'personal',
    evidenceMemoryIds: ['m-1'],
    channelId: 'room-1',
    provenanceRefs: ['source:social_graph_builder'],
    rationale: 'test',
    status: 'pending',
    ...overrides,
  };
}

interface EdgeStubState {
  writes: SocialRelationshipEdgeUpsertInput[];
  entityUpserts: SocialGraphEntityUpsertInput[];
}

function makeContactStore(state: EdgeStubState, tracked = new Map([
  [ALICE, makeContact(ALICE, 'Alice')],
  [BOB, makeContact(BOB, 'Bob')],
])) {
  return {
    async getById(id: string): Promise<Contact | undefined> {
      return tracked.get(id);
    },
    async getSocialGraphEntityByContactId(contactId: string): Promise<SocialGraphEntity | undefined> {
      return makeEntity(contactId, tracked.get(contactId)?.displayName ?? contactId);
    },
    async upsertSocialGraphEntity(input: SocialGraphEntityUpsertInput): Promise<SocialGraphEntity> {
      state.entityUpserts.push(input);
      return makeEntity(input.contactId ?? 'x', input.displayName);
    },
    async upsertSocialRelationshipEdge(input: SocialRelationshipEdgeUpsertInput): Promise<SocialRelationshipEdge> {
      state.writes.push(input);
      return {
        id: `edge:${state.writes.length}`,
        sourceEntityId: input.sourceEntityId,
        targetEntityId: input.targetEntityId,
        relationshipType: input.relationshipType,
        directional: input.directional ?? true,
        sensitivity: input.sensitivity ?? 'personal',
        provenanceRefs: input.provenanceRefs ?? [],
        evidenceMemoryIds: input.evidenceMemoryIds ?? [],
        confidence: input.confidence ?? 0.7,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
    },
  };
}

let tmpRoot: string;
let proposalStore: SocialGraphProposalStore;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'graph-proposals-svc-'));
  proposalStore = createFileSocialGraphProposalStore(join(tmpRoot, 'proposals.json'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('AdminGraphProposalsService', () => {
  it('AC4: approve writes the edge through upsertSocialRelationshipEdge and marks accepted', async () => {
    const { proposal } = await proposalStore.create(baseProposalInput());
    const state: EdgeStubState = { writes: [], entityUpserts: [] };
    const service = createAdminGraphProposalsService({
      proposalStore,
      contactStore: makeContactStore(state),
    });

    const result = await service.approveGraphProposal(proposal.id);
    expect(result.ok).toBe(true);
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]).toMatchObject({
      sourceEntityId: `contact:${ALICE}`,
      targetEntityId: `contact:${BOB}`,
      relationshipType: 'sibling',
      directional: false,
    });
    expect(state.writes[0].provenanceRefs).toContain('source:memory');

    const stored = await proposalStore.getById(proposal.id);
    expect(stored?.status).toBe('accepted');
    expect(stored?.acceptedRelationshipType).toBe('sibling');
    expect(stored?.acceptedEdgeId).toBeTruthy();
  });

  it('AC4: approve with an adjusted type writes the operator-chosen relationship', async () => {
    const { proposal } = await proposalStore.create(baseProposalInput());
    const state: EdgeStubState = { writes: [], entityUpserts: [] };
    const service = createAdminGraphProposalsService({
      proposalStore,
      contactStore: makeContactStore(state),
    });

    const result = await service.approveGraphProposal(proposal.id, 'friend');
    expect(result.ok).toBe(true);
    expect(state.writes[0].relationshipType).toBe('friend');
    const stored = await proposalStore.getById(proposal.id);
    expect(stored?.acceptedRelationshipType).toBe('friend');
  });

  it('AC4: rejects an invalid adjusted type without writing', async () => {
    const { proposal } = await proposalStore.create(baseProposalInput());
    const state: EdgeStubState = { writes: [], entityUpserts: [] };
    const service = createAdminGraphProposalsService({
      proposalStore,
      contactStore: makeContactStore(state),
    });
    const result = await service.approveGraphProposal(proposal.id, 'not-a-real-type');
    expect(result).toEqual({ ok: false, message: 'Invalid relationship type' });
    expect(state.writes).toHaveLength(0);
  });

  it('AC4: reject persists and blocks re-proposal of the same evidence', async () => {
    const input = baseProposalInput();
    const { proposal } = await proposalStore.create(input);
    const state: EdgeStubState = { writes: [], entityUpserts: [] };
    const service = createAdminGraphProposalsService({
      proposalStore,
      contactStore: makeContactStore(state),
    });

    const result = await service.rejectGraphProposal(proposal.id);
    expect(result.ok).toBe(true);
    const stored = await proposalStore.getById(proposal.id);
    expect(stored?.status).toBe('rejected');

    // Re-proposing the identical evidence set is blocked (idempotent create).
    const reproposed = await proposalStore.create(input);
    expect(reproposed.created).toBe(false);
    expect(reproposed.proposal.status).toBe('rejected');
    expect(await proposalStore.list()).toHaveLength(1);
  });

  it('cannot approve an already-decided proposal', async () => {
    const { proposal } = await proposalStore.create(baseProposalInput());
    const state: EdgeStubState = { writes: [], entityUpserts: [] };
    const service = createAdminGraphProposalsService({
      proposalStore,
      contactStore: makeContactStore(state),
    });
    await service.rejectGraphProposal(proposal.id);
    const result = await service.approveGraphProposal(proposal.id);
    expect(result.ok).toBe(false);
    expect(state.writes).toHaveLength(0);
  });

  it('returns not-found for an unknown proposal', async () => {
    const state: EdgeStubState = { writes: [], entityUpserts: [] };
    const service = createAdminGraphProposalsService({
      proposalStore,
      contactStore: makeContactStore(state),
    });
    const approve = await service.approveGraphProposal('missing');
    expect(approve).toEqual({ ok: false, message: 'Graph proposal not found' });
    const reject = await service.rejectGraphProposal('missing');
    expect(reject).toEqual({ ok: false, message: 'Graph proposal not found' });
  });
});
