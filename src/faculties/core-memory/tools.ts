import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { textResult, textResultWithError } from '../../core/tools/results.js';
import {
  ACTIVE_CONCERN_PRIORITIES,
  type ActiveConcernPriority,
} from '../../core/intention/concerns.js';
import type { ConcernStorePort } from '../../core/intention/concern-store-port.js';
import {
  createCreateConcernTool,
  createListConcernsTool,
} from '../../core/intention/tools.js';
import { createValuesListTool, type ValuesListParams } from '../values/tools.js';
import type { ValuesJournalStore } from '../values/store.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import {
  CORE_MEMORY_LABELS,
  isCoreMemoryLabel,
  type CoreMemoryAppendOptions,
  type CoreMemoryBlock,
  type CoreMemoryLabel,
  type CoreMemoryRethinkInput,
  type CoreMemorySnapshot,
} from './store.js';

const LABEL_ENUM = [...CORE_MEMORY_LABELS];
const ORIENT_ACTIONS = [
  'append',
  'replace',
  'reorient',
  'values_list',
  'create_concern',
  'list_concerns',
  'resolve_concern',
] as const;
type OrientAction = (typeof ORIENT_ACTIONS)[number];

interface CoreMemoryToolStore {
  append(
    label: CoreMemoryLabel,
    appendText: string,
    options?: CoreMemoryAppendOptions,
  ): CoreMemoryBlock;
  replace(label: CoreMemoryLabel, content: string): CoreMemoryBlock;
  rethink(input: CoreMemoryRethinkInput): CoreMemorySnapshot;
}

export interface OrientToolOptions {
  valuesJournal?: ValuesJournalStore | null;
  concernStore?: ConcernStorePort | null;
}

interface OrientToolParams extends ValuesListParams {
  action: OrientAction;
  block?: CoreMemoryLabel;
  text?: string;
  separator?: string;
  persona?: string;
  human?: string;
  goals?: string;
  priority?: ActiveConcernPriority;
  contactId?: string;
  source?: 'appraisal' | 'agent' | 'heartbeat';
  includeResolved?: boolean;
  includeExpired?: boolean;
  concernId?: string;
  concernIds?: string[];
  outcome?: string;
}

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

export function createOrientTool(
  store: CoreMemoryToolStore,
  options: OrientToolOptions = {},
): AgentTool<any> {
  return {
    name: 'orient',
    label: 'orient',
    description:
      'Manage active orientation across persona, human, and goals blocks. '
      + 'Use action=append for incremental updates, action=replace to rewrite one block, '
      + 'action=reorient for a holistic refresh of all three blocks, '
      + 'action=values_list to inspect recent values reflections, and '
      + 'action=create_concern|list_concerns|resolve_concern to manage active open threads, reminders, checkups, and proactive communication items. '
      + 'Open threads are not necessarily problems. Put follow-ups such as "reach out tonight" here, not in scratchpad. '
      + 'For action=resolve_concern, pass concernId or concernIds copied exactly from the concern.id returned by create_concern or list_concerns; '
      + 'do not use tool_search, fs, or analysis_workbench to rediscover it.',
    parameters: Type.Object({
      action: Type.Unsafe<OrientAction>({
        type: 'string',
        enum: [...ORIENT_ACTIONS],
        description: 'Orientation action.',
      }),
      block: Type.Optional(Type.Unsafe<CoreMemoryLabel>({
        type: 'string',
        enum: LABEL_ENUM,
        description: 'Orientation block label for append/replace: persona, human, or goals.',
      })),
      text: Type.Optional(Type.String({
        description: 'Block text for append or replace actions, or concern text for action=create_concern.',
      })),
      separator: Type.Optional(
        Type.String({
          description: 'Optional separator inserted before appended text. Default: newline.',
        }),
      ),
      persona: Type.Optional(Type.String({
        description: 'Complete replacement text for the persona block when action=reorient.',
      })),
      human: Type.Optional(Type.String({
        description: 'Complete replacement text for the human block when action=reorient.',
      })),
      goals: Type.Optional(Type.String({
        description: 'Complete replacement text for the goals block when action=reorient.',
      })),
      limit: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: 200,
        description: 'Optional bounded limit for action=values_list or action=list_concerns.',
      })),
      priority: Type.Optional(Type.Unsafe<ActiveConcernPriority>({
        type: 'string',
        enum: [...ACTIVE_CONCERN_PRIORITIES],
        description: 'Concern priority for action=create_concern.',
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

        if (action === 'create_concern') {
          return createCreateConcernTool(requireConcernStore(options.concernStore)).execute(
            toolCallId,
            {
              text: params.text ?? '',
              priority: params.priority,
              contactId: params.contactId,
              source: params.source,
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
            const concern = await concernStore.resolveConcern(concernId, { outcome: params.outcome });
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

        if (action === 'append') {
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
          const block = store.append(label, appendText, { separator: params.separator });
          return textResult(
            `Appended to ${label} orientation (${block.content.length}/${block.maxChars} chars).`,
          );
        }

        if (action === 'replace') {
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
          const block = store.replace(label, replacementText);
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
        const snapshot = store.rethink({
          persona,
          human,
          goals,
        });
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
