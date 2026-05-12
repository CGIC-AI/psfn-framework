// ── Prompt Layer Agent Tools ──
// Tools that let the companion inspect and modify its own prompt stack.
// Policy: read access is always available; writes are tier-gated by capabilities.

import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { PromptLayerStatePort } from './prompt-state-port.js';
import type { PromptLayer, PromptHistoryEntry } from './prompt-types.js';
import {
  CARD_BACKED_FOUNDATION_PROMPT_MESSAGE,
  isCanonicalCharacterFoundationLayer,
} from './canonical-foundation.js';
import type { CharacterCardVersionStore, PersonaUpdateToolOptions } from './card-versioning.js';
import { executePersonaUpdateAction, extractCardPatchFromRecord } from './card-versioning.js';
import type { CapabilityToken } from '../../system/capabilities/tokens.js';
import { withCapabilityRequirement } from '../../system/capabilities/requirements.js';
import {
  IdentityCoolingOffManager,
} from '../../system/capabilities/safeguards.js';
import type { ApprovalQueuePort, ConfirmationQueueEntry } from '../../system/capabilities/approval-queue-port.js';
import type { CapabilityTier } from '../../system/config/runtime-config-contracts.js';
import { textResult, textResultWithError } from '../tools/results.js';
import { toErrorMessage } from '../../shared/utils/errors.js';

const DEFAULT_DIFF_LINE_LIMIT = 160;
const MAX_DIFF_LINE_LIMIT = 1_000;
const DEFAULT_CHANGELOG_LIMIT = 20;
const MAX_CHANGELOG_LIMIT = 200;
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

interface PromptLineDiffSummary {
  added: number;
  removed: number;
  lines: string[];
  hiddenLineCount: number;
}

type ProtectedPromptLayerProposalAction = 'update' | 'rollback' | 'toggle';

interface ProtectedPromptLayerProposalInput {
  action: ProtectedPromptLayerProposalAction;
  layer: PromptLayer;
  tier: CapabilityTier;
  reason: string;
  nextContent?: string;
  requestedVersion?: number;
  nextEnabled?: boolean;
}

function errorMessage(error: unknown): string {
  return toErrorMessage(error);
}

function resolvePromptLayerById(store: PromptLayerStatePort, layerId: string): PromptLayer | null {
  const normalized = layerId.trim();
  if (!normalized) return null;
  const layers = store.getAll();
  return layers.find(l => l.id === normalized || l.id.startsWith(normalized)) ?? null;
}

function resolvePromptLayerWriteCapability(store: PromptLayerStatePort, layerId: string): CapabilityToken {
  const layer = resolvePromptLayerById(store, layerId);
  if (!layer) return 'identity.write.runtime';
  if (layer.type === 'base') return 'identity.write.base';
  if (layer.type === 'operator') return 'identity.write.operator';
  return 'identity.write.runtime';
}

function isProtectedPromptLayer(layer: PromptLayer): boolean {
  return layer.type === 'base' || layer.type === 'operator';
}

function protectedPromptLayerLabel(layer: PromptLayer): string {
  return `${layer.type}/${layer.name} (${layer.id.slice(0, 8)} v${layer.version})`;
}

function protectedPromptLayerActionLabel(action: ProtectedPromptLayerProposalAction): string {
  if (action === 'rollback') return 'rollback';
  if (action === 'toggle') return 'toggle';
  return 'update';
}

function enqueueProtectedPromptLayerProposal(
  store: PromptLayerStatePort,
  confirmationQueue: ApprovalQueuePort,
  input: ProtectedPromptLayerProposalInput,
): ConfirmationQueueEntry {
  const actionLabel = protectedPromptLayerActionLabel(input.action);
  const lineDelta = typeof input.nextContent === 'string'
    ? countLineChanges(input.layer.content, input.nextContent)
    : null;
  const params: Record<string, unknown> = {
    layer_id: input.layer.id,
    layer_type: input.layer.type,
    layer_name: input.layer.name,
    previous_version: input.layer.version,
    previous_checksum: input.layer.checksum,
    previous_enabled: input.layer.enabled,
    reason: input.reason,
  };

  if (typeof input.nextContent === 'string') {
    params.content = input.nextContent;
  }
  if (typeof input.requestedVersion === 'number') {
    params.requested_version = input.requestedVersion;
  }
  if (typeof input.nextEnabled === 'boolean') {
    params.enabled = input.nextEnabled;
  }

  const companionReasonParts = [
    `${input.layer.type} prompt-layer ${actionLabel} proposed by ${input.tier} tier.`,
    input.reason,
    `Current layer: ${protectedPromptLayerLabel(input.layer)}; checksum ${input.layer.checksum}.`,
  ];
  if (lineDelta) {
    companionReasonParts.push(`Content delta: +${lineDelta.added}/-${lineDelta.removed} lines.`);
  }
  if (typeof input.nextEnabled === 'boolean') {
    companionReasonParts.push(`Requested enabled state: ${input.nextEnabled}.`);
  }

  return confirmationQueue.enqueue(
    {
      method: `identity.prompt_layer.${actionLabel}`,
      action: actionLabel,
      scope: protectedPromptLayerLabel(input.layer),
      params,
      companionReason: companionReasonParts.join(' '),
    },
    async (approvedParams: Record<string, unknown>, queueEntry: ConfirmationQueueEntry) => {
      const approvedLayerId = typeof approvedParams.layer_id === 'string'
        ? approvedParams.layer_id.trim()
        : input.layer.id;
      if (!approvedLayerId) {
        throw new Error('Approved prompt-layer proposal must include layer_id.');
      }

      const targetLayer = resolvePromptLayerById(store, approvedLayerId);
      if (!targetLayer) {
        throw new Error(`Layer not found: ${approvedLayerId}`);
      }
      if (isCanonicalCharacterFoundationLayer(targetLayer)) {
        throw new Error(CARD_BACKED_FOUNDATION_PROMPT_MESSAGE);
      }
      if (!isProtectedPromptLayer(targetLayer)) {
        throw new Error('Approved prompt-layer proposal must target a base or operator layer.');
      }
      if (targetLayer.version !== input.layer.version || targetLayer.checksum !== input.layer.checksum) {
        throw new Error(
          `Layer ${targetLayer.name} changed after proposal creation; inspect current v${targetLayer.version} and submit a new proposal.`,
        );
      }
      if (targetLayer.enabled !== input.layer.enabled) {
        throw new Error(
          `Layer ${targetLayer.name} enabled state changed after proposal creation; inspect current state and submit a new proposal.`,
        );
      }

      const approvedReason = normalizeReason(
        typeof approvedParams.reason === 'string' ? approvedParams.reason : undefined,
      ) ?? queueEntry.companionReason;

      if (input.action === 'toggle') {
        const enabled = approvedParams.enabled;
        if (typeof enabled !== 'boolean') {
          throw new Error('Approved prompt-layer toggle proposal must include boolean enabled.');
        }
        if (targetLayer.enabled === enabled) return;
        store.toggle(targetLayer.id);
        return;
      }

      const approvedContent = typeof approvedParams.content === 'string'
        ? approvedParams.content
        : input.nextContent;
      if (typeof approvedContent !== 'string') {
        throw new Error('Approved prompt-layer proposal must include content.');
      }

      store.update(targetLayer.id, approvedContent, 'admin:confirmation', {}, approvedReason);
    },
  );
}

function protectedPromptLayerProposalQueuedText(
  entry: ConfirmationQueueEntry,
  layer: PromptLayer,
  action: ProtectedPromptLayerProposalAction,
): string {
  return (
    `Prompt-layer ${protectedPromptLayerActionLabel(action)} queued for confirmation (id: ${entry.id}). ` +
    `${layer.type} identity layers cannot be changed directly by agent tools; ` +
    'use the admin Confirmations page to approve, deny, or modify.'
  );
}

function resolvePromptLayerWriteCapabilityForAction(
  store: PromptLayerStatePort,
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
  store: PromptLayerStatePort,
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

  const stagedLayer = readiness.stage ? store.getById(readiness.stage.layerId) : undefined;
  if (!stagedLayer) {
    return textResultWithError(`Layer not found: ${readiness.stage?.layerId ?? stageId}`, true);
  }
  if (isCanonicalCharacterFoundationLayer(stagedLayer)) {
    return textResultWithError(CARD_BACKED_FOUNDATION_PROMPT_MESSAGE, true);
  }
  if (isProtectedPromptLayer(stagedLayer)) {
    return textResultWithError(
      `${stagedLayer.type} identity layers now require operator confirmation; submit a new update or rollback proposal.`,
      true,
    );
  }

  const committed = identityCoolingOff.markCommitted(stageId);
  if (committed.status !== 'ready' || !committed.stage) {
    return textResultWithError(`Unable to commit stage ${stageId}.`, true);
  }

  const layer = stagedLayer;

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
  store: PromptLayerStatePort,
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

export interface IdentityToolOptions extends PromptLayerUpdateToolOptions, Pick<PersonaUpdateToolOptions, 'confirmationQueue'> {
  cardStore?: CharacterCardVersionStore;
}

export function createIdentityTool(
  store: PromptLayerStatePort,
  options: IdentityToolOptions = {},
): AgentTool<any> {
  const listTool = createPromptLayerListTool(store);
  const getTool = createPromptLayerGetTool(store);
  const diffTool = createIdentityDiffTool(store);
  const historyTool = createIdentityChangelogTool(store);
  const updateTool = createPromptLayerUpdateTool(store, options);
  const rollbackTool = createPromptLayerRollbackTool(store, options);
  const toggleTool = createPromptLayerToggleTool(store, options);
  const identityCoolingOff = options.identityCoolingOff;

  const tool: AgentTool<any> = {
    name: 'identity',
    description:
      'Unified identity surface for prompt-layer inspection, prompt-layer mutation, staged prompt commits/cancels, and persona updates. '
      + 'Mutating actions remain capability-gated, audited, and confirmation/cooling-off guarded. '
      + 'For action=toggle_layer, the tool result is JSON containing layerId, previousEnabled, enabled, and state.',
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
      layer_id: Type.Optional(Type.String({ description: 'Prompt layer ID. Prefer the full layer id from list_layers; prefix match is accepted.' })),
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
      toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
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
          case 'list_layers':
            return listTool.execute(toolCallId, {}, signal);
          case 'get_layer':
            return getTool.execute(toolCallId, params as { layer_id?: string; layer?: { id: string } }, signal);
          case 'diff_layer':
            return diffTool.execute(toolCallId, params as {
              layer_id: string;
              version?: number;
              to_version?: number;
              max_diff_lines?: number;
            }, signal);
          case 'history':
            return historyTool.execute(toolCallId, params as { layer_id?: string; limit?: number }, signal);
          case 'update_layer':
            return updateTool.execute(toolCallId, {
              layer_id: typeof params.layer_id === 'string' ? params.layer_id : undefined,
              content: typeof params.content === 'string' ? params.content : undefined,
              reason: typeof params.reason === 'string' ? params.reason : undefined,
              action: 'update',
            }, signal);
          case 'rollback_layer':
            return rollbackTool.execute(toolCallId, {
              layer_id: typeof params.layer_id === 'string' ? params.layer_id : undefined,
              version: typeof params.version === 'number' ? params.version : undefined,
              reason: typeof params.reason === 'string' ? params.reason : undefined,
              action: 'rollback',
            }, signal);
          case 'toggle_layer':
            return toggleTool.execute(toolCallId, {
              layer_id: typeof params.layer_id === 'string' ? params.layer_id : '',
            }, signal);
          case 'update_persona':
            if (!options.cardStore) {
              return textResultWithError('Character-card identity store is not configured.', true);
            }
            return executePersonaUpdateAction(options.cardStore, params, {
              getCapabilityTier: options.getCapabilityTier,
              confirmationQueue: options.confirmationQueue,
            });
          case 'commit_stage':
          case 'cancel_stage':
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
      } catch (error) {
        return textResultWithError(`identity failed: ${errorMessage(error)}`, true);
      }
    },
  };

  return withCapabilityRequirement(tool, (params) =>
    resolveIdentityRequiredCapability(store, identityCoolingOff, params),
  );
}

export function createPromptLayerListTool(store: PromptLayerStatePort): AgentTool<any> {
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
          return `[${status}] ${l.type}/${l.name} (id=${l.id}, v${l.version}, priority=${l.priority}${meta ? ', ' + meta : ''})`;
        });
        return textResult(lines.join('\n'));
      } catch (error) {
        return textResultWithError(`prompt_layer_list failed: ${errorMessage(error)}`, true);
      }
    },
  };
}

export function createPromptLayerGetTool(store: PromptLayerStatePort): AgentTool<any> {
  return {
    name: 'prompt_layer_get',
    description: 'Get the full content and metadata of a specific prompt layer. Use layer_id or layer.id.',
    label: 'prompt_layer_get',
    parameters: Type.Object({
      layer_id: Type.Optional(Type.String({ description: 'ID of the prompt layer to retrieve (prefix match OK).' })),
      layer: Type.Optional(Type.Object({
        id: Type.String({ description: 'Prompt layer ID to retrieve (prefix match OK).' }),
      })),
    }),
    execute: async (
      _toolCallId: string,
      params: { layer_id?: string; layer?: { id: string } },
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const layerId = (params.layer_id ?? params.layer?.id ?? '').trim();
        if (!layerId) return textResultWithError('prompt_layer_get requires layer_id.', true);
        const layers = store.getAll();
        const layer = layers.find(l => l.id === layerId || l.id.startsWith(layerId));
        if (!layer) return textResultWithError(`Layer not found: ${layerId}`, true);

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

export function createIdentityDiffTool(store: PromptLayerStatePort): AgentTool<any> {
  return withCapabilityRequirement({
    name: 'identity_diff',
    description:
      'Compare a prompt layer\'s current version to any historical version and return a textual diff summary. Use version or to_version.',
    label: 'identity_diff',
    parameters: Type.Object({
      layer_id: Type.String({ description: 'Prompt layer ID (or prefix) to diff.' }),
      version: Type.Optional(Type.Number({ description: 'Historical version to compare against.', minimum: 1 })),
      to_version: Type.Optional(Type.Number({ description: 'Alias for version.', minimum: 1 })),
      max_diff_lines: Type.Optional(Type.Number({
        description: `Max changed lines to display (default ${DEFAULT_DIFF_LINE_LIMIT}, max ${MAX_DIFF_LINE_LIMIT}).`,
        minimum: 1,
      })),
    }),
    execute: async (
      _toolCallId: string,
      params: {
        layer_id: string;
        version?: number;
        to_version?: number;
        max_diff_lines?: number;
      },
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const layer = resolvePromptLayerById(store, params.layer_id);
        if (!layer) return textResultWithError(`Layer not found: ${params.layer_id}`, true);

        const requestedVersion = Math.floor(params.version ?? params.to_version ?? Number.NaN);
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

export function createIdentityChangelogTool(store: PromptLayerStatePort): AgentTool<any> {
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
  confirmationQueue?: ApprovalQueuePort;
}

export function createPromptLayerUpdateTool(
  store: PromptLayerStatePort,
  options: PromptLayerUpdateToolOptions = {},
): AgentTool<any> {
  const identityCoolingOff = options.identityCoolingOff;
  const getCapabilityTier = options.getCapabilityTier ?? (() => 'autonomous' as CapabilityTier);
  const confirmationQueue = options.confirmationQueue;

  const tool: AgentTool<any> = {
    name: 'prompt_layer_update',
    description:
      'Update the content of a prompt layer. Access is controlled by capability tier; history is preserved for rollback. ' +
      'Base and operator identity-layer edits are queued for operator confirmation.',
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
        if (isProtectedPromptLayer(layer)) {
          const reason = normalizeReason(params.reason) ?? 'Prompt layer updated via prompt_layer_update';
          if (!confirmationQueue) {
            return textResultWithError(
              `${layer.type} identity layer updates require confirmation queue support.`,
              true,
            );
          }
          const entry = enqueueProtectedPromptLayerProposal(store, confirmationQueue, {
            action: 'update',
            layer,
            tier,
            reason,
            nextContent: content,
          });
          return textResult(
            protectedPromptLayerProposalQueuedText(entry, layer, 'update'),
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
  store: PromptLayerStatePort,
  options: PromptLayerUpdateToolOptions = {},
): AgentTool<any> {
  const identityCoolingOff = options.identityCoolingOff;
  const getCapabilityTier = options.getCapabilityTier ?? (() => 'autonomous' as CapabilityTier);
  const confirmationQueue = options.confirmationQueue;

  const tool: AgentTool<any> = {
    name: 'prompt_layer_rollback',
    description:
      'Rollback a prompt layer to historical content. Access is controlled by capability tier. ' +
      'Base and operator identity-layer rollbacks are queued for operator confirmation.',
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
        if (isProtectedPromptLayer(layer)) {
          const reason = normalizeReason(params.reason)
            ?? `Prompt layer rolled back via prompt_layer_rollback to version ${requestedVersion}`;
          if (!confirmationQueue) {
            return textResultWithError(
              `${layer.type} identity layer rollbacks require confirmation queue support.`,
              true,
            );
          }
          const entry = enqueueProtectedPromptLayerProposal(store, confirmationQueue, {
            action: 'rollback',
            layer,
            tier,
            reason,
            nextContent: baseline.content,
            requestedVersion,
          });
          return textResult(
            protectedPromptLayerProposalQueuedText(entry, layer, 'rollback'),
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

export function createPromptLayerToggleTool(
  store: PromptLayerStatePort,
  options: PromptLayerUpdateToolOptions = {},
): AgentTool<any> {
  const getCapabilityTier = options.getCapabilityTier ?? (() => 'autonomous' as CapabilityTier);
  const confirmationQueue = options.confirmationQueue;
  const tool: AgentTool<any> = {
    name: 'prompt_layer_toggle',
    description:
      'Toggle a prompt layer on/off. Access is controlled by capability tier. '
      + 'Successful runtime/channel/task toggles return JSON with layerId, previousEnabled, enabled, and state.',
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
        const layerId = typeof params.layer_id === 'string' ? params.layer_id.trim() : '';
        if (!layerId) return textResultWithError('layer_id is required.', true);
        const layer = resolvePromptLayerById(store, layerId);
        if (!layer) return textResultWithError(`Layer not found: ${layerId}`, true);
        if (isCanonicalCharacterFoundationLayer(layer)) {
          return textResultWithError(CARD_BACKED_FOUNDATION_PROMPT_MESSAGE, true);
        }
        if (isProtectedPromptLayer(layer)) {
          if (!confirmationQueue) {
            return textResultWithError(
              `${layer.type} identity layer toggles require confirmation queue support.`,
              true,
            );
          }
          const entry = enqueueProtectedPromptLayerProposal(store, confirmationQueue, {
            action: 'toggle',
            layer,
            tier: getCapabilityTier(),
            reason: 'Prompt layer toggle requested via prompt_layer_toggle',
            nextEnabled: !layer.enabled,
          });
          return textResult(
            protectedPromptLayerProposalQueuedText(entry, layer, 'toggle'),
          );
        }

        const previousEnabled = layer.enabled;
        const toggled = store.toggle(layer.id);
        return textResult(JSON.stringify({
          action: 'toggle_layer',
          layerId: toggled.id,
          layerName: toggled.name,
          layerType: toggled.type,
          previousEnabled,
          enabled: toggled.enabled,
          state: toggled.enabled ? 'enabled' : 'disabled',
        }, null, 2));
      } catch (error) {
        return textResultWithError(`prompt_layer_toggle failed: ${errorMessage(error)}`, true);
      }
    },
  };

  return withCapabilityRequirement(tool, (params) =>
    resolvePromptLayerWriteCapability(store, String(params.layer_id ?? '')),
  );
}
