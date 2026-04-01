import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { MemoryWriter } from './memory/writer.js';
import { buildAutonomousActionMemoryContext } from './memory/types.js';
import { describePromotedToolMutation } from './agent/substrate-agent/tool-orchestration-runtime.js';
import type { SubstrateConfig } from './types.js';
import type { PromotedToolMutationResult } from './agent/substrate-agent.js';
import {
  RUNTIME_SETTINGS_KEYS,
  getRuntimeSettingsSnapshot,
  isRuntimeSettingKey,
  type RuntimeSettingKey,
} from './settings.js';
import { textResultWithError as textResult } from './tools/results.js';
import { toErrorMessage } from './utils/errors.js';

interface SettingsGetParams {
  key?: string;
  keys?: string[];
  list?: boolean;
}

function unknownKeyError(key: string): AgentToolResult<{ isError?: boolean }> {
  return textResult(
    `Unknown setting key "${key}". Use {"list": true} to discover available keys.`,
    true,
  );
}

function promotedMutationResponse(
  action: string,
  manager: PromotedExtendedToolsManager,
  result: PromotedToolMutationResult,
): AgentToolResult<{ isError?: boolean }> {
  return textResult(
    JSON.stringify({
      action,
      maxSlots: manager.getPromotedExtendedToolsLimit(),
      ...result,
    }, null, 2),
    !result.ok,
  );
}

export interface PromotedExtendedToolsManager {
  getPromotedExtendedToolsLimit(): number;
  getPromotedExtendedTools(): readonly string[];
  setPromotedExtendedTools(next: readonly string[]): string[];
  persistPromotedExtendedTools(next: readonly string[]): string | null;
  addPromotedExtendedTool(toolName: string): PromotedToolMutationResult;
  removePromotedExtendedTool(toolName: string): PromotedToolMutationResult;
  swapPromotedExtendedTools(fromSlot: number, toSlot: number): PromotedToolMutationResult;
}

export interface PromotedToolsMutationToolOptions {
  getMemoryWriter?: () => Pick<MemoryWriter, 'write'> | undefined;
}

async function recordPromotedToolMutationMemory(input: {
  memoryWriter: Pick<MemoryWriter, 'write'>;
  toolName: string;
  action: 'add' | 'remove' | 'swap';
  before: readonly string[];
  after: readonly string[];
  reason?: string;
  extraTags?: string[];
  summary?: string;
}): Promise<void> {
  const provenance = buildAutonomousActionMemoryContext({
    toolName: input.toolName,
    action: input.action,
    reason: input.reason,
    timestampMs: Date.now(),
  });
  await input.memoryWriter.write({
    text: input.summary ?? describePromotedToolMutation({
      action: input.action,
      before: input.before,
      after: input.after,
      reason: input.reason,
    }),
    type: 'episodic',
    importance: 0.82,
    salience: 0.8,
    confidence: 0.9,
    emotionalValence: 0,
    retentionClass: 'durable',
    tags: [...provenance.tags, ...(input.extraTags ?? [])],
    sourceRef: provenance.sourceRef,
    provenanceRefs: provenance.provenanceRefs,
    scopeRef: provenance.scopeRef,
    scopeTags: [...provenance.scopeTags, ...(input.extraTags ?? [])],
  });
}

export function createSettingsGetTool(config: SubstrateConfig): AgentTool<any> {
  return {
    name: 'settings_get',
    label: 'settings_get',
    description:
      'Read runtime settings safely. Use list=true to view available keys, key="name" for one value, or keys=[...] for a subset.',
    parameters: Type.Object({
      key: Type.Optional(Type.String({ description: 'Single settings key to retrieve.' })),
      keys: Type.Optional(Type.Array(Type.String(), { description: 'Subset of settings keys to retrieve.' })),
      list: Type.Optional(Type.Boolean({ description: 'Return available safe keys.' })),
    }),
    execute: async (
      _toolCallId: string,
      params: SettingsGetParams,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      const snapshot = getRuntimeSettingsSnapshot(config);

      if (params.list) {
        return textResult(
          JSON.stringify({
            mode: 'list',
            keys: [...RUNTIME_SETTINGS_KEYS],
          }, null, 2),
        );
      }

      if (params.key && params.keys?.length) {
        return textResult('Provide either "key" or "keys", not both.', true);
      }

      if (params.key) {
        if (!isRuntimeSettingKey(params.key)) {
          return unknownKeyError(params.key);
        }
        return textResult(
          JSON.stringify({
            mode: 'single',
            key: params.key,
            value: snapshot[params.key],
          }, null, 2),
        );
      }

      if (params.keys?.length) {
        const invalid = params.keys.find(k => !isRuntimeSettingKey(k));
        if (invalid) return unknownKeyError(invalid);

        const subset: Partial<typeof snapshot> = {};
        for (const key of params.keys as RuntimeSettingKey[]) {
          subset[key] = snapshot[key];
        }

        return textResult(
          JSON.stringify({
            mode: 'subset',
            settings: subset,
          }, null, 2),
        );
      }

      return textResult(
        JSON.stringify({
          mode: 'all',
          settings: snapshot,
        }, null, 2),
      );
    },
  };
}

export function createPromotedToolsListTool(
  manager: PromotedExtendedToolsManager,
): AgentTool<any> {
  return {
    name: 'promoted_tools_list',
    label: 'promoted_tools_list',
    description: 'List promoted extended tools that stay active every turn.',
    parameters: Type.Object({}),
    execute: async (): Promise<AgentToolResult<{ isError?: boolean }>> => {
      return textResult(
        JSON.stringify({
          action: 'list',
          maxSlots: manager.getPromotedExtendedToolsLimit(),
          promotedTools: manager.getPromotedExtendedTools(),
        }, null, 2),
      );
    },
  };
}

export function createPromotedToolsAddTool(
  manager: PromotedExtendedToolsManager,
  options: PromotedToolsMutationToolOptions = {},
): AgentTool<any> {
  return {
    name: 'promoted_tools_add',
    label: 'promoted_tools_add',
    description: 'Add an extended tool to promoted slots (max 4, capability-safe).',
    parameters: Type.Object({
      tool: Type.String({ description: 'Extended tool name to promote.' }),
      reason: Type.Optional(Type.String({ description: 'Optional reason for the promotion.' })),
    }),
    execute: async (
      _toolCallId: string,
      params: { tool: string; reason?: string },
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      const before = manager.getPromotedExtendedTools();
      const result = manager.addPromotedExtendedTool(params.tool);
      const memoryWriter = options.getMemoryWriter?.();
      if (result.ok && result.changed && memoryWriter) {
        try {
          const summary = describePromotedToolMutation({
            action: 'add',
            toolName: params.tool,
            before,
            after: result.promotedTools,
            reason: params.reason,
          });
          await recordPromotedToolMutationMemory({
            memoryWriter,
            toolName: 'promoted_tools_add',
            action: 'add',
            before,
            after: result.promotedTools,
            reason: params.reason,
            extraTags: ['promoted_tools', 'toolset'],
            summary,
          });
        } catch (error) {
          const rollbackError = manager.persistPromotedExtendedTools(before);
          manager.setPromotedExtendedTools(before);
          return textResult(
            `Failed to persist autonomous-action memory for promoted tool add; rolled back change. ${toErrorMessage(error)}`
            + (rollbackError ? ` Rollback persistence failed: ${rollbackError}` : ''),
          true,
          );
        }
      }
      return promotedMutationResponse('add', manager, result);
    },
  };
}

export function createPromotedToolsRemoveTool(
  manager: PromotedExtendedToolsManager,
  options: PromotedToolsMutationToolOptions = {},
): AgentTool<any> {
  return {
    name: 'promoted_tools_remove',
    label: 'promoted_tools_remove',
    description: 'Remove a promoted extended tool by name.',
    parameters: Type.Object({
      tool: Type.String({ description: 'Promoted tool name to remove.' }),
      reason: Type.Optional(Type.String({ description: 'Optional reason for the removal.' })),
    }),
    execute: async (
      _toolCallId: string,
      params: { tool: string; reason?: string },
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      const before = manager.getPromotedExtendedTools();
      const result = manager.removePromotedExtendedTool(params.tool);
      const memoryWriter = options.getMemoryWriter?.();
      if (result.ok && result.changed && memoryWriter) {
        try {
          const summary = describePromotedToolMutation({
            action: 'remove',
            toolName: params.tool,
            before,
            after: result.promotedTools,
            reason: params.reason,
          });
          await recordPromotedToolMutationMemory({
            memoryWriter,
            toolName: 'promoted_tools_remove',
            action: 'remove',
            before,
            after: result.promotedTools,
            reason: params.reason,
            extraTags: ['promoted_tools', 'toolset'],
            summary,
          });
        } catch (error) {
          const rollbackError = manager.persistPromotedExtendedTools(before);
          manager.setPromotedExtendedTools(before);
          return textResult(
            `Failed to persist autonomous-action memory for promoted tool removal; rolled back change. ${toErrorMessage(error)}`
            + (rollbackError ? ` Rollback persistence failed: ${rollbackError}` : ''),
          true,
          );
        }
      }
      return promotedMutationResponse('remove', manager, result);
    },
  };
}

export function createPromotedToolsSwapTool(
  manager: PromotedExtendedToolsManager,
  options: PromotedToolsMutationToolOptions = {},
): AgentTool<any> {
  return {
    name: 'promoted_tools_swap',
    label: 'promoted_tools_swap',
    description: 'Swap two promoted tool slots using 1-based slot indices.',
    parameters: Type.Object({
      fromSlot: Type.Integer({ description: '1-based source slot index.' }),
      toSlot: Type.Integer({ description: '1-based destination slot index.' }),
      reason: Type.Optional(Type.String({ description: 'Optional reason for the swap.' })),
    }),
    execute: async (
      _toolCallId: string,
      params: { fromSlot: number; toSlot: number; reason?: string },
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      const before = manager.getPromotedExtendedTools();
      const result = manager.swapPromotedExtendedTools(params.fromSlot, params.toSlot);
      const memoryWriter = options.getMemoryWriter?.();
      if (result.ok && result.changed && memoryWriter) {
        try {
          const summary = describePromotedToolMutation({
            action: 'swap',
            fromSlot: params.fromSlot,
            toSlot: params.toSlot,
            before,
            after: result.promotedTools,
            reason: params.reason,
          });
          await recordPromotedToolMutationMemory({
            memoryWriter,
            toolName: 'promoted_tools_swap',
            action: 'swap',
            before,
            after: result.promotedTools,
            reason: params.reason,
            extraTags: ['promoted_tools', 'toolset'],
            summary,
          });
        } catch (error) {
          const rollbackError = manager.persistPromotedExtendedTools(before);
          manager.setPromotedExtendedTools(before);
          return textResult(
            `Failed to persist autonomous-action memory for promoted tool swap; rolled back change. ${toErrorMessage(error)}`
            + (rollbackError ? ` Rollback persistence failed: ${rollbackError}` : ''),
          true,
          );
        }
      }
      return promotedMutationResponse('swap', manager, result);
    },
  };
}
