import { describe, expect, it, vi } from 'vitest';

import type { LLMContext, LLMResponse } from '../../../shared/contracts/runtime.js';
import {
  buildAutomataBusWorkerScope,
  type AutomataBusWorkerAccess,
  type AutomataBusWorkerPort,
} from '../../automata/bus/worker-access.js';
import {
  completeExtractionChunkWithAutomataBus,
  type ExtractionCompletionPhase,
} from './automata-bus-completion.js';

const BOUNDS = {
  maxQueryChars: 120,
  maxTextChars: 240,
  maxArrayItems: 8,
  maxSearchResults: 10,
  maxRunResults: 20,
  maxBriefingChars: 400,
  maxBriefingItems: 4,
  maxToolResultChars: 1_000,
} as const;

function response(overrides: Partial<LLMResponse>): LLMResponse {
  return {
    content: '',
    toolCalls: [],
    model: 'fixture-model',
    inputTokens: 0,
    outputTokens: 0,
    stopReason: 'end_turn',
    ...overrides,
  };
}

function binding() {
  const actionResult = async () => ({ ok: true });
  const search = vi.fn(actionResult);
  const append = vi.fn(actionResult);
  const port: AutomataBusWorkerPort = {
    isClassEligible: classId => classId === 'memory.extraction',
    brief: vi.fn(actionResult),
    search,
    append,
    correct: vi.fn(actionResult),
    handoff: vi.fn(actionResult),
    runs: vi.fn(actionResult),
    inspect: vi.fn(actionResult),
  };
  const access: AutomataBusWorkerAccess = {
    port,
    bounds: BOUNDS,
    identity: {
      companionId: 'companion-public-example',
      audience: 'eligible-automata',
      maxSensitivity: 'personal',
    },
  };
  const scope = buildAutomataBusWorkerScope(access, {
    automatonClass: 'memory.extraction',
    runId: 'request-public-example',
    taskId: 'channel-public-example',
  });
  return { access, scope, search, append };
}

describe('completeExtractionChunkWithAutomataBus', () => {
  it('exposes the bounded tool and executes search plus append with authoritative extraction scope', async () => {
    const bound = binding();
    const calls: Array<{ context: LLMContext; phase: ExtractionCompletionPhase }> = [];
    const complete = vi.fn(async (context: LLMContext, phase: ExtractionCompletionPhase) => {
      calls.push({ context, phase });
      if (phase === 'initial') {
        return response({
          stopReason: 'tool_use',
          toolCalls: [
            {
              id: 'call-search',
              name: 'automata_bus',
              input: { action: 'search', query: 'known extraction parser failures', limit: 2 },
            },
            {
              id: 'call-append',
              name: 'automata_bus',
              input: {
                action: 'append',
                claim: 'The focused extraction parser fixture passed.',
                provenance: 'computed',
                evidence: [{
                  kind: 'command',
                  reference: 'command:extraction-parser-fixture',
                  summary: 'Focused parser fixture passed.',
                }],
                artifact_refs: ['artifact:fixture-output'],
                verification_status: 'verified',
              },
            },
          ],
        });
      }
      return response({ content: '<facts></facts>' });
    });

    const content = await completeExtractionChunkWithAutomataBus({
      prompt: 'EXTRACTION PROMPT',
      automataBus: { access: bound.access, scope: bound.scope },
      complete,
    });

    expect(content).toBe('<facts></facts>');
    expect(calls.map(call => call.phase)).toEqual(['initial', 'after_automata_bus']);
    expect(calls[0]?.context.tools).toEqual([
      expect.objectContaining({ name: 'automata_bus' }),
    ]);
    expect(calls[1]?.context.tools).toBeUndefined();
    expect(calls[1]?.context.messages.at(-1)?.content).toContain(
      'They are not evidence that a fact occurred',
    );
    expect(bound.search).toHaveBeenCalledWith({
      scope: bound.scope,
      query: 'known extraction parser failures',
      limit: 2,
    });
    expect(bound.append).toHaveBeenCalledWith(expect.objectContaining({
      scope: bound.scope,
      claim: 'The focused extraction parser fixture passed.',
    }));
  });

  it('preflights malformed and oversized batches before any Bus operation', async () => {
    const cases = [
      [
        {
          id: 'call-search',
          name: 'automata_bus',
          input: { action: 'search', query: 'safe query' },
        },
        {
          id: 'call-malformed',
          name: 'automata_bus',
          input: { action: 'search', query: 'x'.repeat(BOUNDS.maxQueryChars + 1) },
        },
      ],
      Array.from({ length: BOUNDS.maxArrayItems + 1 }, (_, index) => ({
        id: `call-${index}`,
        name: 'automata_bus',
        input: { action: 'search', query: 'safe query' },
      })),
    ];

    for (const toolCalls of cases) {
      const bound = binding();
      const complete = vi.fn(async () => response({ toolCalls }));
      await expect(completeExtractionChunkWithAutomataBus({
        prompt: 'EXTRACTION PROMPT',
        automataBus: { access: bound.access, scope: bound.scope },
        complete,
      })).rejects.toThrow(/exceed/);
      expect(bound.search).not.toHaveBeenCalled();
      expect(bound.append).not.toHaveBeenCalled();
      expect(complete).toHaveBeenCalledOnce();
    }
  });
});
