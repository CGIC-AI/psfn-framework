import { describe, expect, it, vi } from 'vitest';
import type { ToolResultMessage } from '@mariozechner/pi-ai';
import { EventBus } from '../../shared/event-bus.js';
import { executeToolCallsWithScheduler } from '../agent/tool-call-scheduler.js';
import type {
  PendingFollowUp,
  PendingFollowUpCreateInput,
} from '../intention/pending-follow-ups.js';
import { createScheduleTool } from './schedule-tool.js';
import { Scheduler } from './scheduler.js';
import type {
  ScheduledPromptCreateInput,
  ScheduledPromptRecord,
  ScheduledPromptStorePort,
} from './scheduled-prompt-store-port.js';

function resultText(result: Awaited<ReturnType<ReturnType<typeof createScheduleTool>['execute']>>): string {
  const content = result.content[0];
  return content.type === 'text' ? content.text : '';
}

function createScheduler(): Scheduler {
  return new Scheduler(new EventBus(), {
    tickIntervalMs: 100,
    heartbeatIntervalMs: 500,
  });
}

function createScheduledPromptStore(): ScheduledPromptStorePort & {
  records: ScheduledPromptRecord[];
} {
  const records: ScheduledPromptRecord[] = [];
  return {
    records,
    create: vi.fn(async (input: ScheduledPromptCreateInput) => {
      const record: ScheduledPromptRecord = {
        ...input,
        createdAt: input.createdAt ?? new Date().toISOString(),
        status: 'pending',
      };
      records.push(record);
      return record;
    }),
    listPending: vi.fn(async () => records.filter(record => record.status === 'pending')),
    markCompleted: vi.fn(async (id: string, options = {}) => {
      const record = records.find(candidate => candidate.id === id && candidate.status === 'pending');
      if (!record) return null;
      record.status = 'completed';
      record.completedAt = options.completedAt ?? new Date().toISOString();
      return record;
    }),
  };
}

function createPendingFollowUpStore() {
  const records: PendingFollowUp[] = [];
  return {
    records,
    enqueue: vi.fn(async (input: PendingFollowUpCreateInput) => {
      const record: PendingFollowUp = {
        ...input,
        id: `follow-up-${records.length + 1}`,
        createdAt: input.createdAt ?? '2026-07-14T12:00:00.000Z',
        ...(input.wakeConditions ? { wakeConditions: [...input.wakeConditions] } : {}),
      };
      records.push(record);
      return record;
    }),
    list: vi.fn(async () => records),
    dequeue: vi.fn(async () => null),
  };
}

async function executeScheduleCall(
  tool: ReturnType<typeof createScheduleTool>,
  args: Record<string, unknown>,
): Promise<ToolResultMessage> {
  const result = await executeToolCallsWithScheduler(
    [tool],
    {
      role: 'assistant',
      content: [{
        type: 'toolCall',
        id: 'schedule-call-1',
        name: 'schedule',
        arguments: args,
      }],
      stopReason: 'stop',
    },
    undefined,
    { stream: { push: () => undefined } },
    { maxParallelToolCalls: 1 },
  );
  return result.toolResults[0] as ToolResultMessage;
}

function createTool(options: Partial<Parameters<typeof createScheduleTool>[0]> = {}) {
  const scheduledPromptStore = createScheduledPromptStore();
  const scheduler = createScheduler();
  const tool = createScheduleTool({
    scheduler,
    agentLoop: {
      handleMessage: vi.fn(async () => ({ content: 'response' })),
    },
    sender: {
      send: vi.fn(async () => undefined),
    },
    heartbeatPolicyStore: {
      load: vi.fn(() => ({ templates: [] })),
    } as any,
    syncReflectionTasks: vi.fn(),
    runTemplate: vi.fn(),
    heartbeatChannelId: 'discord:heartbeat',
    scheduledPromptStore,
    ...options,
  });
  return { tool, scheduler, scheduledPromptStore };
}

describe('schedule tool', () => {
  it('groups model-facing actions by schedule domain and required arguments', () => {
    const tool = createScheduleTool({
      scheduler: {} as any,
      agentLoop: {} as any,
      sender: {} as any,
      heartbeatPolicyStore: {} as any,
      syncReflectionTasks: vi.fn(),
      runTemplate: vi.fn(),
    });

    expect(tool.description).toContain('Orientation: action=list');
    expect(tool.description).toContain('Follow-ups: create_follow_up needs content');
    expect(tool.description).toContain('channel_type=discord (not prompt-facing discord_text)');
    expect(tool.description).toContain('activate_follow_up needs follow_up_id');
    expect(tool.description).toContain('Reminders: create_reminder needs title/content');
    expect(tool.description).toContain('trigger_reminder needs reminder_id');
    expect(tool.description).toContain('Templates: list_templates inspects them');
    expect(tool.description).toContain('update_template uses template_id for existing templates and id only when adding');
    expect(tool.description).toContain('Scheduled prompts: schedule_prompt needs name, prompt, and exactly one of delay_minutes or run_at');
  });

  it('publishes continuity channel types as one canonical enum', () => {
    const { tool } = createTool();
    const schema = tool.parameters as unknown as {
      properties: Record<string, Record<string, unknown>>;
    };

    expect(schema.properties.channel_type).toEqual(expect.objectContaining({
      type: 'string',
      enum: ['discord', 'terminal', 'api', 'telegram', 'psfn-amica'],
    }));
    expect(schema.properties.channel_type).not.toHaveProperty('anyOf');
  });

  it.each([
    ['DM', '123456789012345678'],
    ['guild channel', '234567890123456789'],
  ])('validates and queues a Discord follow-up for a string %s snowflake', async (_surface, channelId) => {
    const pendingFollowUpStore = createPendingFollowUpStore();
    const { tool } = createTool({ pendingFollowUpStore });

    const result = await executeScheduleCall(tool, {
      action: 'create_follow_up',
      content: 'Check whether the conversation needs a follow-up.',
      channel_id: channelId,
      channel_type: 'discord',
    });

    expect(result.isError).toBe(false);
    expect(pendingFollowUpStore.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      channelId,
      channelType: 'discord',
    }));
  });

  it.each([
    ['a prefixed destination', 'discord:dm:not-a-snowflake'],
    ['a value outside the unsigned 64-bit range', '18446744073709551616'],
  ])('fails closed before enqueueing %s as a Discord channel id', async (_case, channelId) => {
    const pendingFollowUpStore = createPendingFollowUpStore();
    const { tool } = createTool({ pendingFollowUpStore });

    const result = await executeScheduleCall(tool, {
      action: 'create_follow_up',
      content: 'This must not be queued to an ambiguous destination.',
      channel_id: channelId,
      channel_type: 'discord',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('channel_id must be a Discord snowflake string');
    expect(pendingFollowUpStore.enqueue).not.toHaveBeenCalled();
  });

  it('fails closed before enqueueing a non-canonical channel type', async () => {
    const pendingFollowUpStore = createPendingFollowUpStore();
    const { tool } = createTool({ pendingFollowUpStore });

    const result = await executeScheduleCall(tool, {
      action: 'create_follow_up',
      content: 'This must not be queued to an unsupported channel type.',
      channel_id: '123456789012345678',
      channel_type: 'discord_text',
    });

    expect(result.isError).toBe(true);
    expect(pendingFollowUpStore.enqueue).not.toHaveBeenCalled();
  });

  it('persists relative scheduled prompts before registering the one-shot task', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-03-07T12:00:00.000Z'));
    try {
      const { tool, scheduler, scheduledPromptStore } = createTool();
      const result = await tool.execute('call-1', {
        action: 'schedule_prompt',
        name: 'Check in',
        prompt: 'Please check in about the scheduled prompt.',
        delay_minutes: 30,
      });

      expect(resultText(result)).toContain('2026-03-07T12:30:00.000Z');
      expect(scheduledPromptStore.create).toHaveBeenCalledWith(expect.objectContaining({
        name: 'Check in',
        prompt: 'Please check in about the scheduled prompt.',
        runAt: '2026-03-07T12:30:00.000Z',
        source: 'schedule_tool',
        channelId: expect.stringContaining('internal:planned:'),
        channelType: 'terminal',
        deliveryChannelId: 'discord:heartbeat',
      }));
      expect(scheduler.listTasks()).toHaveLength(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('accepts future absolute run_at datetimes with explicit timezone', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-03-07T12:00:00.000Z'));
    try {
      const { tool, scheduledPromptStore } = createTool();
      const result = await tool.execute('call-2', {
        action: 'schedule_prompt',
        name: 'Review',
        prompt: 'Please review the absolute scheduled prompt.',
        run_at: '2026-03-08T09:15:00-05:00',
      });

      expect(resultText(result)).toContain('2026-03-08T14:15:00.000Z');
      expect(scheduledPromptStore.records[0]?.runAt).toBe('2026-03-08T14:15:00.000Z');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('rejects ambiguous or invalid absolute scheduled prompt datetimes', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-03-07T12:00:00.000Z'));
    try {
      const { tool, scheduledPromptStore } = createTool();

      const naive = await tool.execute('call-naive', {
        action: 'schedule_prompt',
        name: 'Naive',
        prompt: 'Please reject this ambiguous scheduled prompt.',
        run_at: '2026-03-08T09:15:00',
      });
      expect(resultText(naive)).toContain('run_at must be an ISO-8601 datetime with explicit timezone');

      const both = await tool.execute('call-both', {
        action: 'schedule_prompt',
        name: 'Both',
        prompt: 'Please reject this mutually exclusive scheduled prompt.',
        delay_minutes: 5,
        run_at: '2026-03-08T09:15:00Z',
      });
      expect(resultText(both)).toContain('exactly one of delay_minutes or run_at');

      const past = await tool.execute('call-past', {
        action: 'schedule_prompt',
        name: 'Past',
        prompt: 'Please reject this past scheduled prompt.',
        run_at: '2026-03-07T11:59:00Z',
      });
      expect(resultText(past)).toContain('run_at must be in the future');

      const farFuture = await tool.execute('call-far', {
        action: 'schedule_prompt',
        name: 'Far',
        prompt: 'Please reject this far future scheduled prompt.',
        run_at: '2027-03-09T12:00:01Z',
      });
      expect(resultText(farFuture)).toContain('run_at must be no more than 366 days in the future');

      expect(scheduledPromptStore.create).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('fails closed when scheduled prompt persistence is unavailable', async () => {
    const { tool } = createTool({ scheduledPromptStore: null });

    const result = await tool.execute('call-missing-store', {
      action: 'schedule_prompt',
      name: 'No store',
      prompt: 'Please reject this prompt without persistence.',
      delay_minutes: 5,
    });

    expect(resultText(result)).toContain('scheduled prompt store is unavailable');
    expect(result.details.isError).toBe(true);
  });
});
