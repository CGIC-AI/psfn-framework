import { describe, expect, it, vi } from 'vitest';
import {
  ExtractionIntegrityError,
  runExtractionOrchestration,
  type ExtractionRunOptions,
} from './orchestrator.js';
import type { ExtractionSourceSpeaker } from './speaker-routing.js';
import { MemoryWritePolicyError } from '../writer.js';

function buildOptions(overrides: Partial<ExtractionRunOptions> = {}): ExtractionRunOptions {
  const recoveredEntries = [
    {
      id: 1,
      channelId: 'api:test',
      role: 'user',
      content: 'I really enjoy board games.',
      authorName: 'Alex',
      timestamp: 1,
    },
    {
      id: 2,
      channelId: 'api:test',
      role: 'assistant',
      content: 'I love hearing that.',
      timestamp: 2,
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
      characterName: 'Lyra',
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
    resolveCoveredUpToMessageId: vi.fn().mockReturnValue(2),
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

  it('skips memory write policy rejections without aborting the extraction run', async () => {
    const policyFailure = new MemoryWritePolicyError({
      reason: 'novelty_below_threshold',
      sensitivity: 'intimate',
      salience: 0.8,
      novelty: 0.17,
      minSalience: 0.6,
      minNovelty: 0.18,
    });
    const processFact = vi.fn()
      .mockRejectedValueOnce(policyFailure)
      .mockResolvedValueOnce({
        action: 'created',
        memory: { id: 'mem-2' },
      });
    const options = buildOptions({
      llmClient: {
        complete: vi.fn().mockResolvedValue({
          content: `<response>
<fact>
<text>User prefers quiet evening check-ins</text>
<type>relational</type>
<importance>0.9</importance>
<confidence>0.95</confidence>
</fact>
<fact>
<text>User enjoys board games</text>
<type>semantic</type>
<importance>0.8</importance>
<confidence>0.9</confidence>
</fact>
</response>`,
        }),
      } as ExtractionRunOptions['llmClient'],
      processFact,
    });

    await expect(runExtractionOrchestration(options)).resolves.toBeUndefined();

    expect(processFact).toHaveBeenCalledTimes(2);
    expect(options.recordExtractionMarker).toHaveBeenCalledWith('api:test', 2);
    expect(options.emitExtractionEnd).toHaveBeenCalledWith(expect.objectContaining({
      acceptedCount: 1,
      rejectedCount: 1,
      writeCount: 1,
      rejectionBreakdown: expect.objectContaining({
        low_novelty: 1,
      }),
    }));
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

describe('runExtractionOrchestration naming fidelity', () => {
  it('feeds resolved names into extraction and normalizes generic fact text before writes', async () => {
    const llmClient = {
      complete: vi.fn().mockResolvedValue({
        content: `<response>
<fact>
<text>The user appreciates the companion's patience.</text>
<type>relational</type>
<importance>0.85</importance>
<confidence>0.95</confidence>
</fact>
</response>`,
      }),
    } as ExtractionRunOptions['llmClient'];
    const processFact = vi.fn().mockResolvedValue({
      action: 'created',
      memory: { id: 'mem-1' },
    });
    const options = buildOptions({
      llmClient,
      processFact,
      resolveParticipantNames: () => ({
        userName: 'Alex',
        companionName: 'Lyra',
      }),
    });

    await runExtractionOrchestration(options);

    expect(llmClient.complete).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: expect.stringContaining('Alex: I really enjoy board games.'),
    }), 'extraction');
    expect(llmClient.complete).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: expect.stringContaining('Lyra: I love hearing that.'),
    }), 'extraction');
    expect(llmClient.complete).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: expect.stringContaining('Human participant name: Alex'),
    }), 'extraction');
    expect(processFact).toHaveBeenCalledWith(expect.objectContaining({
      text: "Alex appreciates Lyra's patience.",
    }), expect.any(String), undefined, expect.objectContaining({
      routingReason: 'single_speaker_transcript',
      sourceSpeakerName: 'Alex',
    }));
  });

  it('normalizes resolved raw macros before writes', async () => {
    const llmClient = {
      complete: vi.fn().mockResolvedValue({
        content: `<response>
<fact>
<text>{{user}} appreciates {{char}} {{char}}'s patience.</text>
<type>relational</type>
<importance>0.85</importance>
<confidence>0.95</confidence>
</fact>
</response>`,
      }),
    } as ExtractionRunOptions['llmClient'];
    const processFact = vi.fn().mockResolvedValue({
      action: 'created',
      memory: { id: 'mem-1' },
    });
    const options = buildOptions({
      llmClient,
      processFact,
      resolveParticipantNames: () => ({
        userName: 'Alex',
        companionName: 'Carlini',
      }),
    });

    await runExtractionOrchestration(options);

    expect(processFact).toHaveBeenCalledWith(expect.objectContaining({
      text: "Alex appreciates Carlini's patience.",
    }), expect.any(String), undefined);
  });

  it('skips unresolved raw macros before L2 writes', async () => {
    const llmClient = {
      complete: vi.fn().mockResolvedValue({
        content: `<response>
<fact>
<text>{{user}} wants {{char}} to remember livestream guardrails.</text>
<type>relational</type>
<importance>0.85</importance>
<confidence>0.95</confidence>
</fact>
</response>`,
      }),
    } as ExtractionRunOptions['llmClient'];
    const processFact = vi.fn();
    const emitExtractionEnd = vi.fn().mockResolvedValue(undefined);
    const options = buildOptions({
      llmClient,
      processFact,
      emitExtractionEnd,
    });

    await runExtractionOrchestration(options);

    expect(processFact).not.toHaveBeenCalled();
    expect(emitExtractionEnd).toHaveBeenCalledWith(expect.objectContaining({
      parsedCount: 1,
      acceptedCount: 0,
      rejectedCount: 1,
      writeCount: 0,
      rejectionBreakdown: expect.objectContaining({
        low_signal: 1,
      }),
    }));
  });

  it('omits internal-lane system notes from extraction prompts', async () => {
    const llmClient = {
      complete: vi.fn().mockResolvedValue({
        content: `<response>
<fact>
<text>User asked for a simple summary.</text>
<type>semantic</type>
<importance>0.6</importance>
<confidence>0.9</confidence>
</fact>
</response>`,
      }),
    } as ExtractionRunOptions['llmClient'];
    const processFact = vi.fn().mockResolvedValue({
      action: 'created',
      memory: { id: 'mem-1' },
    });
    const options = buildOptions({
      llmClient,
      processFact,
      recoveredEntries: [
        {
          id: 1,
          channelId: 'api:test',
          role: 'system',
          content: 'Admin updated prompt order.',
          authorId: 'system',
          authorName: 'System',
          timestamp: 1,
          metadata: JSON.stringify({
            sessionLane: {
              schemaVersion: 1,
              kind: 'internal',
              source: 'appendSystemNote',
            },
          }),
        },
        {
          id: 2,
          channelId: 'api:test',
          role: 'user',
          content: 'Please keep only the actual conversation.',
          timestamp: 2,
        },
      ] as ExtractionRunOptions['recoveredEntries'],
    });

    await runExtractionOrchestration(options);

    expect(llmClient.complete).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: expect.stringContaining('user: Please keep only the actual conversation.'),
    }), 'extraction');
    expect(llmClient.complete).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: expect.not.stringContaining('Admin updated prompt order.'),
    }), 'extraction');
  });

  it('uses neutral role labels when explicit participant names are unavailable', async () => {
    const llmClient = {
      complete: vi.fn().mockResolvedValue({
        content: `<response>
<fact>
<text>assistant noted the follow-up and user asked for clarity.</text>
<type>semantic</type>
<importance>0.6</importance>
<confidence>0.9</confidence>
</fact>
</response>`,
      }),
    } as ExtractionRunOptions['llmClient'];
    const processFact = vi.fn().mockResolvedValue({
      action: 'created',
      memory: { id: 'mem-1' },
    });
    const options = buildOptions({
      llmClient,
      processFact,
      recoveredEntries: [
        {
          id: 1,
          channelId: 'api:test',
          role: 'user',
          content: 'Please keep it simple.',
          timestamp: 1,
        },
        {
          id: 2,
          channelId: 'api:test',
          role: 'assistant',
          content: 'I will keep it simple.',
          timestamp: 2,
        },
      ] as ExtractionRunOptions['recoveredEntries'],
      sessionManager: {
        getRecentMessages: vi.fn().mockReturnValue([
          {
            id: 1,
            channelId: 'api:test',
            role: 'user',
            content: 'Please keep it simple.',
            timestamp: 1,
          },
          {
            id: 2,
            channelId: 'api:test',
            role: 'assistant',
            content: 'I will keep it simple.',
            timestamp: 2,
          },
        ]),
        characterName: '',
      } as ExtractionRunOptions['sessionManager'],
      resolveParticipantNames: () => ({}),
    });

    await runExtractionOrchestration(options);

    expect(llmClient.complete).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: expect.stringContaining('user: Please keep it simple.'),
    }), 'extraction');
    expect(llmClient.complete).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: expect.stringContaining('assistant: I will keep it simple.'),
    }), 'extraction');
  });
});

describe('runExtractionOrchestration group-room speaker routing', () => {
  it('routes a clear mixed-speaker fact to the source speaker contact instead of the trigger contact', async () => {
    const processFact = vi.fn().mockResolvedValue({
      action: 'created',
      memory: { id: 'mem-mrdragonfox' },
    });
    const emitExtractionEnd = vi.fn().mockResolvedValue(undefined);
    const maybePersistEmotionalState = vi.fn();
    const maybeRefreshContactProfile = vi.fn();
    const resolveSourceSpeakerContactId = vi.fn(async (speaker: ExtractionSourceSpeaker) => {
      if (speaker.authorId === 'discord-mrdragonfox') return 'contact-mrdragonfox';
      if (speaker.authorId === 'discord-vega') return 'contact-vega';
      return undefined;
    });
    const options = buildOptions({
      channelId: 'discord:kube',
      canonicalContactId: 'contact-vega',
      recoveredEntries: [
        {
          id: 1,
          channelId: 'discord:kube',
          role: 'user',
          authorId: 'discord-mrdragonfox',
          authorName: 'MrDragonFox',
          content: 'ya i mean if we put her on twitch or yt live or ticktok we need also guardrails',
          timestamp: 1,
        },
        {
          id: 2,
          channelId: 'discord:kube',
          role: 'user',
          authorId: 'discord-vega',
          authorName: 'Vega',
          content: 'I can collect the notes after we finish this pass.',
          timestamp: 2,
        },
      ] as ExtractionRunOptions['recoveredEntries'],
      llmClient: {
        complete: vi.fn().mockResolvedValue({
          content: `<response>
<fact>
<text>MrDragonFox believes that if Carlini is put on Twitch, YouTube, or TikTok live, guardrails are needed.</text>
<type>semantic</type>
<importance>0.92</importance>
<confidence>0.95</confidence>
</fact>
</response>`,
        }),
      } as ExtractionRunOptions['llmClient'],
      processFact,
      emitExtractionEnd,
      maybePersistEmotionalState,
      maybeRefreshContactProfile,
      resolveSourceSpeakerContactId,
      resolveCoveredUpToMessageId: vi.fn().mockReturnValue(2),
    });

    await runExtractionOrchestration(options);

    expect(processFact).toHaveBeenCalledTimes(1);
    expect(processFact).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('MrDragonFox believes'),
    }), expect.any(String), 'contact-mrdragonfox', expect.objectContaining({
      triggerContactId: 'contact-vega',
      routedContactId: 'contact-mrdragonfox',
      sourceSpeakerName: 'MrDragonFox',
      routingReason: 'speaker_name_prefix',
    }));
    expect(maybePersistEmotionalState).toHaveBeenCalledWith(
      'contact-mrdragonfox',
      [expect.objectContaining({ text: expect.stringContaining('MrDragonFox believes') })],
      expect.any(Array),
    );
    expect(maybeRefreshContactProfile).toHaveBeenCalledWith(
      'discord:kube',
      'manual',
      'contact-mrdragonfox',
      [expect.objectContaining({
        contactId: 'contact-mrdragonfox',
        triggerContactId: 'contact-vega',
        sourceSpeakerName: 'MrDragonFox',
      })],
    );
    expect(maybeRefreshContactProfile.mock.calls.map(call => call[2])).not.toContain('contact-vega');
    expect(emitExtractionEnd).toHaveBeenCalledWith(expect.objectContaining({
      triggerContactId: 'contact-vega',
      routedContactIds: ['contact-mrdragonfox'],
      sourceSpeakerNames: ['MrDragonFox'],
      routedFactCount: 1,
      ambiguousSpeakerSkippedCount: 0,
      rejectionBreakdown: expect.objectContaining({
        ambiguous_speaker: 0,
      }),
    }));
  });

  it('skips ambiguous mixed-speaker facts instead of defaulting them to the trigger contact', async () => {
    const processFact = vi.fn();
    const emitExtractionEnd = vi.fn().mockResolvedValue(undefined);
    const options = buildOptions({
      channelId: 'discord:kube',
      canonicalContactId: 'contact-vega',
      recoveredEntries: [
        {
          id: 1,
          channelId: 'discord:kube',
          role: 'user',
          authorId: 'discord-mrdragonfox',
          authorName: 'MrDragonFox',
          content: 'Guardrails matter before any streams happen.',
          timestamp: 1,
        },
        {
          id: 2,
          channelId: 'discord:kube',
          role: 'user',
          authorId: 'discord-vega',
          authorName: 'Vega',
          content: 'I can help with notes later.',
          timestamp: 2,
        },
      ] as ExtractionRunOptions['recoveredEntries'],
      llmClient: {
        complete: vi.fn().mockResolvedValue({
          content: `<response>
<fact>
<text>Carlini needs stronger launch planning.</text>
<type>semantic</type>
<importance>0.9</importance>
<confidence>0.9</confidence>
</fact>
</response>`,
        }),
      } as ExtractionRunOptions['llmClient'],
      processFact,
      emitExtractionEnd,
      resolveSourceSpeakerContactId: vi.fn(async (speaker: ExtractionSourceSpeaker) => {
        if (speaker.authorId === 'discord-mrdragonfox') return 'contact-mrdragonfox';
        if (speaker.authorId === 'discord-vega') return 'contact-vega';
        return undefined;
      }),
    });

    await runExtractionOrchestration(options);

    expect(processFact).not.toHaveBeenCalled();
    expect(emitExtractionEnd).toHaveBeenCalledWith(expect.objectContaining({
      acceptedCount: 0,
      rejectedCount: 1,
      writeCount: 0,
      ambiguousSpeakerSkippedCount: 1,
      rejectionBreakdown: expect.objectContaining({
        ambiguous_speaker: 1,
      }),
    }));
  });
});

describe('runExtractionOrchestration pre-LLM gate', () => {
  it('skips the extraction LLM for low-signal turns and reports the skip', async () => {
    const llmClient = {
      complete: vi.fn(),
    } as ExtractionRunOptions['llmClient'];
    const processFact = vi.fn();
    const emitExtractionEnd = vi.fn().mockResolvedValue(undefined);
    const options = buildOptions({
      llmClient,
      processFact,
      recoveredEntries: [
        {
          id: 1,
          channelId: 'api:test',
          role: 'user',
          content: 'Please summarize the findings.',
          timestamp: 1,
        },
        {
          id: 2,
          channelId: 'api:test',
          role: 'assistant',
          content: 'I can help with that.',
          timestamp: 2,
        },
      ] as ExtractionRunOptions['recoveredEntries'],
      emitExtractionEnd,
    });

    await runExtractionOrchestration(options);

    expect(llmClient.complete).not.toHaveBeenCalled();
    expect(processFact).not.toHaveBeenCalled();
    expect(options.emitExtractionStart).toHaveBeenCalledWith(
      'api:test',
      'manual',
      expect.any(String),
    );
    expect(emitExtractionEnd).toHaveBeenCalledWith(expect.objectContaining({
      channelId: 'api:test',
      count: 0,
      triggerReason: 'manual',
      parsedCount: 0,
      acceptedCount: 0,
      rejectedCount: 0,
      writeCount: 0,
      deduplicatedCount: 0,
      supersededCount: 0,
      preLlmGateSkipped: true,
      preLlmGateReason: 'low_signal',
    }));
  });
});
