import { Type } from '@sinclair/typebox';
import { CANONICAL_TOOL_SURFACE_DESCRIPTIONS } from '../../core/agent/tool-surface/descriptions.js';
import type { AgentToolResult, SubstrateAgentTool } from '../../boundary/pi-agent/index.js';
import { textResult, textResultWithError } from '../../core/tools/results.js';
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
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim();
  return normalized.length > 0 ? normalized : null;
}

function ensureReplacementText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  return raw;
}

function requireValuesJournal(valuesJournal: ValuesJournalStore | null | undefined): ValuesJournalStore {
  if (!valuesJournal) {
    throw new Error('orient values support is not wired');
  }
  return valuesJournal;
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
        description: 'Required orientation action.',
      }),
      block: Type.Optional(Type.Unsafe<CoreMemoryLabel>({
        type: 'string',
        enum: LABEL_ENUM,
        description: 'Short-term working block for append/replace: persona=local continuity, human=participant or room context, goals=near-term focus.',
      })),
      text: Type.Optional(Type.String({
        description: 'Block text for action=append or action=replace.',
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
        description: 'Complete replacement text for short-term scoped goals when action=reorient.',
      })),
      limit: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: 200,
        description: 'Optional bounded limit for action=values_list.',
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
    }),
    execute: async (
      _toolCallId: string,
      params: OrientToolParams,
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
