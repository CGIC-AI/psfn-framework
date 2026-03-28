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

interface CoreMemoryToolStore {
  append(
    label: CoreMemoryLabel,
    appendText: string,
    options?: CoreMemoryAppendOptions,
  ): CoreMemoryBlock;
  replace(label: CoreMemoryLabel, content: string): CoreMemoryBlock;
  rethink(input: CoreMemoryRethinkInput): CoreMemorySnapshot;
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

export function createCoreMemoryAppendTool(store: CoreMemoryToolStore): AgentTool<any> {
  return {
    name: 'core_memory_append',
    description:
      'Append a short fact or update to one core memory block. ' +
      'Use this for incremental updates to persona, human, or goals memory.',
    label: 'core_memory_append',
    parameters: Type.Object({
      block: Type.Unsafe<CoreMemoryLabel>({
        type: 'string',
        enum: LABEL_ENUM,
        description: 'Core memory block label: persona, human, or goals.',
      }),
      text: Type.String({
        description: 'Text to append to the selected core memory block.',
      }),
      separator: Type.Optional(
        Type.String({
          description: 'Optional separator inserted before appended text. Default: newline.',
        }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: {
        block: CoreMemoryLabel;
        text: string;
        separator?: string;
      },
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      const label = ensureLabel(params.block);
      if (!label) {
        return textResultWithError(
          `Error: block must be one of ${LABEL_ENUM.join(', ')}`,
          true,
        );
      }
      const appendText = ensureString(params.text);
      if (!appendText) {
        return textResultWithError('Error: text is required', true);
      }
      if (params.separator !== undefined && typeof params.separator !== 'string') {
        return textResultWithError('Error: separator must be a string when provided', true);
      }

      try {
        const block = store.append(label, appendText, { separator: params.separator });
        return textResult(
          `Appended to ${label} core memory (${block.content.length}/${block.maxChars} chars).`,
        );
      } catch (error) {
        return textResultWithError(
          `Error appending core memory: ${toErrorMessage(error)}`,
          true,
        );
      }
    },
  };
}

export function createCoreMemoryReplaceTool(store: CoreMemoryToolStore): AgentTool<any> {
  return {
    name: 'core_memory_replace',
    description:
      'Replace one core memory block with new content. ' +
      'Use this when the previous block contents are stale or incorrect.',
    label: 'core_memory_replace',
    parameters: Type.Object({
      block: Type.Unsafe<CoreMemoryLabel>({
        type: 'string',
        enum: LABEL_ENUM,
        description: 'Core memory block label: persona, human, or goals.',
      }),
      text: Type.String({
        description: 'Replacement text for the selected core memory block.',
      }),
    }),
    execute: async (
      _toolCallId: string,
      params: {
        block: CoreMemoryLabel;
        text: string;
      },
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      const label = ensureLabel(params.block);
      if (!label) {
        return textResultWithError(
          `Error: block must be one of ${LABEL_ENUM.join(', ')}`,
          true,
        );
      }
      if (typeof params.text !== 'string') {
        return textResultWithError('Error: text must be a string', true);
      }

      try {
        const block = store.replace(label, params.text);
        return textResult(
          `Replaced ${label} core memory (${block.content.length}/${block.maxChars} chars).`,
        );
      } catch (error) {
        return textResultWithError(
          `Error replacing core memory: ${toErrorMessage(error)}`,
          true,
        );
      }
    },
  };
}

export function createMemoryRethinkTool(store: CoreMemoryToolStore): AgentTool<any> {
  return {
    name: 'memory_rethink',
    description:
      'Rewrite all core memory blocks at once (persona, human, goals). ' +
      'Use this for holistic memory cleanup or strategic reorganization.',
    label: 'memory_rethink',
    parameters: Type.Object({
      persona: Type.String({
        description: 'Complete replacement text for the persona block.',
      }),
      human: Type.String({
        description: 'Complete replacement text for the human block.',
      }),
      goals: Type.String({
        description: 'Complete replacement text for the goals block.',
      }),
    }),
    execute: async (
      _toolCallId: string,
      params: {
        persona: string;
        human: string;
        goals: string;
      },
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      if (typeof params.persona !== 'string') {
        return textResultWithError('Error: persona must be a string', true);
      }
      if (typeof params.human !== 'string') {
        return textResultWithError('Error: human must be a string', true);
      }
      if (typeof params.goals !== 'string') {
        return textResultWithError('Error: goals must be a string', true);
      }

      try {
        const snapshot = store.rethink({
          persona: params.persona,
          human: params.human,
          goals: params.goals,
        });
        const persona = snapshot.blocks.persona;
        const human = snapshot.blocks.human;
        const goals = snapshot.blocks.goals;
        return textResult(
          `Rewrote core memory blocks ` +
          `(persona ${persona.content.length}/${persona.maxChars}, ` +
          `human ${human.content.length}/${human.maxChars}, ` +
          `goals ${goals.content.length}/${goals.maxChars}).`,
        );
      } catch (error) {
        return textResultWithError(
          `Error rewriting core memory: ${toErrorMessage(error)}`,
          true,
        );
      }
    },
  };
}
