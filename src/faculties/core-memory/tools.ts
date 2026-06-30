import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { textResult, textResultWithError } from '../../core/tools/results.js';
import {
  ACTIVE_CONCERN_EVIDENCE_KINDS,
  ACTIVE_CONCERN_OWNERS,
  ACTIVE_CONCERN_PRIORITIES,
  ACTIVE_CONCERN_SENSITIVITIES,
  ACTIVE_CONCERN_STATUSES,
  type ActiveConcernEvidenceRef,
  type ActiveConcernOwner,
  type ActiveConcernPriority,
  type ActiveConcernSensitivity,
  type ActiveConcernStatus,
} from '../../core/intention/concerns.js';
import type { ConcernStorePort } from '../../core/intention/concern-store-port.js';
import {
  createCreateConcernTool,
  createListConcernsTool,
} from '../../core/intention/tools.js';
import {
  createValuesAddTool,
  createValuesListTool,
  createValuesUpdateTool,
  type ValuesListParams,
} from '../values/tools.js';
import type { ValuesJournalStore } from '../values/store.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { getRequestContext } from '../../primitives/llm/request-context.js';
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
] as const;
type OrientAction = (typeof ORIENT_ACTIONS)[number];

interface CoreMemoryToolStore {
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
  status?: ActiveConcernStatus;
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
): AgentTool<any> {
  return {
    name: 'orient',
    label: 'orient',
    description:
      'Manage scoped continuity notes, values, and active concerns for the current channel or DM. '
      + 'Do not use continuity blocks to assign identity, mood, feelings, or relationship stance. '
      + 'Blocks: append/replace update one storage block; reorient refreshes local continuity, participant/room context, and commitments together. '
      + 'Values: values_list/add/update handles values reflections. '
      + 'Concerns: create_concern/list_concerns/resolve_concern/transition_concern tracks short-term follow-ups, checkups, reminders, and open threads. '
      + 'Use exact concernId values from create_concern or list_concerns when resolving or transitioning.',
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
          'Block text for append or replace actions, or concern text for action=create_concern. '
          + 'Create a concern in the same turn when deciding to follow up later, ask again tomorrow, reach out tonight, or track a short-term open thread.',
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
        description: 'Concern priority for action=create_concern.',
      })),
      status: Type.Optional(Type.Unsafe<ActiveConcernStatus>({
        type: 'string',
        enum: [...ACTIVE_CONCERN_STATUSES],
        description: 'Concern lifecycle status for action=create_concern or action=transition_concern.',
      })),
      salience: Type.Optional(Type.Number({
        minimum: 0,
        maximum: 1,
        description: 'Concern salience for action=create_concern or action=transition_concern.',
      })),
      sensitivity: Type.Optional(Type.Unsafe<ActiveConcernSensitivity>({
        type: 'string',
        enum: [...ACTIVE_CONCERN_SENSITIVITIES],
        description: 'Concern sensitivity metadata for action=create_concern.',
      })),
      owner: Type.Optional(Type.Unsafe<ActiveConcernOwner>({
        type: 'string',
        enum: [...ACTIVE_CONCERN_OWNERS],
        description: 'Concern lifecycle owner for action=create_concern.',
      })),
      evidenceRefs: Type.Optional(Type.Array(CONCERN_EVIDENCE_REF_SCHEMA, {
        maxItems: 20,
        description: 'Safe evidence references for concern creation, resolution, or transition. Do not include raw sensitive content.',
      })),
      reopenResolved: Type.Optional(Type.Boolean({
        description: 'For action=create_concern, true only when new evidence should reopen a matching terminal concern.',
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
        description: 'Optional concern contact scope for action=create_concern or action=list_concerns.',
      })),
      source: Type.Optional(Type.Union([
        Type.Literal('appraisal'),
        Type.Literal('agent'),
        Type.Literal('heartbeat'),
      ], {
        description: 'Concern creation source for action=create_concern.',
      })),
      includeResolved: Type.Optional(Type.Boolean({
        description: 'Include resolved concerns for action=list_concerns.',
      })),
      includeExpired: Type.Optional(Type.Boolean({
        description: 'Include expired concerns for action=list_concerns.',
      })),
      concernId: Type.Optional(Type.String({
        minLength: 1,
        description: 'Used for action=resolve_concern. Copy the exact concern.id from create_concern or list_concerns.',
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
    }),
    execute: async (
      toolCallId: string,
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
        if (action === 'values_list') {
          return createValuesListTool(requireValuesJournal(options.valuesJournal)).execute(
            toolCallId,
            { limit: params.limit },
          );
        }

        if (action === 'values_add') {
          return createValuesAddTool(requireValuesJournal(options.valuesJournal)).execute(
            toolCallId,
            {
              value: params.value ?? '',
              ...(params.context !== undefined ? { context: params.context } : {}),
            },
          );
        }

        if (action === 'values_update') {
          return createValuesUpdateTool(requireValuesJournal(options.valuesJournal)).execute(
            toolCallId,
            {
              version: params.version ?? 0,
              value: params.value ?? '',
              ...(params.context !== undefined ? { context: params.context } : {}),
            },
          );
        }

        if (action === 'create_concern') {
          return createCreateConcernTool(requireConcernStore(options.concernStore)).execute(
            toolCallId,
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
          return createListConcernsTool(requireConcernStore(options.concernStore)).execute(
            toolCallId,
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
            const concern = await concernStore.resolveConcern(concernId, {
              outcome: params.outcome,
              evidenceRefs: params.evidenceRefs,
            });
            if (concern) {
              resolved.push(concern);
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
          const transitioned = [];
          const missing = [];
          for (const concernId of uniqueConcernIds) {
            const concern = await concernStore.transitionConcernStatus(concernId, {
              status: params.status,
              outcome: params.outcome,
              evidenceRefs: params.evidenceRefs,
              resolutionEvidenceRefs: params.evidenceRefs,
              nextReviewAt: params.nextReviewAt,
              clearNextReview: params.clearNextReview,
              salience: params.salience,
            });
            if (concern) {
              transitioned.push(concern);
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
          if (params.separator !== undefined && typeof params.separator !== 'string') {
            return textResultWithError('Error: separator must be a string when provided', true);
          }
          const block = store.append(label, appendText, {
            separator: params.separator,
            scope,
          });
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
