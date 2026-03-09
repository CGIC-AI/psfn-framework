import { describe, expect, it, vi } from 'vitest';
import {
  ExtractionIntegrityError,
  runExtractionOrchestration,
  type ExtractionRunOptions,
} from './orchestrator.js';

function buildOptions(overrides: Partial<ExtractionRunOptions> = {}): ExtractionRunOptions {
  const recoveredEntries = [
    {
      id: 1,
      channelId: 'api:test',
      role: 'user',
      content: 'I really enjoy board games.',
      authorName: 'user',
      timestamp: 1,
    },
  ];

  return {
    channelId: 'api:test',
    triggerReason: 'manual',
    recoveredEntries: recoveredEntries as ExtractionRunOptions['recoveredEntries'],
    llmClient: {
      complete: vi.fn().mockResolvedValue({
        content: `<response>
<fact>
<text>User enjoys board games</text>
<type>semantic</type>
<importance>0.9</importance>
<confidence>0.95</confidence>
</fact>
</response>`,
      }),
    } as ExtractionRunOptions['llmClient'],
    sessionManager: {
      getRecentMessages: vi.fn().mockReturnValue(recoveredEntries),
    } as ExtractionRunOptions['sessionManager'],
    memoryStore: {
      getMemoriesByChannel: vi.fn().mockReturnValue([]),
    } as ExtractionRunOptions['memoryStore'],
    promptRegistry: null,
    gateConfig: {
      minImportance: 0,
      minConfidence: 0,
      minNovelty: 0,
    },
    maxWrites: 3,
    telemetryEnabled: true,
    useCompositionalExtraction: false,
    isAcceptingExtractions: () => true,
    processFact: vi.fn().mockResolvedValue({
      action: 'created',
      memory: { id: 'mem-1' },
    }),
    emitExtractionStart: vi.fn().mockResolvedValue(undefined),
    emitExtractionEnd: vi.fn().mockResolvedValue(undefined),
    resolveCoveredUpToMessageId: vi.fn().mockReturnValue(1),
    recordExtractionMarker: vi.fn(),
    maybePersistEmotionalState: vi.fn(),
    maybeRefreshContactProfile: vi.fn(),
    ...overrides,
  };
}

describe('runExtractionOrchestration fail-closed errors', () => {
  it('surfaces fact write failures with structured context instead of continuing', async () => {
    const processFactFailure = new Error('simulated write failure');
    const options = buildOptions({
      processFact: vi.fn().mockRejectedValue(processFactFailure),
    });

    const runPromise = runExtractionOrchestration(options);
    await expect(runPromise).rejects.toBeInstanceOf(ExtractionIntegrityError);
    await expect(runPromise).rejects.toMatchObject({
      context: {
        stage: 'fact_processing',
        channelId: 'api:test',
        triggerReason: 'manual',
        factIndex: 0,
        factType: 'semantic',
      },
      cause: processFactFailure,
    });
    expect(options.emitExtractionEnd).not.toHaveBeenCalled();
  });

  it('surfaces orchestration failures with structured context instead of swallowing', async () => {
    const llmFailure = new Error('simulated llm failure');
    const options = buildOptions({
      llmClient: {
        complete: vi.fn().mockRejectedValue(llmFailure),
      } as ExtractionRunOptions['llmClient'],
    });

    const runPromise = runExtractionOrchestration(options);
    await expect(runPromise).rejects.toBeInstanceOf(ExtractionIntegrityError);
    await expect(runPromise).rejects.toMatchObject({
      context: {
        stage: 'orchestration',
        channelId: 'api:test',
        triggerReason: 'manual',
      },
      cause: llmFailure,
    });
    expect(options.emitExtractionEnd).not.toHaveBeenCalled();
  });
});
