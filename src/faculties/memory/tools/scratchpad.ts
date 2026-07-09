import { Type } from '@sinclair/typebox';
import type { AgentToolResult } from '../../../boundary/pi-agent/index.js';
import type { SubstrateAgentTool } from '../../../boundary/pi-agent/index.js';

import { textResult, textResultWithError } from '../../../core/tools/results.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import type { MemoryStorePort } from '../memory-store-port.js';

const SCRATCHPAD_DEFAULT_LIMIT = 20;
const SCRATCHPAD_MAX_LIMIT = 64;

type ScratchpadToolAction = 'list' | 'add' | 'replace' | 'append' | 'remove';
const SCRATCHPAD_TOOL_ACTIONS: ScratchpadToolAction[] = ['list', 'add', 'replace', 'append', 'remove'];

function errorMessage(error: unknown): string {
  return toErrorMessage(error);
}

function clampInt(val: number, min: number, max: number): number {
  if (!Number.isFinite(val)) return min;
  return Math.max(min, Math.min(max, Math.floor(val)));
}

function formatScratchpadList(
  entries: Array<{ id: string; content: string; updatedAt: number }>,
): string {
  if (entries.length === 0) {
    return 'Scratchpad is empty. Use it for temporary same-day working notes, excerpts, and working summaries.';
  }

  const lines = [
    `Scratchpad entries (${entries.length}) [24h ephemeral working context]:`,
    'Do not use scratchpad for durable reminders, proactive follow-ups, relationship state, journals, or stable memories. Promote stable facts to memory, follow-ups to orient open threads, and durable notes to journal.',
  ];
  for (const entry of entries) {
    lines.push(`- ${entry.id} [${new Date(entry.updatedAt).toISOString()}]: ${entry.content}`);
  }
  return lines.join('\n');
}

export function createScratchpadTool(memoryStore: MemoryStorePort): SubstrateAgentTool {
  return {
    name: 'scratchpad',
    description:
      '24h ephemeral working-note workspace for temporary excerpts, summaries, and same-day task context. '
      + 'Use action=list|add|replace|append|remove. Do not use scratchpad for durable reminders, proactive follow-ups, relationship state, journals, or stable memories. '
      + 'Use orient concerns/open threads for reminders and proactive follow-ups, memory for stable facts, and journal for durable markdown notes.',
    label: 'scratchpad',
    parameters: Type.Object({
      action: Type.Unsafe<ScratchpadToolAction>({
        type: 'string',
        enum: [...SCRATCHPAD_TOOL_ACTIONS],
        description: 'One of: list, add, replace, append, remove.',
      }),
      limit: Type.Optional(
        Type.Number({ description: `Used with action=list. Maximum notes to return (1-${SCRATCHPAD_MAX_LIMIT}, default ${SCRATCHPAD_DEFAULT_LIMIT}).` }),
      ),
      id: Type.Optional(
        Type.String({ description: 'Required for action=replace, action=append, and action=remove. Scratchpad entry id.' }),
      ),
      content: Type.Optional(
        Type.String({ description: 'Required for action=add, action=replace, and action=append. Scratchpad note text.' }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: {
        action: ScratchpadToolAction;
        limit?: number;
        id?: string;
        content?: string;
      },
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const action = params.action;
        if (!SCRATCHPAD_TOOL_ACTIONS.includes(action)) {
          return textResultWithError(`Error: invalid action "${action}"`, true);
        }

        switch (action) {
          case 'list': {
            const limit = params.limit === undefined
              ? SCRATCHPAD_DEFAULT_LIMIT
              : clampInt(params.limit, 1, SCRATCHPAD_MAX_LIMIT);
            const entries = memoryStore.listScratchpadEntries(limit);
            return textResult(formatScratchpadList(entries));
          }

          case 'add': {
            const content = params.content?.trim();
            if (!content) {
              return textResultWithError('Error: content is required for action=add', true);
            }
            const result = await memoryStore.addScratchpadEntry(content);
            const evictedSuffix = result.evictedIds.length > 0
              ? ` Evicted oldest ids: ${result.evictedIds.join(', ')}`
              : '';
            return textResult(
              `Scratchpad entry added (id: ${result.entry.id}). `
              + 'Keep temporary working context here; promote only stable outcomes elsewhere.'
              + evictedSuffix,
            );
          }

          case 'replace': {
            const id = params.id?.trim();
            const content = params.content?.trim();
            if (!id) {
              return textResultWithError('Error: id is required for action=replace', true);
            }
            if (!content) {
              return textResultWithError('Error: content is required for action=replace', true);
            }
            const replaced = await memoryStore.replaceScratchpadEntry(id, content);
            if (!replaced) {
              return textResultWithError(`Scratchpad entry not found: ${id}`, true);
            }
            return textResult(`Scratchpad entry replaced (id: ${replaced.id}).`);
          }

          case 'append': {
            const id = params.id?.trim();
            const content = params.content?.trim();
            if (!id) {
              return textResultWithError('Error: id is required for action=append', true);
            }
            if (!content) {
              return textResultWithError('Error: content is required for action=append', true);
            }
            const appended = await memoryStore.appendScratchpadEntry(id, content);
            if (!appended) {
              return textResultWithError(`Scratchpad entry not found: ${id}`, true);
            }
            return textResult(`Scratchpad entry appended (id: ${appended.id}).`);
          }

          case 'remove': {
            const id = params.id?.trim();
            if (!id) {
              return textResultWithError('Error: id is required for action=remove', true);
            }
            const removed = await memoryStore.removeScratchpadEntry(id);
            if (!removed) {
              return textResultWithError(`Scratchpad entry not found: ${id}`, true);
            }
            return textResult(`Scratchpad entry removed (id: ${id}).`);
          }
        }

        return textResultWithError(`Error: unsupported scratchpad action "${action}"`, true);
      } catch (error) {
        return textResultWithError(`Error using scratchpad: ${errorMessage(error)}`, true);
      }
    },
  };
}

export function createScratchpadReadTool(memoryStore: MemoryStorePort): SubstrateAgentTool {
  return {
    name: 'scratchpad_read',
    description:
      'List current scratchpad entries (short-lived working notes). ' +
      'Use before replacing or removing notes so you can reference the right id.',
    label: 'scratchpad_read',
    parameters: Type.Object({
      limit: Type.Optional(
        Type.Number({ description: `Maximum notes to return (1-${SCRATCHPAD_MAX_LIMIT}, default ${SCRATCHPAD_DEFAULT_LIMIT}).` }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: { limit?: number },
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const limit = params.limit === undefined
          ? SCRATCHPAD_DEFAULT_LIMIT
          : clampInt(params.limit, 1, SCRATCHPAD_MAX_LIMIT);
        const entries = memoryStore.listScratchpadEntries(limit);
        return textResult(formatScratchpadList(entries));
      } catch (error) {
        return textResultWithError(`Error reading scratchpad: ${errorMessage(error)}`, true);
      }
    },
  };
}

type ScratchpadWriteOperation = 'add' | 'replace' | 'remove';
const SCRATCHPAD_WRITE_OPERATIONS: ScratchpadWriteOperation[] = ['add', 'replace', 'remove'];

export function createScratchpadWriteTool(memoryStore: MemoryStorePort): SubstrateAgentTool {
  return {
    name: 'scratchpad_write',
    description:
      'Mutate scratchpad notes with add/replace/remove operations. ' +
      'Scratchpad is bounded and intended for short-lived working memory.',
    label: 'scratchpad_write',
    parameters: Type.Object({
      operation: Type.Unsafe<ScratchpadWriteOperation>({
        type: 'string',
        enum: [...SCRATCHPAD_WRITE_OPERATIONS],
        description: 'One of: add, replace, remove.',
      }),
      id: Type.Optional(
        Type.String({ description: 'Required for replace/remove. Scratchpad entry id.' }),
      ),
      content: Type.Optional(
        Type.String({ description: 'Required for add/replace. Scratchpad note text.' }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: {
        operation: ScratchpadWriteOperation;
        id?: string;
        content?: string;
      },
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const operation = params.operation;
        if (!SCRATCHPAD_WRITE_OPERATIONS.includes(operation)) {
          return textResultWithError(`Error: invalid operation "${operation}"`, true);
        }

        switch (operation) {
          case 'add': {
            const content = params.content?.trim();
            if (!content) {
              return textResultWithError('Error: content is required for add', true);
            }
            const result = await memoryStore.addScratchpadEntry(content);
            const evictedSuffix = result.evictedIds.length > 0
              ? ` Evicted oldest ids: ${result.evictedIds.join(', ')}`
              : '';
            return textResult(`Scratchpad entry added (id: ${result.entry.id}).${evictedSuffix}`);
          }
          case 'replace': {
            const id = params.id?.trim();
            const content = params.content?.trim();
            if (!id) {
              return textResultWithError('Error: id is required for replace', true);
            }
            if (!content) {
              return textResultWithError('Error: content is required for replace', true);
            }
            const replaced = await memoryStore.replaceScratchpadEntry(id, content);
            if (!replaced) {
              return textResultWithError(`Scratchpad entry not found: ${id}`, true);
            }
            return textResult(`Scratchpad entry replaced (id: ${replaced.id}).`);
          }
          case 'remove': {
            const id = params.id?.trim();
            if (!id) {
              return textResultWithError('Error: id is required for remove', true);
            }
            const removed = await memoryStore.removeScratchpadEntry(id);
            if (!removed) {
              return textResultWithError(`Scratchpad entry not found: ${id}`, true);
            }
            return textResult(`Scratchpad entry removed (id: ${id}).`);
          }
        }
      } catch (error) {
        return textResultWithError(`Error writing scratchpad: ${errorMessage(error)}`, true);
      }
    },
  };
}
