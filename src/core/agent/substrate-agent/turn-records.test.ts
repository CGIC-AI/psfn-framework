import { describe, expect, it } from 'vitest';
import { buildTurnRecord, sanitizePersistedReasoningText } from './turn-records.js';

describe('turn-records tool persistence', () => {
  it('keeps concise persisted reasoning that is useful to operators', () => {
    expect(sanitizePersistedReasoningText('Need the memory tool first.')).toBe('Need the memory tool first.');
  });

  it('drops placeholder or contaminated reasoning before persistence', () => {
    expect(sanitizePersistedReasoningText('None')).toBeUndefined();
    expect(sanitizePersistedReasoningText('[Scratchpad]\nWorking notes (short-term, may be stale; verify before acting):\n- old note')).toBeUndefined();
  });

  it('uses enriched persisted user content when the stored turn has current image description context', () => {
    const record = buildTurnRecord({
      message: {
        id: 'source-message-image',
        channelId: 'api:test',
        channelType: 'api',
        authorId: 'user-1',
        authorName: 'User',
        content: 'what did i send?',
        timestamp: new Date(1_700_000_000_000),
      },
      turnId: '019d2326-d9e1-701d-bcee-250d2cbb0e4e',
      requestId: 'req-turn-records-image',
      startedAt: 1_700_000_000_000,
      completedAt: 1_700_000_000_250,
      userSessionEntryId: 1,
      assistantSessionEntryId: 2,
      response: {
        content: 'It was a catgirl on a server rack.',
        channelId: 'api:test',
        metadata: {
          model: 'test-model',
          inputTokens: 10,
          outputTokens: 6,
          durationMs: 250,
        },
      },
      turnMessages: [],
      promptMode: 'default',
      promptText: 'prompt',
      contextMessageCount: 1,
      memoryContextChars: 0,
      trustLevel: 'regular',
      speakerRole: 'user',
      retrievalProvenanceRefs: [],
      persistedUserMessageContent: [
        'what did i send?',
        '',
        '---',
        'Image attachment:',
        'Description: A catgirl sits on a server rack.',
        'Model: vision-model',
        'Image count: 1',
        '---',
      ].join('\n'),
      hashPromptText: () => 'prompt-hash',
    });

    expect(record.userMessage.content).toContain('Description: A catgirl sits on a server rack.');
    expect(record.userMessage.content).not.toBe('what did i send?');
  });

  it('records a durable location when the turn carried a bound satellite placeId', () => {
    const record = buildTurnRecord({
      message: {
        id: 'source-message-satellite',
        channelId: 'psfn-amica:test',
        channelType: 'psfn-amica',
        authorId: 'user-1',
        authorName: 'User',
        content: 'lights?',
        timestamp: new Date(1_700_000_000_000),
        routing: {
          source: 'satellite',
          satellite: {
            schemaVersion: 1,
            satelliteId: 'pi-voice',
            satelliteDisplayName: 'Pi Voice',
            endpointId: 'endpoint-1',
            endpointDisplayName: 'Endpoint 1',
            claimType: 'voice',
            sessionId: 'sess-1',
            mobility: 'static',
            promptChannelType: 'psfn-amica',
            placeId: 'living_room',
            capabilities: {
              advertised: [],
              registryMax: [],
              effective: [],
              policyDenied: [],
            },
            telemetryScopes: [],
            auth: { mode: 'api_key', principalId: 'anon', certBound: false },
          },
        },
      },
      turnId: '019d2326-d9e1-701d-bcee-250d2cbb0e4e',
      requestId: 'req-turn-records-satellite',
      startedAt: 1_700_000_000_000,
      completedAt: 1_700_000_000_250,
      userSessionEntryId: 1,
      assistantSessionEntryId: 2,
      response: {
        content: 'On it.',
        channelId: 'psfn-amica:test',
        metadata: { model: 'test-model', inputTokens: 5, outputTokens: 3, durationMs: 250 },
      },
      turnMessages: [],
      promptMode: 'default',
      promptText: 'prompt',
      contextMessageCount: 1,
      memoryContextChars: 0,
      trustLevel: 'regular',
      speakerRole: 'user',
      retrievalProvenanceRefs: [],
      hashPromptText: () => 'prompt-hash',
    });

    expect(record.location).toEqual({ placeId: 'living_room', satelliteId: 'pi-voice' });
  });

  it('omits location when the turn carried no satellite place binding', () => {
    const record = buildTurnRecord({
      message: {
        id: 'source-message-nolocation',
        channelId: 'api:test',
        channelType: 'api',
        authorId: 'user-1',
        authorName: 'User',
        content: 'hi',
        timestamp: new Date(1_700_000_000_000),
      },
      turnId: '019d2326-d9e1-701d-bcee-250d2cbb0e4e',
      requestId: 'req-turn-records-nolocation',
      startedAt: 1_700_000_000_000,
      completedAt: 1_700_000_000_250,
      userSessionEntryId: 1,
      assistantSessionEntryId: 2,
      response: {
        content: 'hey',
        channelId: 'api:test',
        metadata: { model: 'test-model', inputTokens: 5, outputTokens: 3, durationMs: 250 },
      },
      turnMessages: [],
      promptMode: 'default',
      promptText: 'prompt',
      contextMessageCount: 1,
      memoryContextChars: 0,
      trustLevel: 'regular',
      speakerRole: 'user',
      retrievalProvenanceRefs: [],
      hashPromptText: () => 'prompt-hash',
    });

    expect(record.location).toBeUndefined();
  });

  it('preserves tool arguments, results, and rationale in the turn record', () => {
    const record = buildTurnRecord({
      message: {
        id: 'source-message-1',
        channelId: 'api:test',
        channelType: 'api',
        authorId: 'user-1',
        authorName: 'User',
        content: 'Patch the memory.',
        timestamp: new Date(1_700_000_000_000),
      },
      turnId: '019d2326-d9e1-701d-bcee-250d2cbb0e4e',
      requestId: 'req-turn-records',
      startedAt: 1_700_000_000_000,
      completedAt: 1_700_000_000_250,
      userSessionEntryId: 1,
      assistantSessionEntryId: 2,
      response: {
        content: 'Done.',
        channelId: 'api:test',
        metadata: {
          model: 'openrouter/moonshotai/kimi-k2.5',
          inputTokens: 100,
          outputTokens: 25,
          durationMs: 250,
        },
      },
      turnMessages: [
        {
          role: 'assistant',
          api: 'openai-responses',
          provider: 'openrouter',
          model: 'openrouter/moonshotai/kimi-k2.5',
          usage: {
            input: 100,
            output: 25,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 125,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: 'toolUse',
          timestamp: 1_700_000_000_100,
          content: [
            { type: 'thinking', thinking: 'Need the patch tool to correct this memory.' },
            {
              type: 'toolCall',
              id: 'call-1',
              name: 'memory',
              arguments: { action: 'patch', memory_id: 'memory-1', text: 'patched value' },
              thoughtSignature: 'sig-1',
            },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'memory',
          isError: false,
          timestamp: 1_700_000_000_150,
          content: [{ type: 'text', text: 'Memory patched.' }],
          details: { memoryId: 'memory-1', updatedFields: ['text'] },
        },
      ],
      promptMode: 'default',
      promptText: 'system prompt',
      contextMessageCount: 1,
      memoryContextChars: 0,
      trustLevel: 'regular',
      speakerRole: 'user',
      retrievalProvenanceRefs: [],
      hashPromptText: () => 'prompt-hash',
    });

    expect(record.toolCalls).toEqual([
      {
        toolName: 'memory',
        toolCallId: 'call-1',
        isError: false,
        arguments: {
          action: 'patch',
          memory_id: 'memory-1',
          text: 'patched value',
        },
        provenanceRefs: ['source:tool:memory|invocation:call-1'],
        resultText: 'Memory patched.',
        details: {
          memoryId: 'memory-1',
          updatedFields: ['text'],
        },
        rationale: 'Need the patch tool to correct this memory.',
        thoughtSignature: 'sig-1',
      },
    ]);
  });

  it('builds failed turn records without fabricating an assistant message', () => {
    const record = buildTurnRecord({
      message: {
        id: 'source-message-2',
        channelId: 'api:test',
        channelType: 'api',
        authorId: 'user-1',
        authorName: 'User',
        content: 'Store the secret.',
        timestamp: new Date(1_700_000_100_000),
      },
      turnId: '019d2326-d9e1-701d-bcee-250d2cbb0e4f',
      requestId: 'req-turn-record-failed',
      startedAt: 1_700_000_100_000,
      completedAt: 1_700_000_100_250,
      userSessionEntryId: 1,
      assistantSessionEntryId: null,
      model: 'openrouter/moonshotai/kimi-k2.5',
      status: 'failed',
      turnMessages: [
        {
          role: 'assistant',
          api: 'openai-responses',
          provider: 'openrouter',
          model: 'openrouter/moonshotai/kimi-k2.5',
          usage: {
            input: 120,
            output: 15,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 135,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: 'toolUse',
          timestamp: 1_700_000_100_100,
          content: [
            { type: 'thinking', thinking: 'Need the memory tool first.' },
            {
              type: 'toolCall',
              id: 'call-2',
              name: 'memory',
              arguments: { action: 'write', text: 'secret value', type: 'semantic' },
              thoughtSignature: 'sig-2',
            },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 'call-2',
          toolName: 'memory',
          isError: false,
          timestamp: 1_700_000_100_180,
          content: [{ type: 'text', text: 'Memory stored.' }],
          details: { memoryId: 'memory-2' },
        },
      ],
      promptMode: 'default',
      promptText: 'system prompt',
      contextMessageCount: 1,
      memoryContextChars: 0,
      trustLevel: 'regular',
      speakerRole: 'user',
      retrievalProvenanceRefs: [],
      hashPromptText: () => 'prompt-hash',
    });

    expect(record.status).toBe('failed');
    expect(record.assistantMessage).toBeUndefined();
    expect(record.versionPointers.model).toBe('openrouter/moonshotai/kimi-k2.5');
    expect(record.toolCalls).toEqual([
      {
        toolName: 'memory',
        toolCallId: 'call-2',
        isError: false,
        arguments: { action: 'write', text: 'secret value', type: 'semantic' },
        provenanceRefs: ['source:tool:memory|invocation:call-2'],
        resultText: 'Memory stored.',
        details: { memoryId: 'memory-2' },
        rationale: 'Need the memory tool first.',
        thoughtSignature: 'sig-2',
      },
    ]);
  });

  it('normalizes malformed memory action=write arguments in the canonical turn record', () => {
    const record = buildTurnRecord({
      message: {
        id: 'source-message-3',
        channelId: 'api:test',
        channelType: 'api',
        authorId: 'user-1',
        authorName: 'User',
        content: 'Store the exact secret.',
        timestamp: new Date(1_700_000_200_000),
      },
      turnId: '019d2326-d9e1-701d-bcee-250d2cbb0e50',
      requestId: 'req-turn-record-normalized',
      startedAt: 1_700_000_200_000,
      completedAt: 1_700_000_200_250,
      userSessionEntryId: 1,
      assistantSessionEntryId: 2,
      response: {
        content: 'Stored.',
        channelId: 'api:test',
        metadata: {
          model: 'openrouter/moonshotai/kimi-k2.5',
          inputTokens: 120,
          outputTokens: 20,
          durationMs: 250,
        },
      },
      turnMessages: [
        {
          role: 'assistant',
          api: 'openai-responses',
          provider: 'openrouter',
          model: 'openrouter/moonshotai/kimi-k2.5',
          usage: {
            input: 120,
            output: 20,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 140,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: 'toolUse',
          timestamp: 1_700_000_200_100,
          content: [
            { type: 'thinking', thinking: 'Need to save the exact secret string.' },
            {
              type: 'toolCall',
              id: 'call-3',
              name: 'memory',
              arguments: {
                action: 'write',
                text: ': "matrix-secret-2026-04-10T04-49-43-076Z", "type": "semantic", "sensitivity": "personal"}',
                content: 'matrix-secret-2026-04-10T04-49-43-076Z',
                type: 'semantic',
                sensitivity: 'personal',
              },
              thoughtSignature: 'sig-3',
            },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 'call-3',
          toolName: 'memory',
          isError: false,
          timestamp: 1_700_000_200_180,
          content: [{ type: 'text', text: 'Memory stored.' }],
          details: { memoryId: 'memory-3' },
        },
      ],
      promptMode: 'default',
      promptText: 'system prompt',
      contextMessageCount: 1,
      memoryContextChars: 0,
      trustLevel: 'regular',
      speakerRole: 'user',
      retrievalProvenanceRefs: [],
      hashPromptText: () => 'prompt-hash',
    });

    expect(record.toolCalls).toEqual([
      {
        toolName: 'memory',
        toolCallId: 'call-3',
        isError: false,
        arguments: {
          action: 'write',
          text: 'matrix-secret-2026-04-10T04-49-43-076Z',
          type: 'semantic',
          sensitivity: 'personal',
        },
        provenanceRefs: ['source:tool:memory|invocation:call-3'],
        resultText: 'Memory stored.',
        details: { memoryId: 'memory-3' },
        rationale: 'Need to save the exact secret string.',
        thoughtSignature: 'sig-3',
      },
    ]);
  });

  it('normalizes placeholder memory action=write text from step_text in the canonical turn record', () => {
    const record = buildTurnRecord({
      message: {
        id: 'source-message-4',
        channelId: 'api:test',
        channelType: 'api',
        authorId: 'user-1',
        authorName: 'User',
        content: 'Store the exact secret again.',
        timestamp: new Date(1_700_000_300_000),
      },
      turnId: '019d2326-d9e1-701d-bcee-250d2cbb0e51',
      requestId: 'req-turn-record-step-text',
      startedAt: 1_700_000_300_000,
      completedAt: 1_700_000_300_250,
      userSessionEntryId: 1,
      assistantSessionEntryId: 2,
      response: {
        content: 'Stored.',
        channelId: 'api:test',
        metadata: {
          model: 'openrouter/moonshotai/kimi-k2.5',
          inputTokens: 120,
          outputTokens: 20,
          durationMs: 250,
        },
      },
      turnMessages: [
        {
          role: 'assistant',
          api: 'openai-responses',
          provider: 'openrouter',
          model: 'openrouter/moonshotai/kimi-k2.5',
          usage: {
            input: 120,
            output: 20,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 140,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: 'toolUse',
          timestamp: 1_700_000_300_100,
          content: [
            { type: 'thinking', thinking: 'Need to save the exact secret string.' },
            {
              type: 'toolCall',
              id: 'call-4',
              name: 'memory',
              arguments: {
                action: 'write',
                text: '.',
                step_text: 'matrix-secret-2026-04-10T05-00-06-862Z',
                type: 'semantic',
                sensitivity: 'personal',
              },
              thoughtSignature: 'sig-4',
            },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 'call-4',
          toolName: 'memory',
          isError: false,
          timestamp: 1_700_000_300_180,
          content: [{ type: 'text', text: 'Memory stored.' }],
          details: { memoryId: 'memory-4' },
        },
      ],
      promptMode: 'default',
      promptText: 'system prompt',
      contextMessageCount: 1,
      memoryContextChars: 0,
      trustLevel: 'regular',
      speakerRole: 'user',
      retrievalProvenanceRefs: [],
      hashPromptText: () => 'prompt-hash',
    });

    expect(record.toolCalls).toEqual([
      {
        toolName: 'memory',
        toolCallId: 'call-4',
        isError: false,
        arguments: {
          action: 'write',
          text: 'matrix-secret-2026-04-10T05-00-06-862Z',
          type: 'semantic',
          sensitivity: 'personal',
        },
        provenanceRefs: ['source:tool:memory|invocation:call-4'],
        resultText: 'Memory stored.',
        details: { memoryId: 'memory-4' },
        rationale: 'Need to save the exact secret string.',
        thoughtSignature: 'sig-4',
      },
    ]);
  });

  it('normalizes memory id aliases in the canonical turn record', () => {
    const record = buildTurnRecord({
      message: {
        id: 'source-message-5',
        channelId: 'api:test',
        channelType: 'api',
        authorId: 'user-1',
        authorName: 'User',
        content: 'Patch then delete the memory.',
        timestamp: new Date(1_700_000_350_000),
      },
      turnId: '019d2326-d9e1-701d-bcee-250d2cbb0e52',
      requestId: 'req-turn-record-memory-id-alias',
      startedAt: 1_700_000_350_000,
      completedAt: 1_700_000_350_300,
      userSessionEntryId: 1,
      assistantSessionEntryId: 2,
      response: {
        content: 'Done.',
        channelId: 'api:test',
        metadata: {
          model: 'openrouter/moonshotai/kimi-k2.5',
          inputTokens: 120,
          outputTokens: 20,
          durationMs: 300,
        },
      },
      turnMessages: [
        {
          role: 'assistant',
          api: 'openai-responses',
          provider: 'openrouter',
          model: 'openrouter/moonshotai/kimi-k2.5',
          usage: {
            input: 120,
            output: 20,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 140,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: 'toolUse',
          timestamp: 1_700_000_350_100,
          content: [
            { type: 'thinking', thinking: 'Need to patch it, then remove it cleanly.' },
            {
              type: 'toolCall',
              id: 'call-5',
              name: 'memory',
              arguments: {
                action: 'patch',
                id: 'memory-5',
                text: 'patched value',
              },
              thoughtSignature: 'sig-5',
            },
            {
              type: 'toolCall',
              id: 'call-6',
              name: 'memory',
              arguments: {
                action: 'delete',
                id: 'memory-5',
                reason: 'cleanup',
              },
              thoughtSignature: 'sig-6',
            },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 'call-5',
          toolName: 'memory',
          isError: false,
          timestamp: 1_700_000_350_180,
          content: [{ type: 'text', text: 'Memory patched.' }],
          details: { memoryId: 'memory-5', updatedFields: ['text'] },
        },
        {
          role: 'toolResult',
          toolCallId: 'call-6',
          toolName: 'memory',
          isError: false,
          timestamp: 1_700_000_350_220,
          content: [{ type: 'text', text: 'Memory deleted.' }],
          details: { memoryId: 'memory-5', deleteId: 'delete-5' },
        },
      ],
      promptMode: 'default',
      promptText: 'system prompt',
      contextMessageCount: 1,
      memoryContextChars: 0,
      trustLevel: 'regular',
      speakerRole: 'user',
      retrievalProvenanceRefs: [],
      hashPromptText: () => 'prompt-hash',
    });

    expect(record.toolCalls).toEqual([
      {
        toolName: 'memory',
        toolCallId: 'call-5',
        isError: false,
        arguments: {
          action: 'patch',
          memory_id: 'memory-5',
          text: 'patched value',
        },
        provenanceRefs: ['source:tool:memory|invocation:call-5'],
        resultText: 'Memory patched.',
        details: { memoryId: 'memory-5', updatedFields: ['text'] },
        rationale: 'Need to patch it, then remove it cleanly.',
        thoughtSignature: 'sig-5',
      },
      {
        toolName: 'memory',
        toolCallId: 'call-6',
        isError: false,
        arguments: {
          action: 'delete',
          memory_id: 'memory-5',
          reason: 'cleanup',
        },
        provenanceRefs: ['source:tool:memory|invocation:call-6'],
        resultText: 'Memory deleted.',
        details: { memoryId: 'memory-5', deleteId: 'delete-5' },
        rationale: 'Need to patch it, then remove it cleanly.',
        thoughtSignature: 'sig-6',
      },
    ]);
  });

  it('normalizes malformed fs_read path arguments in the canonical turn record', () => {
    const record = buildTurnRecord({
      message: {
        id: 'source-message-fs-read',
        channelId: 'api:test',
        channelType: 'api',
        authorId: 'user-1',
        authorName: 'User',
        content: 'Read the welcome doc.',
        timestamp: new Date(1_700_000_320_000),
      },
      turnId: '019d2326-d9e1-701d-bcee-250d2cbb0e70',
      requestId: 'req-turn-record-fs-read-normalized',
      startedAt: 1_700_000_320_000,
      completedAt: 1_700_000_320_250,
      userSessionEntryId: 1,
      assistantSessionEntryId: 2,
      response: {
        content: 'Read.',
        channelId: 'api:test',
        metadata: {
          model: 'openrouter/moonshotai/kimi-k2.5',
          inputTokens: 80,
          outputTokens: 12,
          durationMs: 250,
        },
      },
      turnMessages: [
        {
          role: 'assistant',
          api: 'openai-responses',
          provider: 'openrouter',
          model: 'openrouter/moonshotai/kimi-k2.5',
          usage: {
            input: 80,
            output: 12,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 92,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: 'toolUse',
          timestamp: 1_700_000_320_100,
          content: [
            { type: 'thinking', thinking: 'Need to open the welcome doc first.' },
            {
              type: 'toolCall',
              id: 'call-fs-read-1',
              name: 'fs_read',
              arguments: {
                file_path: '>companion/docs/welcome.md',
              },
            },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 'call-fs-read-1',
          toolName: 'fs_read',
          isError: false,
          timestamp: 1_700_000_320_180,
          content: [{ type: 'text', text: '# Welcome Home' }],
          details: {},
        },
      ],
      promptMode: 'default',
      promptText: 'system prompt',
      contextMessageCount: 1,
      memoryContextChars: 0,
      trustLevel: 'regular',
      speakerRole: 'user',
      retrievalProvenanceRefs: [],
      hashPromptText: () => 'prompt-hash',
    });

    expect(record.toolCalls).toEqual([
      {
        toolName: 'fs_read',
        toolCallId: 'call-fs-read-1',
        isError: false,
        arguments: {
          path: 'companion/docs/welcome.md',
        },
        provenanceRefs: ['source:tool:fs_read|invocation:call-fs-read-1'],
        resultText: '# Welcome Home',
        details: {},
        rationale: 'Need to open the welcome doc first.',
      },
    ]);
  });

  it('normalizes structured lifecycle reasons in the canonical turn record', () => {
    const record = buildTurnRecord({
      message: {
        id: 'source-message-self-rebuild',
        channelId: 'api:test',
        channelType: 'api',
        authorId: 'user-1',
        authorName: 'User',
        content: 'Rebuild yourself.',
        timestamp: new Date(1_700_000_330_000),
      },
      turnId: '019d2326-d9e1-701d-bcee-250d2cbb0e71',
      requestId: 'req-turn-record-self-rebuild-normalized',
      startedAt: 1_700_000_330_000,
      completedAt: 1_700_000_330_250,
      userSessionEntryId: 1,
      assistantSessionEntryId: 2,
      response: {
        content: 'Rebuild queued.',
        channelId: 'api:test',
        metadata: {
          model: 'openrouter/moonshotai/kimi-k2.5',
          inputTokens: 80,
          outputTokens: 12,
          durationMs: 250,
        },
      },
      turnMessages: [
        {
          role: 'assistant',
          api: 'openai-responses',
          provider: 'openrouter',
          model: 'openrouter/moonshotai/kimi-k2.5',
          usage: {
            input: 80,
            output: 12,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 92,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: 'toolUse',
          timestamp: 1_700_000_330_100,
          content: [
            { type: 'thinking', thinking: 'Need to queue a rebuild after this turn.' },
            {
              type: 'toolCall',
              id: 'call-self-rebuild-1',
              name: 'self_rebuild',
              arguments: {
                reason: {
                  note: 'autonomous shakedown rebuild',
                },
              },
            },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 'call-self-rebuild-1',
          toolName: 'self_rebuild',
          isError: false,
          timestamp: 1_700_000_330_180,
          content: [{ type: 'text', text: 'Rebuild queued.' }],
          details: {},
        },
      ],
      promptMode: 'default',
      promptText: 'system prompt',
      contextMessageCount: 1,
      memoryContextChars: 0,
      trustLevel: 'regular',
      speakerRole: 'user',
      retrievalProvenanceRefs: [],
      hashPromptText: () => 'prompt-hash',
    });

    expect(record.toolCalls).toEqual([
      {
        toolName: 'self_rebuild',
        toolCallId: 'call-self-rebuild-1',
        isError: false,
        arguments: {
          reason: 'autonomous shakedown rebuild',
        },
        provenanceRefs: ['source:tool:self_rebuild|invocation:call-self-rebuild-1'],
        resultText: 'Rebuild queued.',
        details: {},
        rationale: 'Need to queue a rebuild after this turn.',
      },
    ]);
  });

  it('normalizes lifecycle primary_reason wrappers in the canonical turn record', () => {
    const record = buildTurnRecord({
      message: {
        id: 'source-message-lifecycle-restart',
        channelId: 'api:test',
        channelType: 'api',
        authorId: 'user-1',
        authorName: 'User',
        content: 'restart please',
        timestamp: new Date(1_700_000_331_000),
      },
      turnId: '019d2326-d9e1-701d-bcee-250d2cbb0e53',
      requestId: 'req-turn-record-lifecycle-restart',
      startedAt: 1_700_000_331_000,
      completedAt: 1_700_000_331_200,
      userSessionEntryId: 1,
      assistantSessionEntryId: 2,
      response: {
        content: 'Restart queued.',
        channelId: 'api:test',
        metadata: {
          model: 'openrouter/moonshotai/kimi-k2.5',
          inputTokens: 64,
          outputTokens: 18,
          durationMs: 200,
        },
      },
      turnMessages: [
        {
          role: 'assistant',
          api: 'openai-responses',
          provider: 'openrouter',
          model: 'openrouter/moonshotai/kimi-k2.5',
          usage: {
            input: 64,
            output: 18,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 82,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: 'toolUse',
          timestamp: 1_700_000_331_100,
          content: [
            { type: 'thinking', thinking: 'Need to queue a restart after this turn.' },
            {
              type: 'toolCall',
              id: 'call-self-restart-1',
              name: 'self_restart',
              arguments: {
                reason: {
                  primary_reason: 'autonomous shakedown restart',
                },
              },
            },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 'call-self-restart-1',
          toolName: 'self_restart',
          isError: false,
          timestamp: 1_700_000_331_180,
          content: [{ type: 'text', text: 'Restart queued.' }],
          details: {},
        },
      ],
      promptMode: 'default',
      promptText: 'system prompt',
      contextMessageCount: 1,
      memoryContextChars: 0,
      trustLevel: 'regular',
      speakerRole: 'user',
      retrievalProvenanceRefs: [],
      hashPromptText: () => 'prompt-hash',
    });

    expect(record.toolCalls).toEqual([
      {
        toolName: 'self_restart',
        toolCallId: 'call-self-restart-1',
        isError: false,
        arguments: {
          reason: 'autonomous shakedown restart',
        },
        provenanceRefs: ['source:tool:self_restart|invocation:call-self-restart-1'],
        resultText: 'Restart queued.',
        details: {},
        rationale: 'Need to queue a restart after this turn.',
      },
    ]);
  });

  it('collects explicit provenance refs from tool result details', () => {
    const record = buildTurnRecord({
      message: {
        id: 'source-message-5',
        channelId: 'api:test',
        channelType: 'api',
        authorId: 'user-1',
        authorName: 'User',
        content: 'Analyze the image.',
        timestamp: new Date(1_700_000_400_000),
      },
      turnId: '019d2326-d9e1-701d-bcee-250d2cbb0e52',
      requestId: 'req-turn-record-provenance',
      startedAt: 1_700_000_400_000,
      completedAt: 1_700_000_400_250,
      userSessionEntryId: 1,
      assistantSessionEntryId: 2,
      response: {
        content: 'Analyzed.',
        channelId: 'api:test',
        metadata: {
          model: 'openrouter/moonshotai/kimi-k2.5',
          inputTokens: 120,
          outputTokens: 20,
          durationMs: 250,
        },
      },
      turnMessages: [
        {
          role: 'assistant',
          api: 'openai-responses',
          provider: 'openrouter',
          model: 'openrouter/moonshotai/kimi-k2.5',
          usage: {
            input: 120,
            output: 20,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 140,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: 'toolUse',
          timestamp: 1_700_000_400_100,
          content: [
            { type: 'thinking', thinking: 'Need the image tool first.' },
            {
              type: 'toolCall',
              id: 'call-5',
              name: 'media',
              arguments: { action: 'analyze', input_urls: ['https://example.test/cat.png'] },
              thoughtSignature: 'sig-5',
            },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 'call-5',
          toolName: 'media',
          isError: false,
          timestamp: 1_700_000_400_180,
          content: [{ type: 'text', text: 'Image analyzed.' }],
          details: {
            provenanceRef: 'image:artifact:cat03',
            nested: {
              sourceRefs: ['vision:model:google/gemini-3-flash-preview'],
            },
          },
        },
      ],
      promptMode: 'default',
      promptText: 'system prompt',
      contextMessageCount: 1,
      memoryContextChars: 0,
      trustLevel: 'regular',
      speakerRole: 'user',
      retrievalProvenanceRefs: [],
      hashPromptText: () => 'prompt-hash',
    });

    expect(record.toolCalls).toEqual([
      {
        toolName: 'media',
        toolCallId: 'call-5',
        isError: false,
        arguments: {
          action: 'analyze',
          input_urls: ['https://example.test/cat.png'],
        },
        provenanceRefs: [
          'source:tool:media|invocation:call-5',
          'image:artifact:cat03',
          'vision:model:google/gemini-3-flash-preview',
        ],
        resultText: 'Image analyzed.',
        details: {
          provenanceRef: 'image:artifact:cat03',
          nested: {
            sourceRefs: ['vision:model:google/gemini-3-flash-preview'],
          },
        },
        rationale: 'Need the image tool first.',
        thoughtSignature: 'sig-5',
      },
    ]);
  });

  it('drops contaminated tool rationale and prompt reasoning from persisted turn artifacts', () => {
    const record = buildTurnRecord({
      message: {
        id: 'source-message-6',
        channelId: 'api:test',
        channelType: 'api',
        authorId: 'user-1',
        authorName: 'User',
        content: 'Review the scratchpad.',
        timestamp: new Date(1_700_000_500_000),
      },
      turnId: '019d2326-d9e1-701d-bcee-250d2cbb0e53',
      requestId: 'req-turn-record-contaminated',
      startedAt: 1_700_000_500_000,
      completedAt: 1_700_000_500_250,
      userSessionEntryId: 1,
      assistantSessionEntryId: 2,
      response: {
        content: 'Reviewed.',
        channelId: 'api:test',
        metadata: {
          model: 'openrouter/moonshotai/kimi-k2.5',
          inputTokens: 120,
          outputTokens: 20,
          durationMs: 250,
        },
      },
      turnMessages: [
        {
          role: 'assistant',
          api: 'openai-responses',
          provider: 'openrouter',
          model: 'openrouter/moonshotai/kimi-k2.5',
          usage: {
            input: 120,
            output: 20,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 140,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: 'toolUse',
          timestamp: 1_700_000_500_100,
          content: [
            {
              type: 'thinking',
              thinking: '[Scratchpad]\nWorking notes (short-term, may be stale; verify before acting):\n- stale note',
            },
            {
              type: 'toolCall',
              id: 'call-6',
              name: 'scratchpad',
              arguments: { action: 'list' },
              thoughtSignature: 'sig-6',
            },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 'call-6',
          toolName: 'scratchpad',
          isError: false,
          timestamp: 1_700_000_500_180,
          content: [{ type: 'text', text: 'Scratchpad read.' }],
          details: {},
        },
      ],
      turnObservability: {
        stages: [],
        retrievals: [],
        snapshot: {
          turnId: '019d2326-d9e1-701d-bcee-250d2cbb0e53',
          requestId: 'req-turn-record-contaminated',
          channelId: 'api:test',
          capturedAt: 1_700_000_500_200,
          trustLevel: 'regular',
          promptContext: {
            renderedStaticPrefix: '',
            renderedDynamicSuffix: '',
            runtimeContext: '',
            memoryContextBlock: '',
            scratchpadContext: '',
            assembledPrompt: '',
            finalSystemPrompt: '',
            messages: [],
            response: {
              content: 'Reviewed.',
              reasoning: 'None',
              model: 'openrouter/moonshotai/kimi-k2.5',
            },
          },
        },
      },
      promptMode: 'default',
      promptText: 'system prompt',
      contextMessageCount: 1,
      memoryContextChars: 0,
      trustLevel: 'regular',
      speakerRole: 'user',
      retrievalProvenanceRefs: [],
      hashPromptText: () => 'prompt-hash',
    });

    expect(record.toolCalls).toEqual([
      expect.objectContaining({
        toolName: 'scratchpad',
        toolCallId: 'call-6',
        thoughtSignature: 'sig-6',
      }),
    ]);
    expect(record.toolCalls[0]?.rationale).toBeUndefined();
    expect(record.observability?.snapshot?.promptContext?.response?.reasoning).toBeUndefined();
  });
});
