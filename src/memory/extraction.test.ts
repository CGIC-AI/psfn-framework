import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryExtractor, parseFactsXml, __test as extractionTestUtils } from './extraction.js';
import { __test as tokenTestUtils } from '../llm/tokens.js';

afterEach(() => {
  tokenTestUtils.resetTokenizerState();
});

describe('parseFactsXml', () => {
  it('parses a valid response with multiple facts', () => {
    const xml = `<response>
<fact>
<text>User is a software engineer</text>
<type>semantic</type>
<importance>0.8</importance>
<emotional_valence>0.0</emotional_valence>
<confidence>0.95</confidence>
<tags>identity, profession</tags>
</fact>
<fact>
<text>User felt excited about the new project</text>
<type>emotional</type>
<importance>0.6</importance>
<emotional_valence>0.7</emotional_valence>
<confidence>0.8</confidence>
<tags>feelings, work</tags>
</fact>
</response>`;

    const facts = parseFactsXml(xml);
    expect(facts).toHaveLength(2);

    expect(facts[0].text).toBe('User is a software engineer');
    expect(facts[0].type).toBe('semantic');
    expect(facts[0].importance).toBe(0.8);
    expect(facts[0].emotionalValence).toBe(0.0);
    expect(facts[0].confidence).toBe(0.95);
    expect(facts[0].tags).toEqual(['identity', 'profession']);

    expect(facts[1].type).toBe('emotional');
    expect(facts[1].emotionalValence).toBe(0.7);
  });

  it('returns empty array for empty response', () => {
    expect(parseFactsXml('<response></response>')).toEqual([]);
  });

  it('returns empty array for no response block', () => {
    expect(parseFactsXml('Just some text')).toEqual([]);
  });

  it('skips facts with invalid type', () => {
    const xml = `<response>
<fact>
<text>Something</text>
<type>invalid</type>
<importance>0.5</importance>
</fact>
</response>`;

    expect(parseFactsXml(xml)).toEqual([]);
  });

  it('supports relational facts', () => {
    const xml = `<response>
<fact>
<text>User's sister is named Alex</text>
<type>relational</type>
<importance>0.8</importance>
</fact>
</response>`;

    const facts = parseFactsXml(xml);
    expect(facts).toHaveLength(1);
    expect(facts[0].type).toBe('relational');
  });

  it('clamps values to valid ranges', () => {
    const xml = `<response>
<fact>
<text>Test</text>
<type>semantic</type>
<importance>1.5</importance>
<emotional_valence>-2.0</emotional_valence>
<confidence>-0.5</confidence>
<tags></tags>
</fact>
</response>`;

    const facts = parseFactsXml(xml);
    expect(facts).toHaveLength(1);
    expect(facts[0].importance).toBe(1.0);
    expect(facts[0].emotionalValence).toBe(-1.0);
    expect(facts[0].confidence).toBe(0.0);
  });

  it('defaults sensitivity to personal for invalid sensitivity value', () => {
    const xml = `<response>
<fact>
<text>User likes tea</text>
<type>semantic</type>
<sensitivity>super_secret</sensitivity>
</fact>
</response>`;

    const facts = parseFactsXml(xml);
    expect(facts).toHaveLength(1);
    expect(facts[0].sensitivity).toBe('personal');
  });
});

describe('extraction acceptance gates', () => {
  it('rejects low-importance facts', () => {
    const decision = extractionTestUtils.evaluateFactAcceptance(
      {
        text: 'User said hi',
        type: 'episodic',
        importance: 0.2,
        emotionalValence: 0,
        confidence: 0.95,
        tags: [],
      },
      [],
      { minImportance: 0.45, minConfidence: 0.6, minNovelty: 0.35 },
    );

    expect(decision.accepted).toBe(false);
    expect(decision.reason).toBe('low_importance');
  });

  it('rejects low-confidence facts', () => {
    const decision = extractionTestUtils.evaluateFactAcceptance(
      {
        text: 'User might like jazz',
        type: 'semantic',
        importance: 0.8,
        emotionalValence: 0,
        confidence: 0.4,
        tags: [],
      },
      [],
      { minImportance: 0.45, minConfidence: 0.6, minNovelty: 0.35 },
    );

    expect(decision.accepted).toBe(false);
    expect(decision.reason).toBe('low_confidence');
  });

  it('rejects low-novelty facts similar to existing memories', () => {
    const decision = extractionTestUtils.evaluateFactAcceptance(
      {
        text: 'User loves espresso',
        type: 'semantic',
        importance: 0.8,
        emotionalValence: 0,
        confidence: 0.95,
        tags: [],
      },
      ['User loves espresso'],
      { minImportance: 0.45, minConfidence: 0.6, minNovelty: 0.35 },
    );

    expect(decision.accepted).toBe(false);
    expect(decision.reason).toBe('low_novelty');
    expect(decision.novelty).toBe(0);
  });

  it('rejects low-signal filler and conversation meta facts', () => {
    const decision = extractionTestUtils.evaluateFactAcceptance(
      {
        text: 'User greeted assistant and exchanged pleasantries in a quick chat',
        type: 'episodic',
        importance: 0.85,
        emotionalValence: 0,
        confidence: 0.95,
        tags: [],
      },
      [],
      { minImportance: 0.45, minConfidence: 0.6, minNovelty: 0.35 },
    );

    expect(decision.accepted).toBe(false);
    expect(decision.reason).toBe('low_signal');
  });

  it('keeps meaningful relationship facts even with greeting language', () => {
    const decision = extractionTestUtils.evaluateFactAcceptance(
      {
        text: "User's sister greeted them at the airport after deployment",
        type: 'relational',
        importance: 0.85,
        emotionalValence: 0.4,
        confidence: 0.9,
        tags: ['family'],
      },
      [],
      { minImportance: 0.45, minConfidence: 0.6, minNovelty: 0.35 },
    );

    expect(decision.accepted).toBe(true);
    expect(decision.reason).toBeUndefined();
  });

  it('accepts high-value, novel facts', () => {
    const decision = extractionTestUtils.evaluateFactAcceptance(
      {
        text: 'User is planning to move to Seattle this summer',
        type: 'episodic',
        importance: 0.85,
        emotionalValence: 0.1,
        confidence: 0.9,
        tags: ['plans'],
      },
      ['User likes coffee'],
      { minImportance: 0.45, minConfidence: 0.6, minNovelty: 0.35 },
    );

    expect(decision.accepted).toBe(true);
    expect(decision.reason).toBeUndefined();
    expect(decision.novelty).toBeGreaterThan(0.35);
  });
});

describe('MemoryExtractor telemetry payloads', () => {
  it('includes trigger reason and extraction stats in emitted events', async () => {
    const llmClient = {
      complete: vi.fn().mockResolvedValue({ content: '<response></response>' }),
    } as any;

    const sessionManager = {
      getMessageCount: vi.fn().mockReturnValue(5),
      getRecentMessages: vi.fn().mockReturnValue([
        { role: 'user', content: 'User likes coffee', authorName: 'user' },
      ]),
    } as any;

    const memoryStore = {
      getMemoriesByChannel: vi.fn().mockReturnValue([]),
    } as any;

    const embeddingService = {
      embed: vi.fn().mockResolvedValue(new Float32Array(8)),
      embedBatch: vi.fn(),
      dims: 8,
    } as any;

    const eventBus = {
      emit: vi.fn().mockResolvedValue(undefined),
    } as any;

    const extractor = new MemoryExtractor(
      llmClient,
      sessionManager,
      memoryStore,
      embeddingService,
      eventBus,
      {
        extractionInterval: 5,
        minImportance: 0.45,
        minConfidence: 0.6,
        minNovelty: 0.35,
        telemetryEnabled: true,
      },
    );

    await extractor.maybeExtract('api:telemetry-test');

    const calls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
    const startCall = calls.find(([name]) => name === 'memory.extraction.start');
    const endCall = calls.find(([name]) => name === 'memory.extraction.end');

    expect(startCall).toBeTruthy();
    expect(startCall?.[1]?.triggerReason).toBe('interval');

    expect(endCall).toBeTruthy();
    expect(endCall?.[1]?.count).toBe(0);
    expect(endCall?.[1]?.parsedCount).toBe(0);
    expect(endCall?.[1]?.acceptedCount).toBe(0);
  });

  it('uses framed message token counting for context-threshold triggers', async () => {
    tokenTestUtils.setTokenizerFactory(() => ({
      encode: (text: string) => ({ length: text.length }),
    }));

    const llmClient = {
      complete: vi.fn().mockResolvedValue({ content: '<response></response>' }),
    } as any;

    const sessionManager = {
      getMessageCount: vi.fn().mockReturnValue(1),
      getRecentMessages: vi.fn().mockReturnValue([
        { role: 'user', content: 'a', authorName: 'user' },
        { role: 'assistant', content: 'b', authorName: 'assistant' },
        { role: 'user', content: 'c', authorName: 'user' },
      ]),
    } as any;

    const memoryStore = {
      getMemoriesByChannel: vi.fn().mockReturnValue([]),
      getContactProfile: vi.fn().mockReturnValue(undefined),
      getMemoriesByContact: vi.fn().mockReturnValue([]),
      upsertContactProfile: vi.fn(),
    } as any;

    const embeddingService = {
      embed: vi.fn().mockResolvedValue(new Float32Array(8)),
      embedBatch: vi.fn(),
      dims: 8,
    } as any;

    const eventBus = {
      emit: vi.fn().mockResolvedValue(undefined),
    } as any;

    const extractor = new MemoryExtractor(
      llmClient,
      sessionManager,
      memoryStore,
      embeddingService,
      eventBus,
      {
        primaryModel: 'test-model',
        primaryProvider: 'test-provider',
        extractionModel: 'test-model',
        extractionProvider: 'test-provider',
        primaryMaxTokens: 4096,
        extractionMaxTokens: 4096,
        discordToken: '',
        discordBotId: '',
        characterCardPath: '',
        dataDir: '',
        databasePath: '',
        sessionMessageLimit: 30,
        memoryRetrievalLimit: 15,
        extractionInterval: 10,
        maintenanceIntervalMs: 60_000,
        defaultContextWindow: 60,
        memoryBudgetPct: 20,
        extractionThresholdPct: 50,
        compactionThresholdPct: 70,
        memoryExtractionTelemetryEnabled: true,
        modelRoster: {
          chat: {
            model: 'test-model',
            provider: 'test-provider',
            maxTokens: 4096,
            contextWindow: 60,
          },
        },
      } as any,
    );

    await extractor.maybeExtract('api:threshold-tokens-callsite');

    expect(llmClient.complete).toHaveBeenCalledTimes(1);
    const calls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
    const startCall = calls.find(([name]) => name === 'memory.extraction.start');
    expect(startCall?.[1]?.triggerReason).toBe('context_threshold');
  });

  it('injects runtime datetime tokens in extraction prompts', async () => {
    const llmClient = {
      complete: vi.fn().mockResolvedValue({ content: '<response></response>' }),
    } as any;

    const sessionManager = {
      getRecentMessages: vi.fn().mockReturnValue([
        { role: 'user', content: 'User likes coffee', authorName: 'user' },
      ]),
    } as any;

    const memoryStore = {
      getMemoriesByChannel: vi.fn().mockReturnValue([]),
    } as any;

    const embeddingService = {
      embed: vi.fn().mockResolvedValue(new Float32Array(8)),
      embedBatch: vi.fn(),
      dims: 8,
    } as any;

    const eventBus = {
      emit: vi.fn().mockResolvedValue(undefined),
    } as any;

    const promptRegistry = {
      getPrompt: vi.fn().mockReturnValue(
        'Extraction run at {{current_datetime}}.\nKnown:\n{existing_facts}\nRecent:\n{recent_messages}',
      ),
    } as any;

    const extractor = new MemoryExtractor(
      llmClient,
      sessionManager,
      memoryStore,
      embeddingService,
      eventBus,
      { extractionInterval: 5 },
      promptRegistry,
    );

    await extractor.extract('api:telemetry-test');

    const firstCall = (llmClient.complete as ReturnType<typeof vi.fn>).mock.calls[0][0] as { systemPrompt: string };
    expect(firstCall.systemPrompt).not.toContain('{{current_datetime}}');
    expect(firstCall.systemPrompt).toMatch(/Extraction run at \d{4}-\d{2}-\d{2}T/);
  });

  it('caps writes by ranked value and reports write_cap rejections', async () => {
    const llmClient = {
      complete: vi.fn().mockResolvedValue({
        content: `<response>
<fact>
<text>User likes rainy weather</text>
<type>semantic</type>
<importance>0.75</importance>
<emotional_valence>0.1</emotional_valence>
<confidence>0.8</confidence>
</fact>
<fact>
<text>User is interviewing for senior engineering roles</text>
<type>semantic</type>
<importance>0.9</importance>
<emotional_valence>0.0</emotional_valence>
<confidence>0.9</confidence>
</fact>
<fact>
<text>User's partner is named Taylor</text>
<type>relational</type>
<importance>0.95</importance>
<emotional_valence>0.0</emotional_valence>
<confidence>0.92</confidence>
</fact>
</response>`,
      }),
    } as any;

    const sessionManager = {
      getRecentMessages: vi.fn().mockReturnValue([
        { role: 'user', content: 'Conversation content', authorName: 'user' },
      ]),
    } as any;

    const memoryStore = {
      getMemoriesByChannel: vi.fn().mockReturnValue([]),
    } as any;

    const embeddingService = {
      embed: vi.fn().mockResolvedValue(new Float32Array(8)),
      embedBatch: vi.fn(),
      dims: 8,
    } as any;

    const eventBus = {
      emit: vi.fn().mockResolvedValue(undefined),
    } as any;

    const extractor = new MemoryExtractor(
      llmClient,
      sessionManager,
      memoryStore,
      embeddingService,
      eventBus,
      {
        primaryModel: 'test-model',
        primaryProvider: 'test-provider',
        extractionModel: 'test-model',
        extractionProvider: 'test-provider',
        primaryMaxTokens: 4096,
        extractionMaxTokens: 4096,
        discordToken: '',
        discordBotId: '',
        characterCardPath: '',
        dataDir: '',
        databasePath: '',
        sessionMessageLimit: 30,
        memoryRetrievalLimit: 15,
        extractionInterval: 5,
        maintenanceIntervalMs: 60_000,
        defaultContextWindow: 16_000,
        memoryBudgetPct: 20,
        extractionThresholdPct: 30,
        compactionThresholdPct: 70,
        memoryExtractionMinImportance: 0.45,
        memoryExtractionMinConfidence: 0.6,
        memoryExtractionMinNovelty: 0.35,
        memoryExtractionMaxWrites: 2,
        memoryExtractionTelemetryEnabled: true,
        modelRoster: {
          chat: {
            model: 'test-model',
            provider: 'test-provider',
            maxTokens: 4096,
            contextWindow: 16_000,
          },
        },
      } as any,
    );

    const processFact = vi.fn(async (fact: { text: string }) => ({
      action: 'created',
      memory: { id: `memory:${fact.text}` },
    }));
    (extractor as any).processFact = processFact;

    await extractor.extract('api:cap-test');

    expect(processFact).toHaveBeenCalledTimes(2);
    const writtenTexts = processFact.mock.calls.map(call => call[0].text);
    expect(writtenTexts).toContain("User's partner is named Taylor");
    expect(writtenTexts).toContain('User is interviewing for senior engineering roles');
    expect(writtenTexts).not.toContain('User likes rainy weather');

    const calls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
    const endCall = calls.find(([name]) => name === 'memory.extraction.end');
    expect(endCall).toBeTruthy();
    expect(endCall?.[1]?.parsedCount).toBe(3);
    expect(endCall?.[1]?.acceptedCount).toBe(2);
    expect(endCall?.[1]?.writeCount).toBe(2);
    expect(endCall?.[1]?.rejectionBreakdown?.write_cap).toBe(1);
  });
});

describe('MemoryExtractor canonical profile synthesis', () => {
  it('refreshes canonical profile on interval when source memories are sufficient', async () => {
    const llmClient = {
      complete: vi
        .fn()
        .mockResolvedValueOnce({ content: '<response></response>' })
        .mockResolvedValueOnce({
          content: '<profile><summary>Operator is a direct communicator and primary partner.</summary></profile>',
        }),
    } as any;

    const sessionManager = {
      getMessageCount: vi.fn().mockReturnValue(6),
      getRecentMessages: vi.fn().mockReturnValue([
        { role: 'user', content: 'Hey', authorName: 'Operator' },
      ]),
    } as any;

    const memoryStore = {
      getMemoriesByChannel: vi.fn().mockReturnValue([]),
      getContactProfile: vi.fn().mockReturnValue(undefined),
      getMemoriesByContact: vi.fn().mockReturnValue([
        {
          id: 'm1',
          type: 'relational',
          text: 'Operator is my primary partner.',
          importance: 0.95,
          confidence: 0.95,
          salience: 0.92,
        },
        {
          id: 'm2',
          type: 'semantic',
          text: 'Operator prefers direct technical communication.',
          importance: 0.82,
          confidence: 0.88,
          salience: 0.8,
        },
      ]),
      upsertContactProfile: vi.fn(),
    } as any;

    const embeddingService = {
      embed: vi.fn().mockResolvedValue(new Float32Array(8)),
      embedBatch: vi.fn(),
      dims: 8,
    } as any;

    const eventBus = {
      emit: vi.fn().mockResolvedValue(undefined),
    } as any;

    const extractor = new MemoryExtractor(
      llmClient,
      sessionManager,
      memoryStore,
      embeddingService,
      eventBus,
      {
        extractionInterval: 5,
        minImportance: 0.45,
        minConfidence: 0.6,
        minNovelty: 0.35,
        telemetryEnabled: true,
      },
    );

    await extractor.maybeExtract('api:profile-test', 'contact-canonical-1');
    await extractor.drain({ timeoutMs: 2_000 });

    expect(memoryStore.getMemoriesByContact).toHaveBeenCalledWith('contact-canonical-1', 16);
    expect(memoryStore.upsertContactProfile).toHaveBeenCalledWith(expect.objectContaining({
      contactId: 'contact-canonical-1',
      summary: 'Operator is a direct communicator and primary partner.',
      sourceMemoryIds: ['m1', 'm2'],
    }));
  });

  it('skips profile refresh when synthesized summary novelty is too low', async () => {
    const llmClient = {
      complete: vi
        .fn()
        .mockResolvedValueOnce({ content: '<response></response>' })
        .mockResolvedValueOnce({
          content: '<profile><summary>Operator prefers concise updates.</summary></profile>',
        }),
    } as any;

    const sessionManager = {
      getMessageCount: vi.fn().mockReturnValue(6),
      getRecentMessages: vi.fn().mockReturnValue([
        { role: 'user', content: 'Hey', authorName: 'Operator' },
      ]),
    } as any;

    const memoryStore = {
      getMemoriesByChannel: vi.fn().mockReturnValue([]),
      getContactProfile: vi.fn().mockReturnValue({
        summary: 'Operator prefers concise updates.',
        updatedAt: Date.now() - (24 * 60 * 60 * 1000),
      }),
      getMemoriesByContact: vi.fn().mockReturnValue([
        {
          id: 'm1',
          type: 'semantic',
          text: 'Operator prefers concise updates.',
          importance: 0.8,
          confidence: 0.9,
          salience: 0.8,
        },
        {
          id: 'm2',
          type: 'relational',
          text: 'Operator is my partner.',
          importance: 0.95,
          confidence: 0.95,
          salience: 0.9,
        },
      ]),
      upsertContactProfile: vi.fn(),
    } as any;

    const embeddingService = {
      embed: vi.fn().mockResolvedValue(new Float32Array(8)),
      embedBatch: vi.fn(),
      dims: 8,
    } as any;

    const eventBus = {
      emit: vi.fn().mockResolvedValue(undefined),
    } as any;

    const extractor = new MemoryExtractor(
      llmClient,
      sessionManager,
      memoryStore,
      embeddingService,
      eventBus,
      {
        extractionInterval: 5,
        minImportance: 0.45,
        minConfidence: 0.6,
        minNovelty: 0.35,
        telemetryEnabled: true,
      },
    );

    await extractor.maybeExtract('api:profile-test', 'contact-canonical-1');
    await extractor.drain({ timeoutMs: 2_000 });

    expect(memoryStore.upsertContactProfile).not.toHaveBeenCalled();
  });
});
