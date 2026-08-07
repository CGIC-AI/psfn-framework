import { Value } from '@sinclair/typebox/value';
import { fromAny } from '@total-typescript/shoehorn';
import { describe, it, expect, expectTypeOf, vi } from 'vitest';
import {
  createGatewayClarificationPort,
  createGatewayDiscordNotifySender,
  createHttpNotificationPortFromEnv,
  createNotifyDispatcher,
  createNotifyTool,
  resolveClarificationChannelRoute,
  validateClarifyRequest,
  type ClarificationDispatchOutcome,
  type ClarificationDeliveryPort,
  type ClarificationDeliveryResult,
  type NotifyDelivery,
  type NotifyDispatchResult,
  type PendingClarification,
} from './ntfy.js';
import type { ClarifyDeliverParams, ClarifyDeliverResult } from '../../boundary/gateway/protocol.js';
import type { NotificationPort } from '../../boundary/gateway/notification-port.js';
import { ExternalCommunicationRateLimiter } from '../../system/capabilities/safeguards.js';
import { runWithRequestContext } from '../../primitives/llm/request-context.js';

const companionBriefSender = {
  kind: 'companion',
  provenance: 'companion.notify.brief',
} as const;
const systemApprovalSender = {
  kind: 'system',
  provenance: 'system.approval.request',
} as const;

function resultText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0]?.text ?? '';
}

describe('notify tool', () => {
  it('returns explicit success text when a brief is sent', async () => {
    const notifier: NotificationPort = {
      notify: vi.fn().mockResolvedValue({
        status: 'sent',
        topic: 'ops',
        messageId: 'msg-1',
      }),
    };
    const tool = createNotifyTool(createNotifyDispatcher({ briefNotifier: notifier }));

    const result = await tool.execute('call-1', {
      action: 'brief',
      message: 'Discord gateway offline',
      title: 'Incident',
      priority: 5,
    });

    expect(resultText(fromAny(result))).toContain('notify: brief sent via ntfy');
    expect(resultText(fromAny(result))).toContain('topic "ops"');
    expect(resultText(fromAny(result))).toContain('id msg-1');
    expect(fromAny(result.details).isError).toBeUndefined();
    expect(notifier.notify).toHaveBeenCalledWith(expect.objectContaining({
      sender: companionBriefSender,
    }));
  });

  it('returns explicit debounced text when a duplicate brief is suppressed', async () => {
    const notifier: NotificationPort = {
      notify: vi.fn().mockResolvedValue({
        status: 'debounced',
        topic: 'ops',
      }),
    };
    const tool = createNotifyTool(createNotifyDispatcher({ briefNotifier: notifier }));

    const result = await tool.execute('call-2', {
      action: 'brief',
      message: 'Discord gateway offline',
    });

    expect(resultText(fromAny(result))).toContain('notify: brief debounced');
    expect(fromAny(result.details).isError).toBeUndefined();
  });

  it('returns explicit failure text when brief delivery throws', async () => {
    const notifier: NotificationPort = {
      notify: vi.fn().mockRejectedValue(new Error('ntfy request failed: 503 Service Unavailable')),
    };
    const tool = createNotifyTool(createNotifyDispatcher({ briefNotifier: notifier }));

    const result = await tool.execute('call-3', {
      action: 'brief',
      message: 'Discord gateway offline',
    });

    expect(resultText(fromAny(result))).toContain('notify: failure');
    expect(resultText(fromAny(result))).toContain('503 Service Unavailable');
    expect(fromAny(result.details).isError).toBe(true);
  });

  it('fails fast when brief message is empty', async () => {
    const notifier: NotificationPort = {
      notify: vi.fn(),
    };
    const tool = createNotifyTool(createNotifyDispatcher({ briefNotifier: notifier }));

    const result = await tool.execute('call-4', {
      action: 'brief',
      message: '   ',
    });

    expect(resultText(fromAny(result))).toContain('notify: failure');
    expect(fromAny(result.details).isError).toBe(true);
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it('enforces brief safeguard rate limits', async () => {
    let now = 1_000;
    const limiter = new ExternalCommunicationRateLimiter({
      now: () => now,
      discordPerHour: 1,
      emailPerHour: 1,
    });
    const notifier: NotificationPort = {
      notify: vi.fn().mockResolvedValue({
        status: 'sent',
        topic: 'ops',
      }),
    };
    const tool = createNotifyTool(createNotifyDispatcher({
      briefNotifier: notifier,
      rateLimiter: limiter,
      defaultBudgetChannel: 'discord',
    }));

    const first = await tool.execute('call-5', { action: 'brief', message: 'First alert' });
    expect(resultText(fromAny(first))).toContain('notify: brief sent');

    const blocked = await tool.execute('call-6', { action: 'brief', message: 'Second alert' });
    expect(resultText(fromAny(blocked))).toContain('rate limit');
    expect(fromAny(blocked.details).isError).toBe(true);
    expect(notifier.notify).toHaveBeenCalledTimes(1);

    now += 60 * 60 * 1000 + 1;
    const afterWindow = await tool.execute('call-7', { action: 'brief', message: 'Third alert' });
    expect(resultText(fromAny(afterWindow))).toContain('notify: brief sent');
    expect(notifier.notify).toHaveBeenCalledTimes(2);
  });

  it('blocks scheduled/internal execution contexts to prevent heartbeat ntfy bleed', async () => {
    const notifier: NotificationPort = {
      notify: vi.fn(),
    };
    const tool = createNotifyTool(createNotifyDispatcher({ briefNotifier: notifier }));

    const result = await runWithRequestContext(
      {
        callType: 'scheduled',
        channelId: 'internal:reflection:whisper',
        purpose: 'agent.turn.prompt',
      },
      async () => tool.execute('call-8', {
        action: 'brief',
        message: 'Heartbeat alert',
      }),
    );

    expect(resultText(fromAny(result))).toContain('notify: blocked');
    expect(fromAny(result.details).isError).toBe(true);
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it('sends lightweight outbound notifications through explicit discord delivery targets', async () => {
    const notifier: NotificationPort = {
      notify: vi.fn(),
    };
    const sender = createGatewayDiscordNotifySender({
      discordSend: vi.fn().mockResolvedValue(undefined),
    });
    const tool = createNotifyTool(createNotifyDispatcher({
      briefNotifier: notifier,
      channelSender: sender,
    }));

    const result = await runWithRequestContext(
      {
        callType: 'chat',
        channelId: 'discord:ops-room',
        purpose: 'agent.turn.prompt',
        requesterProvenance: 'human',
        requestAudience: 'external',
      },
      async () => tool.execute('call-9', {
        action: 'send',
        message: 'Background task completed.',
        delivery_channel: 'discord',
        delivery_target: 'discord:ops-room',
      }),
    );

    expect(resultText(fromAny(result))).toContain('notify: send sent via discord');
  });

  it('fails closed when external send has no request context', async () => {
    const notifier: NotificationPort = {
      notify: vi.fn(),
    };
    const discordSend = vi.fn().mockResolvedValue(undefined);
    const sender = createGatewayDiscordNotifySender({ discordSend });
    const tool = createNotifyTool(createNotifyDispatcher({
      briefNotifier: notifier,
      channelSender: sender,
    }));

    const result = await tool.execute('call-10', {
      action: 'send',
      message: 'Missing provenance.',
      delivery_channel: 'discord',
      delivery_target: 'discord:ops-room',
    });

    expect(resultText(fromAny(result))).toContain('notify: blocked');
    expect(resultText(fromAny(result))).toContain('unknown request context');
    expect(fromAny(result.details).isError).toBe(true);
    expect(discordSend).not.toHaveBeenCalled();
  });

  it('fails closed when external send has unknown requester provenance', async () => {
    const notifier: NotificationPort = {
      notify: vi.fn(),
    };
    const discordSend = vi.fn().mockResolvedValue(undefined);
    const sender = createGatewayDiscordNotifySender({ discordSend });
    const tool = createNotifyTool(createNotifyDispatcher({
      briefNotifier: notifier,
      channelSender: sender,
    }));

    const result = await runWithRequestContext(
      {
        callType: 'chat',
        channelId: 'discord:ops-room',
        purpose: 'agent.turn.prompt',
        requestAudience: 'external',
      },
      async () => tool.execute('call-11', {
        action: 'send',
        message: 'Unknown requester.',
        delivery_channel: 'discord',
        delivery_target: 'discord:ops-room',
      }),
    );

    expect(resultText(fromAny(result))).toContain('notify: blocked');
    expect(resultText(fromAny(result))).toContain('unknown requester provenance');
    expect(fromAny(result.details).isError).toBe(true);
    expect(discordSend).not.toHaveBeenCalled();
  });

  it('blocks external send from a non-human requester on an external chat channel', async () => {
    const notifier: NotificationPort = {
      notify: vi.fn(),
    };
    const discordSend = vi.fn().mockResolvedValue(undefined);
    const sender = createGatewayDiscordNotifySender({ discordSend });
    const tool = createNotifyTool(createNotifyDispatcher({
      briefNotifier: notifier,
      channelSender: sender,
    }));

    const result = await runWithRequestContext(
      {
        callType: 'chat',
        channelId: 'discord:ops-room',
        purpose: 'agent.turn.prompt',
        requesterProvenance: 'system',
        requestAudience: 'external',
      },
      async () => tool.execute('call-12', {
        action: 'send',
        message: 'System-injected outbound.',
        delivery_channel: 'discord',
        delivery_target: 'discord:ops-room',
      }),
    );

    expect(resultText(fromAny(result))).toContain('notify: blocked');
    expect(resultText(fromAny(result))).toContain('non-human requester provenance (system)');
    expect(fromAny(result.details).isError).toBe(true);
    expect(discordSend).not.toHaveBeenCalled();
  });

  it('blocks external send from an internal-origin turn to prevent raw outbound bleed', async () => {
    const notifier: NotificationPort = {
      notify: vi.fn(),
    };
    const discordSend = vi.fn().mockResolvedValue(undefined);
    const sender = createGatewayDiscordNotifySender({ discordSend });
    const tool = createNotifyTool(createNotifyDispatcher({
      briefNotifier: notifier,
      channelSender: sender,
    }));

    const result = await runWithRequestContext(
      {
        callType: 'chat',
        channelId: 'internal:free-time',
        purpose: 'agent.turn.prompt',
        requesterProvenance: 'self_directed',
        requestAudience: 'self',
      },
      async () => tool.execute('call-13', {
        action: 'send',
        message: 'Sneaking a message out.',
        delivery_channel: 'discord',
        delivery_target: 'discord:ops-room',
      }),
    );

    expect(resultText(fromAny(result))).toContain('notify: blocked');
    expect(resultText(fromAny(result))).toContain('internal channel (internal:free-time)');
    expect(fromAny(result.details).isError).toBe(true);
    expect(discordSend).not.toHaveBeenCalled();
  });

  it('blocks external send from a scheduled turn to prevent heartbeat outbound bleed', async () => {
    const notifier: NotificationPort = {
      notify: vi.fn(),
    };
    const discordSend = vi.fn().mockResolvedValue(undefined);
    const sender = createGatewayDiscordNotifySender({ discordSend });
    const tool = createNotifyTool(createNotifyDispatcher({
      briefNotifier: notifier,
      channelSender: sender,
    }));

    const result = await runWithRequestContext(
      {
        callType: 'scheduled',
        channelId: 'discord:ops-room',
        purpose: 'agent.turn.prompt',
        requesterProvenance: 'system',
        requestAudience: 'external',
      },
      async () => tool.execute('call-14', {
        action: 'send',
        message: 'Sneaking a message out.',
        delivery_channel: 'discord',
        delivery_target: 'discord:ops-room',
      }),
    );

    expect(resultText(fromAny(result))).toContain('notify: blocked');
    expect(resultText(fromAny(result))).toContain('scheduled execution context');
    expect(fromAny(result.details).isError).toBe(true);
    expect(discordSend).not.toHaveBeenCalled();
  });

  it('declares runtime wiring metadata for Garden health derivation', () => {
    const notifier: NotificationPort = {
      notify: vi.fn(),
    };

    const tool = createNotifyTool(
      createNotifyDispatcher({ briefNotifier: notifier }),
      { gatewayMode: true },
    ) as {
      wiringMeta?: {
        requiredServices?: string[];
        requiredGatewayMethods?: string[];
      };
    };

    expect(tool.wiringMeta).toEqual({
      requiredGatewayMethods: [
        'discord.send',
        'notify.ntfy',
        'companion.initiation.permit.prepare_handoff',
      ],
      requiredServices: ['ntfy'],
    });
  });

  it('resolves the ntfy token through the credential vault when constructing the notifier from env', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: () => null,
      },
    });
    vi.stubGlobal('fetch', fetchSpy);

    try {
      const notifier = createHttpNotificationPortFromEnv(
        {
          NTFY_BASE_URL: 'https://ntfy.local',
          NTFY_TOPIC: 'ops',
        },
        {
          resolveOptional(reference) {
            return reference.envName === 'NTFY_TOKEN' ? 'vault-token' : undefined;
          },
          resolveRequired(reference, description) {
            const value = this.resolveOptional(reference);
            if (value) return value;
            throw new Error(`${description} is not configured`);
          },
          has(reference) {
            return this.resolveOptional(reference) !== undefined;
          },
        },
      );

      await notifier.notify({
        sender: systemApprovalSender,
        message: 'Operator alert',
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://ntfy.local/ops',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer vault-token',
          }),
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('presents a structured clarification through the channel seam and returns pending state', async () => {
    const notifier: NotificationPort = { notify: vi.fn() };
    let presented: PendingClarification | undefined;
    const clarificationPort: ClarificationDeliveryPort = {
      deliver: vi.fn(async (clarification: PendingClarification): Promise<ClarificationDeliveryResult> => {
        presented = clarification;
        return { status: 'pending', channel: 'telegram', target: 'chat:42' };
      }),
    };
    const tool = createNotifyTool(createNotifyDispatcher({
      briefNotifier: notifier,
      clarificationPort,
    }));

    const result = await tool.execute('call-clarify-1', {
      action: 'clarify',
      question: '  Which draft should I send?  ',
      choices: ['The warm one', 'The concise one'],
    });

    expect(resultText(fromAny(result))).toContain('notify: clarify shared on telegram');
    expect(resultText(fromAny(result))).toContain('waiting for a choice');
    expect(fromAny(result.details).isError).toBeUndefined();
    // Channel-agnostic seam: the renderer receives a typed, normalized clarification.
    expect(presented).toBeDefined();
    expect(presented?.question).toBe('Which draft should I send?');
    expect(presented?.choices).toEqual(['The warm one', 'The concise one']);
    expect(typeof presented?.id).toBe('string');
    expect(presented?.id.length).toBeGreaterThan(0);
  });

  it('plumbs a resolved selection back into the turn', async () => {
    const notifier: NotificationPort = { notify: vi.fn() };
    const clarificationPort: ClarificationDeliveryPort = {
      deliver: async (clarification: PendingClarification): Promise<ClarificationDeliveryResult> => ({
        status: 'resolved',
        channel: 'discord',
        target: 'discord:room',
        selection: {
          clarificationId: clarification.id,
          selectedIndex: 1,
          selectedChoice: clarification.choices[1]!,
        },
      }),
    };
    const tool = createNotifyTool(createNotifyDispatcher({
      briefNotifier: notifier,
      clarificationPort,
    }));

    const result = await tool.execute('call-clarify-2', {
      action: 'clarify',
      question: 'Tea or coffee?',
      choices: ['Tea', 'Coffee'],
    });

    expect(resultText(fromAny(result))).toContain('notify: clarify answered');
    expect(resultText(fromAny(result))).toContain('chose "Coffee"');
    expect(fromAny(result.details).isError).toBeUndefined();
  });

  it('fails closed when a resolved selection does not match a delivered choice', async () => {
    const notifier: NotificationPort = { notify: vi.fn() };
    const clarificationPort: ClarificationDeliveryPort = {
      deliver: async (clarification: PendingClarification): Promise<ClarificationDeliveryResult> => ({
        status: 'resolved',
        channel: 'discord',
        target: 'discord:room',
        selection: {
          clarificationId: clarification.id,
          selectedIndex: 0,
          selectedChoice: 'Something the companion never offered',
        },
      }),
    };
    const tool = createNotifyTool(createNotifyDispatcher({
      briefNotifier: notifier,
      clarificationPort,
    }));

    const result = await tool.execute('call-clarify-3', {
      action: 'clarify',
      question: 'Tea or coffee?',
      choices: ['Tea', 'Coffee'],
    });

    expect(resultText(fromAny(result))).toContain('notify: failure');
    expect(resultText(fromAny(result))).toContain('does not match a delivered choice');
    expect(fromAny(result.details).isError).toBe(true);
  });

  it('does not plumb an unverified selection from a pending delivery into the turn', async () => {
    // Hardening: a channel that reports `pending` while (incorrectly or
    // maliciously) attaching a `selection` must never leak that choice text
    // into the turn. The spread is gated strictly on a verified resolved
    // selection, so the pending outcome carries no selectedChoice/selectedIndex.
    const notifier: NotificationPort = { notify: vi.fn() };
    const clarificationPort: ClarificationDeliveryPort = {
      deliver: async (clarification: PendingClarification): Promise<ClarificationDeliveryResult> => ({
        status: 'pending',
        channel: 'discord',
        target: 'discord:room',
        selection: {
          clarificationId: clarification.id,
          selectedIndex: 1,
          selectedChoice: clarification.choices[1]!,
        },
      }),
    };
    const tool = createNotifyTool(createNotifyDispatcher({
      briefNotifier: notifier,
      clarificationPort,
    }));

    const result = await tool.execute('call-clarify-pending-selection', {
      action: 'clarify',
      question: 'Tea or coffee?',
      choices: ['Tea', 'Coffee'],
    });

    const text = resultText(fromAny(result));
    // Presented as still-pending, never as answered, and the unverified choice
    // text is absent from the turn-facing output.
    expect(text).toContain('waiting for a choice');
    expect(text).not.toContain('answered');
    expect(text).not.toContain('Coffee');
    expect(fromAny(result.details).isError).toBeUndefined();
  });

  it('fails closed when clarify has no interactive channel wired', async () => {
    const notifier: NotificationPort = { notify: vi.fn() };
    const tool = createNotifyTool(createNotifyDispatcher({ briefNotifier: notifier }));

    const result = await tool.execute('call-clarify-4', {
      action: 'clarify',
      question: 'Which one?',
      choices: ['A', 'B'],
    });

    expect(resultText(fromAny(result))).toContain('notify: failure');
    expect(resultText(fromAny(result))).toContain('no interactive channel is wired');
    expect(fromAny(result.details).isError).toBe(true);
  });

  it('blocks clarify from scheduled/internal contexts with no live human', async () => {
    const clarificationPort: ClarificationDeliveryPort = {
      deliver: vi.fn(),
    };
    const tool = createNotifyTool(createNotifyDispatcher({
      briefNotifier: { notify: vi.fn() },
      clarificationPort,
    }));

    const result = await runWithRequestContext(
      { callType: 'scheduled', channelId: 'internal:reflection:whisper', purpose: 'agent.turn.prompt' },
      async () => tool.execute('call-clarify-5', {
        action: 'clarify',
        question: 'Which one?',
        choices: ['A', 'B'],
      }),
    );

    expect(resultText(fromAny(result))).toContain('notify: blocked');
    expect(resultText(fromAny(result))).toContain('clarify is not allowed');
    expect(fromAny(result.details).isError).toBe(true);
    expect(clarificationPort.deliver).not.toHaveBeenCalled();
  });

  it('rejects malformed clarify questions and choice sets (fail closed)', () => {
    expect(() => validateClarifyRequest({ action: 'clarify', question: '   ', choices: ['A', 'B'] }))
      .toThrow('question is required');
    expect(() => validateClarifyRequest({ action: 'clarify', question: 'Q', choices: ['only one'] }))
      .toThrow('at least 2 choices');
    expect(() => validateClarifyRequest({ action: 'clarify', question: 'Q', choices: ['A', 'B', 'C', 'D', 'E', 'F'] }))
      .toThrow('at most 5 choices');
    expect(() => validateClarifyRequest({ action: 'clarify', question: 'Q', choices: ['A', '  '] }))
      .toThrow('every choice must be a non-empty string');
    expect(() => validateClarifyRequest({ action: 'clarify', question: 'Q', choices: ['Same', 'Same'] }))
      .toThrow('choices must be distinct');
    expect(() => validateClarifyRequest({ action: 'clarify', question: 'Q', choices: ['Tea', 'tea'] }))
      .toThrow('choices must be distinct');
    expect(() => validateClarifyRequest({ action: 'clarify', question: 'Q', choices: ['A', 'X'.repeat(201)] }))
      .toThrow('at most 200 characters');
    // Normalizes trimmed input and mints a stable id + distinct-choice contract.
    const normalized = validateClarifyRequest({ action: 'clarify', question: '  Q  ', choices: [' A ', 'B'] });
    expect(normalized.question).toBe('Q');
    expect(normalized.choices).toEqual(['A', 'B']);
    expect(normalized.id.length).toBeGreaterThan(0);
  });

  it('declares exact choice uniqueness in the clarify tool schema', () => {
    const tool = createNotifyTool({ dispatch: vi.fn() });
    expect(Value.Check(tool.parameters, {
      action: 'clarify',
      question: 'Tea or coffee?',
      choices: ['Tea', 'Tea'],
    })).toBe(false);
  });

  it('keeps dispatch results action-discriminated with required delivery metadata', () => {
    type DeliveryResult = Exclude<NotifyDispatchResult, { action: 'clarify' }>;
    type ClarifyResult = Extract<NotifyDispatchResult, { action: 'clarify' }>;

    expectTypeOf<DeliveryResult['delivery']>().toEqualTypeOf<NotifyDelivery>();
    expectTypeOf<DeliveryResult['target']>().toEqualTypeOf<string>();
    expectTypeOf<ClarifyResult['clarification']>()
      .toEqualTypeOf<ClarificationDispatchOutcome>();
  });

  it('fails closed when the sender provenance does not match the sender kind', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    try {
      const notifier = createHttpNotificationPortFromEnv({
        NTFY_BASE_URL: 'https://ntfy.local',
        NTFY_TOPIC: 'ops',
      });

      await expect(notifier.notify({
        sender: {
          kind: 'system',
          provenance: 'companion.notify.brief',
        },
        message: 'Operator alert',
      })).rejects.toThrow('notify sender provenance must start with "system."');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('resolveClarificationChannelRoute', () => {
  it('routes a Telegram channel id to the telegram channel', () => {
    expect(resolveClarificationChannelRoute('telegram:42')).toEqual({
      channel: 'telegram',
      target: 'telegram:42',
    });
  });

  it('routes a Discord snowflake (and threaded snowflake) to the discord channel', () => {
    expect(resolveClarificationChannelRoute('123456789012345678')).toEqual({
      channel: 'discord',
      target: '123456789012345678',
    });
    expect(resolveClarificationChannelRoute('123456789012345678:987654321')).toEqual({
      channel: 'discord',
      target: '123456789012345678:987654321',
    });
  });

  it('fails closed (null) for internal, voice, and non-interactive channels', () => {
    expect(resolveClarificationChannelRoute('internal:reflection:whisper')).toBeNull();
    expect(resolveClarificationChannelRoute('discord-voice:123')).toBeNull();
    expect(resolveClarificationChannelRoute('api:session-7')).toBeNull();
    expect(resolveClarificationChannelRoute('')).toBeNull();
  });
});

describe('createGatewayClarificationPort', () => {
  const clarification: PendingClarification = {
    id: 'clar-9',
    question: 'Which one?',
    choices: ['A', 'B'],
  };

  it('dispatches to the active turn channel with the bounded timeout', async () => {
    const calls: ClarifyDeliverParams[] = [];
    const gateway = {
      clarifyDeliver: async (params: ClarifyDeliverParams): Promise<ClarifyDeliverResult> => {
        calls.push(params);
        return {
          status: 'resolved',
          channel: 'telegram',
          target: params.target,
          selection: { clarificationId: clarification.id, selectedIndex: 1, selectedChoice: 'B' },
        };
      },
    };
    const port = createGatewayClarificationPort(gateway);

    const result = await runWithRequestContext(
      { channelId: 'telegram:77', viewerAuthorId: 'user-42', purpose: 'agent.turn.prompt' },
      async () => port.deliver(clarification),
    );

    expect(result.status).toBe('resolved');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.channel).toBe('telegram');
    expect(calls[0]!.target).toBe('telegram:77');
    expect(calls[0]!.clarification).toEqual(clarification);
    expect(calls[0]!.timeoutMs).toBeGreaterThan(0);
    // The originating author is plumbed through so the channel binds the answer.
    expect(calls[0]!.originatingUserId).toBe('user-42');
  });

  it('omits originatingUserId when the turn carries no resolvable author', async () => {
    const calls: ClarifyDeliverParams[] = [];
    const gateway = {
      clarifyDeliver: async (params: ClarifyDeliverParams): Promise<ClarifyDeliverResult> => {
        calls.push(params);
        return { status: 'pending', channel: 'telegram', target: params.target };
      },
    };
    const port = createGatewayClarificationPort(gateway);

    await runWithRequestContext(
      { channelId: 'telegram:77', purpose: 'agent.turn.prompt' },
      async () => port.deliver(clarification),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.originatingUserId).toBeUndefined();
  });

  it('fails closed when the turn has no channel context', async () => {
    const gateway = { clarifyDeliver: vi.fn() };
    const port = createGatewayClarificationPort(gateway);
    await expect(port.deliver(clarification)).rejects.toThrow('no active interactive channel');
    expect(gateway.clarifyDeliver).not.toHaveBeenCalled();
  });

  it('fails closed when the active channel cannot present choices', async () => {
    const gateway = { clarifyDeliver: vi.fn() };
    const port = createGatewayClarificationPort(gateway);
    await expect(
      runWithRequestContext(
        { channelId: 'api:session-3', purpose: 'agent.turn.prompt' },
        async () => port.deliver(clarification),
      ),
    ).rejects.toThrow('not supported on channel');
    expect(gateway.clarifyDeliver).not.toHaveBeenCalled();
  });
});
