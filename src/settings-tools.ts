import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { SubstrateConfig } from './types.js';
import {
  RUNTIME_SETTINGS_KEYS,
  getRuntimeSettingsSnapshot,
  isRuntimeSettingKey,
  type RuntimeSettingKey,
} from './settings.js';
import { textResultWithError as textResult } from './tools/results.js';

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
