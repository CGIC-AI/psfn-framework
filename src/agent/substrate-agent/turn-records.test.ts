import { describe, expect, it } from 'vitest';
import { buildTurnRecord } from './turn-records.js';
import { createTurnId } from '../../turns/id.js';
import type { AgentResponse, SubstrateMessage } from '../../shared/contracts/runtime.js';

function makeMessage(overrides?: Partial<SubstrateMessage>): SubstrateMessage {
  return {
    id: 'msg-turn-record-1',
    channelId: 'test-channel',
    channelType: 'terminal',
    authorId: 'user-1',
    authorName: 'User',
    content: 'hello',
    timestamp: new Date(1_700_000_000_000),
    ...overrides,
  };
}

function makeResponse(): AgentResponse {
  return {
    channelId: 'test-channel',
    content: 'reply',
    metadata: {
      model: 'test/model',
      inputTokens: 1,
      outputTokens: 1,
      durationMs: 1,
    },
  };
}

describe('buildTurnRecord', () => {
  it('preserves system role for intention follow-up inputs', () => {
    const record = buildTurnRecord({
      message: makeMessage({
        id: 'intention-follow-up:test',
        authorId: 'system:intention',
        authorName: 'Intention Appraisal',
        content: '[SYSTEM: Intention Appraisal] follow-up',
      }),
      turnId: createTurnId(),
      requestId: 'intention-follow-up:test',
      startedAt: 1_700_000_000_000,
      completedAt: 1_700_000_000_100,
      userSessionEntryId: 1,
      assistantSessionEntryId: 2,
      response: makeResponse(),
      turnMessages: [],
      promptMode: 'default',
      promptText: 'prompt',
      contextMessageCount: 1,
      memoryContextChars: 0,
      trustLevel: 'regular',
      speakerRole: 'system',
      retrievalProvenanceRefs: [],
      hashPromptText: (text) => text,
    });

    expect(record.userMessage.role).toBe('system');
    expect(record.userMessage.authorId).toBe('system:intention');
  });

  it('preserves system role for scheduler-authored internal prompts', () => {
    const record = buildTurnRecord({
      message: makeMessage({
        id: 'reflection-whisper-1',
        channelId: 'internal:reflection:whisper',
        authorId: 'scheduler',
        authorName: 'Whisper',
        content: 'heartbeat prompt',
      }),
      turnId: createTurnId(),
      requestId: 'reflection-whisper-1',
      startedAt: 1_700_000_000_000,
      completedAt: 1_700_000_000_100,
      userSessionEntryId: null,
      assistantSessionEntryId: null,
      response: makeResponse(),
      turnMessages: [],
      promptMode: 'default',
      promptText: 'prompt',
      contextMessageCount: 0,
      memoryContextChars: 0,
      trustLevel: 'primary',
      speakerRole: 'system',
      retrievalProvenanceRefs: [],
      hashPromptText: (text) => text,
    });

    expect(record.userMessage.role).toBe('system');
    expect(record.userMessage.authorId).toBe('scheduler');
  });

  it('preserves user role when the turn speaker is user-authored', () => {
    const record = buildTurnRecord({
      message: makeMessage({
        id: 'user-turn-1',
        authorId: 'user-1',
        authorName: 'User',
        content: 'hello there',
      }),
      turnId: createTurnId(),
      requestId: 'user-turn-1',
      startedAt: 1_700_000_000_000,
      completedAt: 1_700_000_000_100,
      userSessionEntryId: 1,
      assistantSessionEntryId: 2,
      response: makeResponse(),
      turnMessages: [],
      promptMode: 'default',
      promptText: 'prompt',
      contextMessageCount: 1,
      memoryContextChars: 0,
      trustLevel: 'regular',
      speakerRole: 'user',
      retrievalProvenanceRefs: [],
      hashPromptText: (text) => text,
    });

    expect(record.userMessage.role).toBe('user');
    expect(record.userMessage.authorId).toBe('user-1');
  });
});
