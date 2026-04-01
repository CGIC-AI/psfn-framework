// ── Heartbeat / Reflection Tools ──
// 3 agent-accessible tools for managing reflection templates and scheduling.
// heartbeat_get_policy  — view all templates
// heartbeat_update_policy — enable/disable, change interval/prompt, add new templates
// schedule_task — create a one-shot scheduled prompt

import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type {
  HeartbeatPolicyStore,
  ReflectionDeliberationConfig,
} from './heartbeat-policy.js';
import { getHeartbeatTemplateAuditProfile } from './heartbeat-policy.js';
import type { Scheduler } from './scheduler.js';
import type { MessageSender } from '../lifecycle/notifications.js';
import type { PostTurnActionCandidate, SubstrateMessage } from '../types.js';
import { textResult, textResultWithError } from '../tools/results.js';
import { toErrorMessage } from '../utils/errors.js';
import { isBusyTurnError } from '../lifecycle/turn-contention.js';
import type { MemoryWriter } from '../memory/writer.js';
import { buildAutonomousActionMemoryContext } from '../memory/types.js';

// ── Helpers ──

function formatMs(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

const MAX_SCHEDULED_TASKS = 50;

function errorMessage(error: unknown): string {
  return toErrorMessage(error);
}

function formatDeliberation(config?: ReflectionDeliberationConfig): string {
  if (!config) return 'default';
  const parts: string[] = [];
  if (config.maxRounds !== undefined) parts.push(`rounds=${config.maxRounds}`);
  if (config.maxTotalTokens !== undefined) parts.push(`tokens=${config.maxTotalTokens}`);
  if (config.maxWallTimeMs !== undefined) parts.push(`wall=${config.maxWallTimeMs}ms`);
  if (config.voices !== undefined && config.voices.length > 0) {
    parts.push(`voices=${config.voices.join('+')}`);
  }
  return parts.length > 0 ? parts.join(', ') : 'default';
}

function cloneDeliberation(config: ReflectionDeliberationConfig | undefined): ReflectionDeliberationConfig | undefined {
  if (!config) return undefined;
  return {
    ...(config.maxRounds !== undefined ? { maxRounds: config.maxRounds } : {}),
    ...(config.maxTotalTokens !== undefined ? { maxTotalTokens: config.maxTotalTokens } : {}),
    ...(config.maxWallTimeMs !== undefined ? { maxWallTimeMs: config.maxWallTimeMs } : {}),
    ...(config.voices !== undefined ? { voices: [...config.voices] } : {}),
    ...(config.inputUsdPerMillionTokens !== undefined
      ? { inputUsdPerMillionTokens: config.inputUsdPerMillionTokens }
      : {}),
    ...(config.outputUsdPerMillionTokens !== undefined
      ? { outputUsdPerMillionTokens: config.outputUsdPerMillionTokens }
      : {}),
  };
}

async function recordAutonomousHeartbeatMemory(
  memoryWriter: Pick<MemoryWriter, 'write'>,
  input: {
    action: 'add' | 'update';
    templateId: string;
    templateName: string;
    summary: string;
    reason?: string;
  },
): Promise<void> {
  const provenance = buildAutonomousActionMemoryContext({
    toolName: 'heartbeat_update_policy',
    action: input.action,
    reason: input.reason,
    timestampMs: Date.now(),
  });

  await memoryWriter.write({
    text: input.summary,
    type: 'episodic',
    importance: 0.84,
    salience: 0.82,
    confidence: 0.9,
    emotionalValence: 0,
    retentionClass: 'durable',
    tags: [
      ...provenance.tags,
      'heartbeat_policy',
      `template:${input.templateId}`,
    ],
    sourceRef: provenance.sourceRef,
    provenanceRefs: provenance.provenanceRefs,
    scopeRef: provenance.scopeRef,
    scopeTags: [
      ...provenance.scopeTags,
      'heartbeat_policy',
      `template:${input.templateId}`,
      `template_name:${input.templateName.toLowerCase()}`,
    ],
  });
}

interface HeartbeatRunTemplateResult {
  templateId: string;
  templateName: string;
  reflection: string;
  silent?: boolean;
  queued?: boolean;
  deferredAction?: PostTurnActionCandidate;
}

interface ScheduleTaskAgentLoop {
  handleMessage(message: SubstrateMessage): Promise<{ content: string }>;
  waitForIdle?(): Promise<void>;
}

// ── Tool 1: heartbeat_get_policy ──

export function createHeartbeatGetPolicyTool(
  store: HeartbeatPolicyStore,
): AgentTool<any> {
  return {
    name: 'heartbeat_get_policy',
    label: 'heartbeat_get_policy',
    description:
      'View all reflection templates in the heartbeat policy: cadence, prompts, enabled status, and the intended purpose/output posture of each heartbeat.',
    parameters: Type.Object({}),
    execute: async (): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const policy = store.load();
        const lines = [
          `Heartbeat Policy (v${policy.version}, updated ${policy.updatedAt} by ${policy.updatedBy})`,
          `Templates: ${policy.templates.length}`,
          '',
        ];

        for (const t of policy.templates) {
          const audit = getHeartbeatTemplateAuditProfile(t);
          lines.push(`[${t.enabled ? 'ON' : 'OFF'}] ${t.id} — "${t.name}"`);
          lines.push(`  Interval: ${formatMs(t.intervalMs)}`);
          lines.push(`  Discord: ${t.sendToDiscord ? 'yes' : 'no'}`);
          lines.push(`  Mode: ${t.mode ?? 'standard'}`);
          lines.push(`  Purpose: ${audit.purpose}`);
          lines.push(`  Output: ${audit.outputExpectation}`);
          lines.push(`  Extraction: ${audit.extractionExpectation}`);
          lines.push(`  Silence: ${audit.allowSilentInterval ? 'allowed' : 'not allowed by default'}`);
          if (t.mode === 'deliberation') {
            lines.push(`  Deliberation: ${formatDeliberation(t.deliberation)}`);
          }
          lines.push(`  Prompt: ${t.prompt.slice(0, 120)}${t.prompt.length > 120 ? '...' : ''}`);
          lines.push('');
        }

        return textResult(lines.join('\n'));
      } catch (error) {
        return textResultWithError(`heartbeat_get_policy failed: ${errorMessage(error)}`, true);
      }
    },
  };
}

// ── Tool 2: heartbeat_update_policy ──

export function createHeartbeatUpdatePolicyTool(
  store: HeartbeatPolicyStore,
  syncFn: () => void,
  options: { memoryWriter?: Pick<MemoryWriter, 'write'> } = {},
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
      reason: Type.Optional(
        Type.String({ description: 'Optional reason for the policy change; captured in autonomous-action memory.' }),
      ),
      internalStateInput: Type.Optional(
        Type.Boolean({
          description:
            'When true, injects serialized InternalState + recent metacognitive flags + active concerns into prompt input.',
        }),
      ),
      mode: Type.Optional(
        Type.Union([
          Type.Literal('standard'),
          Type.Literal('deliberation'),
        ], { description: 'Reflection execution mode' }),
      ),
      deliberation: Type.Optional(
        Type.Object({
          maxRounds: Type.Optional(Type.Number({ description: 'Hard cap on deliberation rounds (1-8)' })),
          maxTotalTokens: Type.Optional(Type.Number({ description: 'Hard cap on total deliberation tokens' })),
          maxWallTimeMs: Type.Optional(Type.Number({ description: 'Hard cap on deliberation wall time (ms)' })),
          voices: Type.Optional(
            Type.Array(
              Type.Union([Type.Literal('reasoning'), Type.Literal('background')]),
              { description: 'Voice routing purposes for each round' },
            ),
          ),
          inputUsdPerMillionTokens: Type.Optional(
            Type.Number({ description: 'Estimated input token cost rate' }),
          ),
          outputUsdPerMillionTokens: Type.Optional(
            Type.Number({ description: 'Estimated output token cost rate' }),
          ),
        }),
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
        reason?: string;
        internalStateInput?: boolean;
        mode?: 'standard' | 'deliberation';
        deliberation?: ReflectionDeliberationConfig;
      },
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const policy = store.load();
        const previousPolicy = JSON.parse(JSON.stringify(policy)) as typeof policy;

        // ── Add mode ──
        if (params.action === 'add') {
          if (!params.id || !params.name || !params.prompt || params.intervalMs === undefined) {
            return textResultWithError('Add requires: id, name, prompt, intervalMs', true);
          }

          if (policy.templates.length >= store.maxTemplates) {
            return textResultWithError(`Max ${store.maxTemplates} templates allowed`, true);
          }

          if (policy.templates.some(t => t.id === params.id)) {
            return textResultWithError(`Template "${params.id}" already exists`, true);
          }

          const newTemplate = {
            id: params.id,
            name: params.name,
            prompt: params.prompt,
            intervalMs: params.intervalMs,
            enabled: params.enabled ?? true,
            sendToDiscord: params.sendToDiscord ?? false,
            ...(params.internalStateInput !== undefined ? { internalStateInput: params.internalStateInput } : {}),
            mode: params.mode ?? 'standard',
            ...(params.deliberation ? { deliberation: cloneDeliberation(params.deliberation) } : {}),
          };

          const errors = store.validateNew(newTemplate);
          if (errors.length > 0) {
            return textResultWithError(
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

          if (options.memoryWriter) {
            try {
              await recordAutonomousHeartbeatMemory(options.memoryWriter, {
                action: 'add',
                templateId: newTemplate.id,
                templateName: newTemplate.name,
                reason: params.reason,
                summary:
                  `Autonomous self-configuration change via heartbeat_update_policy: added heartbeat template "${newTemplate.id}" `
                  + `(${newTemplate.name}, interval ${formatMs(newTemplate.intervalMs)}, mode=${newTemplate.mode}).`
                  + (params.reason ? ` Reason: ${params.reason.trim()}.` : ''),
              });
            } catch (error) {
              store.save(previousPolicy);
              syncFn();
              return textResultWithError(
                `heartbeat_update_policy failed to persist autonomous-action memory; change rolled back. ${errorMessage(error)}`,
                true,
              );
            }
          }

          return textResult(`Added template "${params.id}" (${formatMs(params.intervalMs)} interval)`);
        }

        // ── Update mode ──
        if (!params.templateId) {
          return textResultWithError('Provide templateId to update, or action="add" to create', true);
        }

        const template = policy.templates.find(t => t.id === params.templateId);
        if (!template) {
          return textResultWithError(`Template "${params.templateId}" not found`, true);
        }

        // Build update object for validation
        const updates: Record<string, unknown> = {};
        if (params.name !== undefined) updates.name = params.name;
        if (params.prompt !== undefined) updates.prompt = params.prompt;
        if (params.intervalMs !== undefined) updates.intervalMs = params.intervalMs;
        if (params.internalStateInput !== undefined) updates.internalStateInput = params.internalStateInput;
        if (params.mode !== undefined) updates.mode = params.mode;
        if (params.deliberation !== undefined) updates.deliberation = params.deliberation;

        if (Object.keys(updates).length > 0) {
          const errors = store.validateUpdate(updates);
          if (errors.length > 0) {
            return textResultWithError(
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
        if (params.internalStateInput !== undefined) template.internalStateInput = params.internalStateInput;
        if (params.mode !== undefined) template.mode = params.mode;
        if (params.deliberation !== undefined) template.deliberation = cloneDeliberation(params.deliberation);

        policy.version++;
        policy.updatedAt = new Date().toISOString();
        policy.updatedBy = 'agent';
        store.save(policy);
        syncFn();

        if (options.memoryWriter) {
          try {
            const changedFields = [
              ...(params.name !== undefined ? [`name="${params.name}"`] : []),
              ...(params.prompt !== undefined ? ['prompt updated'] : []),
              ...(params.intervalMs !== undefined ? [`interval=${formatMs(params.intervalMs)}`] : []),
              ...(params.enabled !== undefined ? [`enabled=${params.enabled}`] : []),
              ...(params.sendToDiscord !== undefined ? [`discord=${params.sendToDiscord}`] : []),
              ...(params.internalStateInput !== undefined ? [`internalStateInput=${params.internalStateInput}`] : []),
              ...(params.mode !== undefined ? [`mode=${params.mode}`] : []),
              ...(params.deliberation !== undefined ? ['deliberation updated'] : []),
            ];
            await recordAutonomousHeartbeatMemory(options.memoryWriter, {
              action: 'update',
              templateId: template.id,
              templateName: template.name,
              reason: params.reason,
              summary:
                `Autonomous self-configuration change via heartbeat_update_policy: updated heartbeat template "${template.id}" `
                + `(${changedFields.join(', ') || 'no-op'}).`
                + (params.reason ? ` Reason: ${params.reason.trim()}.` : ''),
            });
          } catch (error) {
            store.save(previousPolicy);
            syncFn();
            return textResultWithError(
              `heartbeat_update_policy failed to persist autonomous-action memory; change rolled back. ${errorMessage(error)}`,
              true,
            );
          }
        }

        return textResult(
          `Updated template "${params.templateId}" — ` +
          `${template.enabled ? 'enabled' : 'disabled'}, ` +
          `${formatMs(template.intervalMs)} interval, mode=${template.mode ?? 'standard'}`,
        );
      } catch (error) {
        return textResultWithError(`heartbeat_update_policy failed: ${errorMessage(error)}`, true);
      }
    },
  };
}

// ── Tool 3: heartbeat_run_template ──

export function createHeartbeatRunTemplateTool(
  store: HeartbeatPolicyStore,
  runTemplate: (
    templateId: string,
    options?: { sendToDiscordOverride?: boolean; deferIfBusy?: boolean },
  ) => Promise<HeartbeatRunTemplateResult>,
): AgentTool<any> {
  return {
    name: 'heartbeat_run_template',
    label: 'heartbeat_run_template',
    description:
      'Manually trigger any reflection template by template id and return the reflection output now. ' +
      'Useful when you want a specific reflection run on demand.',
    parameters: Type.Object({
      templateId: Type.String({ description: 'Reflection template id to run immediately' }),
      sendToDiscord: Type.Optional(
        Type.Boolean({ description: 'Override whether this manual run should be sent to Discord' }),
      ),
      deferIfBusy: Type.Optional(
        Type.Boolean({
          description:
            'Queue this reflection for post-reply execution if the runtime is currently busy. Default: true.',
        }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: { templateId: string; sendToDiscord?: boolean; deferIfBusy?: boolean },
    ): Promise<AgentToolResult<{ isError?: boolean; deferredAction?: PostTurnActionCandidate }>> => {
      const templateId = params.templateId.trim();
      if (!templateId) {
        return textResultWithError('templateId is required', true);
      }

      try {
        const policy = store.load();
        if (!policy.templates.some(template => template.id === templateId)) {
          return textResultWithError(`Template "${templateId}" not found`, true);
        }

        const result = await runTemplate(templateId, {
          ...(params.sendToDiscord !== undefined
            ? { sendToDiscordOverride: params.sendToDiscord }
            : {}),
          deferIfBusy: params.deferIfBusy ?? true,
        });
        if (result.queued) {
          return {
            content: [{
              type: 'text',
              text:
                `Queued reflection template "${result.templateName}" (${result.templateId}) `
                + 'for post-reply execution.',
            }],
            details: {
              ...(result.deferredAction ? { deferredAction: result.deferredAction } : {}),
            },
          };
        }
        if (result.silent) {
          return textResult(
            `Completed reflection template "${result.templateName}" (${result.templateId}) `
            + 'with no note emitted. The current policy allows a silent/background interval when nothing useful surfaces.',
          );
        }
        const reflection = result.reflection.trim();
        return textResult(
          `Triggered reflection template "${result.templateName}" (${result.templateId}).\n\n`
          + (reflection || '[empty reflection output]'),
        );
      } catch (error) {
        return textResultWithError(`heartbeat_run_template failed: ${errorMessage(error)}`, true);
      }
    },
  };
}

// ── Tool 4: schedule_task ──

export function createScheduleTaskTool(
  scheduler: Scheduler,
  agentLoop: ScheduleTaskAgentLoop,
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
      try {
        if (params.delay_minutes < 1 || params.delay_minutes > 10080) {
          return textResultWithError('delay_minutes must be between 1 and 10080 (7 days)', true);
        }

        if (!params.name || params.name.length === 0) {
          return textResultWithError('name is required', true);
        }

        if (!params.prompt || params.prompt.length < 10) {
          return textResultWithError('prompt must be at least 10 characters', true);
        }

        // Count existing tasks
        const allTasks = scheduler.listTasks();
        if (allTasks.length >= MAX_SCHEDULED_TASKS) {
          return textResultWithError(`Max ${MAX_SCHEDULED_TASKS} total tasks allowed`, true);
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
            const runPlannedPrompt = async (): Promise<void> => {
              const response = await agentLoop.handleMessage({
                id: `planned-${Date.now()}`,
                channelId: `internal:planned:${taskId}`,
                channelType: 'terminal',
                authorId: 'scheduler',
                authorName: params.name,
                content: params.prompt,
                timestamp: new Date(),
              });

              // If channel available, send result to Discord
              if (heartbeatChannelId) {
                await sender.send(heartbeatChannelId, response.content);
              }
            };

            try {
              await runPlannedPrompt();
            } catch (err) {
              if (!isBusyTurnError(err)) {
                throw err;
              }
              if (typeof agentLoop.waitForIdle !== 'function') {
                throw err;
              }
              await agentLoop.waitForIdle();
              await runPlannedPrompt();
            }
          },
          state: 'idle',
        });

        const fireAt = new Date(runAt).toISOString();
        return textResult(`Scheduled "${params.name}" to fire at ${fireAt} (in ${params.delay_minutes}m)`);
      } catch (error) {
        return textResultWithError(`schedule_task failed: ${errorMessage(error)}`, true);
      }
    },
  };
}
