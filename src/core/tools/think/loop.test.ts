import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runRLMLoop } from './loop.js';
import type { LLMProvider } from '../../agent/contracts.js';
import type { REPLDeps, REPLConfig } from './types.js';
import { DEFAULT_REPL_CONFIG } from './types.js';
import type { LLMResponse } from '../../../shared/contracts/runtime.js';

const ORIGINAL_MODULE_REGISTRY_PATH = process.env.MODULE_REGISTRY_PATH;

beforeEach(() => {
  process.env.MODULE_REGISTRY_PATH = ORIGINAL_MODULE_REGISTRY_PATH ?? 'companion/modules/repl-registry.json';
});

afterEach(() => {
  if (ORIGINAL_MODULE_REGISTRY_PATH === undefined) {
    delete process.env.MODULE_REGISTRY_PATH;
  } else {
    process.env.MODULE_REGISTRY_PATH = ORIGINAL_MODULE_REGISTRY_PATH;
  }
});

function mockResponse(content: string, inputTokens = 10, outputTokens = 20): LLMResponse {
  return {
    content,
    toolCalls: [],
    model: 'mock',
    inputTokens,
    outputTokens,
    stopReason: 'stop',
  };
}

/** Create a mock LLM that returns a sequence of responses */
function sequentialLLM(responses: string[]): LLMProvider {
  let callIdx = 0;
  return {
    stream: vi.fn(),
    complete: vi.fn(async () => {
      const content = responses[callIdx] ?? 'FINAL("fallback")';
      callIdx++;
      return mockResponse(content);
    }),
  };
}

function makeDeps(llm: LLMProvider, overrides?: Partial<REPLDeps>): REPLDeps {
  return {
    llmProvider: llm,
    embeddingService: null,
    memoryStore: null,
    sessionManager: null,
    config: DEFAULT_REPL_CONFIG,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<REPLConfig['budget']> = {}): REPLConfig {
  return {
    ...DEFAULT_REPL_CONFIG,
    budget: { ...DEFAULT_REPL_CONFIG.budget, ...overrides },
  };
}

describe('runRLMLoop', () => {
  it('handles single-iteration FINAL in text', async () => {
    const llm = sequentialLLM(['FINAL("immediate answer")']);
    const result = await runRLMLoop('What is 2+2?', makeDeps(llm));

    expect(result.answer).toBe('immediate answer');
    expect(result.iterations).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.totalInputTokens).toBe(10);
    expect(result.totalOutputTokens).toBe(20);
    expect(result.budgetStatus).toBeDefined();
    expect(result.budgetStatus.exceeded).toBeNull();
    expect(result.budgetStatus.iterations).toBe(1);
  });

  it('routes think completions through reasoning purpose', async () => {
    const llm = sequentialLLM(['FINAL("done")']);
    await runRLMLoop('Reasoning route test', makeDeps(llm));

    const calls = (llm.complete as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][1]).toBe('reasoning');
  });

  it('does not derive shell_exec from the llm provider without an explicit sandbox boundary', async () => {
    const llm = {
      ...sequentialLLM(['```repl\nFINAL(typeof shell_exec);\n```']),
      shellExec: vi.fn(async () => ({
        command: 'node',
        args: ['-v'],
        cwd: process.cwd(),
        exitCode: 0,
        stdout: 'v22.0.0',
        stderr: '',
        timedOut: false,
        truncated: false,
        durationMs: 5,
      })),
    } as LLMProvider & {
      shellExec: ReturnType<typeof vi.fn>;
    };

    const result = await runRLMLoop('Boundary route test', makeDeps(llm));

    expect(result.answer).toBe('undefined');
    expect(llm.shellExec).not.toHaveBeenCalled();
  });

  it('propagates structured origin metadata into think iteration calls', async () => {
    const llm = sequentialLLM(['FINAL("done")']);
    await runRLMLoop(
      'Metadata route test',
      makeDeps(llm),
      {
        turnId: 'turn-1',
        requestId: 'req-1',
        channelId: 'discord:123',
        toolName: 'think',
        toolCallId: 'tool-1',
        originType: 'tool',
        originStage: 'repl.think.tool',
      },
    );

    const calls = (llm.complete as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].correlation).toMatchObject({
      turnId: 'turn-1',
      requestId: 'req-1:iteration-1',
      channelId: 'discord:123',
      toolName: 'think',
      toolCallId: 'tool-1',
      callType: 'tool',
      originType: 'tool',
      originStage: 'repl.think.iteration',
      purpose: 'repl.think.iteration',
    });
  });

  it('handles multi-iteration with code execution', async () => {
    const llm = sequentialLLM([
      '```repl\nvar x = 21;\nprint(x * 2);\n```',
      'FINAL("42")',
    ]);
    const result = await runRLMLoop('Compute', makeDeps(llm));

    expect(result.answer).toBe('42');
    expect(result.iterations).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it('handles FINAL called inside code', async () => {
    const llm = sequentialLLM([
      '```repl\nconst result = 6 * 7;\nFINAL(String(result));\n```',
    ]);
    const result = await runRLMLoop('Multiply', makeDeps(llm));

    expect(result.answer).toBe('42');
    expect(result.iterations).toBe(1);
  });

  it('handles FINAL_VAR lookup', async () => {
    const llm = sequentialLLM([
      '```repl\nvar answer = "computed value";\n```',
      'FINAL_VAR(answer)',
    ]);
    const result = await runRLMLoop('Compute and store', makeDeps(llm));

    expect(result.answer).toBe('computed value');
    expect(result.iterations).toBe(2);
  });

  it('FINAL_VAR with missing variable returns message', async () => {
    const llm = sequentialLLM([
      'FINAL_VAR(nonexistent)',
    ]);
    const result = await runRLMLoop('Lookup', makeDeps(llm));

    expect(result.answer).toContain('not found');
    expect(result.iterations).toBe(1);
  });

  it('nudges on no-action response', async () => {
    const llm = sequentialLLM([
      'Let me think about this...',
      'FINAL("thought about it")',
    ]);
    const result = await runRLMLoop('Think hard', makeDeps(llm));

    expect(result.answer).toBe('thought about it');
    expect(result.iterations).toBe(2);

    // Verify nudge was appended after the no-action response
    // messages array is shared by reference, so inspect position directly
    const calls = (llm.complete as ReturnType<typeof vi.fn>).mock.calls;
    const secondCallMessages = calls[1][0].messages;
    // messages at call 2: [user:task, assistant:no-action, user:nudge]
    const nudge = secondCallMessages[2];
    expect(nudge.role).toBe('user');
    expect(nudge.content).toContain('```repl');
  });

  it('truncates at maxIterations', async () => {
    const llm = sequentialLLM(
      Array(5).fill('```repl\nprint("still going");\n```'),
    );
    const deps = makeDeps(llm, {
      config: makeConfig({ maxIterations: 3 }),
    });
    const result = await runRLMLoop('Loop forever', deps);

    expect(result.truncated).toBe(true);
    expect(result.iterations).toBe(3);
    expect(result.budgetStatus.exceeded).toBe('max iterations');
  });

  it('accumulates tokens across iterations', async () => {
    const llm = sequentialLLM([
      '```repl\nprint("step 1");\n```',
      '```repl\nprint("step 2");\n```',
      'FINAL("done")',
    ]);
    const result = await runRLMLoop('Multi-step', makeDeps(llm));

    expect(result.totalInputTokens).toBe(30);  // 10 * 3
    expect(result.totalOutputTokens).toBe(60);  // 20 * 3
    expect(result.iterations).toBe(3);
  });

  it('feeds code execution output back to LLM', async () => {
    const llm = sequentialLLM([
      '```repl\nprint("output from code");\n```',
      'FINAL("got it")',
    ]);
    const result = await runRLMLoop('Execute', makeDeps(llm));

    // Verify the second call received the output from the first code execution
    const calls = (llm.complete as ReturnType<typeof vi.fn>).mock.calls;
    const secondCallMessages = calls[1][0].messages;
    // Should have: user task, assistant code, user output, ...
    expect(secondCallMessages[2].role).toBe('user');
    expect(secondCallMessages[2].content).toBe('output from code');

    expect(result.answer).toBe('got it');
  });

  it('feeds code errors back to LLM', async () => {
    const llm = sequentialLLM([
      '```repl\nthrow new Error("oops");\n```',
      'FINAL("recovered")',
    ]);
    const result = await runRLMLoop('Error recovery', makeDeps(llm));

    const calls = (llm.complete as ReturnType<typeof vi.fn>).mock.calls;
    const secondCallMessages = calls[1][0].messages;
    const feedback = secondCallMessages[2].content;
    expect(feedback).toContain('Error: oops');

    expect(result.answer).toBe('recovered');
  });

  it('handles LLM error gracefully', async () => {
    const llm: LLMProvider = {
      stream: vi.fn(),
      complete: vi.fn(async () => { throw new Error('LLM down'); }),
    };

    await expect(runRLMLoop('test', makeDeps(llm))).rejects.toThrow('LLM down');
  });

  it('stops with explicit reason when LLM call exceeds remaining wall-time budget', async () => {
    const llm: LLMProvider = {
      stream: vi.fn(),
      complete: vi.fn(async () => {
        await new Promise(resolve => setTimeout(resolve, 60));
        return mockResponse('FINAL("too late")');
      }),
    };

    const deps = makeDeps(llm, {
      config: makeConfig({ maxWallTimeMs: 50 }),
    });
    const result = await runRLMLoop('Timeout guard test', deps);

    expect(result.truncated).toBe(true);
    expect(result.iterations).toBe(0);
    expect(result.budgetStatus.exceeded).toBe('llm timeout');
    expect(result.answer).toContain('timed out');
  });

  it('records durationMs', async () => {
    const llm = sequentialLLM(['FINAL("quick")']);
    const result = await runRLMLoop('Quick task', makeDeps(llm));
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('stops when token budget exceeded', async () => {
    // Each response uses 30 tokens (10 input + 20 output)
    // Set budget to 50 tokens — should stop after 2 iterations
    const llm = sequentialLLM([
      '```repl\nprint("step 1");\n```',
      '```repl\nprint("step 2");\n```',
      '```repl\nprint("step 3");\n```',
      'FINAL("done")',
    ]);
    const deps = makeDeps(llm, {
      config: makeConfig({ maxTokens: 50 }),
    });
    const result = await runRLMLoop('Token test', deps);

    expect(result.truncated).toBe(true);
    expect(result.budgetStatus.exceeded).toBe('token budget');
    expect(result.budgetStatus.totalTokens).toBeGreaterThanOrEqual(50);
    // Should have stopped after 2 iterations (2 * 30 = 60 >= 50)
    expect(result.iterations).toBe(2);
  });

  it('budgetStatus tracks sub-queries from sandbox', async () => {
    const llm = sequentialLLM([
      '```repl\nvar r = await llm_query("q1"); print(r);\n```',
      'FINAL("done")',
    ]);
    const deps = makeDeps(llm);
    const result = await runRLMLoop('Sub-query test', deps);

    expect(result.budgetStatus.subQueries).toBe(1);
    expect(result.budgetStatus.exceeded).toBeNull();
  });

  it('propagates structured origin metadata into sandbox llm_query calls', async () => {
    const llm = sequentialLLM([
      '```repl\nvar r = await llm_query("q1"); print(r);\n```',
      'sub-result',
      'FINAL("done")',
    ]);

    await runRLMLoop(
      'Sandbox metadata route test',
      makeDeps(llm),
      {
        turnId: 'turn-2',
        requestId: 'req-2',
        channelId: 'discord:456',
        toolName: 'think',
        toolCallId: 'tool-2',
        originType: 'tool',
        originStage: 'repl.think.tool',
      },
    );

    const calls = (llm.complete as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[1][0].correlation).toMatchObject({
      turnId: 'turn-2',
      requestId: 'req-2:sandbox-subquery:1',
      channelId: 'discord:456',
      toolName: 'llm_query',
      toolCallId: 'tool-2',
      callType: 'tool',
      originType: 'tool',
      originStage: 'repl.sandbox.llm_query',
      purpose: 'repl.sandbox.llm_query',
    });
  });

  it('runs sub_think with isolated child context and conclusion-only return when policy allows it', async () => {
    const llm = sequentialLLM([
      '```repl\nconst child = await sub_think("child task"); print(child);\n```',
      'FINAL("child conclusion")',
      'FINAL("parent conclusion")',
    ]);

    const result = await runRLMLoop(
      'Root task',
      makeDeps(llm, {
        getCapabilityTier: () => 'autonomous',
        compositionalPolicy: {
          enabled: true,
          allowedTiers: ['autonomous'],
          allowedChannelTypes: ['api'],
          allowedPurposes: ['think'],
        },
      }),
      {
        channelId: 'api:session-1',
        requestId: 'req-nested',
        toolCallId: 'tool-nested',
        toolName: 'think',
        originType: 'tool',
        originStage: 'repl.think.tool',
      },
    );

    expect(result.answer).toBe('parent conclusion');
    expect(result.diagnostics).toMatchObject({
      nestedThinkCallCount: 1,
      nestedThinkSuccessCount: 1,
      nestedThinkFailureCount: 0,
      maxNestedDepthReached: 1,
    });

    const calls = (llm.complete as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[1][0].messages[0]).toEqual({ role: 'user', content: 'child task' });
    expect(calls[1][0].messages).toHaveLength(2);
    expect(calls[1][0].correlation).toMatchObject({
      requestId: 'req-nested:subthink-1:iteration-1',
      toolCallId: 'tool-nested:subthink-1',
      originStage: 'repl.think.iteration',
      purpose: 'repl.think.iteration',
    });

    const feedback = calls[2][0].messages[2].content;
    expect(feedback).toContain('child conclusion');
    expect(feedback).not.toContain('[Think:');
  });

  it('fails closed when sub_think is denied by compositional policy', async () => {
    const llm = sequentialLLM([
      '```repl\nawait sub_think("blocked task");\n```',
      'FINAL("done")',
    ]);

    const result = await runRLMLoop(
      'Denied nested think',
      makeDeps(llm),
      {
        channelId: 'api:session-2',
        requestId: 'req-denied',
        toolCallId: 'tool-denied',
        toolName: 'think',
        originType: 'tool',
        originStage: 'repl.think.tool',
      },
    );

    const calls = (llm.complete as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1][0].messages[2].content).toContain(
      'sub_think is disabled by compositional policy (disabled)',
    );
    expect(result.diagnostics.nestedThinkFailureCount).toBeGreaterThanOrEqual(1);
  });

  it('counts nested think LLM spend against the parent token budget', async () => {
    const llm = sequentialLLM([
      '```repl\nconst child = await sub_think("budget child"); print(child);\n```',
      'FINAL("child conclusion")',
      'FINAL("parent conclusion")',
    ]);
    const deps = makeDeps(llm, {
      getCapabilityTier: () => 'autonomous',
      compositionalPolicy: {
        enabled: true,
        allowedTiers: ['autonomous'],
        allowedChannelTypes: ['api'],
        allowedPurposes: ['think'],
      },
      config: makeConfig({ maxTokens: 50 }),
    });

    const result = await runRLMLoop(
      'Nested budget test',
      deps,
      {
        channelId: 'api:session-3',
        requestId: 'req-budget',
        toolCallId: 'tool-budget',
        toolName: 'think',
        originType: 'tool',
        originStage: 'repl.think.tool',
      },
    );

    expect(result.truncated).toBe(true);
    expect(result.iterations).toBe(2);
    expect(result.totalInputTokens).toBe(20);
    expect(result.totalOutputTokens).toBe(40);
    expect(result.budgetStatus.exceeded).toBe('token budget');
    expect((llm.complete as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it('enforces max tool-call budget across sandbox helper calls', async () => {
    const llm = Object.assign(
      sequentialLLM([
        '```repl\nconst a = await read_file("a.txt"); const b = await read_file("b.txt"); print(a); print(b);\n```',
        'FINAL("done")',
      ]),
      {
        fsRead: vi.fn(async (path: string) => `content:${path}`),
      },
    ) as LLMProvider;

    const deps = makeDeps(llm, {
      config: makeConfig({ maxToolCalls: 1, maxIterations: 5 }),
    });
    const result = await runRLMLoop('Tool budget test', deps);

    expect(result.truncated).toBe(true);
    expect(result.budgetStatus.exceeded).toBe('tool-call limit');
    expect(result.budgetStatus.toolCalls).toBe(1);
    expect(result.steps[0].output).toContain('max tool calls reached');
    expect((llm as any).fsRead).toHaveBeenCalledTimes(1);
    expect((llm.complete as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('includes variable tracking in feedback', async () => {
    const llm = sequentialLLM([
      '```repl\nvar myVar = 42;\n```',
      'FINAL("done")',
    ]);
    const deps = makeDeps(llm);
    const result = await runRLMLoop('Var tracking test', deps);

    // Verify the feedback to LLM includes variable info
    const calls = (llm.complete as ReturnType<typeof vi.fn>).mock.calls;
    const secondCallMessages = calls[1][0].messages;
    const feedback = secondCallMessages[2].content;
    expect(feedback).toContain('vars changed: myVar');
    expect(result.answer).toBe('done');
  });

  it('includes steps in ThinkResult', async () => {
    const llm = sequentialLLM([
      '```repl\nprint("step output");\n```',
      'FINAL("done")',
    ]);
    const result = await runRLMLoop('Test steps', makeDeps(llm));

    expect(result.steps).toBeDefined();
    expect(result.steps.length).toBeGreaterThanOrEqual(1);
    expect(result.steps[0].iteration).toBe(1);
    expect(result.steps[0].code).toContain('print("step output")');
    expect(result.steps[0].output).toContain('step output');
    expect(result.steps[0].error).toBeNull();
    expect(result.steps[0].timestamp).toBeGreaterThan(0);
    expect(result.steps[0].inputTokens).toBe(10);
    expect(result.steps[0].outputTokens).toBe(20);
    expect(result.steps[0].tokensUsed).toBe(30); // 10 input + 20 output
    expect(result.steps[0].cumulativeTokens).toBe(30);
    expect(result.steps[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(result.steps[0].variablesChanged).toEqual([]);
  });

  it('flattens evidence from all steps', async () => {
    const llm = sequentialLLM([
      '```repl\nvar r = await llm_query("q1"); print(r);\n```',
      'FINAL("done")',
    ]);
    const result = await runRLMLoop('Evidence test', makeDeps(llm));

    expect(result.evidence).toBeDefined();
    expect(Array.isArray(result.evidence)).toBe(true);
    // The llm_query in the sandbox should have produced evidence
    expect(result.evidence.length).toBeGreaterThanOrEqual(1);
    expect(result.evidence[0].source).toBe('llm_query');
  });

  it('includes evidence in truncated results', async () => {
    const llm = sequentialLLM([
      '```repl\nvar r = await llm_query("q1"); print(r);\n```',
      '```repl\nvar r2 = await llm_query("q2"); print(r2);\n```',
      '```repl\nprint("still going");\n```',
    ]);
    const deps = makeDeps(llm, {
      config: makeConfig({ maxIterations: 2 }),
    });
    const result = await runRLMLoop('Truncated evidence', deps);

    expect(result.truncated).toBe(true);
    expect(result.steps).toHaveLength(2);
    expect(result.evidence.length).toBeGreaterThanOrEqual(1);
  });

  it('ThinkResult has empty steps/evidence for direct FINAL', async () => {
    const llm = sequentialLLM(['FINAL("immediate")']);
    const result = await runRLMLoop('Direct answer', makeDeps(llm));

    expect(result.steps).toBeDefined();
    expect(result.steps).toHaveLength(1); // The FINAL step itself
    expect(result.evidence).toHaveLength(0);
  });

  it('steps include none-type iterations', async () => {
    const llm = sequentialLLM([
      'Let me think about this...',
      'FINAL("thought about it")',
    ]);
    const result = await runRLMLoop('None step test', makeDeps(llm));

    expect(result.steps).toHaveLength(2); // none step + final step
    expect(result.steps[0].code).toBe('');
    expect(result.steps[0].output).toBe('');
    expect(result.steps[0].iteration).toBe(1);
    expect(result.steps[1].iteration).toBe(2);
  });

  it('steps include code errors', async () => {
    const llm = sequentialLLM([
      '```repl\nthrow new Error("oops");\n```',
      'FINAL("recovered")',
    ]);
    const result = await runRLMLoop('Error step test', makeDeps(llm));

    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].error).toContain('oops');
    expect(result.steps[0].code).toContain('throw new Error');
  });

  it('code step preserves code and keeps sandbox-truncated output', async () => {
    const longCode = 'print("' + 'x'.repeat(3000) + '");';
    const llm = sequentialLLM([
      '```repl\n' + longCode + '\n```',
      'FINAL("done")',
    ]);
    const result = await runRLMLoop('Truncation test', makeDeps(llm));

    expect(result.steps[0].code.length).toBeGreaterThan(2000);
    expect(result.steps[0].output.length).toBeLessThanOrEqual(DEFAULT_REPL_CONFIG.outputTruncation + 80);
  });

  it('applies tier-dependent iteration limits', async () => {
    const makeTierDeps = (tier: 'nursery' | 'apprentice' | 'autonomous') => makeDeps(
      sequentialLLM(Array(20).fill('```repl\nprint("still going");\n```')),
      {
        getCapabilityTier: () => tier,
        config: makeConfig({
          maxIterations: 50,
          maxWallTimeMs: 500_000,
          maxSubQueries: 100,
        }),
      },
    );

    const nursery = await runRLMLoop('tier nursery', makeTierDeps('nursery'));
    const apprentice = await runRLMLoop('tier apprentice', makeTierDeps('apprentice'));
    const autonomous = await runRLMLoop('tier autonomous', makeTierDeps('autonomous'));

    expect(nursery.iterations).toBe(5);
    expect(apprentice.iterations).toBe(10);
    expect(autonomous.iterations).toBe(15);
  });

  it('clamps configured wall-time budget to active tier wall-time ceiling', async () => {
    const llm: LLMProvider = {
      stream: vi.fn(),
      complete: vi.fn(async () => {
        await new Promise(resolve => setTimeout(resolve, 45));
        return mockResponse('FINAL("too late")');
      }),
    };

    const config = makeConfig({ maxWallTimeMs: 500_000 });
    config.tierBudgets = {
      ...config.tierBudgets,
      nursery: {
        ...config.tierBudgets.nursery,
        maxWallTimeMs: 25,
      },
    };

    const result = await runRLMLoop('tier wall-time clamp', makeDeps(llm, {
      config,
      getCapabilityTier: () => 'nursery',
    }));

    expect(result.truncated).toBe(true);
    expect(result.iterations).toBe(0);
    expect(result.budgetStatus.exceeded).toBe('wall time');
    expect(result.answer).toBe('[No response generated]');
  });

  it('enforces invocation rate limits across think calls', async () => {
    const llm = sequentialLLM(['FINAL("first")', 'FINAL("second")']);
    const cfg = makeConfig();
    cfg.rateLimit = {
      ...cfg.rateLimit,
      maxInvocationsPerMinute: 1,
      windowMs: 60_000,
    };
    const deps = makeDeps(llm, { config: cfg });

    const first = await runRLMLoop('first', deps);
    const second = await runRLMLoop('second', deps);

    expect(first.budgetStatus.exceeded).toBeNull();
    expect(second.budgetStatus.exceeded).toBe('invocation rate limit');
    expect(second.answer).toContain('rate limit');
  });

  it('tracks cumulative session/day cost and enforces nursery daily cap', async () => {
    const llm = sequentialLLM(['FINAL("first")', 'FINAL("blocked")']);
    const cfg = makeConfig();
    cfg.rateLimit = {
      ...cfg.rateLimit,
      maxInvocationsPerMinute: 20,
    };
    cfg.cost = {
      ...cfg.cost,
      inputUsdPerMillionTokens: 1000,
      outputUsdPerMillionTokens: 1000,
      nurseryDailyCapUsd: 0.01,
    };
    const deps = makeDeps(llm, {
      config: cfg,
      getCapabilityTier: () => 'nursery',
    });

    const first = await runRLMLoop('first', deps);
    const second = await runRLMLoop('second', deps);

    expect(first.budgetStatus.sessionCostUsd).toBeGreaterThan(0);
    expect(first.budgetStatus.dayCostUsd).toBeGreaterThan(0);
    expect(second.budgetStatus.exceeded).toBe('daily cost cap');
    expect(second.answer).toContain('daily cost cap');
  });

  it('emits autonomous soft warning when daily cost crosses warning threshold', async () => {
    const llm = sequentialLLM(['FINAL("done")']);
    const cfg = makeConfig();
    cfg.cost = {
      ...cfg.cost,
      inputUsdPerMillionTokens: 1000,
      outputUsdPerMillionTokens: 1000,
      autonomousDailyWarningUsd: 0.01,
    };
    cfg.rateLimit = {
      ...cfg.rateLimit,
      maxInvocationsPerMinute: 20,
    };
    const deps = makeDeps(llm, {
      config: cfg,
      getCapabilityTier: () => 'autonomous',
    });

    const result = await runRLMLoop('warn', deps);
    expect(result.budgetStatus.exceeded).toBeNull();
    expect(result.budgetStatus.warnings.length).toBe(1);
    expect(result.budgetStatus.warnings[0]).toContain('Autonomous');
  });

  it('counts sandbox llm_query calls in session/day cost totals', async () => {
    const llm = sequentialLLM([
      '```repl\nvar r = await llm_query("sub"); print(r);\n```',
      'sub-result',
      'FINAL("done")',
    ]);
    const cfg = makeConfig();
    cfg.rateLimit = {
      ...cfg.rateLimit,
      maxInvocationsPerMinute: 20,
    };
    cfg.cost = {
      ...cfg.cost,
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 1,
      nurseryDailyCapUsd: 999,
      autonomousDailyWarningUsd: 999,
    };
    const deps = makeDeps(llm, { config: cfg });

    const result = await runRLMLoop('subquery-cost', deps);

    expect(result.budgetStatus.sessionCostUsd).toBeCloseTo(0.00009, 8);
    expect(result.budgetStatus.dayCostUsd).toBeCloseTo(0.00009, 8);
  });
});
