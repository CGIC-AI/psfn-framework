import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../../shared/event-bus.js';
import { AdminAdaptiveToolsDataService } from './adaptive-tools-service.js';

describe('AdminAdaptiveToolsDataService invocation audit', () => {
  it('shows successful contact use while retaining only the action name from arguments', async () => {
    const eventBus = new EventBus();
    const service = new AdminAdaptiveToolsDataService({ eventBus });

    await eventBus.emit('agent.toolcall.end', {
      channelId: 'discord:dm:lyra',
      contentIndex: 0,
      toolCallId: 'contact-call-1',
      toolName: 'contact',
      arguments: {
        action: 'lookup',
        contactId: 'private-contact-id',
        rationale: 'private relationship rationale',
      },
      turnId: 'turn-1',
      requestId: 'request-1',
    });
    await eventBus.emit('agent.tool.end', {
      channelId: 'discord:dm:lyra',
      toolCallId: 'contact-call-1',
      toolName: 'contact',
      outcome: 'success',
      isError: false,
      turnId: 'turn-1',
      requestId: 'request-1',
    });

    const data = await service.getAdaptiveToolsData();
    expect(data.recentInvocations).toEqual([
      expect.objectContaining({
        toolName: 'contact',
        action: 'lookup',
        outcome: 'success',
        status: 'ok',
        channelId: 'discord:dm:lyra',
        toolCallId: 'contact-call-1',
        turnId: 'turn-1',
        requestId: 'request-1',
      }),
    ]);
    expect(JSON.stringify(data.recentInvocations)).not.toContain('private-contact-id');
    expect(JSON.stringify(data.recentInvocations)).not.toContain('private relationship rationale');
    expect(data.recentFailures).toEqual([]);
  });

  it('records failed invocations in both the run trail and failure diagnostics', async () => {
    const eventBus = new EventBus();
    const service = new AdminAdaptiveToolsDataService({ eventBus });

    await eventBus.emit('agent.toolcall.end', {
      channelId: 'api-session',
      contentIndex: 0,
      toolCallId: 'contact-call-2',
      toolName: 'contact',
      arguments: { action: 'set_relationship', contactId: 'secret-id' },
    });
    await eventBus.emit('agent.tool.end', {
      channelId: 'api-session',
      toolCallId: 'contact-call-2',
      toolName: 'contact',
      outcome: 'execution_failure',
      isError: true,
      errorMessage: 'relationship policy denied the write for secret-id',
    });

    const data = await service.getAdaptiveToolsData();
    expect(data.recentInvocations).toEqual([
      expect.objectContaining({
        toolName: 'contact',
        action: 'set_relationship',
        outcome: 'execution_failure',
        status: 'error',
      }),
    ]);
    expect(data.recentFailures).toEqual([
      expect.objectContaining({
        toolName: 'contact',
        message: 'Contact tool invocation failed.',
      }),
    ]);
    expect(JSON.stringify(data.recentInvocations)).not.toContain('secret-id');
    expect(JSON.stringify(data.recentFailures)).not.toContain('secret-id');
  });

  it('drops malformed action strings rather than treating arbitrary argument text as audit metadata', async () => {
    const eventBus = new EventBus();
    const service = new AdminAdaptiveToolsDataService({ eventBus });

    await eventBus.emit('agent.toolcall.end', {
      channelId: 'api-session',
      contentIndex: 0,
      toolCallId: 'malformed-action',
      toolName: 'contact',
      arguments: { action: 'lookup private-contact-id' },
    });
    await eventBus.emit('agent.tool.end', {
      channelId: 'api-session',
      toolCallId: 'malformed-action',
      toolName: 'contact',
      outcome: 'execution_failure',
      isError: true,
    });

    const data = await service.getAdaptiveToolsData();
    expect(data.recentInvocations).toEqual([
      expect.objectContaining({ toolName: 'contact', status: 'error' }),
    ]);
    expect(data.recentInvocations[0]).not.toHaveProperty('action');
    expect(JSON.stringify(data.recentInvocations)).not.toContain('private-contact-id');
  });

  it('drops syntactically valid actions that are not declared for the selected tool', async () => {
    const eventBus = new EventBus();
    const service = new AdminAdaptiveToolsDataService({ eventBus });

    await eventBus.emit('agent.toolcall.end', {
      channelId: 'api-session',
      contentIndex: 0,
      toolCallId: 'unknown-action',
      toolName: 'contact',
      arguments: { action: 'private_contact_identifier' },
    });
    await eventBus.emit('agent.tool.end', {
      channelId: 'api-session',
      toolCallId: 'unknown-action',
      toolName: 'contact',
      outcome: 'success',
      isError: false,
    });

    const data = await service.getAdaptiveToolsData();
    expect(data.recentInvocations[0]).not.toHaveProperty('action');
    expect(JSON.stringify(data.recentInvocations)).not.toContain('private_contact_identifier');
  });

  it('correlates reused tool-call ids by channel without crossing action metadata', async () => {
    const eventBus = new EventBus();
    const service = new AdminAdaptiveToolsDataService({ eventBus });

    await eventBus.emit('agent.toolcall.end', {
      channelId: 'channel-a', contentIndex: 0, toolCallId: 'reused', toolName: 'contact',
      arguments: { action: 'lookup' },
    });
    await eventBus.emit('agent.toolcall.end', {
      channelId: 'channel-b', contentIndex: 0, toolCallId: 'reused', toolName: 'contact',
      arguments: { action: 'set_relationship' },
    });
    await eventBus.emit('agent.tool.end', {
      channelId: 'channel-b', toolCallId: 'reused', toolName: 'contact', outcome: 'success', isError: false,
    });
    await eventBus.emit('agent.tool.end', {
      channelId: 'channel-a', toolCallId: 'reused', toolName: 'contact', outcome: 'success', isError: false,
    });

    const data = await service.getAdaptiveToolsData();
    expect(data.recentInvocations).toEqual(expect.arrayContaining([
      expect.objectContaining({ channelId: 'channel-a', action: 'lookup' }),
      expect.objectContaining({ channelId: 'channel-b', action: 'set_relationship' }),
    ]));
  });

  it('keeps policy denials and skips visible without inflating recent runtime failures', async () => {
    const eventBus = new EventBus();
    const service = new AdminAdaptiveToolsDataService({ eventBus });

    await eventBus.emit('agent.tool.end', {
      channelId: 'api-session',
      toolCallId: 'web-denied',
      toolName: 'web',
      outcome: 'policy_denial',
      isError: true,
      errorMessage: 'Policy denied this request.',
    });
    await eventBus.emit('agent.tool.end', {
      channelId: 'api-session',
      toolCallId: 'fs-duplicate',
      toolName: 'fs',
      outcome: 'duplicate_skip',
      isError: true,
      errorMessage: 'Duplicate skipped.',
    });

    const data = await service.getAdaptiveToolsData();
    // Deterministic newest-first order by construction: the monotonic
    // invocation sequence breaks millisecond-timestamp ties, so the
    // second-emitted event (duplicate_skip) always sorts ahead of the first
    // (policy_denial) regardless of whether the wall clock ticked between the
    // two emits (psfn-framework-5gg3).
    expect(data.recentInvocations.map(invocation => invocation.outcome)).toEqual([
      'duplicate_skip',
      'policy_denial',
    ]);
    expect(data.recentFailures).toEqual([]);
  });

  it('orders recent invocations newest-first deterministically on a millisecond tie', async () => {
    const eventBus = new EventBus();
    const service = new AdminAdaptiveToolsDataService({ eventBus });

    // Pin the clock so both events share an identical millisecond timestamp:
    // this is exactly the tie case where a timestamp-only sort would fall back
    // to insertion order and mask the ordering bug. With the sequence
    // tiebreaker the newest-emitted event must still come first.
    const fixedNow = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(fixedNow);
    try {
      await eventBus.emit('agent.tool.end', {
        channelId: 'api-session',
        toolCallId: 'first',
        toolName: 'web',
        outcome: 'policy_denial',
        isError: true,
      });
      await eventBus.emit('agent.tool.end', {
        channelId: 'api-session',
        toolCallId: 'second',
        toolName: 'fs',
        outcome: 'duplicate_skip',
        isError: true,
      });
    } finally {
      nowSpy.mockRestore();
    }

    const data = await service.getAdaptiveToolsData();
    expect(data.recentInvocations.map(invocation => invocation.toolCallId)).toEqual([
      'second',
      'first',
    ]);
  });
});
