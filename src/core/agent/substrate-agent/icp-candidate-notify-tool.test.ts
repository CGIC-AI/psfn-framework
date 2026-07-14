import { describe, expect, it, vi } from 'vitest';
import type { AgentTool } from '../../../boundary/pi-agent/index.js';
import { resolveToolRequiredCapabilities } from '../../../system/capabilities/requirements.js';
import { createIcpCandidateScopedNotifyTool } from './icp-candidate-notify-tool.js';

function makeNotifyTool(execute: AgentTool<any>['execute']): AgentTool<any> {
  return {
    name: 'notify',
    description: 'Unified notification surface.',
    parameters: {},
    execute,
  } as AgentTool<any>;
}

describe('ICP candidate-scoped unified notify surface', () => {
  it('exposes only the canonical companion-send schema and capability', () => {
    const tool = createIcpCandidateScopedNotifyTool({
      notifyTool: makeNotifyTool(vi.fn()),
      authorizeExecution: () => true,
    });

    expect(tool.name).toBe('notify');
    expect(tool.description).not.toContain('operator brief');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['action', 'target_kind', 'contact_id', 'initiation_permit'],
      properties: {
        action: { const: 'send' },
        target_kind: { const: 'companion' },
      },
    });
    expect(resolveToolRequiredCapabilities(tool, {
      action: 'send',
      target_kind: 'companion',
    })).toEqual(['external.companion']);
  });

  it.each([
    ['external Discord send', {
      action: 'send',
      target_kind: 'external',
      message: 'escape',
      delivery_channel: 'discord',
      delivery_target: 'operator-channel',
    }],
    ['external email send', {
      action: 'send',
      target_kind: 'external',
      message: 'escape',
      delivery_channel: 'email',
      delivery_target: 'operator@example.test',
    }],
    ['operator brief', { action: 'brief', message: 'escape' }],
    ['approval request', {
      action: 'approval_request',
      approval_id: 'approval-1',
      approval_method: 'runtime.restart',
      approval_action: 'restart',
      approval_scope: 'system',
      approval_reason: 'escape',
    }],
    ['widened companion shape', {
      action: 'send',
      target_kind: 'companion',
      contact_id: 'peer-contact-b',
      initiation_permit: '44444444-4444-4444-8444-444444444444',
      message: 'must not be accepted',
    }],
  ])('blocks %s before the unified dispatcher can execute', async (_label, params) => {
    const execute = vi.fn();
    const tool = createIcpCandidateScopedNotifyTool({
      notifyTool: makeNotifyTool(execute),
      authorizeExecution: () => true,
    });

    const result = await tool.execute('call-escape', params);

    expect(result).toMatchObject({ details: { isError: true } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('revalidates exact live owner authorization before delegating companion send', async () => {
    const expectedResult = {
      content: [{ type: 'text', text: 'queued' }],
      details: {},
    };
    const execute = vi.fn(async () => expectedResult);
    const authorizeExecution = vi.fn(() => false);
    const tool = createIcpCandidateScopedNotifyTool({
      notifyTool: makeNotifyTool(execute),
      authorizeExecution,
    });
    const params = {
      action: 'send',
      target_kind: 'companion',
      contact_id: 'peer-contact-b',
      initiation_permit: '44444444-4444-4444-8444-444444444444',
    } as const;

    const denied = await tool.execute('call-denied', params);
    expect(denied).toMatchObject({ details: { isError: true } });
    expect(execute).not.toHaveBeenCalled();

    authorizeExecution.mockReturnValue(true);
    await expect(tool.execute('call-allowed', params)).resolves.toBe(expectedResult);
    expect(authorizeExecution).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith('call-allowed', params, undefined);
  });
});
