import { describe, expect, it } from 'vitest';
import type { MemoryStorePort } from '../../../faculties/memory/memory-store-port.js';
import type { SessionStore } from '../../../persistence/sessions/store.js';
import { AdminContactsDataService } from './contacts-service.js';
import type { AdminContactRelationshipScoreReader } from './types.js';
import { createContactRelationshipScoreReader } from '../../../core/contacts/trust-drift-signals.js';
import type { EmotionalTimeSeriesPoint } from '../../../core/contacts/store/emotional-baseline.js';
import { createTestPostgresContactStore } from '../../../test-support/postgres-contact-store.js';
import type { FleetGardenRequestContext, GardenRequestContext } from '../garden-request-context.js';
import { FLEET_GARDEN_CONTACT_OPERATOR_ACTOR } from '../garden-request-context.js';

function fleetContext(contactId: string): GardenRequestContext {
  return {
    kind: 'fleet_principal',
    actor: { principalId: `principal-${contactId}`, contactId },
  } as unknown as GardenRequestContext;
}

async function createServiceHarness(options?: {
  relationshipScoreReader?: AdminContactRelationshipScoreReader;
  primaryUserId?: string;
}) {
  const { store: contactStore } = await createTestPostgresContactStore(options?.primaryUserId);
  const sessionStore = {
    listChannels: () => [],
    getLastEntry: () => undefined,
  } as unknown as SessionStore;
  const profiles = new Map<string, {
    schemaVersion: 1;
    contactId: string;
    summary: string;
    sourceMemoryIds: string[];
    confidenceScore: number;
    noveltyScore: number;
    updatedAt: number;
    freshUntil: number;
  }>();
  const memoryStore = {
    listRecentContactShapes: () => [...profiles.values()],
    getRecentContactShape: (contactId: string) => profiles.get(contactId),
  } as unknown as MemoryStorePort;
  const service = new AdminContactsDataService({
    contactStore,
    memoryStore,
    sessionStore,
    relationshipScoreReader: options?.relationshipScoreReader,
  });
  return { contactStore, service, profiles, memoryStore, sessionStore };
}

function authenticatedContactMutationContext(input: {
  contactId: string;
  role?: 'owner' | 'admin' | 'member';
  provider?: 'discord' | 'testing_harness';
  accessMode?: 'sole_admin' | 'multi_admin';
}): FleetGardenRequestContext {
  return {
    kind: 'fleet_principal', requestId: 'request-fixture', decisionId: 'decision-fixture',
    authorizationEventId: 'authorization-event-fixture', resolvedAt: '2030-01-01T00:00:00.000Z',
    versions: { authorityGeneration: 1, globalAuthEpoch: 1, sessionAuthnVersion: 1,
      sessionAuthzVersion: 1, bindingVersion: 1, grantVersion: 1, policyVersion: 1 },
    issuedAt: 1, expiresAt: 2,
    actor: { kind: 'fleet_principal', principalId: 'principal-fixture',
      provider: input.provider ?? 'discord', providerSubjectId: 'provider-subject-fixture',
      contactId: input.contactId, contactBindingId: 'binding-fixture', role: input.role ?? 'owner',
      operatorGrantId: 'grant-fixture', sessionRecordId: 'session-fixture',
      sessionAssurance: 'oauth', accessMode: input.accessMode ?? 'sole_admin' },
    action: 'contacts.manage',
    resource: { routeId: 'PATCH /api/admin/contacts/:id', scope: 'personal_workspace',
      area: 'contacts', companionId: '11111111-1111-4111-8111-111111111111',
      pathParams: { id: input.contactId }, query: {} },
    subjectRelation: 'self',
    authorization: { action: 'contacts.manage', baseRole: 'admin',
      resource: { scope: 'personal_workspace', area: 'contacts' }, subjectRelation: 'self',
      requirements: { assurance: 'oauth', confirmation: 'none', approvals: [] },
      publicAccess: 'never', recoveryAccess: 'forbidden' },
  };
}

describe('AdminContactsDataService', () => {
  it('persists protected sole-owner mutations under the canonical operator actor with SSO metadata', async () => {
    const { contactStore, service } = await createServiceHarness();
    const owner = await contactStore.upsert({ displayName: 'Fleet Owner' });
    const protectedContact = await contactStore.upsert({ displayName: 'Chosen Family', relationshipType: 'friend' });
    const context = authenticatedContactMutationContext({ contactId: owner.id });

    await expect(service.updateContact(protectedContact.id, JSON.stringify({
      displayName: 'Chosen Family Updated', trustLevel: 'trusted', relationshipType: 'family',
    }), context)).resolves.toMatchObject({ ok: true });

    const audit = await contactStore.listMutationAuditEntries({ contactId: protectedContact.id });
    expect(audit.filter(entry => ['display_name', 'trust_level', 'relationship_type'].includes(entry.field)))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ actor: FLEET_GARDEN_CONTACT_OPERATOR_ACTOR,
          metadata: expect.objectContaining({ source: 'fleet_garden', provider: 'discord',
            providerSubjectId: 'provider-subject-fixture', principalId: 'principal-fixture' }) }),
      ]));
    expect(audit.filter(entry => ['display_name', 'trust_level', 'relationship_type'].includes(entry.field)))
      .toHaveLength(3);
  });

  it.each([
    ['non-owner', { role: 'admin' as const }],
    ['automated harness', { provider: 'testing_harness' as const }],
  ])('denies %s protected fleet mutations', async (_label, overrides) => {
    const { contactStore, service } = await createServiceHarness();
    const contact = await contactStore.upsert({ displayName: 'Protected Contact', relationshipType: 'friend' });
    const result = await service.updateContact(contact.id, JSON.stringify({ trustLevel: 'trusted', relationshipType: 'family' }),
      authenticatedContactMutationContext({ contactId: contact.id, ...overrides }));
    expect(result).toMatchObject({ ok: false, failureKind: 'authorization' });
    expect(await contactStore.getById(contact.id)).toMatchObject({ trustLevel: 'regular', relationshipType: 'friend' });
  });

  it('reports primary-contact trust immutability separately from authorization', async () => {
    const { contactStore, service } = await createServiceHarness({ primaryUserId: 'primary-provider-fixture' });
    const primary = await contactStore.upsert({ displayName: 'Primary Owner', discordUserId: 'primary-provider-fixture', trustLevel: 'primary' },
      { actor: 'operator:test', allowPrimaryTrustAssignment: true });
    const result = await service.updateContact(primary.id, JSON.stringify({ trustLevel: 'trusted' }),
      authenticatedContactMutationContext({ contactId: primary.id }));
    expect(result).toMatchObject({ ok: false, failureKind: 'immutability' });
    expect((await contactStore.getById(primary.id))?.trustLevel).toBe('primary');
  });

  it.each([
    { label: 'machine source into human target', sourceIsMachine: true, targetIsMachine: false },
    { label: 'human source into machine target', sourceIsMachine: false, targetIsMachine: true },
  ])('rejects $label without moving its channel identity', async ({ sourceIsMachine, targetIsMachine }) => {
    const { contactStore, service } = await createServiceHarness();
    const target = await contactStore.upsert({
      displayName: 'Merge target',
    });
    const source = await contactStore.upsert({
      displayName: 'Merge source',
    });
    if (targetIsMachine) {
      expect(await contactStore.setMachineIntelligence(target.id, true, 'operator:test')).toBe(true);
    }
    if (sourceIsMachine) {
      expect(await contactStore.setMachineIntelligence(source.id, true, 'operator:test')).toBe(true);
    }
    await contactStore.linkChannelIdentity(source.id, 'multica', 'workspace-system');
    const targetBefore = await contactStore.getById(target.id);
    const sourceBefore = await contactStore.getById(source.id);

    const result = await service.mergeContacts(
      target.id,
      JSON.stringify({ sourceId: source.id }),
    );

    expect(result).toEqual({
      ok: false,
      message: 'Cannot merge human and machine-intelligence contacts',
    });
    expect(await contactStore.getByChannelIdentity('multica', 'workspace-system'))
      .toMatchObject({ id: source.id });
    expect(await contactStore.getById(target.id)).toEqual(targetBefore);
    expect(await contactStore.getById(source.id)).toEqual(sourceBefore);
  });

  it.each([
    { label: 'machine source into human target', sourceIsMachine: true, targetIsMachine: false },
    { label: 'human source into machine target', sourceIsMachine: false, targetIsMachine: true },
  ])('surfaces the mixed-kind error to a sole-admin Fleet $label request', async ({
    sourceIsMachine,
    targetIsMachine,
  }) => {
    const { contactStore, service } = await createServiceHarness();
    const target = await contactStore.upsert({ displayName: 'Merge target' });
    const source = await contactStore.upsert({ displayName: 'Merge source' });
    if (targetIsMachine) {
      expect(await contactStore.setMachineIntelligence(target.id, true, 'operator:test')).toBe(true);
    }
    if (sourceIsMachine) {
      expect(await contactStore.setMachineIntelligence(source.id, true, 'operator:test')).toBe(true);
    }

    const result = await service.mergeContacts(
      target.id,
      JSON.stringify({ sourceId: source.id }),
      authenticatedContactMutationContext({ contactId: target.id }),
    );

    expect(result).toEqual({
      ok: false,
      message: 'Cannot merge human and machine-intelligence contacts',
    });
    expect((await contactStore.getById(target.id))?.archivedAt).toBeUndefined();
    expect((await contactStore.getById(source.id))?.archivedAt).toBeUndefined();
  });

  it('keeps same-kind Fleet merging disabled', async () => {
    const { contactStore, service } = await createServiceHarness();
    const target = await contactStore.upsert({ displayName: 'Merge target' });
    const source = await contactStore.upsert({ displayName: 'Merge source' });

    const result = await service.mergeContacts(
      target.id,
      JSON.stringify({ sourceId: source.id }),
      authenticatedContactMutationContext({ contactId: target.id }),
    );

    expect(result).toEqual({ ok: false, message: 'Fleet contact merging is unavailable' });
    expect((await contactStore.getById(target.id))?.archivedAt).toBeUndefined();
    expect((await contactStore.getById(source.id))?.archivedAt).toBeUndefined();
  });

  it('moves one exact Multica member identity onto the Fleet owner without merging contacts', async () => {
    const { contactStore, service } = await createServiceHarness();
    const target = await contactStore.upsert({ displayName: 'Fleet owner' });
    const source = await contactStore.upsert({ displayName: 'Multica member duplicate' });
    const system = await contactStore.upsert({ displayName: 'Multica system' });
    expect(await contactStore.setMachineIntelligence(system.id, true, 'system:test')).toBe(true);
    const memberUserId = 'multica:member:99999999-9999-4999-8999-999999999999';
    const systemUserId = 'multica:system:11111111-1111-4111-8111-111111111111';
    expect(await contactStore.linkChannelIdentity(source.id, 'multica', memberUserId)).toBe('linked');
    expect(await contactStore.linkChannelIdentity(system.id, 'multica', systemUserId)).toBe('linked');

    const result = await service.transferChannelIdentity(
      target.id,
      JSON.stringify({ sourceContactId: source.id, channel: 'multica', userId: memberUserId }),
      authenticatedContactMutationContext({ contactId: target.id }),
    );

    expect(result).toMatchObject({ ok: true, message: 'Multica member channel moved to this contact' });
    expect(await contactStore.getByChannelIdentity('multica', memberUserId)).toMatchObject({ id: target.id });
    expect(await contactStore.getByChannelIdentity('multica', systemUserId)).toMatchObject({ id: system.id });
    expect(await contactStore.getById(source.id)).toMatchObject({ id: source.id });
    expect(await contactStore.getById(system.id)).toMatchObject({ isMachineIntelligence: true });
  });

  it('refuses to move a Multica system identity onto a human contact', async () => {
    const { contactStore, service } = await createServiceHarness();
    const target = await contactStore.upsert({ displayName: 'Fleet owner' });
    const source = await contactStore.upsert({ displayName: 'Multica system' });
    expect(await contactStore.setMachineIntelligence(source.id, true, 'system:test')).toBe(true);
    const systemUserId = 'multica:system:11111111-1111-4111-8111-111111111111';
    expect(await contactStore.linkChannelIdentity(source.id, 'multica', systemUserId)).toBe('linked');

    const result = await service.transferChannelIdentity(
      target.id,
      JSON.stringify({ sourceContactId: source.id, channel: 'multica', userId: systemUserId }),
      authenticatedContactMutationContext({ contactId: target.id }),
    );

    expect(result).toEqual({ ok: false, message: 'Only Multica member identities can move between human contacts' });
    expect(await contactStore.getByChannelIdentity('multica', systemUserId)).toMatchObject({ id: source.id });
  });

  it.each(['null', '{"sourceContactId":42,"channel":"multica","userId":true}'])('rejects malformed channel-transfer payload %s', async body => {
    const { contactStore, service } = await createServiceHarness();
    const target = await contactStore.upsert({ displayName: 'Fleet owner' });
    await expect(service.transferChannelIdentity(
      target.id,
      body,
      authenticatedContactMutationContext({ contactId: target.id }),
    )).resolves.toMatchObject({ ok: false });
  });

  it.each([
    { label: 'human contacts', isMachineIntelligence: false },
    { label: 'machine-intelligence contacts', isMachineIntelligence: true },
  ])('still merges $label', async ({ isMachineIntelligence }) => {
    const { contactStore, service } = await createServiceHarness();
    const target = await contactStore.upsert({ displayName: 'Merge target' });
    const source = await contactStore.upsert({ displayName: 'Merge source' });
    if (isMachineIntelligence) {
      expect(await contactStore.setMachineIntelligence(target.id, true, 'operator:test')).toBe(true);
      expect(await contactStore.setMachineIntelligence(source.id, true, 'operator:test')).toBe(true);
    }
    await contactStore.linkChannelIdentity(source.id, 'api', 'source-identity');

    const result = await service.mergeContacts(
      target.id,
      JSON.stringify({ sourceId: source.id }),
    );

    expect(result).toMatchObject({ ok: true, message: 'Contacts merged' });
    expect(await contactStore.getByChannelIdentity('api', 'source-identity'))
      .toMatchObject({ id: target.id });
    expect((await contactStore.getById(source.id))?.archivedAt).toBeTruthy();
  });

  it('does not expose another contact through fleet list projections', async () => {
    const { contactStore, service, profiles } = await createServiceHarness();
    const current = await contactStore.upsert({ displayName: 'Current Contact' });
    const other = await contactStore.upsert({ displayName: 'Other Contact' });
    for (const contact of [current, other]) {
      profiles.set(contact.id, {
        schemaVersion: 1,
        contactId: contact.id,
        summary: `profile-${contact.id}`,
        sourceMemoryIds: [],
        confidenceScore: 1,
        noveltyScore: 0,
        updatedAt: 1,
        freshUntil: 2,
      });
    }

    const result = await service.listContacts(undefined, fleetContext(current.id));

    expect(result.contacts.map(contact => contact.id)).toEqual([current.id]);
    expect([...result.recentContactShapeMap.keys()]).toEqual([current.id]);
    expect(result.socialGraphMap.size).toBe(0);
    expect(result.verifications).toEqual([]);
    expect(result.mutationAudits).toEqual([]);
  });

  it('surfaces archivedAt on the contact list and detail after archiving (klbgi)', async () => {
    const { contactStore, service } = await createServiceHarness();
    const live = await contactStore.upsert({ displayName: 'Still Here' });
    const gone = await contactStore.upsert({ displayName: 'Archived One' });
    expect(await contactStore.archiveContact(gone.id, 'operator:test')).toBe(true);

    // The admin list response must carry archivedAt so the UI can gray out and
    // filter archived contacts (bead psfn-framework-klbgi).
    const list = await service.listContacts();
    const archivedRow = list.contacts.find(contact => contact.id === gone.id);
    const liveRow = list.contacts.find(contact => contact.id === live.id);
    expect(archivedRow?.archivedAt).toBeTruthy();
    expect(liveRow?.archivedAt).toBeUndefined();

    // The detail response carries it too.
    const detail = await service.getContactDetail(gone.id);
    expect(detail?.contact.archivedAt).toBeTruthy();
  });

  it('returns a fleet profile only on the exact current-subject detail', async () => {
    const { contactStore, service, profiles } = await createServiceHarness();
    const current = await contactStore.upsert({ displayName: 'Current Contact' });
    const other = await contactStore.upsert({ displayName: 'Other Contact' });
    for (const contact of [current, other]) {
      profiles.set(contact.id, {
        schemaVersion: 1,
        contactId: contact.id,
        summary: `profile-${contact.id}`,
        sourceMemoryIds: [],
        confidenceScore: 1,
        noveltyScore: 0,
        updatedAt: 1,
        freshUntil: 2,
      });
    }

    await expect(service.getContactDetail(current.id, fleetContext(current.id)))
      .resolves.toMatchObject({ recentContactShape: { contactId: current.id } });
    await expect(service.getContactDetail(other.id, fleetContext(current.id)))
      .resolves.toBeNull();
  });

  it('deletes a persisted conversation channel from a contact', async () => {
    const { contactStore, service } = await createServiceHarness();
    const contact = await contactStore.upsert({ displayName: 'Primary User' });
    await contactStore.recordChannelActivity(contact.id, 'psfn-amica', 'psfn-amica:test:stale-channel', 'invite_only');
    await contactStore.recordChannelActivity(contact.id, 'psfn-amica', 'psfn-amica:test:active-channel', 'private');

    const result = await service.deleteConversationChannel(
      contact.id,
      JSON.stringify({
        channel: 'psfn-amica',
        channelId: 'psfn-amica:test:stale-channel',
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.contact?.conversationChannels).toEqual([
      expect.objectContaining({
        channel: 'psfn-amica',
        channelId: 'psfn-amica:test:active-channel',
      }),
    ]);
    expect(result.relatedChannels).toEqual([
      expect.objectContaining({
        channel: 'psfn-amica',
        channelId: 'psfn-amica:test:active-channel',
      }),
    ]);
  });

  it('fails closed when the conversation channel is not on the contact', async () => {
    const { contactStore, service } = await createServiceHarness();
    const contact = await contactStore.upsert({ displayName: 'Primary User' });

    const result = await service.deleteConversationChannel(
      contact.id,
      JSON.stringify({
        channel: 'psfn-amica',
        channelId: 'psfn-amica:missing',
      }),
    );

    expect(result).toEqual({
      ok: false,
      message: 'Conversation channel not found on contact',
    });
  });

  it('rejects invalid contact timezone updates without mutating the contact', async () => {
    const { contactStore, service } = await createServiceHarness();
    const contact = await contactStore.upsert({
      displayName: 'Timezone User',
      timezone: 'America/New_York',
    });

    const result = await service.updateContact(contact.id, JSON.stringify({
      timezone: 'Mars/Olympus',
    }));

    expect(result).toEqual({
      ok: false,
      message: 'Invalid timezone: Mars/Olympus. timezone must be a valid IANA timezone name',
    });
    expect((await contactStore.getById(contact.id))?.timezone).toBe('America/New_York');
  });

  it('accepts valid contact timezone updates and clears null timezone', async () => {
    const { contactStore, service } = await createServiceHarness();
    const contact = await contactStore.upsert({ displayName: 'Timezone User' });

    const updated = await service.updateContact(contact.id, JSON.stringify({
      timezone: 'America/Los_Angeles',
    }));

    expect(updated.ok).toBe(true);
    expect(updated.contact?.timezone).toBe('America/Los_Angeles');
    await expect(service.getContactDetail(contact.id)).resolves.toMatchObject({
      contact: expect.objectContaining({
        timezone: 'America/Los_Angeles',
      }),
    });

    const cleared = await service.updateContact(contact.id, JSON.stringify({
      timezone: null,
    }));

    expect(cleared.ok).toBe(true);
    expect(cleared.contact?.timezone).toBeUndefined();
    expect((await contactStore.getById(contact.id))?.timezone).toBeUndefined();
  });

  it('applies channel-bonding opt-in updates per linked identity', async () => {
    const { contactStore, service } = await createServiceHarness();
    const contact = await contactStore.upsert({ displayName: 'Bonded Partner' });
    await contactStore.linkChannelIdentity(contact.id, 'discord', 'bond-user', { privacyLevel: 'private' });

    const bondedResult = await service.updateContact(contact.id, JSON.stringify({
      channelBonding: [{ channel: 'discord', userId: 'bond-user', bonded: true }],
    }));
    expect(bondedResult.ok).toBe(true);
    expect(bondedResult.contact?.channels?.find(link => link.userId === 'bond-user')?.bonded).toBe(true);

    const unbondedResult = await service.updateContact(contact.id, JSON.stringify({
      channelBonding: [{ channel: 'discord', userId: 'bond-user', bonded: false }],
    }));
    expect(unbondedResult.ok).toBe(true);
    expect(unbondedResult.contact?.channels?.find(link => link.userId === 'bond-user')?.bonded).not.toBe(true);
  });

  it('rejects channel-bonding updates for unknown identities and malformed payloads', async () => {
    const { contactStore, service } = await createServiceHarness();
    const contact = await contactStore.upsert({ displayName: 'Bonded Partner' });

    await expect(service.updateContact(contact.id, JSON.stringify({
      channelBonding: [{ channel: 'discord', userId: 'never-linked', bonded: true }],
    }))).resolves.toEqual({ ok: false, message: 'Unable to update bonding for discord:never-linked' });

    await expect(service.updateContact(contact.id, JSON.stringify({
      channelBonding: [{ channel: 'discord', userId: '', bonded: true }],
    }))).resolves.toEqual({ ok: false, message: 'channelBonding entries require channel and userId' });

    await expect(service.updateContact(contact.id, JSON.stringify({
      channelBonding: [{ channel: 'discord', userId: 'x', bonded: 'yes' }],
    }))).resolves.toEqual({ ok: false, message: 'channelBonding.bonded must be a boolean' });
  });

  it('includes social graph inspector data for linked and mention-only contacts', async () => {
    const { contactStore, service, profiles } = await createServiceHarness();
    const owner = await contactStore.upsert({ displayName: 'Owner', trustLevel: 'trusted', relationshipType: 'friend' });
    const friend = await contactStore.upsert({ displayName: 'Friend', trustLevel: 'trusted', relationshipType: 'friend' });
    const sibling = await contactStore.upsert(
      { displayName: 'Sibling', relationshipType: 'family' },
      { actor: 'operator:test-setup' },
    );

    profiles.set(friend.id, {
      schemaVersion: 1,
      contactId: friend.id,
      summary: 'Shows up often in supportive contexts.',
      sourceMemoryIds: ['mem-friend-1'],
      confidenceScore: 0.81,
      noveltyScore: 0.4,
      updatedAt: 1_740_000_000_000,
      freshUntil: 1_740_003_600_000,
    });

    await contactStore.linkChannelIdentity(friend.id, 'discord', 'friend-user', { privacyLevel: 'private' });

    const ownerEntity = await contactStore.getSocialGraphEntityByContactId(owner.id);
    const friendEntity = await contactStore.getSocialGraphEntityByContactId(friend.id);
    const siblingEntity = await contactStore.getSocialGraphEntityByContactId(sibling.id);
    if (!ownerEntity || !friendEntity || !siblingEntity) {
      throw new Error('Postgres contact fixture did not create social graph entities');
    }

    await contactStore.upsertSocialRelationshipEdge({
      sourceEntityId: ownerEntity.id,
      targetEntityId: friendEntity.id,
      relationshipType: 'friend',
      directional: false,
      sensitivity: 'personal',
      provenanceRefs: ['memory:friendship'],
      evidenceMemoryIds: ['mem-friend-1'],
      confidence: 0.91,
    });
    await contactStore.upsertSocialRelationshipEdge({
      sourceEntityId: siblingEntity.id,
      targetEntityId: ownerEntity.id,
      relationshipType: 'sibling',
      directional: true,
      sensitivity: 'private',
      provenanceRefs: ['memory:family'],
      evidenceMemoryIds: ['mem-family-1'],
      confidence: 0.78,
    });

    const result = await service.listContacts();
    const graph = result.socialGraphMap.get(owner.id);

    expect(graph?.entity).toMatchObject({
      id: ownerEntity.id,
      displayName: 'Owner',
      source: 'contact',
    });
    expect(graph?.edgeCount).toBe(2);
    expect(graph?.neighborCount).toBe(2);
    expect(graph?.evidenceCount).toBe(2);
    expect(graph?.mentionOnlyNeighborCount).toBe(1);
    expect(graph?.connections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        relationshipType: 'friend',
        direction: 'undirected',
        evidenceMemoryIds: ['mem-friend-1'],
        neighbor: expect.objectContaining({
          contactId: friend.id,
          mentionOnly: false,
          trustLevel: 'trusted',
          recentContactShapeSummary: 'Shows up often in supportive contexts.',
        }),
      }),
      expect.objectContaining({
        relationshipType: 'sibling',
        // E4.3: sibling is a SYMMETRIC kind — a directional write is
        // normalized to one undirected canonical row.
        direction: 'undirected',
        neighbor: expect.objectContaining({
          contactId: sibling.id,
          mentionOnly: true,
          relationshipType: 'family',
        }),
      }),
    ]));
  });

  it('includes dynamic relationship score display data when a reader is available', async () => {
    let requestedContactIds: readonly string[] = [];
    const { contactStore, service } = await createServiceHarness({
      relationshipScoreReader: {
        async listContactRelationshipScores(contactIds) {
          requestedContactIds = contactIds;
          return new Map(contactIds.map(contactId => [contactId, {
            score: 42.5,
            resolvedTier: 'acquaintance',
            previousTierThreshold: 20,
            nextTier: 'friend',
            nextTierThreshold: 60,
            progressToNextTier: 0.5625,
            updatedAt: '2026-06-29T16:45:00.000Z',
          }]));
        },
      },
    });
    const contact = await contactStore.upsert({ displayName: 'Score Contact', relationshipType: 'acquaintance' });

    const result = await service.listContacts();

    expect(requestedContactIds).toEqual([contact.id]);
    expect(result.relationshipScoreMap?.get(contact.id)).toEqual({
      score: 42.5,
      resolvedTier: 'acquaintance',
      previousTierThreshold: 20,
      nextTier: 'friend',
      nextTierThreshold: 60,
      progressToNextTier: 0.5625,
      updatedAt: '2026-06-29T16:45:00.000Z',
    });
  });

  it('populates relationshipScoreMap from the production score reader (kada.4)', async () => {
    const { contactStore, memoryStore, sessionStore } = await createServiceHarness();
    // A public contact that has cleared every autonomous public→regular drift
    // component: 3 positive valence points above threshold, no negatives, and
    // one verified identity link. This must surface progressToNextTier === 1.
    const contact = await contactStore.upsert({ displayName: 'Score Contact', trustLevel: 'public' });
    const positivePoints: EmotionalTimeSeriesPoint[] = [
      { valence: 0.5, confidence: 0.5, observedAtMs: 1 },
      { valence: 0.4, confidence: 0.6, observedAtMs: 2 },
      { valence: 0.6, confidence: 0.7, observedAtMs: 3 },
    ];
    // Production reader over a fake read store exposing exactly the three
    // methods createContactRelationshipScoreReader depends on.
    const reader = createContactRelationshipScoreReader({
      getById: id => contactStore.getById(id),
      getEmotionalTimeSeries: id => (id === contact.id ? positivePoints : []),
      countVerifiedIdentityLinks: id => (id === contact.id ? 1 : 0),
    });
    const service = new AdminContactsDataService({
      contactStore,
      memoryStore,
      sessionStore,
      relationshipScoreReader: reader,
    });

    const result = await service.listContacts();
    const score = result.relationshipScoreMap?.get(contact.id);

    expect(score).toBeDefined();
    expect(score?.resolvedTier).toBe('public');
    expect(score?.nextTier).toBe('regular');
    expect(score?.progressToNextTier).toBe(1);
  });
});
