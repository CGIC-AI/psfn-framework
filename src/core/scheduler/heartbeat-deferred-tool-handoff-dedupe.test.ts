import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { wireHeartbeatRuntime } from '../../app/startup/composition/parity.js';
import { EventBus } from '../../shared/event-bus.js';
import { Scheduler } from './scheduler.js';
import { DEFERRED_TOOL_HANDOFF_ACTION_KIND } from '../agent/deferred-tool-handoff.js';
import type { OutboundReplyGuardPort } from '../../system/lifecycle/outbound-reply-dedupe.js';
import type { AgentResponse } from '../../shared/contracts/runtime.js';

const TEMP_DIRS: string[] = [];

afterEach(() => {
  for (const dir of TEMP_DIRS.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

type ActionHandler = (action: {
  id: string;
  dedupeKey: string;
  channelId: string;
  sourceMessageId: string;
  payload: Record<string, unknown>;
}) => Promise<unknown> | unknown;

function buildAction(): Parameters<ActionHandler>[0] {
  return {
    id: 'action-1',
    dedupeKey: 'tool_handoff.continue:turn-1:hash',
    channelId: 'discord:general',
    sourceMessageId: 'turn-1',
    payload: {
      toolNames: ['media'],
      intendedAction: 'finish the selfie edit',
      turn: {
        turnId: 'turn-1',
        requestId: 'turn-1',
        channelId: 'discord:general',
        channelType: 'discord',
        authorId: 'user-1',
        authorName: 'User',
        callType: 'tool',
      },
    },
  };
}

function wire(options: {
  handoffResponseText: string;
  outboundReplyGuard?: OutboundReplyGuardPort;
}) {
  const tempDir = mkdtempSync(join(tmpdir(), 'psfn-handoff-dedupe-'));
  TEMP_DIRS.push(tempDir);
  const eventBus = new EventBus();
  const scheduler = new Scheduler(eventBus, { tickIntervalMs: 50, heartbeatIntervalMs: 1_000 });

  const handlers = new Map<string, ActionHandler>();
  const postTurnActions = {
    registerHandler: vi.fn((kind: string, cb: ActionHandler) => {
      handlers.set(kind, cb);
      return () => {};
    }),
    listQueued: vi.fn().mockReturnValue([]),
    getStatus: vi.fn(),
  };

  const handleMessage = vi.fn(async (): Promise<AgentResponse> => ({
    content: options.handoffResponseText,
    channelId: 'discord:general',
    metadata: { model: 'm', inputTokens: 1, outputTokens: 1, durationMs: 1 },
  }));
  const activateExtendedTools = vi.fn(() => ({ activatedTools: ['media'] }));
  const sender = { send: vi.fn(async () => {}) };

  wireHeartbeatRuntime(
    { registerTool: vi.fn() },
    scheduler,
    {
      handleMessage,
      followUp: vi.fn(),
      waitForIdle: vi.fn(),
      activateExtendedTools,
      registerPostTurnActionInferer: vi.fn(() => () => {}),
    } as any,
    sender,
    tempDir,
    undefined,
    {
      eventBus,
      postTurnActions: postTurnActions as any,
      llmProvider: { stream: vi.fn(), complete: vi.fn() } as any,
      sessionManager: {
        resolveSessionChannelId: (channelId: string) => channelId,
        getRecentMessages: vi.fn().mockReturnValue([]),
      } as any,
      intentionAppraisalEnabled: false,
      ...(options.outboundReplyGuard ? { outboundReplyGuard: options.outboundReplyGuard } : {}),
    },
  );

  const handler = handlers.get(DEFERRED_TOOL_HANDOFF_ACTION_KIND);
  if (!handler) {
    throw new Error('deferred-tool-handoff action handler was not registered');
  }
  return { handler, sender, handleMessage };
}

describe('deferred-tool-handoff continuation outbound dedupe (psfn-framework-mdxu)', () => {
  it('delivers the continuation reply and records it when it is not a duplicate', async () => {
    const noteDelivered = vi.fn();
    const guard: OutboundReplyGuardPort = {
      noteDelivered,
      evaluate: vi.fn(() => null),
    };
    const { handler, sender } = wire({
      handoffResponseText: 'here is your selfie',
      outboundReplyGuard: guard,
    });

    await handler(buildAction());

    expect(sender.send).toHaveBeenCalledWith('discord:general', 'here is your selfie');
    expect(noteDelivered).toHaveBeenCalledWith({
      channelId: 'discord:general',
      content: 'here is your selfie',
      sourceTurnId: 'turn-1',
      senderKind: 'deferred_tool_handoff',
    });
  });

  it('suppresses the continuation reply when it duplicates an already-delivered reply', async () => {
    const guard: OutboundReplyGuardPort = {
      noteDelivered: vi.fn(),
      evaluate: vi.fn(() => ({
        hash: 'abc',
        priorDeliveredAt: 1,
        ageMs: 65_000,
        priorSourceTurnId: 'turn-1',
        priorSenderKind: 'discord_inbound_reply',
      })),
    };
    const { handler, sender } = wire({
      handoffResponseText: 'I hit a wall, let me try again.',
      outboundReplyGuard: guard,
    });

    await handler(buildAction());

    expect(guard.evaluate).toHaveBeenCalledWith({
      channelId: 'discord:general',
      content: 'I hit a wall, let me try again.',
    });
    expect(sender.send).not.toHaveBeenCalled();
    expect(guard.noteDelivered).not.toHaveBeenCalled();
  });

  it('still delivers when no outbound reply guard is wired (backwards compatible)', async () => {
    const { handler, sender } = wire({ handoffResponseText: 'unguarded reply' });

    await handler(buildAction());

    expect(sender.send).toHaveBeenCalledWith('discord:general', 'unguarded reply');
  });
});
