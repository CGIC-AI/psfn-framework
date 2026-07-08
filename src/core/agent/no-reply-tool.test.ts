import { describe, expect, it, vi } from 'vitest';
import type { IntentionalNoReplyMetadata } from '../../shared/contracts/runtime.js';
import { RESPONSE_CONTROL_TOOL_NAME } from '../../shared/agent-response-disposition.js';
import {
  notePendingPaidDeliverable,
  runWithPaidDeliverableTracking,
} from '../../shared/paid-deliverable-tracking.js';
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

  it('rejects empty or malformed arguments without recording a no-reply decision', async () => {
    const record = vi.fn();
    const tool = createResponseControlTool(record);

    const emptyResult = await tool.execute('tool-call-empty', {} as never);
    expect(emptyResult.details).toMatchObject({ isError: true });
    expect(emptyResult.content[0]?.text).toContain('refusing to record a no-reply decision');

    const wrongAction = await tool.execute('tool-call-wrong', { action: 'reply' } as never);
    expect(wrongAction.details).toMatchObject({ isError: true });

    expect(record).not.toHaveBeenCalled();
  });

  it('fails closed when the sentinel cannot be bound to an active turn', async () => {
    const tool = createResponseControlTool(vi.fn(() => null));

    const result = await tool.execute('tool-call-1', { action: 'no_reply' });

    expect(result.details.isError).toBe(true);
    expect(result.content[0]?.text).toContain('no-reply sentinel was not accepted');
  });

  it('rejects no-reply and never records a decision when a paid deliverable is pending', async () => {
    const record = vi.fn(() => null);
    const tool = createResponseControlTool(record);

    const result = await runWithPaidDeliverableTracking(async () => {
      notePendingPaidDeliverable({
        surface: 'paidImageGeneration',
        toolName: 'selfie_create',
        toolCallId: 'call-selfie-1',
        identifier: 'req-selfie-1',
        artifactCount: 1,
      });
      return tool.execute('tool-call-1', { action: 'no_reply', reason: 'resting' });
    });

    expect(record).not.toHaveBeenCalled();
    expect(result.details.isError).toBe(true);
    expect(result.details.noReply).toBeUndefined();
    expect(result.content[0]?.text).toContain('pending delivery');
    expect(result.content[0]?.text).toContain('req-selfie-1');
    expect(result.content[0]?.text).toContain('via selfie_create');
  });

  it('records no-reply normally when no paid deliverable is pending in the tracking scope', async () => {
    const decision: IntentionalNoReplyMetadata = {
      schemaVersion: 1,
      disposition: 'intentional_no_reply',
      source: 'response_control_tool',
      auditId: 'no-reply:turn-2:tool-call-2',
      decidedAt: Date.parse('2026-03-08T12:00:00Z'),
      turnId: '018f0000-0000-7000-9000-000000000002' as IntentionalNoReplyMetadata['turnId'],
    };
    const record = vi.fn(() => decision);
    const tool = createResponseControlTool(record);

    const result = await runWithPaidDeliverableTracking(async () => (
      tool.execute('tool-call-2', { action: 'no_reply' })
    ));

    expect(record).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({ noReply: true, auditId: decision.auditId });
  });
});
