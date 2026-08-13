import { Type } from '@sinclair/typebox';
import { CANONICAL_TOOL_SURFACE_DESCRIPTIONS } from '../../core/agent/tool-surface/descriptions.js';
import type { AgentToolResult } from '../../boundary/pi-agent/index.js';
import type { SubstrateAgentTool } from '../../boundary/pi-agent/index.js';
import type { TurnID } from '../../shared/contracts/runtime.js';
import { textResult, textResultWithError } from '../../core/tools/results.js';
import {
  ACTIVE_CONCERN_EVIDENCE_KINDS,
  ACTIVE_CONCERN_OWNERS,
  ACTIVE_CONCERN_PRIORITIES,
  ACTIVE_CONCERN_SENSITIVITIES,
  ACTIVE_CONCERN_STATUSES,
  isConcernTerminalStatus,
  type ActiveConcern,
  type ActiveConcernEvidenceRef,
  type ActiveConcernOwner,
  type ActiveConcernPriority,
  type ActiveConcernSensitivity,
  type ActiveConcernStatus,
  type ActiveConcernVAD,
} from '../../core/intention/concerns.js';
import { emitConcernResolutionAppraisal } from '../../core/intention/concern-resolution-appraisal.js';
import type { ConcernStorePort } from '../../core/intention/concern-store-port.js';
import type { EventBus } from '../../shared/event-bus.js';
import {
  executeCreateConcernAction,
  executeListConcernsAction,
} from '../../core/intention/tools.js';
import {
  executeValuesAddAction,
  executeValuesListAction,
  executeValuesUpdateAction,
  type ValuesListParams,
} from '../values/tools.js';
import type { ValuesJournalStore } from '../values/store.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { getRequestContext } from '../../primitives/llm/request-context.js';
import { evaluateCogSecMemoryCandidacy } from '../../core/cogsec/memory-candidacy.js';
import type { IntrospectionConsentStore } from '../introspection/consent-store.js';
import type { IntrospectionTurnSensitivityDecisions } from '../introspection/turn-sensitivity.js';
import {
  CORE_MEMORY_LABELS,
  coreMemoryChannelScope,
  isCoreMemoryLabel,
  type CoreMemoryAppendOptions,
  type CoreMemoryBlock,
  type CoreMemoryLabel,
  type CoreMemoryMutationOptions,
  type CoreMemoryRethinkInput,
  type CoreMemoryScopeDescriptor,
  type CoreMemorySnapshot,
} from './store.js';

const LABEL_ENUM = [...CORE_MEMORY_LABELS];
type AgentManagedConcernStatus = Exclude<ActiveConcernStatus, 'candidate'>;
const AGENT_MANAGED_CONCERN_STATUSES = ACTIVE_CONCERN_STATUSES.filter(
  (status): status is AgentManagedConcernStatus => status !== 'candidate',
);
const ORIENT_ACTIONS = [
  'append',
  'replace',
  'reorient',
  'values_list',
  'values_add',
  'values_update',
  'create_concern',
  'list_concerns',
  'resolve_concern',
  'transition_concern',
  'introspection_consent_get',
  'introspection_consent_set',
  'introspection_turn_sensitivity_set',
] as const;
type OrientAction = (typeof ORIENT_ACTIONS)[number];

interface CoreMemoryToolStore {
  getBlock?(label: CoreMemoryLabel, options?: CoreMemoryMutationOptions): CoreMemoryBlock;
  append(
    label: CoreMemoryLabel,
    appendText: string,
    options?: CoreMemoryAppendOptions,
  ): CoreMemoryBlock;
  replace(label: CoreMemoryLabel, content: string, options?: CoreMemoryMutationOptions): CoreMemoryBlock;
  rethink(input: CoreMemoryRethinkInput, options?: CoreMemoryMutationOptions): CoreMemorySnapshot;
}

export interface OrientToolOptions {
  valuesJournal?: ValuesJournalStore | null;
  concernStore?: ConcernStorePort | null;
  introspectionConsentStore?: IntrospectionConsentStore | null;
  introspectionTurnSensitivityDecisions?: IntrospectionTurnSensitivityDecisions | null;
  /**
   * Live emotional VAD provider (vw3w.1). When the companion decides to resolve
   * or transition a concern into a terminal status, this snapshots the current
   * VAD as resolutionVAD (symmetric to formation capture). Undefined when no
   * current state is available — no fabrication (charter 8.3).
   */
  resolutionVadProvider?: (concern: ActiveConcern) => ActiveConcernVAD | undefined;
  /** Event bus for the resolution-as-appraisal relief-delta event (vw3w.1). */
  eventBus?: EventBus | null;
}

interface OrientToolParams extends ValuesListParams {
  action: OrientAction;
  block?: CoreMemoryLabel;
  text?: string;
  value?: string;
  context?: string;
  version?: number;
  separator?: string;
  persona?: string;
  human?: string;
  goals?: string;
  priority?: ActiveConcernPriority;
  status?: AgentManagedConcernStatus;
  salience?: number;
  sensitivity?: ActiveConcernSensitivity;
  owner?: ActiveConcernOwner;
  evidenceRefs?: ActiveConcernEvidenceRef[];
  reopenResolved?: boolean;
  nextReviewAt?: string;
  clearNextReview?: boolean;
  contactId?: string;
  source?: 'appraisal' | 'agent' | 'heartbeat';
  includeResolved?: boolean;
  includeExpired?: boolean;
  concernId?: string;
  concernIds?: string[];
  outcome?: string;
  enabled?: boolean;
  allowedPublicChannelIds?: string[];
  reason?: string;
  auditContentSensitivity?: 'non_intimate' | 'intimate';
}

const CONCERN_EVIDENCE_REF_SCHEMA = Type.Object({
  kind: Type.Unsafe<ActiveConcernEvidenceRef['kind']>({
    type: 'string',
    enum: [...ACTIVE_CONCERN_EVIDENCE_KINDS],
    description: 'Safe evidence reference kind. Do not include raw sensitive content.',
  }),
  ref: Type.String({
    minLength: 1,
    maxLength: 240,
    description: 'Opaque id, pointer, or stable reference. Do not include raw source text.',
  }),
  sensitivity: Type.Optional(Type.Unsafe<ActiveConcernSensitivity>({
    type: 'string',
    enum: [...ACTIVE_CONCERN_SENSITIVITIES],
  })),
  redacted: Type.Optional(Type.Boolean()),
  hash: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
});

function ensureAction(raw: unknown): OrientAction | null {
  if (typeof raw !== 'string') return null;
  return (ORIENT_ACTIONS as readonly string[]).includes(raw)
    ? raw as OrientAction
    : null;
}

function ensureLabel(raw: unknown): CoreMemoryLabel | null {
  if (typeof raw !== 'string') return null;
  return isCoreMemoryLabel(raw) ? raw : null;
}

function ensureString(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const normalized = raw.trim();
  if (normalized.length === 0) {
    return null;
  }
  return normalized;
}

function ensureReplacementText(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  return raw;
}

function requireValuesJournal(valuesJournal: ValuesJournalStore | null | undefined): ValuesJournalStore {
  if (!valuesJournal) {
    throw new Error('orient values support is not wired');
  }
  return valuesJournal;
}

function requireConcernStore(concernStore: ConcernStorePort | null | undefined): ConcernStorePort {
  if (!concernStore) {
    throw new Error('orient concern support is not wired');
  }
  return concernStore;
}

function validateOrientCandidacy(text: string, context: string): string | null {
  const decision = evaluateCogSecMemoryCandidacy({
    text,
    type: 'reflection',
    tags: ['orient', context],
    sourceType: 'tool_write',
  });
  if (decision.disposition === 'allow') return null;
  return `Error: orient rejected ${context} by CogSec candidacy policy (${decision.riskClass}: ${decision.reasonCodes.join(', ')})`;
}

function resolveCurrentCoreMemoryScope(): CoreMemoryScopeDescriptor | null {
  const requestContext = getRequestContext();
  if (!requestContext?.channelId?.trim()) {
    return null;
  }
  return coreMemoryChannelScope({
    channelId: requestContext.channelId,
    ...(requestContext.viewerIsDirectMessage !== undefined
      ? { isDirectMessage: requestContext.viewerIsDirectMessage }
      : {}),
  });
}

export function createOrientTool(
  store: CoreMemoryToolStore,
  options: OrientToolOptions = {},
): SubstrateAgentTool {
  return {
    name: 'orient',
    label: 'orient',
    description: CANONICAL_TOOL_SURFACE_DESCRIPTIONS.orient,
    parameters: Type.Object({
      action: Type.Unsafe<OrientAction>({
        type: 'string',
        enum: [...ORIENT_ACTIONS],
        description: 'Orientation action.',
      }),
      block: Type.Optional(Type.Unsafe<CoreMemoryLabel>({
        type: 'string',
        enum: LABEL_ENUM,
        description: 'Internal storage block for append/replace. persona=local continuity, human=participant or room context, goals=continuity commitments.',
      })),
      text: Type.Optional(Type.String({
        description:
          'Block text for append or replace actions, or open-thread text for action=create_concern. '
          + 'Use action=create_concern in the same turn to note something to revisit when deciding to follow up later, ask again tomorrow, or reach out tonight.',
      })),
      separator: Type.Optional(
        Type.String({
          description: 'Optional separator inserted before appended text. Default: newline.',
        }),
      ),
      persona: Type.Optional(Type.String({
        description: 'Complete replacement text for local continuity observations when action=reorient. Do not assign identity or mood.',
      })),
      human: Type.Optional(Type.String({
        description: 'Complete replacement text for participant or room context when action=reorient.',
      })),
      goals: Type.Optional(Type.String({
        description: 'Complete replacement text for scoped continuity commitments when action=reorient.',
      })),
      limit: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: 200,
        description: 'Optional bounded limit for action=values_list or action=list_concerns.',
      })),
      value: Type.Optional(Type.String({
        minLength: 1,
        description: 'Values statement for action=values_add or action=values_update.',
      })),
      context: Type.Optional(Type.String({
        minLength: 1,
        description: 'Optional values prompt/context for action=values_add or action=values_update.',
      })),
      version: Type.Optional(Type.Integer({
        minimum: 1,
        description: 'Existing values journal version for action=values_update.',
      })),
      priority: Type.Optional(Type.Unsafe<ActiveConcernPriority>({
        type: 'string',
        enum: [...ACTIVE_CONCERN_PRIORITIES],
        description: 'Relative priority metadata for the open thread noted with action=create_concern; prefer salience for how present it should be.',
      })),
      status: Type.Optional(Type.Unsafe<AgentManagedConcernStatus>({
        type: 'string',
        enum: [...AGENT_MANAGED_CONCERN_STATUSES],
        description: 'Open-thread lifecycle status for action=create_concern or action=transition_concern.',
      })),
      salience: Type.Optional(Type.Number({
        minimum: 0,
        maximum: 1,
        description: 'How present the open thread should be, from 0 to 1, for action=create_concern or action=transition_concern.',
      })),
      sensitivity: Type.Optional(Type.Unsafe<ActiveConcernSensitivity>({
        type: 'string',
        enum: [...ACTIVE_CONCERN_SENSITIVITIES],
        description: 'Sensitivity metadata for the open thread noted with action=create_concern.',
      })),
      owner: Type.Optional(Type.Unsafe<ActiveConcernOwner>({
        type: 'string',
        enum: [...ACTIVE_CONCERN_OWNERS],
        description: 'Lifecycle owner for the open thread noted with action=create_concern.',
      })),
      evidenceRefs: Type.Optional(Type.Array(CONCERN_EVIDENCE_REF_SCHEMA, {
        maxItems: 20,
        description: 'Safe evidence references for open-thread creation, resolution, or transition. Do not include raw sensitive content.',
      })),
      reopenResolved: Type.Optional(Type.Boolean({
        description: 'For action=create_concern, true only when new evidence should reopen a matching terminal open thread.',
      })),
      nextReviewAt: Type.Optional(Type.String({
        minLength: 1,
        description: 'Optional ISO timestamp for deferred/watching lifecycle review.',
      })),
      clearNextReview: Type.Optional(Type.Boolean({
        description: 'For action=transition_concern, clear any existing next review timestamp.',
      })),
      contactId: Type.Optional(Type.String({
        minLength: 1,
        description: 'Optional contact scope for open threads used by action=create_concern or action=list_concerns.',
      })),
      source: Type.Optional(Type.Union([
        Type.Literal('appraisal'),
        Type.Literal('agent'),
        Type.Literal('heartbeat'),
      ], {
        description: 'Creation source for the open thread noted with action=create_concern.',
      })),
      includeResolved: Type.Optional(Type.Boolean({
        description: 'Include resolved open threads for action=list_concerns.',
      })),
      includeExpired: Type.Optional(Type.Boolean({
        description: 'Include expired open threads for action=list_concerns.',
      })),
      concernId: Type.Optional(Type.String({
        minLength: 1,
        description: 'Used for action=resolve_concern. Copy the exact open-thread id returned by create_concern or list_concerns.',
      })),
      concernIds: Type.Optional(Type.Array(Type.String({
        minLength: 1,
      }), {
        minItems: 1,
        maxItems: 20,
        description: 'Used for action=resolve_concern to resolve multiple open thread ids in one call.',
      })),
      outcome: Type.Optional(Type.String({
        minLength: 1,
        description: 'Optional concise resolution note for action=resolve_concern.',
      })),
      enabled: Type.Optional(Type.Boolean({
        description: 'Exact consent state for action=introspection_consent_set.',
      })),
      allowedPublicChannelIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 240 }), {
        maxItems: 64,
        description: 'Exact public channel ids the companion consents to audit. Wildcards are forbidden.',
      })),
      reason: Type.Optional(Type.String({
        minLength: 1,
        maxLength: 500,
        description: 'Companion-authored reason for the introspection consent revision.',
      })),
      auditContentSensitivity: Type.Optional(Type.Union([
        Type.Literal('non_intimate'),
        Type.Literal('intimate'),
      ], {
        description: 'Companion classification of this exact current turn for action=introspection_turn_sensitivity_set.',
      })),
    }),
    execute: async (
      _toolCallId: string,
      params: OrientToolParams,
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      const action = ensureAction(params.action);
      if (!action) {
        return textResultWithError(
          `Error: action must be one of ${ORIENT_ACTIONS.join(', ')}`,
          true,
        );
      }

      try {
        if (action === 'introspection_turn_sensitivity_set') {
          if (!options.introspectionTurnSensitivityDecisions) {
            throw new Error('orient introspection turn sensitivity support is not wired');
          }
          const requestContext = getRequestContext();
          if (
            requestContext?.callType === 'background'
            || !requestContext?.turnId?.trim()
            || !requestContext.requestId?.trim()
          ) {
            throw new Error('introspection turn sensitivity requires an active companion turn with turnId and requestId');
          }
          if (
            params.auditContentSensitivity !== 'non_intimate'
            && params.auditContentSensitivity !== 'intimate'
          ) {
            throw new Error('auditContentSensitivity is required for action=introspection_turn_sensitivity_set');
          }
          const decision = options.introspectionTurnSensitivityDecisions.mark({
            sensitivity: params.auditContentSensitivity,
            turnId: requestContext.turnId as TurnID,
            requestId: requestContext.requestId,
          });
          return textResult(JSON.stringify(decision, null, 2));
        }

        if (action === 'introspection_consent_get') {
          if (!options.introspectionConsentStore) {
            throw new Error('orient introspection consent support is not wired');
          }
          return textResult(JSON.stringify(options.introspectionConsentStore.load(), null, 2));
        }

        if (action === 'introspection_consent_set') {
          if (!options.introspectionConsentStore) {
            throw new Error('orient introspection consent support is not wired');
          }
          const requestContext = getRequestContext();
          if (
            requestContext?.callType === 'background'
            || !requestContext?.turnId?.trim()
            || !requestContext.requestId?.trim()
          ) {
            throw new Error('introspection consent changes require an active companion turn with turnId and requestId');
          }
          if (typeof params.enabled !== 'boolean') {
            throw new Error('enabled is required for action=introspection_consent_set');
          }
          const revision = options.introspectionConsentStore.append({
            enabled: params.enabled,
            allowedPublicChannelIds: params.allowedPublicChannelIds ?? [],
            actor: {
              kind: 'companion',
              turnId: requestContext.turnId,
              requestId: requestContext.requestId,
            },
            reason: params.reason ?? '',
          });
          return textResult(JSON.stringify(revision, null, 2));
        }

        if (action === 'values_list') {
          return executeValuesListAction(
            requireValuesJournal(options.valuesJournal),
            { limit: params.limit },
          );
        }

        if (action === 'values_add') {
          return executeValuesAddAction(
            requireValuesJournal(options.valuesJournal),
            {
              value: params.value ?? '',
              ...(params.context !== undefined ? { context: params.context } : {}),
            },
          );
        }

        if (action === 'values_update') {
          return executeValuesUpdateAction(
            requireValuesJournal(options.valuesJournal),
            {
              version: params.version ?? 0,
              value: params.value ?? '',
              ...(params.context !== undefined ? { context: params.context } : {}),
            },
          );
        }

        if (action === 'create_concern') {
          return executeCreateConcernAction(
            requireConcernStore(options.concernStore),
            {
              text: params.text ?? '',
              priority: params.priority,
              contactId: params.contactId,
              source: params.source,
              status: params.status,
              salience: params.salience,
              sensitivity: params.sensitivity,
              owner: params.owner,
              evidenceRefs: params.evidenceRefs,
              reopenResolved: params.reopenResolved,
              nextReviewAt: params.nextReviewAt,
            },
          );
        }

        if (action === 'list_concerns') {
          return executeListConcernsAction(
            requireConcernStore(options.concernStore),
            {
              contactId: params.contactId,
              includeResolved: params.includeResolved,
              includeExpired: params.includeExpired,
              limit: params.limit,
            },
          );
        }

        if (action === 'resolve_concern') {
          const concernIds = Array.isArray(params.concernIds)
            ? params.concernIds.map(ensureString).filter((id): id is string => Boolean(id))
            : [];
          const singleConcernId = ensureString(params.concernId);
          if (singleConcernId) {
            concernIds.unshift(singleConcernId);
          }
          const uniqueConcernIds = [...new Set(concernIds)];
          if (uniqueConcernIds.length === 0) {
            return textResultWithError(JSON.stringify({
              error: 'missing_required_parameter',
              action: 'resolve_concern',
              required: 'concernId or concernIds',
              hint: 'Retry orient with action="resolve_concern" and concernId or concernIds set to ids returned by create_concern or list_concerns. Do not use tool_search, fs, or analysis_workbench for this.',
            }, null, 2), true);
          }
          const concernStore = requireConcernStore(options.concernStore);
          const resolved = [];
          const missing = [];
          for (const concernId of uniqueConcernIds) {
            const beforeResolution = await concernStore.getById(concernId);
            const resolutionVAD = beforeResolution
              ? options.resolutionVadProvider?.(beforeResolution)
              : undefined;
            const concern = await concernStore.resolveConcern(concernId, {
              outcome: params.outcome,
              evidenceRefs: params.evidenceRefs,
              ...(resolutionVAD ? { resolutionVAD } : {}),
            });
            if (concern) {
              resolved.push(concern);
              await emitConcernResolutionAppraisal(options.eventBus, {
                concern,
                source: 'decision',
              });
            } else {
              missing.push(concernId);
            }
          }
          const resultText = JSON.stringify({
            resolved: resolved.length,
            missing,
            concerns: resolved,
          }, null, 2);
          return missing.length > 0
            ? textResultWithError(resultText, true)
            : textResult(resultText);
        }

        if (action === 'transition_concern') {
          const concernIds = Array.isArray(params.concernIds)
            ? params.concernIds.map(ensureString).filter((id): id is string => Boolean(id))
            : [];
          const singleConcernId = ensureString(params.concernId);
          if (singleConcernId) {
            concernIds.unshift(singleConcernId);
          }
          const uniqueConcernIds = [...new Set(concernIds)];
          if (uniqueConcernIds.length === 0 || !params.status) {
            return textResultWithError(JSON.stringify({
              error: 'missing_required_parameter',
              action: 'transition_concern',
              required: 'concernId or concernIds, and status',
              hint: 'Retry orient with action="transition_concern", status, and concern id(s) returned by list_concerns.',
            }, null, 2), true);
          }
          const concernStore = requireConcernStore(options.concernStore);
          // vw3w.1: a transition into a terminal status is also a resolution —
          // capture the live VAD so the arc is complete on this path too.
          const transitioned = [];
          const missing = [];
          for (const concernId of uniqueConcernIds) {
            const beforeTransition = await concernStore.getById(concernId);
            const transitionResolutionVAD = isConcernTerminalStatus(params.status)
              && beforeTransition
              ? options.resolutionVadProvider?.(beforeTransition)
              : undefined;
            const concern = await concernStore.transitionConcernStatus(concernId, {
              status: params.status,
              outcome: params.outcome,
              evidenceRefs: params.evidenceRefs,
              resolutionEvidenceRefs: params.evidenceRefs,
              nextReviewAt: params.nextReviewAt,
              clearNextReview: params.clearNextReview,
              salience: params.salience,
              ...(transitionResolutionVAD ? { resolutionVAD: transitionResolutionVAD } : {}),
            });
            if (concern) {
              transitioned.push(concern);
              if (isConcernTerminalStatus(concern.status)) {
                await emitConcernResolutionAppraisal(options.eventBus, {
                  concern,
                  source: 'decision',
                });
              }
            } else {
              missing.push(concernId);
            }
          }
          const resultText = JSON.stringify({
            transitioned: transitioned.length,
            missing,
            concerns: transitioned,
          }, null, 2);
          return missing.length > 0
            ? textResultWithError(resultText, true)
            : textResult(resultText);
        }

        if (action === 'append') {
          const scope = resolveCurrentCoreMemoryScope();
          if (!scope) {
            return textResultWithError('Error: orient requires current channel context', true);
          }
          const label = ensureLabel(params.block);
          if (!label) {
            return textResultWithError(
              `Error: block must be one of ${LABEL_ENUM.join(', ')}`,
              true,
            );
          }
          const appendText = ensureString(params.text);
          if (!appendText) {
            return textResultWithError('Error: text is required for action=append', true);
          }
          const candidacyError = validateOrientCandidacy(appendText, label);
          if (candidacyError) {
            return textResultWithError(candidacyError, true);
          }
          if (params.separator !== undefined && typeof params.separator !== 'string') {
            return textResultWithError('Error: separator must be a string when provided', true);
          }
          const scopeOptions = { scope };
          const previousContent = store.getBlock?.(label, scopeOptions).content;
          const block = store.append(label, appendText, {
            separator: params.separator,
            scope,
          });
          if (previousContent !== undefined && block.content === previousContent) {
            return textResultWithError(
              `Error: orient append produced no durable change for ${label}`,
              true,
            );
          }
          return textResult(
            `Appended to ${label} orientation (${block.content.length}/${block.maxChars} chars).`,
          );
        }

        if (action === 'replace') {
          const scope = resolveCurrentCoreMemoryScope();
          if (!scope) {
            return textResultWithError('Error: orient requires current channel context', true);
          }
          const label = ensureLabel(params.block);
          if (!label) {
            return textResultWithError(
              `Error: block must be one of ${LABEL_ENUM.join(', ')}`,
              true,
            );
          }
          const replacementText = ensureReplacementText(params.text);
          if (replacementText === null) {
            return textResultWithError('Error: text must be a string for action=replace', true);
          }
          const candidacyError = validateOrientCandidacy(replacementText, label);
          if (candidacyError) {
            return textResultWithError(candidacyError, true);
          }
          const block = store.replace(label, replacementText, { scope });
          return textResult(
            `Replaced ${label} orientation (${block.content.length}/${block.maxChars} chars).`,
          );
        }

        const persona = ensureReplacementText(params.persona);
        if (persona === null) {
          return textResultWithError('Error: persona must be a string for action=reorient', true);
        }
        const human = ensureReplacementText(params.human);
        if (human === null) {
          return textResultWithError('Error: human must be a string for action=reorient', true);
        }
        const goals = ensureReplacementText(params.goals);
        if (goals === null) {
          return textResultWithError('Error: goals must be a string for action=reorient', true);
        }
        const candidacyErrors = [
          validateOrientCandidacy(persona, 'persona'),
          validateOrientCandidacy(human, 'human'),
          validateOrientCandidacy(goals, 'goals'),
        ].filter((error): error is string => Boolean(error));
        if (candidacyErrors.length > 0) {
          return textResultWithError(candidacyErrors[0] ?? '', true);
        }
        const scope = resolveCurrentCoreMemoryScope();
        if (!scope) {
          return textResultWithError('Error: orient requires current channel context', true);
        }
        const snapshot = store.rethink({
          persona,
          human,
          goals,
        }, { scope });
        const personaBlock = snapshot.blocks.persona;
        const humanBlock = snapshot.blocks.human;
        const goalsBlock = snapshot.blocks.goals;
        return textResult(
          `Reoriented active blocks `
          + `(persona ${personaBlock.content.length}/${personaBlock.maxChars}, `
          + `human ${humanBlock.content.length}/${humanBlock.maxChars}, `
          + `goals ${goalsBlock.content.length}/${goalsBlock.maxChars}).`,
        );
      } catch (error) {
        return textResultWithError(
          `Error updating orientation: ${toErrorMessage(error)}`,
          true,
        );
      }
    },
  };
}
