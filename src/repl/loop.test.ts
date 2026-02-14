import { describe, it, expect, vi } from 'vitest';
import { runRLMLoop } from './loop.js';
import type { LLMProvider } from '../agent-loop.js';
import type { REPLDeps, REPLConfig } from './types.js';
import { DEFAULT_REPL_CONFIG } from './types.js';
import type { LLMResponse } from '../types.js';

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
    expect(feedback).toContain('Variables changed: myVar');
    expect(result.answer).toBe('done');
  });
});
