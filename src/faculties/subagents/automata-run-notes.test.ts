import { describe, expect, it, vi } from 'vitest';
import { fromPartial } from '@total-typescript/shoehorn';
import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import { requestSubagentRunNotes, SUBAGENT_RUN_NOTES_PROMPT } from './automata-run-notes.js';

const BASE_MESSAGE = fromPartial<SubstrateMessage>({
  id: 'subagent-1',
  channelId: 'subagent:subagent-1',
  content: 'Inspect the route.',
});

describe('subagent closing run-notes turn', () => {
  it('asks a Bus-aware worker that wrote nothing for its notes, once, and counts what it wrote', async () => {
    const run = { tool: {}, observedBusWrites: 0 };
    const handleMessage = vi.fn(async (message: SubstrateMessage) => {
      expect(message.content).toBe(SUBAGENT_RUN_NOTES_PROMPT);
      expect(message.id).toBe('subagent-1-run-notes');
      run.observedBusWrites = 2;
      return { metadata: { inputTokens: 40, outputTokens: 12 } };
    });
    const usage = await requestSubagentRunNotes({
      run,
      baseMessage: BASE_MESSAGE,
      subagentId: 'subagent-1',
      handleMessage,
      onFailure: vi.fn(),
    });
    expect(handleMessage).toHaveBeenCalledOnce();
    expect(usage).toEqual({ requested: true, inputTokens: 40, outputTokens: 12, notesWritten: 2 });
  });

  it('does not ask a worker that already left notes or has no Bus tool', async () => {
    const handleMessage = vi.fn();
    for (const run of [{ tool: {}, observedBusWrites: 1 }, { tool: null, observedBusWrites: 0 }]) {
      await expect(requestSubagentRunNotes({
        run,
        baseMessage: BASE_MESSAGE,
        subagentId: 'subagent-1',
        handleMessage,
        onFailure: vi.fn(),
      })).resolves.toEqual({ requested: false, inputTokens: 0, outputTokens: 0, notesWritten: 0 });
    }
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('reports a failed notes turn without discarding the completed run', async () => {
    const onFailure = vi.fn();
    const usage = await requestSubagentRunNotes({
      run: { tool: {}, observedBusWrites: 0 },
      baseMessage: BASE_MESSAGE,
      subagentId: 'subagent-1',
      handleMessage: async () => {
        throw new Error('provider unavailable');
      },
      onFailure,
    });
    expect(onFailure).toHaveBeenCalledWith('provider unavailable');
    expect(usage).toEqual({ requested: true, inputTokens: 0, outputTokens: 0, notesWritten: 0 });
  });
});
