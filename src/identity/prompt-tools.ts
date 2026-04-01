// ── Prompt Layer Agent Tools ──
// Tools that let the companion inspect and modify its own prompt stack.
// Policy: read access is always available; writes are tier-gated by capabilities.

import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { PromptLayerStore } from './prompt-store.js';
import type { PromptLayer, PromptHistoryEntry } from './prompt-types.js';
import type { ConfirmationQueue } from '../capabilities/confirmation-queue.js';
import {
  CARD_BACKED_FOUNDATION_PROMPT_MESSAGE,
  isCanonicalCharacterFoundationLayer,
} from './canonical-foundation.js';
import type { CharacterCardVersionStore } from './card-versioning.js';
import { executePersonaUpdateAction, extractCardPatchFromRecord } from './card-versioning.js';
import type { CapabilityToken } from '../capabilities/tokens.js';
import { withCapabilityRequirement } from '../capabilities/requirements.js';
import {
  IdentityCoolingOffManager,
} from '../capabilities/safeguards.js';
import type { CapabilityTier } from '../types.js';
import { textResult, textResultWithError } from '../tools/results.js';
import { toErrorMessage } from '../utils/errors.js';

const DEFAULT_DIFF_LINE_LIMIT = 160;
const MAX_DIFF_LINE_LIMIT = 1_000;
const DEFAULT_CHANGELOG_LIMIT = 20;
const MAX_CHANGELOG_LIMIT = 200;

interface PromptLineDiffSummary {
  added: number;
  removed: number;
  lines: string[];
  hiddenLineCount: number;
}

const IDENTITY_FAIL_CLOSED_REQUIREMENTS: readonly CapabilityToken[] = [
  'identity.read',
  'identity.write.runtime',
  'identity.write.base',
  'identity.write.operator',
] as const;

const PERSONA_CONFLICT_PARAMETER_KEYS = [
  'layer_id',
  'content',
  'version',
  'stage_id',
  'limit',
  'max_diff_lines',
] as const;

type IdentityAction =
  | 'list_layers'
  | 'get_layer'
  | 'diff_layer'
  | 'history'
  | 'update_layer'
  | 'rollback_layer'
  | 'toggle_layer'
  | 'update_persona'
  | 'commit_stage'
  | 'cancel_stage';

export interface IdentityToolOptions {
  getCapabilityTier?: () => CapabilityTier;
  identityCoolingOff?: IdentityCoolingOffManager;
  cardStore?: CharacterCardVersionStore;
  confirmationQueue?: ConfirmationQueue;
}

function errorMessage(error: unknown): string {
  return toErrorMessage(error);
}

function resolvePromptLayerById(store: PromptLayerStore, layerId: string): PromptLayer | null {
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

function resolvePromptLayerWriteCapabilityForAction(
  store: PromptLayerStore,
  identityCoolingOff: IdentityCoolingOffManager | undefined,
  params: {
    action?: unknown;
    stage_id?: unknown;
    layer_id?: unknown;
  },
): CapabilityToken {
  const action = String(params.action ?? 'update');
  const stageId = typeof params.stage_id === 'string' ? params.stage_id : '';
  if ((action === 'commit' || action === 'cancel') && stageId && identityCoolingOff) {
    const stage = identityCoolingOff.getStage(stageId);
    if (stage) {
      return resolvePromptLayerWriteCapability(store, stage.layerId);
    }
  }
  return resolvePromptLayerWriteCapability(store, String(params.layer_id ?? ''));
}

function handlePromptLayerStagedAction(
  store: PromptLayerStore,
  identityCoolingOff: IdentityCoolingOffManager | undefined,
  params: {
    action: 'commit' | 'cancel';
    stage_id?: string;
    reason?: string;
  },
  options: {
    commitReason: string;
    commitSuccessMessage: (updatedLayer: PromptLayer, stageId: string) => string;
    cancelSuccessMessage: (stageId: string) => string;
  },
): AgentToolResult<{ isError?: boolean }> {
  if (!identityCoolingOff) {
    return textResultWithError('Identity cooling-off safeguard is not configured.', true);
  }

  const stageId = params.stage_id?.trim();
  if (!stageId) {
    return textResultWithError('stage_id is required for commit/cancel actions.', true);
  }

  if (params.action === 'cancel') {
    const cancelled = identityCoolingOff.cancel(stageId);
    if (cancelled.status === 'not_found') {
      return textResultWithError(`Stage not found: ${stageId}`, true);
    }
    if (cancelled.status === 'already_committed') {
      return textResultWithError(`Stage already committed: ${stageId}`, true);
    }
    if (cancelled.status === 'already_cancelled') {
      return textResultWithError(`Stage already cancelled: ${stageId}`, true);
    }
    return textResult(options.cancelSuccessMessage(stageId));
  }

  const readiness = identityCoolingOff.checkReady(stageId);
  if (readiness.status === 'not_found') {
    return textResultWithError(`Stage not found: ${stageId}`, true);
  }
  if (readiness.status === 'already_cancelled') {
    return textResultWithError(`Stage already cancelled: ${stageId}`, true);
  }
  if (readiness.status === 'already_committed') {
    return textResultWithError(`Stage already committed: ${stageId}`, true);
  }
  if (readiness.status === 'cooling_off') {
    const waitSeconds = Math.max(1, Math.ceil((readiness.waitMs ?? 0) / 1000));
    return textResultWithError(
      `Stage ${stageId} is still cooling off (${waitSeconds}s remaining).`,
      true,
    );
  }

  const committed = identityCoolingOff.markCommitted(stageId);
  if (committed.status !== 'ready' || !committed.stage) {
    return textResultWithError(`Unable to commit stage ${stageId}.`, true);
  }

  const layer = store.getById(committed.stage.layerId);
  if (!layer) return textResultWithError(`Layer not found: ${committed.stage.layerId}`, true);
  if (isCanonicalCharacterFoundationLayer(layer)) {
    return textResultWithError(CARD_BACKED_FOUNDATION_PROMPT_MESSAGE, true);
  }

  const reason = normalizeReason(params.reason) ?? options.commitReason;
  const updated = store.update(
    layer.id,
    committed.stage.nextContent,
    'agent',
    {},
    reason,
  );
  return textResult(options.commitSuccessMessage(updated, stageId));
}

function normalizeReason(reason: string | undefined): string | undefined {
  if (reason == null) return undefined;
  const trimmed = reason.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeOptionalBoundedInteger(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  const normalized = Math.floor(raw);
  if (normalized < min || normalized > max) return fallback;
  return normalized;
}

function countLineChanges(previousContent: string, nextContent: string): { added: number; removed: number } {
  const previousLines = previousContent.split('\n');
  const nextLines = nextContent.split('\n');
  const max = Math.max(previousLines.length, nextLines.length);
  let added = 0;
  let removed = 0;

  for (let index = 0; index < max; index += 1) {
    const previous = previousLines[index];
    const next = nextLines[index];
    if (previous === next) continue;
    removed += 1;
    added += 1;
  }

  return { added, removed };
}

function buildPromptLineDiff(
  previousContent: string,
  nextContent: string,
  maxLines: number,
): PromptLineDiffSummary {
  const previousLines = previousContent.split('\n');
  const nextLines = nextContent.split('\n');
  const max = Math.max(previousLines.length, nextLines.length);

  const fullLines: string[] = [];
  let added = 0;
  let removed = 0;

  for (let index = 0; index < max; index += 1) {
    const previous = previousLines[index];
    const next = nextLines[index];
    if (previous === next) continue;
    removed += 1;
    fullLines.push(`- ${previous}`);
    added += 1;
    fullLines.push(`+ ${next}`);
  }

  if (fullLines.length <= maxLines) {
    return {
      added,
      removed,
      lines: fullLines,
      hiddenLineCount: 0,
    };
  }

  return {
    added,
    removed,
    lines: fullLines.slice(0, maxLines),
    hiddenLineCount: fullLines.length - maxLines,
  };
}

function resolveHistoricalPromptVersion(
  layer: PromptLayer,
  history: PromptHistoryEntry[],
  version: number,
): { content: string; checksum: string } | null {
  if (version === layer.version) {
    return {
      content: layer.content,
      checksum: layer.checksum,
    };
  }

  const entry = history.find(item => item.version === version);
  if (!entry) return null;
  return {
    content: entry.previousContent,
    checksum: entry.previousChecksum,
  };
}

function resolveIdentityAction(params: Record<string, unknown>): IdentityAction | null {
  const rawAction = typeof params.action === 'string' ? params.action.trim() : '';
  if (!rawAction) {
    return Object.keys(params).length === 0 ? 'list_layers' : null;
  }

  switch (rawAction) {
    case 'list_layers':
    case 'get_layer':
    case 'diff_layer':
    case 'history':
    case 'update_layer':
    case 'rollback_layer':
    case 'toggle_layer':
    case 'update_persona':
    case 'commit_stage':
    case 'cancel_stage':
      return rawAction;
    default:
      return null;
  }
}

function hasOwnDefinedValue(params: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(params, key) && params[key] !== undefined;
}

function hasPersonaMutationParams(params: Record<string, unknown>): boolean {
  return Object.keys(extractCardPatchFromRecord(params)).length > 0
    || params.allow_destructive_replace === true;
}

function hasPromptConflictParams(params: Record<string, unknown>): boolean {
  return PERSONA_CONFLICT_PARAMETER_KEYS.some((key) => hasOwnDefinedValue(params, key));
}

function validateIdentityActionShape(
  action: IdentityAction,
  params: Record<string, unknown>,
): string | null {
  if (action === 'update_persona') {
    if (hasPromptConflictParams(params)) {
      return 'update_persona does not accept prompt-layer parameters; use the matching identity action for layer reads or mutations.';
    }
    return null;
  }

  if (hasPersonaMutationParams(params)) {
    return `${action} does not accept persona mutation fields; use action=update_persona for character-card edits.`;
  }

  return null;
}

function resolveIdentityRequiredCapability(
  store: PromptLayerStore,
  identityCoolingOff: IdentityCoolingOffManager | undefined,
  params: Record<string, unknown>,
): CapabilityToken | readonly CapabilityToken[] {
  const action = resolveIdentityAction(params);
  switch (action) {
    case 'list_layers':
    case 'get_layer':
    case 'diff_layer':
    case 'history':
      return 'identity.read';
    case 'update_persona':
      return 'identity.write.runtime';
    case 'update_layer':
    case 'rollback_layer':
    case 'toggle_layer':
      return resolvePromptLayerWriteCapability(store, String(params.layer_id ?? ''));
    case 'commit_stage':
      return resolvePromptLayerWriteCapabilityForAction(store, identityCoolingOff, {
        action: 'commit',
        stage_id: params.stage_id,
        layer_id: params.layer_id,
      });
    case 'cancel_stage':
      return resolvePromptLayerWriteCapabilityForAction(store, identityCoolingOff, {
        action: 'cancel',
        stage_id: params.stage_id,
        layer_id: params.layer_id,
      });
    default:
      return IDENTITY_FAIL_CLOSED_REQUIREMENTS;
  }
}

export function createIdentityTool(
  store: PromptLayerStore,
  options: IdentityToolOptions = {},
): AgentTool<any> {
  const identityCoolingOff = options.identityCoolingOff;
  const getCapabilityTier = options.getCapabilityTier ?? (() => 'autonomous' as CapabilityTier);
  const cardStore = options.cardStore;

  const tool: AgentTool<any> = {
    name: 'identity',
    description:
      'Unified identity surface for prompt-layer inspection, prompt-layer mutation, staged prompt commits/cancels, and persona updates. '
      + 'Mutating actions remain capability-gated, audited, and confirmation/cooling-off guarded.',
    label: 'identity',
    parameters: Type.Object({
      action: Type.Optional(Type.Union([
        Type.Literal('list_layers'),
        Type.Literal('get_layer'),
        Type.Literal('diff_layer'),
        Type.Literal('history'),
        Type.Literal('update_layer'),
        Type.Literal('rollback_layer'),
        Type.Literal('toggle_layer'),
        Type.Literal('update_persona'),
        Type.Literal('commit_stage'),
        Type.Literal('cancel_stage'),
      ], {
        description:
          'Identity action. Required for all actions except empty-argument calls, which default to list_layers.',
      })),
      layer_id: Type.Optional(Type.String({ description: 'Prompt layer ID (prefix match OK).' })),
      content: Type.Optional(Type.String({ description: 'Replacement prompt-layer content for update_layer.' })),
      version: Type.Optional(Type.Number({ description: 'Historical prompt-layer version for diff_layer or rollback_layer.', minimum: 1 })),
      stage_id: Type.Optional(Type.String({ description: 'Staged prompt-layer edit ID for commit_stage or cancel_stage.' })),
      max_diff_lines: Type.Optional(Type.Number({
        description: `Max changed lines to display for diff_layer (default ${DEFAULT_DIFF_LINE_LIMIT}, max ${MAX_DIFF_LINE_LIMIT}).`,
        minimum: 1,
      })),
      limit: Type.Optional(Type.Number({
        description: `Max history entries for action=history (default ${DEFAULT_CHANGELOG_LIMIT}, max ${MAX_CHANGELOG_LIMIT}).`,
        minimum: 1,
      })),
      reason: Type.Optional(Type.String({ description: 'Short rationale for an identity mutation.' })),
      name: Type.Optional(Type.String({ description: 'Updated character name for update_persona.' })),
      description: Type.Optional(Type.String({ description: 'Updated character description for update_persona.' })),
      personality: Type.Optional(Type.String({ description: 'Updated character personality for update_persona.' })),
      scenario: Type.Optional(Type.String({ description: 'Updated character scenario for update_persona.' })),
      first_mes: Type.Optional(Type.String({ description: 'Updated first message seed for update_persona.' })),
      mes_example: Type.Optional(Type.String({ description: 'Updated dialogue example for update_persona.' })),
      system_prompt: Type.Optional(Type.String({ description: 'Updated system prompt section for update_persona.' })),
      post_history_instructions: Type.Optional(Type.String({ description: 'Updated post-history instructions for update_persona.' })),
      tags: Type.Optional(Type.Array(Type.String(), { description: 'Updated tag list for update_persona.' })),
      creator: Type.Optional(Type.String({ description: 'Updated creator attribution for update_persona.' })),
      creator_notes: Type.Optional(Type.String({ description: 'Updated creator notes for update_persona.' })),
      alternate_greetings: Type.Optional(Type.Array(Type.String(), { description: 'Updated alternate greetings for update_persona.' })),
      extensions_visual_description: Type.Optional(Type.String({ description: 'Updated visual description extension for update_persona.' })),
      'extensions.visual_description': Type.Optional(Type.String({ description: 'Alias for extensions_visual_description.' })),
      allow_destructive_replace: Type.Optional(Type.Boolean({
        description:
          'Set true only when intentionally replacing most of a long persona field instead of lightly editing it.',
      })),
    }),
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const action = resolveIdentityAction(params);
        if (!action) {
          return textResultWithError(
            'action is required. Supported actions: list_layers, get_layer, diff_layer, history, update_layer, rollback_layer, toggle_layer, update_persona, commit_stage, cancel_stage.',
            true,
          );
        }

        const shapeError = validateIdentityActionShape(action, params);
        if (shapeError) {
          return textResultWithError(shapeError, true);
        }

        switch (action) {
          case 'list_layers': {
            const layers = store.getAll();
            if (layers.length === 0) return textResult('No prompt layers configured.');

            const lines = layers.map((layer) => {
              const status = layer.enabled ? 'ON' : 'OFF';
              const meta = [
                layer.channelType ? `channel=${layer.channelType}` : null,
                layer.taskKind ? `task=${layer.taskKind}` : null,
              ].filter(Boolean).join(', ');
              return `[${status}] ${layer.type}/${layer.name} (v${layer.version}, priority=${layer.priority}${meta ? ', ' + meta : ''}) -- ${layer.id.slice(0, 8)}`;
            });
            return textResult(lines.join('\n'));
          }

          case 'get_layer': {
            const layerId = typeof params.layer_id === 'string' ? params.layer_id : '';
            const layer = resolvePromptLayerById(store, layerId);
            if (!layer) return textResultWithError(`Layer not found: ${String(params.layer_id ?? '')}`, true);

            return textResult([
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
            ].filter(Boolean).join('\n'));
          }

          case 'diff_layer': {
            const layerId = typeof params.layer_id === 'string' ? params.layer_id : '';
            const layer = resolvePromptLayerById(store, layerId);
            if (!layer) return textResultWithError(`Layer not found: ${String(params.layer_id ?? '')}`, true);
            if (typeof params.version !== 'number' || !Number.isInteger(params.version) || params.version <= 0) {
              return textResultWithError('version must be a positive integer.', true);
            }
            if (params.version > layer.version) {
              return textResultWithError(
                `Version ${params.version} is newer than current version ${layer.version}.`,
                true,
              );
            }

            const history = store.getLayerHistory(layer.id);
            const baseline = resolveHistoricalPromptVersion(layer, history, params.version);
            if (!baseline) {
              return textResultWithError(`No prompt history entry found for version ${params.version}.`, true);
            }

            const maxDiffLines = normalizeOptionalBoundedInteger(
              params.max_diff_lines,
              DEFAULT_DIFF_LINE_LIMIT,
              1,
              MAX_DIFF_LINE_LIMIT,
            );
            const diff = buildPromptLineDiff(baseline.content, layer.content, maxDiffLines);
            const lines = [
              `Identity diff for ${layer.type}/${layer.name} (${layer.id.slice(0, 8)})`,
              `Compared versions: v${params.version} -> v${layer.version}`,
              `Checksums: ${baseline.checksum} -> ${layer.checksum}`,
              `Changed lines: +${diff.added} / -${diff.removed}`,
            ];

            if (params.version === layer.version) {
              lines.push('No changes: requested version is the current version.');
              return textResult(lines.join('\n'));
            }

            if (diff.lines.length === 0) {
              lines.push('No textual changes between these versions (metadata-only update).');
              return textResult(lines.join('\n'));
            }

            lines.push('', '--- Diff ---', ...diff.lines);
            if (diff.hiddenLineCount > 0) {
              lines.push(`... ${diff.hiddenLineCount} more changed line(s) omitted.`);
            }
            return textResult(lines.join('\n'));
          }

          case 'history': {
            const limit = normalizeOptionalBoundedInteger(
              params.limit,
              DEFAULT_CHANGELOG_LIMIT,
              1,
              MAX_CHANGELOG_LIMIT,
            );
            const layerFilter = typeof params.layer_id === 'string' && params.layer_id.trim().length > 0
              ? resolvePromptLayerById(store, params.layer_id)
              : null;
            if (params.layer_id && !layerFilter) {
              return textResultWithError(`Layer not found: ${params.layer_id}`, true);
            }

            const history = layerFilter ? store.getLayerHistory(layerFilter.id) : store.getHistory();
            if (history.length === 0) {
              return textResult('No prompt changes recorded yet.');
            }

            const layerTypeById = new Map(store.getAll().map(layer => [layer.id, layer.type]));
            const sorted = [...history].sort((left, right) => {
              const timeDelta = new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime();
              if (timeDelta !== 0) return timeDelta;
              return right.version - left.version;
            });
            const selected = sorted.slice(0, limit);
            const heading = layerFilter
              ? `Identity history for ${layerFilter.type}/${layerFilter.name} (${layerFilter.id.slice(0, 8)})`
              : 'Identity history for all prompt layers';

            const lines = selected.map((entry) => {
              const lineDelta = countLineChanges(entry.previousContent, entry.newContent);
              const layerType = layerTypeById.get(entry.layerId) ?? 'unknown';
              const reason = entry.reason ?? 'unspecified';
              const deltaSummary = (lineDelta.added === 0 && lineDelta.removed === 0)
                ? 'metadata-only'
                : `+${lineDelta.added}/-${lineDelta.removed} lines`;
              return [
                `- ${entry.timestamp}`,
                `${layerType}/${entry.layerName}`,
                `v${entry.version}->v${entry.version + 1}`,
                `by ${entry.updatedBy}`,
                `what: ${deltaSummary}`,
                `why: ${reason}`,
              ].join(' | ');
            });

            const hiddenCount = sorted.length - selected.length;
            if (hiddenCount > 0) {
              lines.push(`... ${hiddenCount} older change(s) omitted.`);
            }
            return textResult([heading, ...lines].join('\n'));
          }

          case 'update_layer': {
            const layerId = typeof params.layer_id === 'string' ? params.layer_id.trim() : '';
            if (!layerId) return textResultWithError('layer_id is required.', true);
            if (typeof params.content !== 'string') return textResultWithError('content is required.', true);

            const layer = resolvePromptLayerById(store, layerId);
            if (!layer) return textResultWithError(`Layer not found: ${layerId}`, true);
            if (isCanonicalCharacterFoundationLayer(layer)) {
              return textResultWithError(CARD_BACKED_FOUNDATION_PROMPT_MESSAGE, true);
            }

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
                nextContent: params.content,
                requestedBy: 'agent',
                tier,
              });
              return textResult(
                `Staged base-layer update (stage_id: ${staged.id}). `
                + `Cooling-off until ${new Date(staged.readyAt).toISOString()}. `
                + 'Use identity with action=commit_stage and stage_id to apply, or action=cancel_stage to abort.',
              );
            }

            const reason = normalizeReason(typeof params.reason === 'string' ? params.reason : undefined)
              ?? 'Prompt layer updated via identity action=update_layer';
            const updated = store.update(layer.id, params.content, 'agent', {}, reason);
            return textResult(`Updated layer "${updated.name}" to v${updated.version} (checksum: ${updated.checksum})`);
          }

          case 'rollback_layer': {
            const layerId = typeof params.layer_id === 'string' ? params.layer_id.trim() : '';
            if (!layerId) return textResultWithError('layer_id is required.', true);
            if (typeof params.version !== 'number' || !Number.isInteger(params.version) || params.version <= 0) {
              return textResultWithError('version must be a positive integer.', true);
            }

            const layer = resolvePromptLayerById(store, layerId);
            if (!layer) return textResultWithError(`Layer not found: ${layerId}`, true);
            if (isCanonicalCharacterFoundationLayer(layer)) {
              return textResultWithError(CARD_BACKED_FOUNDATION_PROMPT_MESSAGE, true);
            }
            if (params.version > layer.version) {
              return textResultWithError(
                `Version ${params.version} is newer than current version ${layer.version}.`,
                true,
              );
            }
            if (params.version === layer.version) {
              return textResult(`Layer "${layer.name}" is already at v${params.version}; no rollback needed.`);
            }

            const history = store.getLayerHistory(layer.id);
            const baseline = resolveHistoricalPromptVersion(layer, history, params.version);
            if (!baseline) {
              return textResultWithError(`No prompt history entry found for version ${params.version}.`, true);
            }
            if (baseline.content === layer.content) {
              return textResult(
                `Layer "${layer.name}" already matches content from v${params.version}; no rollback applied.`,
              );
            }

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
                nextContent: baseline.content,
                requestedBy: 'agent',
                tier,
              });
              return textResult(
                `Staged base-layer rollback to v${params.version} (stage_id: ${staged.id}). `
                + `Cooling-off until ${new Date(staged.readyAt).toISOString()}. `
                + 'Use identity with action=commit_stage and stage_id to apply, or action=cancel_stage to abort.',
              );
            }

            const reason = normalizeReason(typeof params.reason === 'string' ? params.reason : undefined)
              ?? `Prompt layer rolled back via identity action=rollback_layer to version ${params.version}`;
            const updated = store.update(layer.id, baseline.content, 'agent', {}, reason);
            return textResult(
              `Rolled back layer "${updated.name}" to v${params.version} content `
              + `(now v${updated.version}, checksum: ${updated.checksum})`,
            );
          }

          case 'toggle_layer': {
            const layerId = typeof params.layer_id === 'string' ? params.layer_id : '';
            const layer = resolvePromptLayerById(store, layerId);
            if (!layer) return textResultWithError(`Layer not found: ${String(params.layer_id ?? '')}`, true);
            if (isCanonicalCharacterFoundationLayer(layer)) {
              return textResultWithError(CARD_BACKED_FOUNDATION_PROMPT_MESSAGE, true);
            }

            const toggled = store.toggle(layer.id);
            return textResult(`Layer "${toggled.name}" is now ${toggled.enabled ? 'enabled' : 'disabled'}`);
          }

          case 'update_persona': {
            if (!cardStore) {
              return textResultWithError('Character-card identity store is not configured.', true);
            }
            return executePersonaUpdateAction(cardStore, params, {
              getCapabilityTier,
              confirmationQueue: options.confirmationQueue,
            });
          }

          case 'commit_stage':
          case 'cancel_stage': {
            return handlePromptLayerStagedAction(store, identityCoolingOff, {
              action: action === 'commit_stage' ? 'commit' : 'cancel',
              stage_id: typeof params.stage_id === 'string' ? params.stage_id : undefined,
              reason: typeof params.reason === 'string' ? params.reason : undefined,
            }, {
              commitReason: 'Committed staged identity prompt-layer change via identity tool',
              commitSuccessMessage: (updated, stageId) =>
                `Committed staged prompt-layer change for "${updated.name}" to v${updated.version} (stage_id: ${stageId}).`,
              cancelSuccessMessage: (stageId) =>
                `Cancelled staged prompt-layer change (stage_id: ${stageId}).`,
            });
          }
        }
      } catch (error) {
        return textResultWithError(`identity failed: ${errorMessage(error)}`, true);
      }
    },
  };

  return withCapabilityRequirement(tool, (params) =>
    resolveIdentityRequiredCapability(store, identityCoolingOff, params),
  );
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
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
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
      } catch (error) {
        return textResultWithError(`prompt_layer_list failed: ${errorMessage(error)}`, true);
      }
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
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const layers = store.getAll();
        const layer = layers.find(l => l.id === params.layer_id || l.id.startsWith(params.layer_id));
        if (!layer) return textResultWithError(`Layer not found: ${params.layer_id}`, true);

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
      } catch (error) {
        return textResultWithError(`prompt_layer_get failed: ${errorMessage(error)}`, true);
      }
    },
  };
}

export function createIdentityDiffTool(store: PromptLayerStore): AgentTool<any> {
  return withCapabilityRequirement({
    name: 'identity_diff',
    description:
      'Compare a prompt layer\'s current version to any historical version and return a textual diff summary.',
    label: 'identity_diff',
    parameters: Type.Object({
      layer_id: Type.String({ description: 'Prompt layer ID (or prefix) to diff.' }),
      version: Type.Number({ description: 'Historical version to compare against.', minimum: 1 }),
      max_diff_lines: Type.Optional(Type.Number({
        description: `Max changed lines to display (default ${DEFAULT_DIFF_LINE_LIMIT}, max ${MAX_DIFF_LINE_LIMIT}).`,
        minimum: 1,
      })),
    }),
    execute: async (
      _toolCallId: string,
      params: {
        layer_id: string;
        version: number;
        max_diff_lines?: number;
      },
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const layer = resolvePromptLayerById(store, params.layer_id);
        if (!layer) return textResultWithError(`Layer not found: ${params.layer_id}`, true);

        const requestedVersion = Math.floor(params.version);
        if (!Number.isInteger(requestedVersion) || requestedVersion <= 0) {
          return textResultWithError('version must be a positive integer.', true);
        }
        if (requestedVersion > layer.version) {
          return textResultWithError(
            `Version ${requestedVersion} is newer than current version ${layer.version}.`,
            true,
          );
        }

        const history = store.getLayerHistory(layer.id);
        const baseline = resolveHistoricalPromptVersion(layer, history, requestedVersion);
        if (!baseline) {
          return textResultWithError(`No prompt history entry found for version ${requestedVersion}.`, true);
        }

        const maxDiffLines = normalizeOptionalBoundedInteger(
          params.max_diff_lines,
          DEFAULT_DIFF_LINE_LIMIT,
          1,
          MAX_DIFF_LINE_LIMIT,
        );
        const diff = buildPromptLineDiff(baseline.content, layer.content, maxDiffLines);

        const lines = [
          `Identity diff for ${layer.type}/${layer.name} (${layer.id.slice(0, 8)})`,
          `Compared versions: v${requestedVersion} -> v${layer.version}`,
          `Checksums: ${baseline.checksum} -> ${layer.checksum}`,
          `Changed lines: +${diff.added} / -${diff.removed}`,
        ];

        if (requestedVersion === layer.version) {
          lines.push('No changes: requested version is the current version.');
          return textResult(lines.join('\n'));
        }

        if (diff.lines.length === 0) {
          lines.push('No textual changes between these versions (metadata-only update).');
          return textResult(lines.join('\n'));
        }

        lines.push('', '--- Diff ---', ...diff.lines);
        if (diff.hiddenLineCount > 0) {
          lines.push(`... ${diff.hiddenLineCount} more changed line(s) omitted.`);
        }
        return textResult(lines.join('\n'));
      } catch (error) {
        return textResultWithError(`identity_diff failed: ${errorMessage(error)}`, true);
      }
    },
  }, 'identity.read');
}

export function createIdentityChangelogTool(store: PromptLayerStore): AgentTool<any> {
  return withCapabilityRequirement({
    name: 'identity_changelog',
    description:
      'Generate a changelog of prompt-layer identity modifications with who changed what, when, and why.',
    label: 'identity_changelog',
    parameters: Type.Object({
      layer_id: Type.Optional(Type.String({ description: 'Optional prompt layer ID (or prefix) filter.' })),
      limit: Type.Optional(Type.Number({
        description: `Maximum number of changelog entries (default ${DEFAULT_CHANGELOG_LIMIT}, max ${MAX_CHANGELOG_LIMIT}).`,
        minimum: 1,
      })),
    }),
    execute: async (
      _toolCallId: string,
      params: {
        layer_id?: string;
        limit?: number;
      },
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const limit = normalizeOptionalBoundedInteger(
          params.limit,
          DEFAULT_CHANGELOG_LIMIT,
          1,
          MAX_CHANGELOG_LIMIT,
        );

        const layerFilter = typeof params.layer_id === 'string' && params.layer_id.trim().length > 0
          ? resolvePromptLayerById(store, params.layer_id)
          : null;
        if (params.layer_id && !layerFilter) {
          return textResultWithError(`Layer not found: ${params.layer_id}`, true);
        }

        const history = layerFilter
          ? store.getLayerHistory(layerFilter.id)
          : store.getHistory();
        if (history.length === 0) {
          return textResult('No prompt changes recorded yet.');
        }

        const layerTypeById = new Map(store.getAll().map(layer => [layer.id, layer.type]));
        const sorted = [...history].sort((left, right) => {
          const timeDelta = new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime();
          if (timeDelta !== 0) return timeDelta;
          return right.version - left.version;
        });

        const selected = sorted.slice(0, limit);
        const heading = layerFilter
          ? `Identity changelog for ${layerFilter.type}/${layerFilter.name} (${layerFilter.id.slice(0, 8)})`
          : 'Identity changelog for all prompt layers';

        const lines = selected.map(entry => {
          const lineDelta = countLineChanges(entry.previousContent, entry.newContent);
          const layerType = layerTypeById.get(entry.layerId) ?? 'unknown';
          const reason = entry.reason ?? 'unspecified';
          const deltaSummary = (lineDelta.added === 0 && lineDelta.removed === 0)
            ? 'metadata-only'
            : `+${lineDelta.added}/-${lineDelta.removed} lines`;
          return [
            `- ${entry.timestamp}`,
            `${layerType}/${entry.layerName}`,
            `v${entry.version}->v${entry.version + 1}`,
            `by ${entry.updatedBy}`,
            `what: ${deltaSummary}`,
            `why: ${reason}`,
          ].join(' | ');
        });

        const hiddenCount = sorted.length - selected.length;
        if (hiddenCount > 0) {
          lines.push(`... ${hiddenCount} older change(s) omitted.`);
        }

        return textResult([heading, ...lines].join('\n'));
      } catch (error) {
        return textResultWithError(`identity_changelog failed: ${errorMessage(error)}`, true);
      }
    },
  }, 'identity.read');
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
      reason: Type.Optional(Type.String({ description: 'Short rationale for the identity edit.' })),
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
        reason?: string;
        action?: 'update' | 'commit' | 'cancel';
        stage_id?: string;
      },
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const action = params.action ?? 'update';

        if (action === 'cancel' || action === 'commit') {
          return handlePromptLayerStagedAction(store, identityCoolingOff, {
            action,
            stage_id: params.stage_id,
            reason: params.reason,
          }, {
            commitReason: 'Committed staged prompt-layer update via prompt_layer_update',
            commitSuccessMessage: (updated, stageId) =>
              `Committed staged update for "${updated.name}" to v${updated.version} (stage_id: ${stageId}).`,
            cancelSuccessMessage: (stageId) =>
              `Cancelled staged base-layer update (stage_id: ${stageId}).`,
          });
        }

        const layerId = params.layer_id?.trim();
        const content = params.content;
        if (!layerId) return textResultWithError('layer_id is required.', true);
        if (typeof content !== 'string') return textResultWithError('content is required.', true);

        const layer = resolvePromptLayerById(store, layerId);
        if (!layer) return textResultWithError(`Layer not found: ${layerId}`, true);
        if (isCanonicalCharacterFoundationLayer(layer)) {
          return textResultWithError(CARD_BACKED_FOUNDATION_PROMPT_MESSAGE, true);
        }

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

        const reason = normalizeReason(params.reason) ?? 'Prompt layer updated via prompt_layer_update';
        const updated = store.update(layer.id, content, 'agent', {}, reason);
        return textResult(`Updated layer "${updated.name}" to v${updated.version} (checksum: ${updated.checksum})`);
      } catch (error) {
        return textResultWithError(`prompt_layer_update failed: ${errorMessage(error)}`, true);
      }
    },
  };

  return withCapabilityRequirement(tool, (params) => {
    return resolvePromptLayerWriteCapabilityForAction(store, identityCoolingOff, params);
  });
}

export function createPromptLayerRollbackTool(
  store: PromptLayerStore,
  options: PromptLayerUpdateToolOptions = {},
): AgentTool<any> {
  const identityCoolingOff = options.identityCoolingOff;
  const getCapabilityTier = options.getCapabilityTier ?? (() => 'autonomous' as CapabilityTier);

  const tool: AgentTool<any> = {
    name: 'prompt_layer_rollback',
    description:
      'Rollback a prompt layer to historical content. Access is controlled by capability tier. ' +
      'Base-layer rollbacks at Nursery/Apprentice are staged with cooling-off and require commit/cancel.',
    label: 'prompt_layer_rollback',
    parameters: Type.Object({
      layer_id: Type.Optional(Type.String({ description: 'ID of the prompt layer to roll back (prefix match OK).' })),
      version: Type.Optional(Type.Number({ description: 'Historical version to restore.', minimum: 1 })),
      reason: Type.Optional(Type.String({ description: 'Short rationale for the rollback.' })),
      action: Type.Optional(
        Type.Union([
          Type.Literal('rollback'),
          Type.Literal('commit'),
          Type.Literal('cancel'),
        ], { description: 'Action mode. Default: rollback.' }),
      ),
      stage_id: Type.Optional(Type.String({ description: 'Staged base-rollback id used for commit/cancel.' })),
    }),
    execute: async (
      _toolCallId: string,
      params: {
        layer_id?: string;
        version?: number;
        reason?: string;
        action?: 'rollback' | 'commit' | 'cancel';
        stage_id?: string;
      },
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const action = params.action ?? 'rollback';
        if (action === 'cancel' || action === 'commit') {
          return handlePromptLayerStagedAction(store, identityCoolingOff, {
            action,
            stage_id: params.stage_id,
            reason: params.reason,
          }, {
            commitReason: 'Committed staged prompt-layer rollback via prompt_layer_rollback',
            commitSuccessMessage: (updated, stageId) =>
              `Committed staged rollback for "${updated.name}" to v${updated.version} (stage_id: ${stageId}).`,
            cancelSuccessMessage: (stageId) =>
              `Cancelled staged base-layer rollback (stage_id: ${stageId}).`,
          });
        }

        const layerId = params.layer_id?.trim();
        if (!layerId) return textResultWithError('layer_id is required.', true);
        if (typeof params.version !== 'number' || !Number.isInteger(params.version) || params.version <= 0) {
          return textResultWithError('version must be a positive integer.', true);
        }

        const layer = resolvePromptLayerById(store, layerId);
        if (!layer) return textResultWithError(`Layer not found: ${layerId}`, true);
        if (isCanonicalCharacterFoundationLayer(layer)) {
          return textResultWithError(CARD_BACKED_FOUNDATION_PROMPT_MESSAGE, true);
        }

        const requestedVersion = params.version;
        if (requestedVersion > layer.version) {
          return textResultWithError(
            `Version ${requestedVersion} is newer than current version ${layer.version}.`,
            true,
          );
        }
        if (requestedVersion === layer.version) {
          return textResult(`Layer "${layer.name}" is already at v${requestedVersion}; no rollback needed.`);
        }

        const history = store.getLayerHistory(layer.id);
        const baseline = resolveHistoricalPromptVersion(layer, history, requestedVersion);
        if (!baseline) {
          return textResultWithError(`No prompt history entry found for version ${requestedVersion}.`, true);
        }
        if (baseline.content === layer.content) {
          return textResult(
            `Layer "${layer.name}" already matches content from v${requestedVersion}; no rollback applied.`,
          );
        }

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
            nextContent: baseline.content,
            requestedBy: 'agent',
            tier,
          });
          return textResult(
            `Staged base-layer rollback to v${requestedVersion} (stage_id: ${staged.id}). ` +
            `Cooling-off until ${new Date(staged.readyAt).toISOString()}. ` +
            'Use prompt_layer_rollback with action=commit and stage_id to apply, or action=cancel to abort.',
          );
        }

        const reason = normalizeReason(params.reason)
          ?? `Prompt layer rolled back via prompt_layer_rollback to version ${requestedVersion}`;
        const updated = store.update(layer.id, baseline.content, 'agent', {}, reason);
        return textResult(
          `Rolled back layer "${updated.name}" to v${requestedVersion} content ` +
          `(now v${updated.version}, checksum: ${updated.checksum})`,
        );
      } catch (error) {
        return textResultWithError(`prompt_layer_rollback failed: ${errorMessage(error)}`, true);
      }
    },
  };

  return withCapabilityRequirement(tool, (params) => {
    return resolvePromptLayerWriteCapabilityForAction(store, identityCoolingOff, params);
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
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const layers = store.getAll();
        const layer = layers.find(l => l.id === params.layer_id || l.id.startsWith(params.layer_id));
        if (!layer) return textResultWithError(`Layer not found: ${params.layer_id}`, true);
        if (isCanonicalCharacterFoundationLayer(layer)) {
          return textResultWithError(CARD_BACKED_FOUNDATION_PROMPT_MESSAGE, true);
        }

        const toggled = store.toggle(layer.id);
        return textResult(`Layer "${toggled.name}" is now ${toggled.enabled ? 'enabled' : 'disabled'}`);
      } catch (error) {
        return textResultWithError(`prompt_layer_toggle failed: ${errorMessage(error)}`, true);
      }
    },
  };

  return withCapabilityRequirement(tool, (params) =>
    resolvePromptLayerWriteCapability(store, String(params.layer_id ?? '')),
  );
}
