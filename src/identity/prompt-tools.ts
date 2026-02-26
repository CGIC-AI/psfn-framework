// ── Prompt Layer Agent Tools ──
// Tools that let Purrsephone inspect and modify her own prompt stack.
// Policy: read access is always available; writes are tier-gated by capabilities.

import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { PromptLayerStore } from './prompt-store.js';
import type { CapabilityToken } from '../capabilities/tokens.js';
import { withCapabilityRequirement } from '../capabilities/requirements.js';
import {
  IdentityCoolingOffManager,
} from '../capabilities/safeguards.js';
import type { CapabilityTier } from '../types.js';
import { textResult } from '../tools/results.js';

function resolvePromptLayerById(store: PromptLayerStore, layerId: string) {
  const normalized = layerId.trim();
  if (!normalized) return null;
  const layers = store.getAll();
  return layers.find(l => l.id === normalized || l.id.startsWith(normalized)) ?? null;
}

function resolvePromptLayerWriteCapability(store: PromptLayerStore, layerId: string): CapabilityToken {
  const layer = resolvePromptLayerById(store, layerId);
  if (!layer) return 'identity.write.runtime';
  if (layer.type === 'base') return 'identity.write.base';
  if (layer.type === 'operator') return 'identity.write.operator';
  return 'identity.write.runtime';
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

export interface PromptLayerUpdateToolOptions {
  identityCoolingOff?: IdentityCoolingOffManager;
  getCapabilityTier?: () => CapabilityTier;
}

export function createPromptLayerUpdateTool(
  store: PromptLayerStore,
  options: PromptLayerUpdateToolOptions = {},
): AgentTool<any> {
  const identityCoolingOff = options.identityCoolingOff;
  const getCapabilityTier = options.getCapabilityTier ?? (() => 'autonomous' as CapabilityTier);

  const tool: AgentTool<any> = {
    name: 'prompt_layer_update',
    description:
      'Update the content of a prompt layer. Access is controlled by capability tier; history is preserved for rollback. ' +
      'Base-layer edits at Nursery/Apprentice are staged with cooling-off and require commit/cancel.',
    label: 'prompt_layer_update',
    parameters: Type.Object({
      layer_id: Type.Optional(Type.String({ description: 'ID of the prompt layer to update (prefix match OK).' })),
      content: Type.Optional(Type.String({ description: 'New content for the layer.' })),
      action: Type.Optional(
        Type.Union([
          Type.Literal('update'),
          Type.Literal('commit'),
          Type.Literal('cancel'),
        ], { description: 'Action mode. Default: update.' }),
      ),
      stage_id: Type.Optional(Type.String({ description: 'Staged base-edit id used for commit/cancel.' })),
    }),
    execute: async (
      _toolCallId: string,
      params: {
        layer_id?: string;
        content?: string;
        action?: 'update' | 'commit' | 'cancel';
        stage_id?: string;
      },
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<Record<string, never>>> => {
      const action = params.action ?? 'update';

      if (action === 'cancel' || action === 'commit') {
        if (!identityCoolingOff) {
          return textResult('Identity cooling-off safeguard is not configured.');
        }
        const stageId = params.stage_id?.trim();
        if (!stageId) {
          return textResult('stage_id is required for commit/cancel actions.');
        }

        if (action === 'cancel') {
          const cancelled = identityCoolingOff.cancel(stageId);
          if (cancelled.status === 'not_found') {
            return textResult(`Stage not found: ${stageId}`);
          }
          if (cancelled.status === 'already_committed') {
            return textResult(`Stage already committed: ${stageId}`);
          }
          if (cancelled.status === 'already_cancelled') {
            return textResult(`Stage already cancelled: ${stageId}`);
          }
          return textResult(`Cancelled staged base-layer update (stage_id: ${stageId}).`);
        }

        const readiness = identityCoolingOff.checkReady(stageId);
        if (readiness.status === 'not_found') {
          return textResult(`Stage not found: ${stageId}`);
        }
        if (readiness.status === 'already_cancelled') {
          return textResult(`Stage already cancelled: ${stageId}`);
        }
        if (readiness.status === 'already_committed') {
          return textResult(`Stage already committed: ${stageId}`);
        }
        if (readiness.status === 'cooling_off') {
          const waitSeconds = Math.max(1, Math.ceil((readiness.waitMs ?? 0) / 1000));
          return textResult(
            `Stage ${stageId} is still cooling off (${waitSeconds}s remaining).`,
          );
        }

        const committed = identityCoolingOff.markCommitted(stageId);
        if (committed.status !== 'ready' || !committed.stage) {
          return textResult(`Unable to commit stage ${stageId}.`);
        }

        const layer = store.getById(committed.stage.layerId);
        if (!layer) return textResult(`Layer not found: ${committed.stage.layerId}`);

        const updated = store.update(layer.id, committed.stage.nextContent, 'agent');
        return textResult(
          `Committed staged update for "${updated.name}" to v${updated.version} (stage_id: ${stageId}).`,
        );
      }

      const layerId = params.layer_id?.trim();
      const content = params.content;
      if (!layerId) return textResult('layer_id is required.');
      if (typeof content !== 'string') return textResult('content is required.');

      const layer = resolvePromptLayerById(store, layerId);
      if (!layer) return textResult(`Layer not found: ${layerId}`);

      const tier = getCapabilityTier();
      const needsCoolingOff = (
        layer.type === 'base'
        && (tier === 'nursery' || tier === 'apprentice')
        && !!identityCoolingOff
      );
      if (needsCoolingOff) {
        const staged = identityCoolingOff.stageBaseLayerEdit({
          layerId: layer.id,
          layerName: layer.name,
          previousContent: layer.content,
          nextContent: content,
          requestedBy: 'agent',
          tier,
        });
        return textResult(
          `Staged base-layer update (stage_id: ${staged.id}). ` +
          `Cooling-off until ${new Date(staged.readyAt).toISOString()}. ` +
          'Use prompt_layer_update with action=commit and stage_id to apply, or action=cancel to abort.',
        );
      }

      const updated = store.update(layer.id, content, 'agent');
      return textResult(`Updated layer "${updated.name}" to v${updated.version} (checksum: ${updated.checksum})`);
    },
  };

  return withCapabilityRequirement(tool, (params) => {
    const action = String(params.action ?? 'update');
    const stageId = typeof params.stage_id === 'string' ? params.stage_id : '';
    if ((action === 'commit' || action === 'cancel') && stageId && identityCoolingOff) {
      const stage = identityCoolingOff.getStage(stageId);
      if (stage) {
        return resolvePromptLayerWriteCapability(store, stage.layerId);
      }
    }
    return resolvePromptLayerWriteCapability(store, String(params.layer_id ?? ''));
  });
}

export function createPromptLayerToggleTool(store: PromptLayerStore): AgentTool<any> {
  const tool: AgentTool<any> = {
    name: 'prompt_layer_toggle',
    description: 'Toggle a prompt layer on/off. Access is controlled by capability tier.',
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

      const toggled = store.toggle(layer.id);
      return textResult(`Layer "${toggled.name}" is now ${toggled.enabled ? 'enabled' : 'disabled'}`);
    },
  };

  return withCapabilityRequirement(tool, (params) =>
    resolvePromptLayerWriteCapability(store, String(params.layer_id ?? '')),
  );
}
