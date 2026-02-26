import { describe, it, expect } from 'vitest';
import type { UserMessage, AssistantMessage } from '@mariozechner/pi-ai';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import {
  convertToLlm,
  sessionEntryToMessage,
  compactionToMessage,
  isCompactionMessage,
  isSystemNoteMessage,
  isContinuityMessage,
  isMirrorMessage,
  isCustomMessage,
  type CompactionMessage,
  type SystemNoteMessage,
  type ContinuityMessage,
  type MirrorMessage,
} from './messages.js';
import type { SessionEntry, CompactionSummary } from '../session/types.js';

const NOW = Date.now();

function makeUser(content: string): UserMessage {
  return { role: 'user', content, timestamp: NOW };
}

function makeAssistant(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: '', provider: '', model: '',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: NOW,
  };
}

function makeCompaction(summary: string): CompactionMessage {
  return { role: 'custom', type: 'compaction', summary, coveredUpTo: 5, timestamp: NOW };
}

function makeSystemNote(content: string): SystemNoteMessage {
  return { role: 'custom', type: 'systemNote', content, timestamp: NOW };
}

function makeContinuity(content: string): ContinuityMessage {
  return { role: 'custom', type: 'continuity', content, originChannelId: 'ch1', timestamp: NOW };
}

function makeMirror(content: string): MirrorMessage {
  return {
    role: 'custom',
    type: 'mirror',
    content,
    originChannelId: 'api:other',
    sourceRole: 'assistant',
    timestamp: NOW,
  };
}

describe('type guards', () => {
  it('isCompactionMessage', () => {
    expect(isCompactionMessage(makeCompaction('test'))).toBe(true);
    expect(isCompactionMessage(makeUser('test'))).toBe(false);
    expect(isCompactionMessage(makeSystemNote('test'))).toBe(false);
  });

  it('isSystemNoteMessage', () => {
    expect(isSystemNoteMessage(makeSystemNote('test'))).toBe(true);
    expect(isSystemNoteMessage(makeUser('test'))).toBe(false);
  });

  it('isContinuityMessage', () => {
    expect(isContinuityMessage(makeContinuity('test'))).toBe(true);
    expect(isContinuityMessage(makeUser('test'))).toBe(false);
  });

  it('isMirrorMessage', () => {
    expect(isMirrorMessage(makeMirror('test'))).toBe(true);
    expect(isMirrorMessage(makeUser('test'))).toBe(false);
  });

  it('isCustomMessage', () => {
    expect(isCustomMessage(makeCompaction('test'))).toBe(true);
    expect(isCustomMessage(makeSystemNote('test'))).toBe(true);
    expect(isCustomMessage(makeContinuity('test'))).toBe(true);
    expect(isCustomMessage(makeMirror('test'))).toBe(true);
    expect(isCustomMessage(makeUser('test'))).toBe(false);
    expect(isCustomMessage(makeAssistant('test'))).toBe(false);
  });
});

describe('convertToLlm', () => {
  it('passes through standard user/assistant messages', () => {
    const messages: AgentMessage[] = [makeUser('hello'), makeAssistant('hi')];
    const result = convertToLlm(messages);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe('user');
    expect(result[1].role).toBe('assistant');
  });

  it('converts compaction to user message with summary prefix', () => {
    const messages: AgentMessage[] = [makeCompaction('Users discussed cats')];
    const result = convertToLlm(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
    expect((result[0] as UserMessage).content).toBe(
      '[Previous conversation summary]\nUsers discussed cats',
    );
  });

  it('converts system note to user message with prefix', () => {
    const messages: AgentMessage[] = [makeSystemNote('Agent restarted')];
    const result = convertToLlm(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
    expect((result[0] as UserMessage).content).toBe('[System note] Agent restarted');
  });

  it('filters out continuity messages', () => {
    const messages: AgentMessage[] = [
      makeUser('hello'),
      makeContinuity('activity in another channel'),
      makeAssistant('hi'),
    ];
    const result = convertToLlm(messages);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe('user');
    expect(result[1].role).toBe('assistant');
  });

  it('handles mixed message types in correct order', () => {
    const messages: AgentMessage[] = [
      makeCompaction('Earlier context summary'),
      makeUser('hello'),
      makeSystemNote('config changed'),
      makeMirror('Mirror content should be compact'),
      makeAssistant('hi'),
    ];
    const result = convertToLlm(messages);
    expect(result).toHaveLength(5);
    expect((result[0] as UserMessage).content).toContain('[Previous conversation summary]');
    expect((result[1] as UserMessage).content).toBe('hello');
    expect((result[2] as UserMessage).content).toContain('[System note]');
    expect((result[3] as UserMessage).content).toContain('[Mirror note from api:other]');
    expect(result[4].role).toBe('assistant');
  });

  it('renders mirror entries as compact system notes', () => {
    const long = 'x'.repeat(400);
    const result = convertToLlm([makeMirror(long)]);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
    const text = (result[0] as UserMessage).content;
    expect(text).toContain('[Mirror note from api:other]');
    expect(text.length).toBeLessThan(long.length);
    expect(text.endsWith('...')).toBe(true);
  });

  it('handles empty message array', () => {
    expect(convertToLlm([])).toEqual([]);
  });
});

describe('sessionEntryToMessage', () => {
  it('converts user entry to UserMessage', () => {
    const entry: SessionEntry = {
      id: 1, channelId: 'ch1', role: 'user',
      content: 'hello', authorId: 'u1', authorName: 'Alice', timestamp: NOW,
    };
    const msg = sessionEntryToMessage(entry);
    expect(msg.role).toBe('user');
    expect((msg as UserMessage).content).toBe('hello');
    expect((msg as UserMessage).timestamp).toBe(NOW);
  });

  it('converts assistant entry to AssistantMessage', () => {
    const entry: SessionEntry = {
      id: 2, channelId: 'ch1', role: 'assistant',
      content: 'hi there', timestamp: NOW,
    };
    const msg = sessionEntryToMessage(entry);
    expect(msg.role).toBe('assistant');
    const am = msg as AssistantMessage;
    expect(am.content).toEqual([{ type: 'text', text: 'hi there' }]);
    expect(am.timestamp).toBe(NOW);
  });

  it('converts system entry to SystemNoteMessage', () => {
    const entry: SessionEntry = {
      id: 3, channelId: 'ch1', role: 'system',
      content: 'self-check complete', timestamp: NOW,
    };
    const msg = sessionEntryToMessage(entry);
    expect(isSystemNoteMessage(msg)).toBe(true);
    expect((msg as SystemNoteMessage).content).toBe('self-check complete');
  });

  it('converts mirrored system entry to MirrorMessage', () => {
    const entry: SessionEntry = {
      id: 4,
      channelId: 'api:target',
      role: 'system',
      content: 'PSFN [from api:origin]: hi',
      timestamp: NOW,
      metadata: JSON.stringify({
        type: 'mirror',
        sourceChannelId: 'api:origin',
        sourceRole: 'assistant',
      }),
      originChannelId: 'api:origin',
    };
    const msg = sessionEntryToMessage(entry);
    expect(isMirrorMessage(msg)).toBe(true);
    const mirror = msg as MirrorMessage;
    expect(mirror.originChannelId).toBe('api:origin');
    expect(mirror.sourceRole).toBe('assistant');
  });
});

describe('compactionToMessage', () => {
  it('converts CompactionSummary to CompactionMessage', () => {
    const summary: CompactionSummary = {
      id: 1, channelId: 'ch1', summary: 'Talked about cats',
      coveredUpTo: 10, createdAt: NOW,
    };
    const msg = compactionToMessage(summary);
    expect(isCompactionMessage(msg)).toBe(true);
    expect(msg.summary).toBe('Talked about cats');
    expect(msg.coveredUpTo).toBe(10);
    expect(msg.timestamp).toBe(NOW);
  });
});
