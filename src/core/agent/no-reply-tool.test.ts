import { describe, expect, it, vi } from 'vitest';
import type { IntentionalNoReplyMetadata } from '../../shared/contracts/runtime.js';
import { RESPONSE_CONTROL_TOOL_NAME } from '../../shared/agent-response-disposition.js';
import { createResponseControlTool } from './no-reply-tool.js';

describe('createResponseControlTool', () => {
  it('records a structured intentional no-reply decision', async () => {
    const decision: IntentionalNoReplyMetadata = {
      schemaVersion: 1,
      disposition: 'intentional_no_reply',
      source: 'response_control_tool',
      auditId: 'no-reply:turn-1:tool-call-1',
      decidedAt: Date.parse('2026-03-08T12:00:00Z'),
      turnId: '018f0000-0000-7000-9000-000000000001' as IntentionalNoReplyMetadata['turnId'],
      requestId: 'request-1',
      channelId: 'api:test',
      toolCallId: 'tool-call-1',
      reason: 'resting',
    };
    const record = vi.fn(() => decision);
    const tool = createResponseControlTool(record);

    const result = await tool.execute('tool-call-1', {
      action: 'no_reply',
      reason: ' resting ',
    });

    expect(tool.name).toBe(RESPONSE_CONTROL_TOOL_NAME);
    expect(record).toHaveBeenCalledWith({
      source: 'response_control_tool',
      toolCallId: 'tool-call-1',
      reason: 'resting',
    });
    expect(result.details).toMatchObject({
      noReply: true,
      auditId: decision.auditId,
    });
    expect(result.content[0]?.text).toContain('"disposition": "intentional_no_reply"');
  });

  it('fails closed when the sentinel cannot be bound to an active turn', async () => {
    const tool = createResponseControlTool(vi.fn(() => null));

    const result = await tool.execute('tool-call-1', { action: 'no_reply' });

    expect(result.details.isError).toBe(true);
    expect(result.content[0]?.text).toContain('no-reply sentinel was not accepted');
  });
});
