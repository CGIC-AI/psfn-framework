import { describe, expect, it, vi } from 'vitest';
import type { PurrMemory } from '../types.js';
import type { ProfileSynthesisConfig } from './types.js';
import {
  refreshContactProfile,
  type RefreshContactProfileOptions,
} from './profile-synthesis.js';

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
    sourceRef: 'test',
    extractedAt: 1,
    lastAccessed: 1,
    accessCount: 0,
    tags: [],
    sensitivity: 'personal',
    contactId,
  };
}

function options(
  overrides: Partial<RefreshContactProfileOptions> = {},
): RefreshContactProfileOptions {
  const llmClient = {
    complete: vi.fn().mockResolvedValue({
      content: '<profile><summary>Briar prefers concise launch notes.</summary></profile>',
    }),
  };
  const memoryStore = {
    getContactProfile: vi.fn().mockResolvedValue(undefined),
    getMemoriesByContact: vi.fn().mockResolvedValue([
      memory('mem-briar-1', 'Briar prefers concise launch notes.'),
      memory('mem-briar-2', 'Briar likes checklist summaries.'),
    ]),
    upsertContactProfile: vi.fn().mockResolvedValue(undefined),
  };

  return {
    llmClient: llmClient as RefreshContactProfileOptions['llmClient'],
    promptRegistry: null,
    memoryStore: memoryStore as unknown as RefreshContactProfileOptions['memoryStore'],
    channelId: 'discord:kube',
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

describe('refreshContactProfile', () => {
  it('returns a structured skip reason for insufficient target source memories', async () => {
    const memoryStore = {
      getContactProfile: vi.fn().mockResolvedValue(undefined),
      getMemoriesByContact: vi.fn().mockResolvedValue([
        memory('mem-briar-1', 'Briar prefers concise launch notes.'),
      ]),
      upsertContactProfile: vi.fn(),
    };
    const llmClient = {
      complete: vi.fn(),
    };

    const result = await refreshContactProfile(options({
      llmClient: llmClient as RefreshContactProfileOptions['llmClient'],
      memoryStore: memoryStore as unknown as RefreshContactProfileOptions['memoryStore'],
    }));

    expect(result).toEqual({
      status: 'skipped',
      reason: 'insufficient_source_memories',
      sourceMemoryCount: 1,
    });
    expect(llmClient.complete).not.toHaveBeenCalled();
    expect(memoryStore.upsertContactProfile).not.toHaveBeenCalled();
  });

  it('returns a structured skip reason when cooldown blocks an otherwise meaningful update', async () => {
    const memoryStore = {
      getContactProfile: vi.fn().mockResolvedValue({
        contactId: 'contact-briar',
        summary: 'Briar prefers concise launch notes.',
        sourceMemoryIds: ['mem-briar-1'],
        confidenceScore: 0.9,
        noveltyScore: 0.8,
        updatedAt: Date.now(),
      }),
      getMemoriesByContact: vi.fn(),
      upsertContactProfile: vi.fn(),
    };
    const llmClient = {
      complete: vi.fn(),
    };

    const result = await refreshContactProfile(options({
      llmClient: llmClient as RefreshContactProfileOptions['llmClient'],
      memoryStore: memoryStore as unknown as RefreshContactProfileOptions['memoryStore'],
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
          content: '<profile><summary>Briar prefers concise launch notes.</summary></profile>',
        };
      }),
    };
    const memoryStore = {
      getContactProfile: vi.fn().mockResolvedValue(undefined),
      getMemoriesByContact: vi.fn().mockResolvedValue([
        memory('mem-briar-1', 'Briar prefers concise launch notes.'),
        memory('mem-aster-1', 'Aster prefers verbose launch notes.', 'contact-aster'),
        memory('mem-briar-2', 'Briar likes checklist summaries.'),
      ]),
      upsertContactProfile: vi.fn().mockResolvedValue(undefined),
    };

    const result = await refreshContactProfile(options({
      llmClient: llmClient as RefreshContactProfileOptions['llmClient'],
      memoryStore: memoryStore as unknown as RefreshContactProfileOptions['memoryStore'],
    }));

    expect(result).toMatchObject({
      status: 'refreshed',
      sourceMemoryCount: 2,
    });
    expect(renderedPrompt).toContain('Briar prefers concise launch notes.');
    expect(renderedPrompt).toContain('Briar likes checklist summaries.');
    expect(renderedPrompt).not.toContain('Aster prefers verbose launch notes.');
    expect(memoryStore.upsertContactProfile).toHaveBeenCalledWith(expect.objectContaining({
      contactId: 'contact-briar',
      sourceMemoryIds: ['mem-briar-1', 'mem-briar-2'],
    }));
  });
});
