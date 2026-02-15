// ── Heartbeat / Reflection Tools ──
// 3 agent-accessible tools for managing reflection templates and scheduling.
// heartbeat_get_policy  — view all templates
// heartbeat_update_policy — enable/disable, change interval/prompt, add new templates
// schedule_task — create a one-shot scheduled prompt

import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@mariozechner/pi-ai';
import type { HeartbeatPolicyStore } from './heartbeat-policy.js';
import type { Scheduler } from './scheduler.js';
import type { AgentLoop } from '../agent-loop.js';
import type { MessageSender } from '../lifecycle/notifications.js';

// ── Helpers ──

function textResult(text: string, isError = false): AgentToolResult<{ isError?: boolean }> {
  return {
    content: [{ type: 'text', text }] satisfies TextContent[],
    details: { isError: isError || undefined },
  };
}

function formatMs(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

const MAX_SCHEDULED_TASKS = 50;

// ── Tool 1: heartbeat_get_policy ──

export function createHeartbeatGetPolicyTool(
  store: HeartbeatPolicyStore,
): AgentTool<any> {
  return {
    name: 'heartbeat_get_policy',
    label: 'heartbeat_get_policy',
    description:
      'View all reflection templates in the heartbeat policy: their IDs, prompts, intervals, and enabled status.',
    parameters: Type.Object({}),
    execute: async (): Promise<AgentToolResult<{ isError?: boolean }>> => {
      const policy = store.load();
      const lines = [
        `Heartbeat Policy (v${policy.version}, updated ${policy.updatedAt} by ${policy.updatedBy})`,
        `Templates: ${policy.templates.length}`,
        '',
      ];

      for (const t of policy.templates) {
        lines.push(`[${t.enabled ? 'ON' : 'OFF'}] ${t.id} — "${t.name}"`);
        lines.push(`  Interval: ${formatMs(t.intervalMs)}`);
        lines.push(`  Discord: ${t.sendToDiscord ? 'yes' : 'no'}`);
        lines.push(`  Prompt: ${t.prompt.slice(0, 120)}${t.prompt.length > 120 ? '...' : ''}`);
        lines.push('');
      }

      return textResult(lines.join('\n'));
    },
  };
}

// ── Tool 2: heartbeat_update_policy ──

export function createHeartbeatUpdatePolicyTool(
  store: HeartbeatPolicyStore,
  syncFn: () => void,
): AgentTool<any> {
  return {
    name: 'heartbeat_update_policy',
    label: 'heartbeat_update_policy',
    description:
      'Update an existing reflection template (enable/disable, change interval or prompt) or add a new one. ' +
      'To update: provide templateId plus fields to change. ' +
      'To add: set action="add" with id, name, prompt, intervalMs.',
    parameters: Type.Object({
      action: Type.Optional(
        Type.Literal('add', { description: 'Set to "add" to create a new template' }),
      ),
      templateId: Type.Optional(
        Type.String({ description: 'ID of the template to update (for update mode)' }),
      ),
      id: Type.Optional(
        Type.String({ description: 'Slug ID for a new template (for add mode)' }),
      ),
      name: Type.Optional(Type.String({ description: 'Display name' })),
      prompt: Type.Optional(Type.String({ description: 'Reflection prompt text' })),
      intervalMs: Type.Optional(Type.Number({ description: 'Interval in milliseconds' })),
      enabled: Type.Optional(Type.Boolean({ description: 'Enable or disable' })),
      sendToDiscord: Type.Optional(
        Type.Boolean({ description: 'Whether to send the response to Discord' }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: {
        action?: 'add';
        templateId?: string;
        id?: string;
        name?: string;
        prompt?: string;
        intervalMs?: number;
        enabled?: boolean;
        sendToDiscord?: boolean;
      },
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      const policy = store.load();

      // ── Add mode ──
      if (params.action === 'add') {
        if (!params.id || !params.name || !params.prompt || params.intervalMs === undefined) {
          return textResult('Add requires: id, name, prompt, intervalMs', true);
        }

        if (policy.templates.length >= store.maxTemplates) {
          return textResult(`Max ${store.maxTemplates} templates allowed`, true);
        }

        if (policy.templates.some(t => t.id === params.id)) {
          return textResult(`Template "${params.id}" already exists`, true);
        }

        const newTemplate = {
          id: params.id,
          name: params.name,
          prompt: params.prompt,
          intervalMs: params.intervalMs,
          enabled: params.enabled ?? true,
          sendToDiscord: params.sendToDiscord ?? false,
        };

        const errors = store.validateNew(newTemplate);
        if (errors.length > 0) {
          return textResult(
            'Validation errors:\n' + errors.map(e => `  ${e.field}: ${e.message}`).join('\n'),
            true,
          );
        }

        policy.templates.push(newTemplate);
        policy.version++;
        policy.updatedAt = new Date().toISOString();
        policy.updatedBy = 'agent';
        store.save(policy);
        syncFn();

        return textResult(`Added template "${params.id}" (${formatMs(params.intervalMs)} interval)`);
      }

      // ── Update mode ──
      if (!params.templateId) {
        return textResult('Provide templateId to update, or action="add" to create', true);
      }

      const template = policy.templates.find(t => t.id === params.templateId);
      if (!template) {
        return textResult(`Template "${params.templateId}" not found`, true);
      }

      // Build update object for validation
      const updates: Record<string, unknown> = {};
      if (params.name !== undefined) updates.name = params.name;
      if (params.prompt !== undefined) updates.prompt = params.prompt;
      if (params.intervalMs !== undefined) updates.intervalMs = params.intervalMs;

      if (Object.keys(updates).length > 0) {
        const errors = store.validateUpdate(updates);
        if (errors.length > 0) {
          return textResult(
            'Validation errors:\n' + errors.map(e => `  ${e.field}: ${e.message}`).join('\n'),
            true,
          );
        }
      }

      // Apply changes
      if (params.name !== undefined) template.name = params.name;
      if (params.prompt !== undefined) template.prompt = params.prompt;
      if (params.intervalMs !== undefined) template.intervalMs = params.intervalMs;
      if (params.enabled !== undefined) template.enabled = params.enabled;
      if (params.sendToDiscord !== undefined) template.sendToDiscord = params.sendToDiscord;

      policy.version++;
      policy.updatedAt = new Date().toISOString();
      policy.updatedBy = 'agent';
      store.save(policy);
      syncFn();

      return textResult(
        `Updated template "${params.templateId}" — ` +
        `${template.enabled ? 'enabled' : 'disabled'}, ${formatMs(template.intervalMs)} interval`,
      );
    },
  };
}

// ── Tool 3: schedule_task ──

export function createScheduleTaskTool(
  scheduler: Scheduler,
  agentLoop: AgentLoop,
  sender: MessageSender,
  heartbeatChannelId?: string,
): AgentTool<any> {
  return {
    name: 'schedule_task',
    label: 'schedule_task',
    description:
      'Schedule a one-shot task to run after a delay. The prompt will be sent to yourself ' +
      'on an internal channel at the specified time. Delay range: 1–10080 minutes (up to 7 days).',
    parameters: Type.Object({
      name: Type.String({ description: 'Short name for the task' }),
      prompt: Type.String({ description: 'The prompt to send to yourself when the task fires' }),
      delay_minutes: Type.Number({ description: 'Delay in minutes before task fires (1–10080)' }),
    }),
    execute: async (
      _toolCallId: string,
      params: { name: string; prompt: string; delay_minutes: number },
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      if (params.delay_minutes < 1 || params.delay_minutes > 10080) {
        return textResult('delay_minutes must be between 1 and 10080 (7 days)', true);
      }

      if (!params.name || params.name.length === 0) {
        return textResult('name is required', true);
      }

      if (!params.prompt || params.prompt.length < 10) {
        return textResult('prompt must be at least 10 characters', true);
      }

      // Count existing tasks
      const allTasks = scheduler.listTasks();
      if (allTasks.length >= MAX_SCHEDULED_TASKS) {
        return textResult(`Max ${MAX_SCHEDULED_TASKS} total tasks allowed`, true);
      }

      const taskId = `planned:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const runAt = Date.now() + params.delay_minutes * 60_000;

      scheduler.register({
        id: taskId,
        name: params.name,
        type: 'one-shot',
        intervalMs: 0,
        runAt,
        handler: async () => {
          try {
            const response = await agentLoop.handleMessage({
              id: `planned-${Date.now()}`,
              channelId: `internal:planned:${taskId}`,
              channelType: 'terminal',
              authorId: 'scheduler',
              authorName: params.name,
              content: params.prompt,
              timestamp: new Date(),
            });

            // If sender + channel available, send result to Discord
            if (sender && heartbeatChannelId) {
              await sender.send(heartbeatChannelId, response.content);
            }
          } catch (err) {
            // Logged by scheduler's own error handling
          }
        },
        state: 'idle',
      });

      const fireAt = new Date(runAt).toISOString();
      return textResult(`Scheduled "${params.name}" to fire at ${fireAt} (in ${params.delay_minutes}m)`);
    },
  };
}
