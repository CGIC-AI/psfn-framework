import { describe, expect, it, vi } from 'vitest';
import { createDefaultBiographicalDepthPolicy } from '../../../system/config/biographical-depth-policy.js';
import { InMemoryBiographicalProfileStore } from '../biographical/in-memory-store.js';
import { classifyMemorySubject } from '../subject-classification.js';
import type { PurrMemory } from '../types.js';
import type { ProfileSynthesisConfig } from './types.js';
import {
  refreshRecentContactShape,
  type RefreshRecentContactShapeOptions,
} from './recent-contact-shape-synthesis.js';

const baseConfig: ProfileSynthesisConfig = {
  enabled: true,
  refreshIntervalMs: 60 * 60 * 1000,
  cooldownMs: 10 * 60 * 1000,
  minWrites: 1,
  minImportance: 0.65,
  minConfidence: 0.7,
  minNovelty: 0.1,
  sourceMemoryLimit: 16,
  minSourceMemories: 2,
};

function memory(
  id: string,
  text: string,
  contactId = 'contact-briar',
  confidence = 0.9,
): PurrMemory {
  return {
    id,
    text,
    type: 'semantic',
    importance: 0.85,
    emotionalValence: 0,
    confidence,
    salience: 0.82,
    sourceRef: `memory:${id}`,
    sourceType: 'conversation',
    extractedAt: 1,
    lastAccessed: 1,
    accessCount: 0,
    tags: [],
    sensitivity: 'personal',
    consentFlags: { allowRecall: true },
    contactId,
    provenance: { channelId: 'discord:kube', subjectContactId: contactId },
  };
}

function options(
  overrides: Partial<RefreshRecentContactShapeOptions> = {},
): RefreshRecentContactShapeOptions {
  const llmClient = {
    complete: vi.fn().mockResolvedValue({
      content: '<recent_contact_shape><summary>Briar prefers concise launch notes.</summary></recent_contact_shape>',
    }),
  };
  const memoryStore = {
    getRecentContactShape: vi.fn().mockResolvedValue(undefined),
    getMemoriesByContact: vi.fn().mockResolvedValue([
      memory('mem-briar-1', 'Briar prefers concise launch notes.'),
      memory('mem-briar-2', 'Briar likes checklist summaries.'),
    ]),
    upsertRecentContactShape: vi.fn().mockResolvedValue(undefined),
  };

  return {
    llmClient: llmClient as RefreshRecentContactShapeOptions['llmClient'],
    promptRegistry: null,
    memoryStore: memoryStore as unknown as RefreshRecentContactShapeOptions['memoryStore'],
    channelId: 'discord:kube',
    sourceSessionId: 'discord:kube',
    triggerReason: 'manual',
    canonicalContactId: 'contact-briar',
    targetContact: {
      id: 'contact-briar',
      displayName: 'Briar',
      trustLevel: 'regular',
      relationshipType: 'friend',
    },
    acceptedWrites: [
      {
        memoryId: 'mem-briar-1',
        importance: 0.9,
        confidence: 0.95,
        contactId: 'contact-briar',
      },
    ],
    config: baseConfig,
    telemetryEnabled: true,
    ...overrides,
  };
}

describe('refreshRecentContactShape', () => {
  it('rejects testing-session profile synthesis before reads, model calls, or writes', async () => {
    const memoryStore = {
      getRecentContactShape: vi.fn(),
      getMemoriesByContact: vi.fn(),
      upsertRecentContactShape: vi.fn(),
    };
    const llmClient = {
      complete: vi.fn(),
    };

    const result = await refreshRecentContactShape(options({
      sourceSessionId: 'api:testing:profile-persistence',
      llmClient: llmClient as RefreshRecentContactShapeOptions['llmClient'],
      memoryStore: memoryStore as unknown as RefreshRecentContactShapeOptions['memoryStore'],
    }));

    expect(result).toEqual({
      status: 'skipped',
      reason: 'testing_session',
    });
    expect(memoryStore.getRecentContactShape).not.toHaveBeenCalled();
    expect(memoryStore.getMemoriesByContact).not.toHaveBeenCalled();
    expect(llmClient.complete).not.toHaveBeenCalled();
    expect(memoryStore.upsertRecentContactShape).not.toHaveBeenCalled();
  });

  it('returns a structured skip reason for insufficient target source memories', async () => {
    const memoryStore = {
      getRecentContactShape: vi.fn().mockResolvedValue(undefined),
      getMemoriesByContact: vi.fn().mockResolvedValue([
        memory('mem-briar-1', 'Briar prefers concise launch notes.'),
      ]),
      upsertRecentContactShape: vi.fn(),
    };
    const llmClient = {
      complete: vi.fn(),
    };

    const result = await refreshRecentContactShape(options({
      llmClient: llmClient as RefreshRecentContactShapeOptions['llmClient'],
      memoryStore: memoryStore as unknown as RefreshRecentContactShapeOptions['memoryStore'],
    }));

    expect(result).toEqual({
      status: 'skipped',
      reason: 'insufficient_source_memories',
      sourceMemoryCount: 1,
    });
    expect(llmClient.complete).not.toHaveBeenCalled();
    expect(memoryStore.upsertRecentContactShape).not.toHaveBeenCalled();
  });

  it('returns a structured skip reason when cooldown blocks an otherwise meaningful update', async () => {
    const memoryStore = {
      getRecentContactShape: vi.fn().mockResolvedValue({
        contactId: 'contact-briar',
        summary: 'Briar prefers concise launch notes.',
        sourceMemoryIds: ['mem-briar-1'],
        confidenceScore: 0.9,
        noveltyScore: 0.8,
        updatedAt: Date.now(),
      }),
      getMemoriesByContact: vi.fn(),
      upsertRecentContactShape: vi.fn(),
    };
    const llmClient = {
      complete: vi.fn(),
    };

    const result = await refreshRecentContactShape(options({
      llmClient: llmClient as RefreshRecentContactShapeOptions['llmClient'],
      memoryStore: memoryStore as unknown as RefreshRecentContactShapeOptions['memoryStore'],
    }));

    expect(result).toEqual({
      status: 'skipped',
      reason: 'cooldown',
      writeCount: 1,
    });
    expect(memoryStore.getMemoriesByContact).not.toHaveBeenCalled();
    expect(llmClient.complete).not.toHaveBeenCalled();
  });

  it('filters non-target contact memories out of profile synthesis inputs', async () => {
    let renderedPrompt = '';
    const llmClient = {
      complete: vi.fn().mockImplementation(async (context: { systemPrompt: string }) => {
        renderedPrompt = context.systemPrompt;
        return {
          content: '<recent_contact_shape><summary>Briar prefers concise launch notes.</summary></recent_contact_shape>',
        };
      }),
    };
    const memoryStore = {
      getRecentContactShape: vi.fn().mockResolvedValue(undefined),
      getMemoriesByContact: vi.fn().mockResolvedValue([
        memory('mem-briar-1', 'Briar prefers concise launch notes.'),
        memory('mem-aster-1', 'Aster prefers verbose launch notes.', 'contact-aster'),
        memory('mem-briar-2', 'Briar likes checklist summaries.'),
      ]),
      upsertRecentContactShape: vi.fn().mockResolvedValue(undefined),
    };

    const result = await refreshRecentContactShape(options({
      llmClient: llmClient as RefreshRecentContactShapeOptions['llmClient'],
      memoryStore: memoryStore as unknown as RefreshRecentContactShapeOptions['memoryStore'],
    }));

    expect(result).toMatchObject({
      status: 'refreshed',
      sourceMemoryCount: 2,
    });
    expect(renderedPrompt).toContain('Briar prefers concise launch notes.');
    expect(renderedPrompt).toContain('Briar likes checklist summaries.');
    expect(renderedPrompt).not.toContain('Aster prefers verbose launch notes.');
    expect(memoryStore.upsertRecentContactShape).toHaveBeenCalledWith(expect.objectContaining({
      schemaVersion: 1,
      contactId: 'contact-briar',
      sourceMemoryIds: ['mem-briar-1', 'mem-briar-2'],
      freshUntil: expect.any(Number),
    }));
  });

  it('rebuilds structured biography claims from exact live sources in the same synthesis call', async () => {
    const sourceRows = [
      memory('mem-briar-1', 'Briar explicitly prefers concise launch notes.'),
      memory('mem-briar-2', 'Briar likes checklist summaries.'),
    ];
    const byId = new Map(sourceRows.map(row => [row.id, row]));
    const llmClient = {
      complete: vi.fn().mockResolvedValue({
        content: `<recent_contact_shape><summary>Briar has recently preferred concise launch planning.</summary></recent_contact_shape>
<biographical_candidates>${JSON.stringify([{
          kind: 'stable-preference',
          value: {
            kind: 'stable-preference',
            schemaVersion: 1,
            domain: 'communication',
            target: 'concise launch notes',
            polarity: 'prefers',
          },
          basis: 'explicit',
          confidence: 0.95,
          sourceMemoryIds: ['mem-briar-1'],
        }])}</biographical_candidates>`,
      }),
    };
    const memoryStore = {
      getRecentContactShape: vi.fn().mockResolvedValue(undefined),
      getMemoriesByContact: vi.fn().mockResolvedValue(sourceRows),
      getById: vi.fn(async (id: string) => byId.get(id)),
      getMemorySubjectClassification: vi.fn(async (id: string) => {
        const row = byId.get(id);
        return row
          ? classifyMemorySubject(row, {
              memoryRevision: 1,
              validSubjectContactIds: new Set(['contact-briar']),
            })
          : undefined;
      }),
      upsertRecentContactShape: vi.fn().mockResolvedValue(undefined),
    };
    const profileStore = new InMemoryBiographicalProfileStore();

    const result = await refreshRecentContactShape(options({
      llmClient: llmClient as RefreshRecentContactShapeOptions['llmClient'],
      memoryStore: memoryStore as unknown as RefreshRecentContactShapeOptions['memoryStore'],
      biographicalRebuild: {
        profileStore,
        companionSubject: {
          kind: 'companion', companionId: 'purrsephone', subjectVersion: 1,
        },
        policy: createDefaultBiographicalDepthPolicy(),
        depth: 'developing',
      },
    }));

    expect(result).toMatchObject({
      status: 'refreshed',
      biographicalCandidateCount: 1,
      biographicalAdmittedCount: 1,
      biographicalWithheldCount: 0,
    });
    await expect(profileStore.listClaims({ status: 'active' })).resolves.toMatchObject([{
      subject: { kind: 'contact', contactId: 'contact-briar', subjectVersion: 1 },
      kind: 'stable-preference',
      sources: [{ ref: 'memory:mem-briar-1' }],
    }]);
  });

  it('admits an eligible durable claim even when the independent shape is not novel', async () => {
    const sourceRows = [
      memory('mem-briar-1', 'Briar explicitly prefers concise launch notes.'),
      memory('mem-briar-2', 'Briar likes checklist summaries.'),
    ];
    const byId = new Map(sourceRows.map(row => [row.id, row]));
    const unchangedSummary = 'Briar prefers concise launch notes.';
    const llmClient = {
      complete: vi.fn().mockResolvedValue({
        content: `<recent_contact_shape><summary>${unchangedSummary}</summary></recent_contact_shape>
<biographical_candidates>${JSON.stringify([{
          kind: 'stable-preference',
          value: {
            kind: 'stable-preference',
            schemaVersion: 1,
            domain: 'communication',
            target: 'concise launch notes',
            polarity: 'prefers',
          },
          basis: 'explicit',
          confidence: 0.95,
          sourceMemoryIds: ['mem-briar-1'],
        }])}</biographical_candidates>`,
      }),
    };
    const memoryStore = {
      getRecentContactShape: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        contactId: 'contact-briar',
        summary: unchangedSummary,
        sourceMemoryIds: sourceRows.map(row => row.id),
        confidenceScore: 0.9,
        noveltyScore: 0.5,
        updatedAt: Date.now() - (2 * baseConfig.refreshIntervalMs),
        freshUntil: Date.now() - baseConfig.refreshIntervalMs,
      }),
      getMemoriesByContact: vi.fn().mockResolvedValue(sourceRows),
      getById: vi.fn(async (id: string) => byId.get(id)),
      getMemorySubjectClassification: vi.fn(async (id: string) => {
        const row = byId.get(id);
        return row
          ? classifyMemorySubject(row, {
              memoryRevision: 1,
              validSubjectContactIds: new Set(['contact-briar']),
            })
          : undefined;
      }),
      upsertRecentContactShape: vi.fn().mockResolvedValue(undefined),
    };
    const profileStore = new InMemoryBiographicalProfileStore();

    const result = await refreshRecentContactShape(options({
      llmClient: llmClient as RefreshRecentContactShapeOptions['llmClient'],
      memoryStore: memoryStore as unknown as RefreshRecentContactShapeOptions['memoryStore'],
      biographicalRebuild: {
        profileStore,
        companionSubject: {
          kind: 'companion', companionId: 'purrsephone', subjectVersion: 1,
        },
        policy: createDefaultBiographicalDepthPolicy(),
        depth: 'developing',
      },
    }));

    expect(result).toMatchObject({
      status: 'skipped',
      reason: 'low_novelty',
      biographicalCandidateCount: 1,
      biographicalAdmittedCount: 1,
      biographicalWithheldCount: 0,
    });
    expect(memoryStore.upsertRecentContactShape).not.toHaveBeenCalled();
    await expect(profileStore.listClaims({ status: 'active' })).resolves.toHaveLength(1);
  });
});
