import { describe, expect, it } from 'vitest';
import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import {
  buildDeferredToolHandoffCandidate,
  buildDeferredToolHandoffMessage,
  DEFERRED_TOOL_HANDOFF_AUTHOR_ID,
  DEFERRED_TOOL_HANDOFF_AUTHOR_NAME,
  normalizeDeferredToolHandoffPayload,
  normalizeDeferredToolHandoffIntent,
  normalizeToolNameList,
} from './deferred-tool-handoff.js';

describe('normalizeToolNameList', () => {
  it('accepts mixed string and object tool name entries', () => {
    expect(normalizeToolNameList([
      ' image_edit ',
      { name: 'image_analyze' },
      { name: 'image_edit' },
      { name: '   ' },
      { tool: 'ignored' },
      null,
    ])).toEqual(['image_edit', 'image_analyze']);
  });
});

describe('normalizeDeferredToolHandoffIntent', () => {
  it('accepts object tool name entries in deferred payloads', () => {
    expect(normalizeDeferredToolHandoffIntent({
      toolNames: [{ name: 'image_edit' }],
      intendedAction: 'continue edit flow',
      maxRetries: 2,
      sessionId: 'session-1',
    })).toEqual({
      toolNames: ['image_edit'],
      intendedAction: 'continue edit flow',
      maxRetries: 2,
      sessionId: 'session-1',
    });
  });
});

describe('buildDeferredToolHandoffMessage', () => {
  it('marks generated handoffs as system-authored while preserving source provenance', () => {
    const sourceMessage: SubstrateMessage = {
      id: 'source-turn-1',
      channelId: 'api:session-1',
      channelType: 'api',
      authorId: 'api-user-1',
      authorName: 'V',
      content: 'finish that tool work when it is ready',
      timestamp: new Date('2026-05-26T12:00:00Z'),
      routing: {
        source: 'api',
        canonicalContactId: 'contact-v',
        channelPrivacy: 'private',
      },
    };

    const candidate = buildDeferredToolHandoffCandidate({
      toolNames: ['image_edit'],
      intendedAction: 'continue the deferred image edit',
    }, sourceMessage, 'chat');
    const payload = normalizeDeferredToolHandoffPayload(candidate.payload);
    expect(payload).not.toBeNull();

    const message = buildDeferredToolHandoffMessage('action-1', payload!);

    expect(message).toMatchObject({
      id: 'deferred-tool-handoff:action-1',
      channelId: 'api:session-1',
      channelType: 'api',
      authorId: DEFERRED_TOOL_HANDOFF_AUTHOR_ID,
      authorName: DEFERRED_TOOL_HANDOFF_AUTHOR_NAME,
      content: 'continue the deferred image edit',
      routing: {
        source: 'api',
        canonicalContactId: 'contact-v',
        channelPrivacy: 'private',
        generated: {
          kind: 'deferred_tool_handoff',
          sourceMessageId: 'source-turn-1',
          sourceChannelId: 'api:session-1',
          sourceAuthorId: 'api-user-1',
          sourceAuthorName: 'V',
        },
      },
    });
  });
});
