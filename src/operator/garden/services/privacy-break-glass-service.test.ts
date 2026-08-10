import { describe, expect, it, vi } from 'vitest';
import type {
  RecentContactShapeArtifact,
  MemoryStorePort,
} from '../../../faculties/memory/memory-store-port.js';
import type { PurrMemory } from '../../../faculties/memory/types.js';
import type { MemorySubjectClassification } from '../../../shared/contracts/memory-subject.js';
import type { ReflectionJournalEntry } from '../../../persistence/journals/reflection-journal.js';
import type { FleetGardenRequestContext } from '../garden-request-context.js';
import { AdminPrivacyBreakGlassService } from './privacy-break-glass-service.js';

const NOW = 1_750_000_000_000;
const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const MEMORY_ID = 'memory-private-b';
const REASON = { reasonCategory: 'safety_intervention' as const, reason: 'Immediate welfare check.' };

function memory(overrides: Partial<PurrMemory> = {}): PurrMemory {
  return {
    id: MEMORY_ID,
    text: 'private content belonging only to contact-b',
    type: 'semantic',
    importance: 0.8,
    confidence: 0.9,
    emotionalValence: 0,
    salience: 0.7,
    sourceRef: 'test:private-b',
    extractedAt: NOW,
    lastAccessed: NOW,
    accessCount: 0,
    tags: ['private'],
    sensitivity: 'private',
    contactId: 'contact-b',
    ...overrides,
  };
}

function classification(
  overrides: Partial<MemorySubjectClassification> = {},
): MemorySubjectClassification {
  return {
    memoryId: MEMORY_ID,
    subjectClass: 'single_contact',
    status: 'current',
    classifierVersion: 1,
    memoryRevision: 1,
    evidenceDigest: 'a'.repeat(64),
    evidence: ['explicit_subject_contact'],
    subjectContactIds: ['contact-b'],
    reasonClass: 'explicit_subject_contact',
    classifiedAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const JOURNAL_AREA_BY_KIND = {
  memory: 'memory',
  profile: 'contacts',
  journal: 'values',
} as const;

function context(input: {
  kind: 'memory' | 'profile' | 'journal';
  phase: 'confirm' | 'decide';
  resourceId: string;
  assurance?: FleetGardenRequestContext['actor']['sessionAssurance'];
  principalId?: string;
  contactId?: string;
  sessionAuthzVersion?: number;
}): FleetGardenRequestContext {
  const assurance = input.assurance ?? (input.phase === 'confirm' ? 'break_glass' : 'oauth');
  const area = JOURNAL_AREA_BY_KIND[input.kind];
  const authorization = {
    action: 'privacy.break_glass' as const,
    baseRole: 'admin' as const,
    resource: { scope: 'personal_workspace' as const, area },
    subjectRelation: 'none' as const,
    requirements: {
      assurance: input.phase === 'confirm' ? 'privacy_break_glass' as const : 'oauth' as const,
      confirmation: 'explicit' as const,
      approvals: [] as const,
    },
    publicAccess: 'never' as const,
    recoveryAccess: 'forbidden' as const,
  };
  const principalId = input.principalId ?? 'principal-a';
  const contactId = input.contactId ?? 'contact-a';
  return {
    kind: 'fleet_principal',
    requestId: input.phase === 'confirm'
      ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      : 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    decisionId: input.phase === 'confirm'
      ? 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
      : 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    authorizationEventId: `event-${input.phase}`,
    resolvedAt: new Date(NOW).toISOString(),
    versions: {
      authorityGeneration: 1,
      globalAuthEpoch: 1,
      sessionAuthnVersion: 1,
      sessionAuthzVersion: input.sessionAuthzVersion ?? 1,
      bindingVersion: 1,
      grantVersion: 1,
      policyVersion: 1,
    },
    issuedAt: Math.floor(NOW / 1_000),
    expiresAt: Math.floor(NOW / 1_000) + 60,
    actor: {
      kind: 'fleet_principal',
      principalId,
      provider: 'discord',
      providerSubjectId: `provider-${principalId}`,
      contactId,
      contactBindingId: `binding-${contactId}`,
      role: 'admin',
      operatorGrantId: `grant-${principalId}`,
      sessionRecordId: `session-${principalId}`,
      sessionAssurance: assurance,
    },
    action: 'privacy.break_glass',
    resource: {
      routeId: `POST /api/admin/privacy-break-glass/${input.kind}/:id/${input.phase}`,
      scope: 'personal_workspace',
      area,
      companionId: COMPANION_ID,
      pathParams: { id: input.resourceId },
      query: {},
    },
    subjectRelation: 'none',
    authorization,
  };
}

function fixture() {
  let currentMemory = memory();
  let currentClassification = classification();
  const profile: RecentContactShapeArtifact = {
    schemaVersion: 1,
    contactId: 'contact-b',
    summary: 'private synthesized profile',
    sourceMemoryIds: [MEMORY_ID],
    confidenceScore: 0.9,
    noveltyScore: 0.3,
    updatedAt: NOW,
    freshUntil: NOW + 60_000,
  };
  const store = {
    getById: vi.fn(async () => currentMemory),
    getMemorySubjectClassification: vi.fn(async () => currentClassification),
    getRecentContactShape: vi.fn(async () => profile),
  } as unknown as Pick<MemoryStorePort,
    'getById' | 'getMemorySubjectClassification' | 'getRecentContactShape'>;
  let journalEntries: ReflectionJournalEntry[] = [{
    id: 'reflection-1',
    templateId: 'musing',
    templateName: 'Musing',
    prompt: 'Free-form reflection prompt.',
    reflection: 'A private companion reflection.',
    channelId: 'discord:heartbeat',
    mode: 'agent',
    createdAt: '2026-03-08T08:00:00.000Z',
  }];
  const listStream = vi.fn((stream: string, limit: number) => {
    if (stream !== 'reflection-journal') return [];
    return journalEntries.slice(0, limit);
  });
  let clock = NOW;
  const service = new AdminPrivacyBreakGlassService({
    memoryStore: store,
    journalReader: { listStream: listStream as never },
    confirmTtlMs: 60_000,
    now: () => clock,
    randomBytes: () => Buffer.alloc(32, 0xab),
  });
  return {
    service,
    listStream,
    advance: (ms: number) => { clock += ms; },
    changeMemory: (value: PurrMemory) => { currentMemory = value; },
    changeClassification: (value: MemorySubjectClassification) => {
      currentClassification = value;
    },
    changeJournal: (value: ReflectionJournalEntry[]) => { journalEntries = value; },
  };
}

describe('AdminPrivacyBreakGlassService', () => {
  it('requires prior UV break-glass authority and discloses one exact non-subject memory', async () => {
    const { service } = fixture();
    const routine = await service.begin({
      resourceKind: 'memory',
      resourceId: MEMORY_ID,
      request: REASON,
      context: context({ kind: 'memory', phase: 'confirm', resourceId: MEMORY_ID, assurance: 'oauth' }),
    });
    expect(routine).toMatchObject({ ok: false, code: 'trusted_uv_authority_required' });

    const begun = await service.begin({
      resourceKind: 'memory',
      resourceId: MEMORY_ID,
      request: REASON,
      context: context({ kind: 'memory', phase: 'confirm', resourceId: MEMORY_ID }),
    });
    expect(begun.ok).toBe(true);
    if (!begun.ok) throw new Error('expected break-glass confirmation');
    expect(begun.confirmToken).toMatch(/^[0-9a-f]{64}$/u);
    expect(begun.audit).toMatchObject({
      assurance: 'escalated',
      resourceKind: 'memory',
      reasonCategory: REASON.reasonCategory,
      confirmationDecisionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    });

    const decided = await service.decide({
      resourceKind: 'memory',
      resourceId: MEMORY_ID,
      request: { ...REASON, confirmToken: begun.confirmToken },
      context: context({ kind: 'memory', phase: 'decide', resourceId: MEMORY_ID }),
    });
    expect(decided).toMatchObject({
      ok: true,
      disclosure: { kind: 'memory', memory: { id: MEMORY_ID, text: memory().text } },
    });
  });

  it('denies an actor who is a subject and exact-profile substitution', async () => {
    const { service } = fixture();
    await expect(service.begin({
      resourceKind: 'memory',
      resourceId: MEMORY_ID,
      request: REASON,
      context: context({
        kind: 'memory', phase: 'confirm', resourceId: MEMORY_ID, contactId: 'contact-b',
      }),
    })).resolves.toMatchObject({ ok: false, code: 'resource_unavailable' });
    await expect(service.begin({
      resourceKind: 'recent_contact_shape',
      resourceId: 'contact-a',
      request: REASON,
      context: context({ kind: 'profile', phase: 'confirm', resourceId: 'contact-a' }),
    })).resolves.toMatchObject({ ok: false, code: 'resource_unavailable' });
  });

  it('consumes confirmation on reason, principal, authority-version, or target substitution', async () => {
    const variants = [
      {
        request: { ...REASON, reason: 'A different reason.' },
        context: context({ kind: 'memory', phase: 'decide', resourceId: MEMORY_ID }),
        resourceId: MEMORY_ID,
      },
      {
        request: REASON,
        context: context({
          kind: 'memory', phase: 'decide', resourceId: MEMORY_ID, principalId: 'principal-x',
        }),
        resourceId: MEMORY_ID,
      },
      {
        request: REASON,
        context: context({
          kind: 'memory', phase: 'decide', resourceId: MEMORY_ID, sessionAuthzVersion: 2,
        }),
        resourceId: MEMORY_ID,
      },
      {
        request: REASON,
        context: context({ kind: 'memory', phase: 'decide', resourceId: MEMORY_ID }),
        resourceId: 'memory-other',
      },
    ];
    for (const variant of variants) {
      const { service } = fixture();
      const begun = await service.begin({
        resourceKind: 'memory', resourceId: MEMORY_ID, request: REASON,
        context: context({ kind: 'memory', phase: 'confirm', resourceId: MEMORY_ID }),
      });
      if (!begun.ok) throw new Error('expected break-glass confirmation');
      const denied = await service.decide({
        resourceKind: 'memory',
        resourceId: variant.resourceId,
        request: { ...variant.request, confirmToken: begun.confirmToken },
        context: variant.context,
      });
      expect(denied.ok).toBe(false);
      const replay = await service.decide({
        resourceKind: 'memory', resourceId: MEMORY_ID,
        request: { ...REASON, confirmToken: begun.confirmToken },
        context: context({ kind: 'memory', phase: 'decide', resourceId: MEMORY_ID }),
      });
      expect(replay).toMatchObject({ ok: false, code: 'confirmation_unavailable' });
    }
  });

  it('permits only one concurrent decision and rejects expiry or changed content/subject scope', async () => {
    const concurrent = fixture();
    const begun = await concurrent.service.begin({
      resourceKind: 'memory', resourceId: MEMORY_ID, request: REASON,
      context: context({ kind: 'memory', phase: 'confirm', resourceId: MEMORY_ID }),
    });
    if (!begun.ok) throw new Error('expected break-glass confirmation');
    const decision = {
      resourceKind: 'memory' as const,
      resourceId: MEMORY_ID,
      request: { ...REASON, confirmToken: begun.confirmToken },
      context: context({ kind: 'memory', phase: 'decide', resourceId: MEMORY_ID }),
    };
    const outcomes = await Promise.all([
      concurrent.service.decide(decision),
      concurrent.service.decide(decision),
    ]);
    expect(outcomes.filter(result => result.ok)).toHaveLength(1);

    const expired = fixture();
    const expiring = await expired.service.begin({
      resourceKind: 'memory', resourceId: MEMORY_ID, request: REASON,
      context: context({ kind: 'memory', phase: 'confirm', resourceId: MEMORY_ID }),
    });
    if (!expiring.ok) throw new Error('expected break-glass confirmation');
    expired.advance(60_000);
    await expect(expired.service.decide({
      ...decision, request: { ...REASON, confirmToken: expiring.confirmToken },
    })).resolves.toMatchObject({ ok: false, code: 'confirmation_expired' });

    const changed = fixture();
    const stale = await changed.service.begin({
      resourceKind: 'memory', resourceId: MEMORY_ID, request: REASON,
      context: context({ kind: 'memory', phase: 'confirm', resourceId: MEMORY_ID }),
    });
    if (!stale.ok) throw new Error('expected break-glass confirmation');
    changed.changeClassification(classification({ subjectContactIds: ['contact-c'], updatedAt: NOW + 1 }));
    await expect(changed.service.decide({
      ...decision, request: { ...REASON, confirmToken: stale.confirmToken },
    })).resolves.toMatchObject({ ok: false, code: 'resource_changed' });

    const changedContent = fixture();
    const contentSnapshot = await changedContent.service.begin({
      resourceKind: 'memory', resourceId: MEMORY_ID, request: REASON,
      context: context({ kind: 'memory', phase: 'confirm', resourceId: MEMORY_ID }),
    });
    if (!contentSnapshot.ok) throw new Error('expected break-glass confirmation');
    changedContent.changeMemory(memory({ text: 'content changed after confirmation' }));
    await expect(changedContent.service.decide({
      ...decision, request: { ...REASON, confirmToken: contentSnapshot.confirmToken },
    })).resolves.toMatchObject({ ok: false, code: 'resource_changed' });
  });

  it('discloses one exact companion-private journal window under the same two-step binding', async () => {
    const { service, listStream } = fixture();
    const routine = await service.begin({
      resourceKind: 'journal',
      resourceId: 'reflection-journal',
      request: REASON,
      context: context({
        kind: 'journal', phase: 'confirm', resourceId: 'reflection-journal', assurance: 'oauth',
      }),
    });
    expect(routine).toMatchObject({ ok: false, code: 'trusted_uv_authority_required' });

    const begun = await service.begin({
      resourceKind: 'journal',
      resourceId: 'reflection-journal',
      request: REASON,
      context: context({ kind: 'journal', phase: 'confirm', resourceId: 'reflection-journal' }),
    });
    expect(begun.ok).toBe(true);
    if (!begun.ok) throw new Error('expected journal confirmation');
    expect(begun.audit).toMatchObject({ assurance: 'escalated', resourceKind: 'journal' });
    expect(listStream).toHaveBeenCalledWith('reflection-journal', 250);

    const decided = await service.decide({
      resourceKind: 'journal',
      resourceId: 'reflection-journal',
      request: { ...REASON, confirmToken: begun.confirmToken },
      context: context({ kind: 'journal', phase: 'decide', resourceId: 'reflection-journal' }),
    });
    expect(decided).toMatchObject({
      ok: true,
      disclosure: {
        kind: 'journal',
        journal: { stream: 'reflection-journal', entries: [{ id: 'reflection-1' }] },
      },
    });
    await expect(service.decide({
      resourceKind: 'journal',
      resourceId: 'reflection-journal',
      request: { ...REASON, confirmToken: begun.confirmToken },
      context: context({ kind: 'journal', phase: 'decide', resourceId: 'reflection-journal' }),
    })).resolves.toMatchObject({ ok: false, code: 'confirmation_unavailable' });
  });

  it('consumes a journal confirmation on principal or stream substitution and on expiry', async () => {
    for (const substitution of [
      {
        resourceId: 'reflection-journal',
        context: context({
          kind: 'journal', phase: 'decide', resourceId: 'reflection-journal',
          principalId: 'principal-x',
        }),
      },
      {
        resourceId: 'reflection-daily',
        context: context({ kind: 'journal', phase: 'decide', resourceId: 'reflection-daily' }),
      },
    ]) {
      const current = fixture();
      const begun = await current.service.begin({
        resourceKind: 'journal', resourceId: 'reflection-journal', request: REASON,
        context: context({ kind: 'journal', phase: 'confirm', resourceId: 'reflection-journal' }),
      });
      if (!begun.ok) throw new Error('expected journal confirmation');
      await expect(current.service.decide({
        resourceKind: 'journal', resourceId: substitution.resourceId,
        request: { ...REASON, confirmToken: begun.confirmToken },
        context: substitution.context,
      })).resolves.toMatchObject({ ok: false, code: 'confirmation_binding_changed' });
      await expect(current.service.decide({
        resourceKind: 'journal', resourceId: 'reflection-journal',
        request: { ...REASON, confirmToken: begun.confirmToken },
        context: context({ kind: 'journal', phase: 'decide', resourceId: 'reflection-journal' }),
      })).resolves.toMatchObject({ ok: false, code: 'confirmation_unavailable' });
    }

    const expired = fixture();
    const begun = await expired.service.begin({
      resourceKind: 'journal', resourceId: 'reflection-journal', request: REASON,
      context: context({ kind: 'journal', phase: 'confirm', resourceId: 'reflection-journal' }),
    });
    if (!begun.ok) throw new Error('expected journal confirmation');
    expired.advance(60_000);
    await expect(expired.service.decide({
      resourceKind: 'journal', resourceId: 'reflection-journal',
      request: { ...REASON, confirmToken: begun.confirmToken },
      context: context({ kind: 'journal', phase: 'decide', resourceId: 'reflection-journal' }),
    })).resolves.toMatchObject({ ok: false, code: 'confirmation_expired' });
  });

  it('treats an unknown journal stream selector as unavailable', async () => {
    const { service } = fixture();
    await expect(service.begin({
      resourceKind: 'journal',
      resourceId: 'not-a-journal',
      request: REASON,
      context: context({ kind: 'journal', phase: 'confirm', resourceId: 'not-a-journal' }),
    })).resolves.toMatchObject({ ok: false, code: 'resource_unavailable' });
  });

  it('consumes a journal confirmation when the disclosed window changes before decision', async () => {
    const changed = fixture();
    const begun = await changed.service.begin({
      resourceKind: 'journal',
      resourceId: 'reflection-journal',
      request: REASON,
      context: context({ kind: 'journal', phase: 'confirm', resourceId: 'reflection-journal' }),
    });
    if (!begun.ok) throw new Error('expected journal confirmation');
    changed.changeJournal([{
      id: 'reflection-2',
      templateId: 'musing',
      templateName: 'Musing',
      prompt: 'A newer reflection prompt.',
      reflection: 'A newer private companion reflection.',
      channelId: 'discord:heartbeat',
      mode: 'agent',
      createdAt: '2026-03-09T08:00:00.000Z',
    }]);
    await expect(changed.service.decide({
      resourceKind: 'journal',
      resourceId: 'reflection-journal',
      request: { ...REASON, confirmToken: begun.confirmToken },
      context: context({ kind: 'journal', phase: 'decide', resourceId: 'reflection-journal' }),
    })).resolves.toMatchObject({ ok: false, code: 'resource_changed' });
  });

  it('supports the same exact two-step binding for a non-actor profile', async () => {
    const { service } = fixture();
    const begun = await service.begin({
      resourceKind: 'recent_contact_shape', resourceId: 'contact-b', request: REASON,
      context: context({ kind: 'profile', phase: 'confirm', resourceId: 'contact-b' }),
    });
    if (!begun.ok) throw new Error('expected profile confirmation');
    await expect(service.decide({
      resourceKind: 'recent_contact_shape', resourceId: 'contact-b',
      request: { ...REASON, confirmToken: begun.confirmToken },
      context: context({ kind: 'profile', phase: 'decide', resourceId: 'contact-b' }),
    })).resolves.toMatchObject({
      ok: true,
      disclosure: {
        kind: 'recent_contact_shape',
        recentContactShape: { contactId: 'contact-b' },
      },
    });
  });
});
