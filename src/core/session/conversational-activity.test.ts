import { describe, expect, it } from 'vitest';
import type { SessionEntry } from './types.js';
import {
  classifyConversationalActivity,
  SESSION_CONVERSATIONAL_ACTIVITY_KINDS,
} from './conversational-activity.js';

function entry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    id: 1,
    channelId: 'api:contact-morgan',
    role: 'user',
    content: 'Hello',
    timestamp: 1_000,
    ...overrides,
  };
}

describe('classifyConversationalActivity', () => {
  it('uses a closed classification vocabulary', () => {
    expect(SESSION_CONVERSATIONAL_ACTIVITY_KINDS).toEqual([
      'direct_message',
      'group_conversation',
      'inter_companion',
      'experiential_free_time',
      'automation_scaffold',
      'journal',
      'health',
      'maintenance',
      'testing',
    ]);
  });

  it.each([
    ['direct human input', entry(), 'direct_message'],
    ['group companion reply', entry({
      role: 'assistant',
      channelVisibility: 'invite_only',
      metadata: JSON.stringify({ conversationOrigin: { schemaVersion: 1, kind: 'group_conversation' } }),
    }), 'group_conversation'],
    ['ICP turn', entry({
      channelId: 'companion-room:kitchen',
      role: 'assistant',
    }), 'inter_companion'],
    ['free-time experience', entry({
      channelId: 'internal:free-time:painting',
      role: 'assistant',
      authorName: 'Morgan',
    }), 'experiential_free_time'],
  ] as const)('includes %s as %s', (_label, candidate, kind) => {
    expect(classifyConversationalActivity(candidate)).toEqual({ kind, processable: true });
  });

  it.each([
    ['ambient presence', entry({
      role: 'system',
      metadata: JSON.stringify({
        sessionLane: { schemaVersion: 1, kind: 'internal', source: 'ambient_presence' },
      }),
    }), 'automation_scaffold'],
    ['temporal wake', entry({
      role: 'system',
      metadata: JSON.stringify({
        sessionLane: { schemaVersion: 1, kind: 'system_note', source: 'temporal_wakeup_morning' },
      }),
    }), 'automation_scaffold'],
    ['health', entry({ channelId: 'internal:health:runtime', role: 'assistant' }), 'health'],
    ['journal reflection', entry({ channelId: 'internal:reflection:daily', role: 'assistant' }), 'journal'],
    ['maintenance', entry({ channelId: 'internal:maintenance:memory', role: 'assistant' }), 'maintenance'],
    ['free-time framing prompt', entry({ channelId: 'internal:free-time:painting', role: 'system' }), 'automation_scaffold'],
    ['ICP scheduler prompt', entry({ channelId: 'companion-room:kitchen', role: 'system' }), 'automation_scaffold'],
    ['testing namespace', entry({ channelId: 'api:contact-morgan:testing:episode-fixture' }), 'testing'],
    ['testing provenance', entry({
      metadata: JSON.stringify({ testingHarness: { schemaVersion: 1, runId: 'run-1', purpose: 'e2e' } }),
    }), 'testing'],
    ['tool result', entry({ role: 'tool' }), 'maintenance'],
  ] as const)('excludes %s as %s', (_label, candidate, kind) => {
    expect(classifyConversationalActivity(candidate)).toEqual({ kind, processable: false });
  });

  it('fails closed when origin metadata is malformed', () => {
    expect(classifyConversationalActivity(entry({
      metadata: JSON.stringify({ conversationOrigin: { schemaVersion: 1, kind: 'surprise' } }),
    }))).toEqual({ kind: 'maintenance', processable: false });
  });
});
