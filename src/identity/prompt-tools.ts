// ── Prompt Layer Agent Tools ──
// Tools that let Purrsephone inspect and modify her own prompt stack.
// Policy: agent can modify runtime/channel/task layers, but NOT base/operator.

import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@mariozechner/pi-ai';
import type { PromptLayerStore } from './prompt-store.js';

function textResult(text: string): AgentToolResult<Record<string, never>> {
  return {
    content: [{ type: 'text', text }] satisfies TextContent[],
    details: {},
  };
}

export function createPromptLayerListTool(store: PromptLayerStore): AgentTool<any> {
  return {
    name: 'prompt_layer_list',
    description: 'List all prompt layers in the prompt stack, showing their type, name, enabled status, and priority.',
    label: 'prompt_layer_list',
    parameters: Type.Object({}),
    execute: async (
      _toolCallId: string,
      _params: Record<string, never>,
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<Record<string, never>>> => {
      const layers = store.getAll();
      if (layers.length === 0) return textResult('No prompt layers configured.');

      const lines = layers.map(l => {
        const status = l.enabled ? 'ON' : 'OFF';
        const meta = [
          l.channelType ? `channel=${l.channelType}` : null,
          l.taskKind ? `task=${l.taskKind}` : null,
        ].filter(Boolean).join(', ');
        return `[${status}] ${l.type}/${l.name} (v${l.version}, priority=${l.priority}${meta ? ', ' + meta : ''}) -- ${l.id.slice(0, 8)}`;
      });
      return textResult(lines.join('\n'));
    },
  };
}

export function createPromptLayerGetTool(store: PromptLayerStore): AgentTool<any> {
  return {
    name: 'prompt_layer_get',
    description: 'Get the full content and metadata of a specific prompt layer.',
    label: 'prompt_layer_get',
    parameters: Type.Object({
      layer_id: Type.String({ description: 'ID of the prompt layer to retrieve (prefix match OK).' }),
    }),
    execute: async (
      _toolCallId: string,
      params: { layer_id: string },
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<Record<string, never>>> => {
      const layers = store.getAll();
      const layer = layers.find(l => l.id === params.layer_id || l.id.startsWith(params.layer_id));
      if (!layer) return textResult(`Layer not found: ${params.layer_id}`);

      const text = [
        `ID: ${layer.id}`,
        `Type: ${layer.type}`,
        `Name: ${layer.name}`,
        `Enabled: ${layer.enabled}`,
        `Priority: ${layer.priority}`,
        `Version: ${layer.version}`,
        `Updated: ${layer.updatedAt} by ${layer.updatedBy}`,
        `Checksum: ${layer.checksum}`,
        layer.channelType ? `Channel: ${layer.channelType}` : null,
        layer.taskKind ? `Task: ${layer.taskKind}` : null,
        `\n--- Content ---\n${layer.content}`,
      ].filter(Boolean).join('\n');
      return textResult(text);
    },
  };
}

export function createPromptLayerUpdateTool(store: PromptLayerStore): AgentTool<any> {
  return {
    name: 'prompt_layer_update',
    description: 'Update the content of a prompt layer. Agent cannot modify base or operator layers (admin-only). History is preserved for rollback.',
    label: 'prompt_layer_update',
    parameters: Type.Object({
      layer_id: Type.String({ description: 'ID of the prompt layer to update (prefix match OK).' }),
      content: Type.String({ description: 'New content for the layer.' }),
    }),
    execute: async (
      _toolCallId: string,
      params: { layer_id: string; content: string },
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<Record<string, never>>> => {
      const layers = store.getAll();
      const layer = layers.find(l => l.id === params.layer_id || l.id.startsWith(params.layer_id));
      if (!layer) return textResult(`Layer not found: ${params.layer_id}`);

      // Policy: agent can't modify base or operator layers
      if (layer.type === 'base' || layer.type === 'operator') {
        return textResult(`Cannot modify ${layer.type} layers -- these are admin-only.`);
      }

      const updated = store.update(layer.id, params.content, 'agent');
      return textResult(`Updated layer "${updated.name}" to v${updated.version} (checksum: ${updated.checksum})`);
    },
  };
}

export function createPromptLayerToggleTool(store: PromptLayerStore): AgentTool<any> {
  return {
    name: 'prompt_layer_toggle',
    description: 'Toggle a prompt layer on/off. Cannot disable the only base layer.',
    label: 'prompt_layer_toggle',
    parameters: Type.Object({
      layer_id: Type.String({ description: 'ID of the prompt layer to toggle (prefix match OK).' }),
    }),
    execute: async (
      _toolCallId: string,
      params: { layer_id: string },
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<Record<string, never>>> => {
      const layers = store.getAll();
      const layer = layers.find(l => l.id === params.layer_id || l.id.startsWith(params.layer_id));
      if (!layer) return textResult(`Layer not found: ${params.layer_id}`);

      // Policy: don't let agent disable base layers
      if (layer.type === 'base' && layer.enabled) {
        return textResult('Cannot disable base layers -- ask an admin if you need to modify the foundation.');
      }

      const toggled = store.toggle(layer.id);
      return textResult(`Layer "${toggled.name}" is now ${toggled.enabled ? 'enabled' : 'disabled'}`);
    },
  };
}
