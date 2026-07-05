import { describe, expect, it } from 'vitest';
import { resolveAgentResponseDisposition } from './agent-response-disposition.js';
import type { AgentResponse, IntentionalNoReplyMetadata } from './contracts/runtime.js';

function makeNoReply(): IntentionalNoReplyMetadata {
  return {
    schemaVersion: 1,
    disposition: 'intentional_no_reply',
    source: 'response_control_tool',
    auditId: 'no-reply:turn-1:call-1',
    decidedAt: Date.parse('2026-07-04T23:21:44Z'),
    turnId: '018f0000-0000-7000-9000-000000000001' as IntentionalNoReplyMetadata['turnId'],
  };
}

function makeResponse(overrides: Partial<AgentResponse>): AgentResponse {
  return {
    content: '',
    channelId: 'ch-1',
    metadata: {
      model: 'test-model',
      inputTokens: 1,
      outputTokens: 1,
      durationMs: 1,
    },
    ...overrides,
    ...(overrides.metadata
      ? { metadata: { model: 'test-model', inputTokens: 1, outputTokens: 1, durationMs: 1, ...overrides.metadata } }
      : {}),
  } as AgentResponse;
}

describe('resolveAgentResponseDisposition', () => {
  it('honors intentional no-reply when the response carries no content', () => {
    const disposition = resolveAgentResponseDisposition(makeResponse({
      metadata: { noReply: makeNoReply() } as AgentResponse['metadata'],
    }));
    expect(disposition.kind).toBe('intentional_no_reply');
  });

  it('delivers content even when a contradictory noReply marker is present (fail-closed)', () => {
    const disposition = resolveAgentResponseDisposition(makeResponse({
      content: 'the authored reply',
      metadata: { noReply: makeNoReply() } as AgentResponse['metadata'],
    }));
    expect(disposition).toEqual({ kind: 'send', hasText: true, hasAttachments: false });
  });

  it('delivers attachments even when a contradictory noReply marker is present', () => {
    const disposition = resolveAgentResponseDisposition(makeResponse({
      attachments: [{ kind: 'image', fileName: 'purr.png', localPath: '/tmp/purr.png' }] as AgentResponse['attachments'],
      metadata: { noReply: makeNoReply() } as AgentResponse['metadata'],
    }));
    expect(disposition).toEqual({ kind: 'send', hasText: false, hasAttachments: true });
  });

  it('reports empty responses without markers as errors', () => {
    const disposition = resolveAgentResponseDisposition(makeResponse({}));
    expect(disposition.kind).toBe('empty_response_error');
  });
});
