import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { SubstrateConfig } from './config/runtime-config-contracts.js';
import type { PromotedToolMutationResult } from '../core/agent/substrate-agent.js';
import {
  RUNTIME_SETTINGS_KEYS,
  getRuntimeSettingsSnapshot,
  isRuntimeSettingKey,
  type RuntimeSettingKey,
} from './settings.js';
import { textResultWithError as textResult } from '../core/tools/results.js';

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
  addPromotedExtendedTool(toolName: string): PromotedToolMutationResult;
  removePromotedExtendedTool(toolName: string): PromotedToolMutationResult;
  swapPromotedExtendedTools(fromSlot: number, toSlot: number): PromotedToolMutationResult;
}

export function executeSystemReadAction(
  config: SubstrateConfig,
  params: SettingsGetParams,
): AgentToolResult<{ isError?: boolean }> {
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
    ): Promise<AgentToolResult<{ isError?: boolean }>> => executeSystemReadAction(config, params),
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
): AgentTool<any> {
  return {
    name: 'promoted_tools_add',
    label: 'promoted_tools_add',
    description: 'Add an extended tool to promoted slots (max 4, capability-safe).',
    parameters: Type.Object({
      tool: Type.String({ description: 'Extended tool name to promote.' }),
    }),
    execute: async (
      _toolCallId: string,
      params: { tool: string },
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      return promotedMutationResponse(
        'add',
        manager,
        manager.addPromotedExtendedTool(params.tool),
      );
    },
  };
}

export function createPromotedToolsRemoveTool(
  manager: PromotedExtendedToolsManager,
): AgentTool<any> {
  return {
    name: 'promoted_tools_remove',
    label: 'promoted_tools_remove',
    description: 'Remove a promoted extended tool by name.',
    parameters: Type.Object({
      tool: Type.String({ description: 'Promoted tool name to remove.' }),
    }),
    execute: async (
      _toolCallId: string,
      params: { tool: string },
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      return promotedMutationResponse(
        'remove',
        manager,
        manager.removePromotedExtendedTool(params.tool),
      );
    },
  };
}

export function createPromotedToolsSwapTool(
  manager: PromotedExtendedToolsManager,
): AgentTool<any> {
  return {
    name: 'promoted_tools_swap',
    label: 'promoted_tools_swap',
    description: 'Swap two promoted tool slots using 1-based slot indices.',
    parameters: Type.Object({
      fromSlot: Type.Integer({ description: '1-based source slot index.' }),
      toSlot: Type.Integer({ description: '1-based destination slot index.' }),
    }),
    execute: async (
      _toolCallId: string,
      params: { fromSlot: number; toSlot: number },
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      return promotedMutationResponse(
        'swap',
        manager,
        manager.swapPromotedExtendedTools(params.fromSlot, params.toSlot),
      );
    },
  };
}
