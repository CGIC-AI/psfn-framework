import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryExtractor, parseFactsXml, __test as extractionTestUtils } from './extraction.js';
import { __test as tokenTestUtils } from '../llm/tokens.js';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../session/store.js';
import { getDefaultTrustPolicy, resetRuntimeTrustPolicy, setRuntimeTrustPolicy } from '../trust/runtime-policy.js';

const tempDirs: string[] = [];

afterEach(() => {
  tokenTestUtils.resetTokenizerState();
  extractionTestUtils.resetLastExtractionCount();
  resetRuntimeTrustPolicy();
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
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

  it('supports boundary facts', () => {
    const xml = `<response>
<fact>
<text>Assistant declined helping bypass paywalls</text>
<type>boundary</type>
<importance>0.95</importance>
</fact>
</response>`;

    const facts = parseFactsXml(xml);
    expect(facts).toHaveLength(1);
    expect(facts[0].type).toBe('boundary');
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
    expect(llmClient.complete).toHaveBeenCalledWith(expect.anything(), 'background');
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
    expect((llmClient.complete as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe('background');
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

describe('MemoryExtractor refusal boundary extraction', () => {
  it('extracts a boundary memory when assistant refusal is present', async () => {
    const llmClient = {
      complete: vi.fn().mockResolvedValue({ content: '<response></response>' }),
    } as any;

    const sessionManager = {
      getRecentMessages: vi.fn().mockReturnValue([
        {
          id: 101,
          role: 'user',
          authorName: 'user',
          content: 'Can you help me bypass this paywall and crack the subscription?',
          timestamp: 1_000,
        },
        {
          id: 102,
          role: 'assistant',
          authorName: 'assistant',
          content: 'I can\'t help with bypassing paywalls or cracking subscriptions.',
          timestamp: 2_000,
        },
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
      { extractionInterval: 5 },
    );

    const processFact = vi.fn(async (fact: { text: string; type: string }) => ({
      action: 'created',
      memory: { id: `boundary:${fact.type}` },
    }));
    (extractor as any).processFact = processFact;

    await extractor.extract('api:boundary-memory-test');

    expect(processFact).toHaveBeenCalledTimes(1);
    expect(processFact).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'boundary',
        importance: 0.98,
        confidence: 0.95,
        tags: expect.arrayContaining(['boundary', 'refusal']),
      }),
      expect.stringContaining('visibility:private'),
      undefined,
    );
    expect(processFact.mock.calls[0][0].text.toLowerCase()).toContain('paywall');

    const calls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
    const endCall = calls.find(([name]) => name === 'memory.extraction.end');
    expect(endCall).toBeTruthy();
    expect(endCall?.[1]?.parsedCount).toBe(1);
    expect(endCall?.[1]?.acceptedCount).toBe(1);
  });
});

describe('MemoryExtractor provenance and trust caps', () => {
  it('caps extracted importance to 0.5 on public channels', async () => {
    const defaultPolicy = getDefaultTrustPolicy();
    setRuntimeTrustPolicy({
      ...defaultPolicy,
      trustCeiling: {
        ...defaultPolicy.trustCeiling,
      },
      visibilityAllowed: {
        ...defaultPolicy.visibilityAllowed,
      },
      channelClassification: {
        privatePrefixes: [...defaultPolicy.channelClassification.privatePrefixes],
        broadcastPrefixes: [...defaultPolicy.channelClassification.broadcastPrefixes],
        defaultVisibility: 'public',
        visibilityOverrides: {
          exact: { ...defaultPolicy.channelClassification.visibilityOverrides.exact },
          prefix: { ...defaultPolicy.channelClassification.visibilityOverrides.prefix },
        },
      },
    });

    const llmClient = {
      complete: vi.fn().mockResolvedValue({
        content: `<response>
<fact>
<text>User plans to change jobs soon</text>
<type>semantic</type>
<importance>0.95</importance>
<emotional_valence>0</emotional_valence>
<confidence>0.9</confidence>
</fact>
</response>`,
      }),
    } as any;

    const sessionManager = {
      getRecentMessages: vi.fn().mockReturnValue([
        { id: 10, role: 'user', authorName: 'user', content: 'I might switch teams soon', timestamp: 1_000 },
        { id: 11, role: 'assistant', authorName: 'assistant', content: 'Noted', timestamp: 2_000 },
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
      { extractionInterval: 5 },
    );

    const write = vi.fn(async () => ({ action: 'created', memory: { id: 'm-public-1' } }));
    (extractor as any).writer = { write };

    await extractor.extract('discord:public-room');

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(expect.objectContaining({
      importance: 0.5,
      sourceRef: expect.stringContaining('visibility:public'),
    }));
  });

  it('tags shard extractions with shard source and session line range', async () => {
    const llmClient = {
      complete: vi.fn().mockResolvedValue({
        content: `<response>
<fact>
<text>Shard discovered a concrete implementation detail</text>
<type>semantic</type>
<importance>0.8</importance>
<emotional_valence>0</emotional_valence>
<confidence>0.92</confidence>
</fact>
</response>`,
      }),
    } as any;

    const sessionManager = {
      getRecentMessages: vi.fn().mockReturnValue([
        { id: 41, role: 'user', authorName: 'user', content: 'Investigating option A', timestamp: 1_000 },
        { id: 42, role: 'assistant', authorName: 'assistant', content: 'Option A works', timestamp: 2_000 },
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
      { extractionInterval: 5 },
    );

    const write = vi.fn(async () => ({ action: 'created', memory: { id: 'm-shard-1' } }));
    (extractor as any).writer = { write };

    await extractor.extract('shard:shard-abc');

    expect(write).toHaveBeenCalledTimes(1);
    const sourceRef = write.mock.calls[0][0].sourceRef as string;
    expect(sourceRef).toContain('source:shard:shard-abc');
    expect(sourceRef).toContain('session:shard:shard-abc');
    expect(sourceRef).toContain('lines:41-42');
  });
});

describe('MemoryExtractor canonical profile synthesis', () => {
  it('refreshes canonical profile on interval when source memories are sufficient', async () => {
    const llmClient = {
      complete: vi
        .fn()
        .mockResolvedValueOnce({ content: '<response></response>' })
        .mockResolvedValueOnce({
          content: '<profile><summary>Vega is a direct communicator and primary partner.</summary></profile>',
        }),
    } as any;

    const sessionManager = {
      getMessageCount: vi.fn().mockReturnValue(6),
      getRecentMessages: vi.fn().mockReturnValue([
        { role: 'user', content: 'Hey', authorName: 'Vega' },
      ]),
    } as any;

    const memoryStore = {
      getMemoriesByChannel: vi.fn().mockReturnValue([]),
      getContactProfile: vi.fn().mockReturnValue(undefined),
      getMemoriesByContact: vi.fn().mockReturnValue([
        {
          id: 'm1',
          type: 'relational',
          text: 'Vega is my primary partner.',
          importance: 0.95,
          confidence: 0.95,
          salience: 0.92,
        },
        {
          id: 'm2',
          type: 'semantic',
          text: 'Vega prefers direct technical communication.',
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

    const completePurposes = (llmClient.complete as ReturnType<typeof vi.fn>).mock.calls
      .map(([, purpose]) => purpose);
    expect(completePurposes).toEqual(['background', 'background']);
    expect(memoryStore.getMemoriesByContact).toHaveBeenCalledWith('contact-canonical-1', 16);
    expect(memoryStore.upsertContactProfile).toHaveBeenCalledWith(expect.objectContaining({
      contactId: 'contact-canonical-1',
      summary: 'Vega is a direct communicator and primary partner.',
      sourceMemoryIds: ['m1', 'm2'],
    }));
  });

  it('skips profile refresh when synthesized summary novelty is too low', async () => {
    const llmClient = {
      complete: vi
        .fn()
        .mockResolvedValueOnce({ content: '<response></response>' })
        .mockResolvedValueOnce({
          content: '<profile><summary>Vega prefers concise updates.</summary></profile>',
        }),
    } as any;

    const sessionManager = {
      getMessageCount: vi.fn().mockReturnValue(6),
      getRecentMessages: vi.fn().mockReturnValue([
        { role: 'user', content: 'Hey', authorName: 'Vega' },
      ]),
    } as any;

    const memoryStore = {
      getMemoriesByChannel: vi.fn().mockReturnValue([]),
      getContactProfile: vi.fn().mockReturnValue({
        summary: 'Vega prefers concise updates.',
        updatedAt: Date.now() - (24 * 60 * 60 * 1000),
      }),
      getMemoriesByContact: vi.fn().mockReturnValue([
        {
          id: 'm1',
          type: 'semantic',
          text: 'Vega prefers concise updates.',
          importance: 0.8,
          confidence: 0.9,
          salience: 0.8,
        },
        {
          id: 'm2',
          type: 'relational',
          text: 'Vega is my partner.',
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

  it('drains cleanly when fire-and-forget profile refresh rejects', async () => {
    const llmClient = {
      complete: vi
        .fn()
        .mockResolvedValueOnce({ content: '<response></response>' })
        .mockRejectedValueOnce(new Error('profile synthesis timeout')),
    } as any;

    const sessionManager = {
      getMessageCount: vi.fn().mockReturnValue(6),
      getRecentMessages: vi.fn().mockReturnValue([
        { role: 'user', content: 'Hey', authorName: 'Vega' },
      ]),
    } as any;

    const memoryStore = {
      getMemoriesByChannel: vi.fn().mockReturnValue([]),
      getContactProfile: vi.fn().mockReturnValue(undefined),
      getMemoriesByContact: vi.fn().mockReturnValue([
        {
          id: 'm1',
          type: 'relational',
          text: 'Vega is my primary partner.',
          importance: 0.95,
          confidence: 0.95,
          salience: 0.92,
        },
        {
          id: 'm2',
          type: 'semantic',
          text: 'Vega prefers direct technical communication.',
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

    await extractor.maybeExtract('api:profile-error-test', 'contact-canonical-1');

    await expect(extractor.drain({ timeoutMs: 2_000 })).resolves.toBe(true);
    expect(llmClient.complete).toHaveBeenCalledTimes(2);
    expect(memoryStore.upsertContactProfile).not.toHaveBeenCalled();
  });
});

describe('MemoryExtractor emotional state persistence', () => {
  it('updates canonical contact emotional baseline from accepted emotional signals', async () => {
    const llmClient = {
      complete: vi.fn().mockResolvedValue({
        content: `<response>
<fact>
<text>User felt anxious and overwhelmed during the incident</text>
<type>emotional</type>
<importance>0.88</importance>
<emotional_valence>-0.7</emotional_valence>
<confidence>0.91</confidence>
<tags>emotion,stress</tags>
</fact>
</response>`,
      }),
    } as any;

    const sessionManager = {
      getRecentMessages: vi.fn().mockReturnValue([
        { role: 'user', content: 'I am anxious and overwhelmed right now', authorName: 'user' },
      ]),
      getMessageCount: vi.fn().mockReturnValue(1),
    } as any;

    const memoryStore = {
      getMemoriesByChannel: vi.fn().mockReturnValue([]),
      searchByEmbedding: vi.fn().mockReturnValue([]),
      insertMemory: vi.fn(),
    } as any;

    const embeddingService = {
      embed: vi.fn().mockResolvedValue(new Float32Array(8)),
      embedBatch: vi.fn(),
      dims: 8,
    } as any;

    const eventBus = {
      emit: vi.fn().mockResolvedValue(undefined),
    } as any;

    const contactStore = {
      updateEmotionalBaseline: vi.fn().mockReturnValue({
        id: 'contact-canonical-1',
        emotionalBaseline: {
          valenceBaseline: -0.28,
          moodValence: -0.49,
          moodDrift: -0.21,
          moodSamples: 3,
        },
      }),
    } as any;

    const extractor = new MemoryExtractor(
      llmClient,
      sessionManager,
      memoryStore,
      embeddingService,
      eventBus,
      { extractionInterval: 5 },
      null,
      null,
      contactStore,
    );

    await extractor.extract('api:mood-test', 'contact-canonical-1');

    expect(contactStore.updateEmotionalBaseline).toHaveBeenCalledTimes(1);
    expect(contactStore.updateEmotionalBaseline).toHaveBeenCalledWith(
      'contact-canonical-1',
      expect.objectContaining({
        valence: expect.any(Number),
        confidence: expect.any(Number),
        observedAtMs: expect.any(Number),
      }),
    );
    const observedValence = contactStore.updateEmotionalBaseline.mock.calls[0][1].valence as number;
    expect(observedValence).toBeLessThan(0);
  });
});

describe('MemoryExtractor crash recovery markers', () => {
  it('queues pre-compaction extraction over provided compacted entries', async () => {
    const llmClient = {
      complete: vi.fn().mockResolvedValue({ content: '<response></response>' }),
    } as any;
    const sessionManager = {
      getRecentMessages: vi.fn().mockReturnValue([]),
      getMessageCount: vi.fn().mockReturnValue(0),
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
      { extractionInterval: 5 },
    );

    await extractor.queueCompactionExtraction('api:compaction-flush', [
      { id: 11, channelId: 'api:compaction-flush', role: 'user', content: 'User plans a Kyoto trip', timestamp: 1_000 },
      { id: 12, channelId: 'api:compaction-flush', role: 'assistant', content: 'Noted and saved', timestamp: 2_000 },
    ]);

    expect(llmClient.complete).toHaveBeenCalledTimes(1);
    const prompt = (llmClient.complete as ReturnType<typeof vi.fn>).mock.calls[0][0].systemPrompt as string;
    expect(prompt).toContain('User plans a Kyoto trip');
    expect(prompt).toContain('Noted and saved');

    const calls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
    const startCall = calls.find(([name]) => name === 'memory.extraction.start');
    expect(startCall?.[1]?.triggerReason).toBe('pre_compaction');
  });

  it('writes an extraction marker after a successful extraction run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-extraction-marker-'));
    tempDirs.push(dir);
    const sessionStore = new SessionStore(dir);
    const channelId = 'api:marker-test';

    sessionStore.append({
      channelId,
      role: 'user',
      content: 'User likes coffee',
      timestamp: 1_000,
    });
    sessionStore.append({
      channelId,
      role: 'assistant',
      content: 'Noted',
      timestamp: 2_000,
    });

    const llmClient = {
      complete: vi.fn().mockResolvedValue({ content: '<response></response>' }),
    } as any;
    const sessionManager = {
      getRecentMessages: vi.fn().mockImplementation((id: string, limit = 10) => sessionStore.getRecent(id, limit)),
      getMessageCount: vi.fn().mockImplementation((id: string) => sessionStore.count(id)),
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
      { extractionInterval: 5 },
      null,
      sessionStore,
    );

    await extractor.extract(channelId);

    const sessionFile = readdirSync(dir).find(file => file.endsWith('.jsonl') && !file.startsWith('user_'));
    expect(sessionFile).toBeDefined();
    const lines = readFileSync(join(dir, sessionFile!), 'utf-8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>);
    const lastEntry = lines[lines.length - 1];
    expect(lastEntry.type).toBe('marker');
    expect(lastEntry.marker).toBe('extraction');
    expect(lastEntry.coveredUpTo).toBe(2);
  });

  it('queues retroactive extraction using recovered un-extracted entries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-extraction-recovery-'));
    tempDirs.push(dir);
    const sessionStore = new SessionStore(dir);
    const channelId = 'api:crash-recovery';

    sessionStore.append({
      channelId,
      role: 'user',
      content: 'Message 1',
      timestamp: 1_000,
    });
    sessionStore.insertExtractionMarker(channelId, 1, 1_500);
    sessionStore.append({
      channelId,
      role: 'user',
      content: 'Message 2',
      timestamp: 2_000,
    });
    sessionStore.append({
      channelId,
      role: 'assistant',
      content: 'Message 3',
      timestamp: 3_000,
    });

    const candidates = sessionStore.getCrashRecoveryExtractionCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0].unextractedEntries.map(entry => entry.content)).toEqual(['Message 2', 'Message 3']);

    const llmClient = {
      complete: vi.fn().mockResolvedValue({ content: '<response></response>' }),
    } as any;
    const sessionManager = {
      getRecentMessages: vi.fn().mockImplementation((id: string, limit = 10) => sessionStore.getRecent(id, limit)),
      getMessageCount: vi.fn().mockImplementation((id: string) => sessionStore.count(id)),
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
      { extractionInterval: 5 },
      null,
      sessionStore,
    );

    await extractor.queueRetroactiveExtraction(channelId, candidates[0].unextractedEntries);

    expect(llmClient.complete).toHaveBeenCalledTimes(1);
    const prompt = (llmClient.complete as ReturnType<typeof vi.fn>).mock.calls[0][0].systemPrompt as string;
    expect(prompt).toContain('Message 2');
    expect(prompt).toContain('Message 3');

    const afterRecovery = sessionStore.getCrashRecoveryExtractionCandidates();
    expect(afterRecovery).toHaveLength(0);
  });
});
