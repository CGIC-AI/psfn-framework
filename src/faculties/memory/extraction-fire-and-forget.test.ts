import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  logDebug: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  persistEmotionalStateFromExtraction: vi.fn(),
}));

vi.mock('../../shared/logger.js', () => ({
  createComponentLogger: () => ({
    debug: mocks.logDebug,
    error: mocks.logError,
    info: mocks.logInfo,
    warn: mocks.logWarn,
  }),
}));

vi.mock('./extraction/emotional.js', () => ({
  persistEmotionalStateFromExtraction: mocks.persistEmotionalStateFromExtraction,
}));

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('MemoryExtractor fire-and-forget handling', () => {
  it('logs rejected emotional-state persistence without failing extraction', async () => {
    mocks.persistEmotionalStateFromExtraction.mockRejectedValueOnce(
      new Error('emotional persistence offline'),
    );
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const { MemoryExtractor } = await import('./extraction.js');
      const channelId = 'api:emotional-fire-and-forget';
      const canonicalContactId = 'contact-emotional';
      const llmClient = {
        complete: vi.fn().mockResolvedValue({
          content: `<response>
<fact>
<text>User felt relieved after finishing the launch plan</text>
<type>emotional</type>
<importance>0.9</importance>
<emotional_valence>0.7</emotional_valence>
<confidence>0.95</confidence>
<tags>feelings,launch</tags>
</fact>
</response>`,
        }),
      };
      const sessionManager = {
        characterName: 'Purrsephone',
        getRecentMessages: vi.fn().mockReturnValue([
          {
            id: 1,
            channelId,
            role: 'user',
            content: 'I feel relieved after finishing the launch plan.',
            authorName: 'Ada',
            timestamp: 1_000,
          },
          {
            id: 2,
            channelId,
            role: 'assistant',
            content: 'That sounds like a meaningful milestone.',
            authorName: 'Purrsephone',
            timestamp: 1_001,
          },
        ]),
      };
      const memoryStore = {
        getMemoriesByChannel: vi.fn().mockReturnValue([]),
      };
      const embeddingService = {
        dims: 8,
        embed: vi.fn().mockResolvedValue(new Float32Array(8)),
        embedBatch: vi.fn(),
      };
      const telemetry = {
        emit: vi.fn().mockResolvedValue(undefined),
      };
      const extractor = new MemoryExtractor(
        llmClient as never,
        sessionManager as never,
        memoryStore as never,
        embeddingService as never,
        telemetry as never,
        {
          primaryModel: 'test-model',
          primaryProvider: 'test-provider',
          extractionModel: 'test-model',
          extractionProvider: 'test-provider',
          extractionInterval: 5,
          memoryExtractionMinImportance: 0.2,
          memoryExtractionMinConfidence: 0.2,
          memoryExtractionMinNovelty: 0,
          memoryExtractionMaxWrites: 5,
          memoryExtractionTelemetryEnabled: true,
          capabilityTier: 'standard',
          compositionalPolicy: {
            enabled: false,
            allowedTiers: [],
            allowedChannelTypes: [],
            allowedPurposes: [],
          },
          profileSynthesisEnabled: false,
        } as never,
      );
      (extractor as any).processFact = vi.fn(async () => ({
        action: 'created',
        memory: { id: 'memory-emotional' },
      }));

      await expect(extractor.extract(channelId, canonicalContactId)).resolves.toBeUndefined();
      await Promise.resolve();

      expect(mocks.persistEmotionalStateFromExtraction).toHaveBeenCalledWith(expect.objectContaining({
        canonicalContactId,
        acceptedFacts: [
          expect.objectContaining({
            text: 'Ada felt relieved after finishing the launch plan',
            type: 'emotional',
          }),
        ],
      }));
      expect(mocks.logWarn).toHaveBeenCalledWith('Failed to persist emotional state from extraction', {
        canonicalContactId,
        acceptedFactCount: 1,
        recentEntryCount: 2,
        error: 'emotional persistence offline',
      });
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });
});
