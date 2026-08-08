import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { UserMessage, AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai';
import type { AgentMessage } from '../../boundary/pi-agent/index.js';
import { PromptLayerStore } from '../identity/prompt-store.js';
import type { PromptLayer } from '../identity/prompt-types.js';
import type { PromptLayerStatePort } from '../identity/prompt-state-port.js';
import {
  ensureSystemLanguagePromptLayer,
  installSystemLanguagePromptLayerSource,
  resetSystemLanguageRuntimeForTests,
} from '../identity/system-language.js';
import {
  convertToLlm,
  sessionEntryToMessage,
  compactionToMessage,
  isCompactionMessage,
  isSystemNoteMessage,
  isInternalWhisperMessage,
  isContinuityMessage,
  isMirrorMessage,
  isCustomMessage,
  type CompactionMessage,
  type SystemNoteMessage,
  type InternalWhisperMessage,
  type ContinuityMessage,
  type MirrorMessage,
} from './messages.js';
import { MESSAGE_CLASSES } from './message-classes.js';
import type { SessionEntry, CompactionSummary } from '../session/types.js';
import { getToolResultInvocationAudit } from './tool-result-invocation-audit.js';

const NOW = Date.now();

function makeUser(content: string): UserMessage & { messageClass: typeof MESSAGE_CLASSES.outwardSpeech } {
  return { role: 'user', content, timestamp: NOW, messageClass: MESSAGE_CLASSES.outwardSpeech };
}

function makeAssistant(text: string): AssistantMessage & { messageClass: typeof MESSAGE_CLASSES.outwardSpeech } {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: '', provider: '', model: '',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: NOW,
    messageClass: MESSAGE_CLASSES.outwardSpeech,
  };
}

function makeMusingAssistant(text: string): AssistantMessage & { messageClass: typeof MESSAGE_CLASSES.musing } {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: '', provider: '', model: '',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: NOW,
    messageClass: MESSAGE_CLASSES.musing,
  };
}

function makeCompaction(summary: string): CompactionMessage {
  return {
    role: 'custom',
    type: 'compaction',
    messageClass: MESSAGE_CLASSES.compaction,
    summary,
    coveredUpTo: 5,
    timestamp: NOW,
  };
}

function makeSystemNote(content: string): SystemNoteMessage {
  return {
    role: 'custom',
    type: 'systemNote',
    messageClass: MESSAGE_CLASSES.systemNote,
    content,
    timestamp: NOW,
  };
}

function makeWhisper(content: string, speakerName = 'Whisper'): InternalWhisperMessage {
  return {
    role: 'custom',
    type: 'internalWhisper',
    messageClass: MESSAGE_CLASSES.internalWhisper,
    content,
    speakerName,
    timestamp: NOW,
  };
}

function makeContinuity(content: string): ContinuityMessage {
  return {
    role: 'custom',
    type: 'continuity',
    messageClass: MESSAGE_CLASSES.continuity,
    content,
    originChannelId: 'ch1',
    timestamp: NOW,
  };
}

function makeMirror(content: string): MirrorMessage {
  return {
    role: 'custom',
    type: 'mirror',
    content,
    originChannelId: 'api:other',
    sourceRole: 'assistant',
    messageClass: MESSAGE_CLASSES.mirror,
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

  it('isInternalWhisperMessage', () => {
    expect(isInternalWhisperMessage(makeWhisper('test'))).toBe(true);
    expect(isInternalWhisperMessage(makeUser('test'))).toBe(false);
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
    expect(isCustomMessage(makeWhisper('test'))).toBe(true);
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
    expect((result[0] as { messageClass?: string }).messageClass).toBe(MESSAGE_CLASSES.outwardSpeech);
    expect((result[1] as { messageClass?: string }).messageClass).toBe(MESSAGE_CLASSES.outwardSpeech);
  });

  it('preserves the canonical musing class on outward reflection assistant messages', () => {
    const result = convertToLlm([makeMusingAssistant('a quiet thought for Discord')]);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('assistant');
    expect((result[0] as { messageClass?: string }).messageClass).toBe(MESSAGE_CLASSES.musing);
  });

  it('converts compaction to user message with summary prefix', () => {
    const messages: AgentMessage[] = [makeCompaction('Users discussed cats')];
    const result = convertToLlm(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
    expect((result[0] as UserMessage).content).toContain('[Previous conversation summary]');
    expect((result[0] as UserMessage).content).not.toContain('kind="compaction_summary"');
    expect((result[0] as UserMessage).content).not.toContain('safe_as_partner_speech="false"');
    expect((result[0] as UserMessage).content).toContain('Users discussed cats');
    expect((result[0] as { messageClass?: string }).messageClass).toBe(MESSAGE_CLASSES.compaction);
  });

  it('converts system note to an assistant-side internal note with prefix', () => {
    const messages: AgentMessage[] = [makeSystemNote('Agent restarted')];
    const result = convertToLlm(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('assistant');
    expect((result[0] as AssistantMessage).content).toEqual([
      { type: 'text', text: '[System note] Agent restarted' },
    ]);
    expect((result[0] as { messageClass?: string }).messageClass).toBe(MESSAGE_CLASSES.systemNote);
  });

  it('converts internal whispers to an assistant-side internal note', () => {
    const result = convertToLlm([makeWhisper('Stay gentle and concrete.')]);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('assistant');
    expect((result[0] as AssistantMessage).content).toEqual([
      {
        type: 'text',
        text: '[Private runtime note to self; not Participant-visible and not sent by a Participant] Stay gentle and concrete.',
      },
    ]);
    expect((result[0] as { messageClass?: string }).messageClass).toBe(MESSAGE_CLASSES.internalWhisper);
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
    expect(result[2].role).toBe('assistant');
    expect((result[2] as AssistantMessage).content).toEqual([
      { type: 'text', text: '[System note] config changed' },
    ]);
    expect((result[3] as UserMessage).content).toContain('[Mirror note from api:other]');
    expect(result[4].role).toBe('assistant');
    expect((result[0] as { messageClass?: string }).messageClass).toBe(MESSAGE_CLASSES.compaction);
    expect((result[1] as { messageClass?: string }).messageClass).toBe(MESSAGE_CLASSES.outwardSpeech);
    expect((result[2] as { messageClass?: string }).messageClass).toBe(MESSAGE_CLASSES.systemNote);
    expect((result[3] as { messageClass?: string }).messageClass).toBe(MESSAGE_CLASSES.mirror);
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
    expect((result[0] as { messageClass?: string }).messageClass).toBe(MESSAGE_CLASSES.mirror);
  });

  it('uses the neutral named label, never the raw wire role, for assistant mirrors without a source author name', () => {
    const result = convertToLlm([makeMirror('hello from another channel')]);
    expect(result).toHaveLength(1);
    const text = (result[0] as UserMessage).content;
    expect(text).toContain('Me: hello from another channel');
    expect(text).not.toContain('assistant:');
  });

  it('handles empty message array', () => {
    expect(convertToLlm([])).toEqual([]);
  });

  it('rejects upstream harness custom messages without a PSFN type discriminator', () => {
    const message = {
      role: 'custom',
      customType: 'harness-note',
      content: 'must not cross the model boundary implicitly',
      display: false,
      timestamp: NOW,
    } as AgentMessage;

    expect(() => convertToLlm([message])).toThrow('Unsupported agent message role "custom"');
  });

  it('rejects upstream harness execution messages at the model boundary', () => {
    const message = {
      role: 'bashExecution',
      command: 'true',
      output: '',
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: NOW,
    } as AgentMessage;

    expect(() => convertToLlm([message])).toThrow('Unsupported agent message role "bashExecution"');
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
    expect((msg as { messageClass?: string }).messageClass).toBe(MESSAGE_CLASSES.outwardSpeech);
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
    expect((msg as { messageClass?: string }).messageClass).toBe(MESSAGE_CLASSES.outwardSpeech);
  });

  it('converts musing reflection assistant entries to AssistantMessage with the musing class', () => {
    const entry: SessionEntry = {
      id: 21, channelId: 'internal:reflection:musing', role: 'assistant',
      content: 'a quiet thought', timestamp: NOW,
    };
    const msg = sessionEntryToMessage(entry);
    expect(msg.role).toBe('assistant');
    expect((msg as { messageClass?: string }).messageClass).toBe(MESSAGE_CLASSES.musing);
  });

  it('normalizes legacy whisper reflection assistant entries to the canonical musing class', () => {
    const entry: SessionEntry = {
      id: 22, channelId: 'internal:reflection:whisper', role: 'assistant',
      content: 'a legacy quiet thought', timestamp: NOW,
    };
    const msg = sessionEntryToMessage(entry);
    expect(msg.role).toBe('assistant');
    expect((msg as { messageClass?: string }).messageClass).toBe(MESSAGE_CLASSES.musing);
  });

  it('converts system entry to SystemNoteMessage', () => {
    const entry: SessionEntry = {
      id: 3, channelId: 'ch1', role: 'system',
      content: 'self-check complete', timestamp: NOW,
    };
    const msg = sessionEntryToMessage(entry);
    expect(isSystemNoteMessage(msg)).toBe(true);
    expect((msg as SystemNoteMessage).content).toBe('self-check complete');
    expect((msg as { messageClass?: string }).messageClass).toBe(MESSAGE_CLASSES.systemNote);
  });

  it('converts mirrored system entry to MirrorMessage', () => {
    const entry: SessionEntry = {
      id: 4,
      channelId: 'api:target',
      role: 'system',
      content: `Companion [from api:origin]: hi`,
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
    expect(mirror.messageClass).toBe(MESSAGE_CLASSES.mirror);
  });

  it('converts tool entry to ToolResultMessage', () => {
    const entry: SessionEntry = {
      id: 5,
      channelId: 'ch1',
      role: 'tool',
      content: 'matched 2 files',
      timestamp: NOW,
      metadata: JSON.stringify({
        toolObservation: {
          schemaVersion: 1,
          toolName: 'search_files',
          toolCallId: 'tool-1',
          invocationAudit: {
            arguments: { action: 'search', query: '*.ts' },
            rationale: 'Find matching source files.',
          },
          truncated: false,
          originalCharLength: 15,
        },
      }),
    };
    const msg = sessionEntryToMessage(entry) as ToolResultMessage;
    expect(msg.role).toBe('toolResult');
    expect(msg.toolName).toBe('search_files');
    expect(msg.toolCallId).toBe('tool-1');
    expect(msg.content).toEqual([{ type: 'text', text: 'matched 2 files' }]);
    expect(msg.isError).toBe(false);
    expect(getToolResultInvocationAudit(msg)).toEqual({
      arguments: { action: 'search', query: '*.ts' },
      rationale: 'Find matching source files.',
    });
    expect(JSON.stringify(convertToLlm([msg]))).not.toContain('psfnInvocationAudit');
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
    expect(msg.messageClass).toBe(MESSAGE_CLASSES.compaction);
  });
});

describe('companion-configurable chassis phrasing (system.language)', () => {
  afterEach(() => {
    resetSystemLanguageRuntimeForTests();
  });

  function makeUserMirror(content: string): MirrorMessage {
    return {
      role: 'custom',
      type: 'mirror',
      content,
      originChannelId: 'api:other',
      sourceRole: 'user',
      messageClass: MESSAGE_CLASSES.mirror,
      timestamp: NOW,
    };
  }

  function withInstalledLanguage(overrides: Record<string, string>, run: () => void): void {
    const tmpDir = mkdtempSync(join(tmpdir(), 'psfn-messages-language-'));
    try {
      const store = new PromptLayerStore(
        join(tmpDir, 'prompt-layers.json'),
        join(tmpDir, 'prompt-history.jsonl'),
      );
      const layer = ensureSystemLanguagePromptLayer(store);
      const payload = JSON.parse(layer.content) as { templates: Record<string, string> };
      Object.assign(payload.templates, overrides);
      store.update(layer.id, JSON.stringify(payload), 'admin');
      installSystemLanguagePromptLayerSource(store);
      run();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  it('renders the current default chassis strings when no layer source is installed', () => {
    resetSystemLanguageRuntimeForTests();
    const result = convertToLlm([makeSystemNote('boot'), makeWhisper('breathe')]);
    expect((result[0] as AssistantMessage).content).toEqual([
      { type: 'text', text: '[System note] boot' },
    ]);
    expect((result[1] as AssistantMessage).content).toEqual([
      { type: 'text', text: '[Private runtime note to self; not Participant-visible and not sent by a Participant] breathe' },
    ]);
  });

  it('renders companion-configured prefixes and speaker fallbacks without a code change', () => {
    withInstalledLanguage({
      'system_note.prefix': '[Note from the substrate]',
      'internal_whisper.prefix': '[A quiet aside just for me]',
      'mirror_note.speaker_self': 'My own voice',
      'mirror_note.speaker_other': 'A visitor',
    }, () => {
      const result = convertToLlm([
        makeSystemNote('boot'),
        makeWhisper('breathe'),
        makeMirror('echo self'),
        makeUserMirror('echo other'),
      ]);
      expect((result[0] as AssistantMessage).content).toEqual([
        { type: 'text', text: '[Note from the substrate] boot' },
      ]);
      expect((result[1] as AssistantMessage).content).toEqual([
        { type: 'text', text: '[A quiet aside just for me] breathe' },
      ]);
      expect((result[2] as UserMessage).content).toContain('My own voice: echo self');
      expect((result[3] as UserMessage).content).toContain('A visitor: echo other');
    });
  });

  it('never surfaces a raw wire role in a mirror-note speaker fallback', () => {
    resetSystemLanguageRuntimeForTests();
    const result = convertToLlm([makeMirror('self line'), makeUserMirror('other line')]);
    expect((result[0] as UserMessage).content).toContain('Me: self line');
    expect((result[0] as UserMessage).content).not.toContain('assistant:');
    expect((result[1] as UserMessage).content).toContain('Someone: other line');
    expect((result[1] as UserMessage).content).not.toContain('user:');
  });

  it('fails closed to defaults when the installed language layer is malformed', () => {
    const malformedPort = {
      getAll: () => ([{
        id: 'bad-language',
        type: 'system_language',
        identifier: 'system.language',
        enabled: true,
        content: '{"broken":',
      }] as unknown as PromptLayer[]),
    } as unknown as PromptLayerStatePort;
    installSystemLanguagePromptLayerSource(malformedPort);

    const result = convertToLlm([makeSystemNote('boot'), makeMirror('self line')]);
    expect((result[0] as AssistantMessage).content).toEqual([
      { type: 'text', text: '[System note] boot' },
    ]);
    expect((result[1] as UserMessage).content).toContain('Me: self line');
    expect((result[1] as UserMessage).content).not.toContain('assistant:');
  });
});
