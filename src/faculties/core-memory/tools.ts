import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { textResult, textResultWithError } from '../../core/tools/results.js';
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
const ORIENT_ACTIONS = ['append', 'replace', 'reorient'] as const;
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

interface OrientToolParams {
  action: OrientAction;
  block?: CoreMemoryLabel;
  text?: string;
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

export function createOrientTool(store: CoreMemoryToolStore): AgentTool<any> {
  return {
    name: 'orient',
    label: 'orient',
    description:
      'Manage active orientation across persona, human, and goals blocks. ' +
      'Use action=append for incremental updates, action=replace to rewrite one block, ' +
      'and action=reorient for a holistic refresh of all three blocks.',
    parameters: Type.Object({
      action: Type.Unsafe<OrientAction>({
        type: 'string',
        enum: [...ORIENT_ACTIONS],
        description: 'Orientation action: append, replace, or reorient.',
      }),
      block: Type.Optional(Type.Unsafe<CoreMemoryLabel>({
        type: 'string',
        enum: LABEL_ENUM,
        description: 'Orientation block label for append/replace: persona, human, or goals.',
      })),
      text: Type.Optional(Type.String({
        description: 'Block text for append or replace actions.',
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
          `Reoriented active blocks ` +
          `(persona ${personaBlock.content.length}/${personaBlock.maxChars}, ` +
          `human ${humanBlock.content.length}/${humanBlock.maxChars}, ` +
          `goals ${goalsBlock.content.length}/${goalsBlock.maxChars}).`,
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
