import { describe, it, expect, vi } from 'vitest';
import { REPLSandbox, FinalAnswerSignal } from './sandbox.js';
import type { SandboxBudgetRef } from './sandbox.js';
import type { LLMProvider, EmbeddingService } from '../agent-loop.js';
import type { MemoryStore } from '../memory/store.js';
import type { SessionManager } from '../session/manager.js';
import type { LLMResponse } from '../types.js';

function mockLLM(content = 'llm response'): LLMProvider {
  return {
    stream: vi.fn(async () => ({
      content,
      toolCalls: [],
      model: 'mock',
      inputTokens: 10,
      outputTokens: 20,
      stopReason: 'stop',
    } satisfies LLMResponse)),
    complete: vi.fn(async () => ({
      content,
      toolCalls: [],
      model: 'mock',
      inputTokens: 10,
      outputTokens: 20,
      stopReason: 'stop',
    } satisfies LLMResponse)),
  };
}

function nullDeps(llm?: LLMProvider) {
  return {
    llmProvider: llm ?? mockLLM(),
    embeddingService: null,
    memoryStore: null,
    sessionManager: null,
  };
}

describe('REPLSandbox', () => {
  it('executes simple code and captures print output', async () => {
    const sandbox = new REPLSandbox(nullDeps());
    const result = await sandbox.execute('print("hello", 42);', 5000, 8192);
    expect(result.output).toBe('hello 42');
    expect(result.error).toBeNull();
    expect(result.finalAnswer).toBeNull();
    expect(result.variablesChanged).toEqual([]);
  });

  it('persists variables across execute calls', async () => {
    const sandbox = new REPLSandbox(nullDeps());
    const first = await sandbox.execute('var counter = 10;', 5000, 8192);
    expect(first.variablesChanged).toEqual(['counter']);
    const result = await sandbox.execute('print(counter + 5);', 5000, 8192);
    expect(result.output).toBe('15');
    expect(result.variablesChanged).toEqual([]);
  });

  it('captures FINAL signal', async () => {
    const sandbox = new REPLSandbox(nullDeps());
    const result = await sandbox.execute('FINAL("the answer");', 5000, 8192);
    expect(result.finalAnswer).toBe('the answer');
    expect(result.error).toBeNull();
  });

  it('captures output before FINAL', async () => {
    const sandbox = new REPLSandbox(nullDeps());
    const result = await sandbox.execute('print("before"); FINAL("done");', 5000, 8192);
    expect(result.finalAnswer).toBe('done');
    expect(result.output).toBe('before');
  });

  it('captures errors', async () => {
    const sandbox = new REPLSandbox(nullDeps());
    const result = await sandbox.execute('throw new Error("boom");', 5000, 8192);
    expect(result.error).toContain('boom');
    expect(result.finalAnswer).toBeNull();
  });

  it('captures syntax errors', async () => {
    const sandbox = new REPLSandbox(nullDeps());
    const result = await sandbox.execute('if (', 5000, 8192);
    expect(result.error).toBeTruthy();
  });

  it('truncates long output', async () => {
    const sandbox = new REPLSandbox(nullDeps());
    const result = await sandbox.execute('print("x".repeat(200));', 5000, 100);
    expect(result.output).toContain('truncated');
    expect(result.output.length).toBeLessThan(250);
  });

  it('llm_query calls llmProvider.complete', async () => {
    const llm = mockLLM('sub-answer');
    const sandbox = new REPLSandbox(nullDeps(llm));
    const result = await sandbox.execute(
      'const answer = await llm_query("test prompt"); print(answer);',
      5000, 8192,
    );
    expect(result.output).toBe('sub-answer');
    expect(llm.complete).toHaveBeenCalled();
  });

  it('memory_search returns empty when no memory store', async () => {
    const sandbox = new REPLSandbox(nullDeps());
    const result = await sandbox.execute(
      'const results = await memory_search("test"); print(results.length);',
      5000, 8192,
    );
    expect(result.output).toBe('0');
  });

  it('memory_search queries store when available', async () => {
    const embedding = new Float32Array([1, 0, 0]);
    const embeddingService = {
      embed: vi.fn(async () => embedding),
      embedBatch: vi.fn(),
      dims: 3,
    } as unknown as EmbeddingService;

    const memoryStore = {
      searchByEmbedding: vi.fn(() => [
        { text: 'memory text', type: 'semantic', importance: 0.8, similarity: 0.9 },
      ]),
      getAllActiveMemories: vi.fn(() => []),
    } as unknown as MemoryStore;

    const sandbox = new REPLSandbox({
      llmProvider: mockLLM(),
      embeddingService,
      memoryStore,
      sessionManager: null,
    });

    const result = await sandbox.execute(
      'const r = await memory_search("test", 5); print(r[0].text);',
      5000, 8192,
    );
    expect(result.output).toBe('memory text');
    expect(embeddingService.embed).toHaveBeenCalledWith('test');
  });

  it('memory_count returns 0 when no store', async () => {
    const sandbox = new REPLSandbox(nullDeps());
    const result = await sandbox.execute('print(memory_count());', 5000, 8192);
    expect(result.output).toBe('0');
  });

  it('getLocals returns user-defined variables', async () => {
    const sandbox = new REPLSandbox(nullDeps());
    await sandbox.execute('var myVar = "hello";\nvar num = 42;', 5000, 8192);
    const locals = sandbox.getLocals();
    expect(locals.myVar).toBe('hello');
    expect(locals.num).toBe(42);
  });

  it('getLocals excludes builtins', async () => {
    const sandbox = new REPLSandbox(nullDeps());
    const locals = sandbox.getLocals();
    expect(locals.print).toBeUndefined();
    expect(locals.FINAL).toBeUndefined();
    expect(locals.JSON).toBeUndefined();
    expect(locals.Math).toBeUndefined();
  });

  it('blocks require/process/Buffer access', async () => {
    const sandbox = new REPLSandbox(nullDeps());

    const r1 = await sandbox.execute('require("fs");', 5000, 8192);
    expect(r1.error).toBeTruthy();

    const r2 = await sandbox.execute('process.exit();', 5000, 8192);
    expect(r2.error).toBeTruthy();

    const r3 = await sandbox.execute('Buffer.from("x");', 5000, 8192);
    expect(r3.error).toBeTruthy();
  });

  it('console.log maps to print', async () => {
    const sandbox = new REPLSandbox(nullDeps());
    const result = await sandbox.execute('console.log("via console");', 5000, 8192);
    expect(result.output).toBe('via console');
  });

  it('JSON stringify/parse works in sandbox', async () => {
    const sandbox = new REPLSandbox(nullDeps());
    const result = await sandbox.execute(
      'const obj = JSON.parse(\'{"a":1}\'); print(JSON.stringify(obj));',
      5000, 8192,
    );
    expect(result.output).toBe('{"a":1}');
  });

  it('memory_upsert returns error when no memory system', async () => {
    const sandbox = new REPLSandbox(nullDeps());
    const result = await sandbox.execute(
      'const r = await memory_upsert("fact", "semantic"); print(r.action);',
      5000, 8192,
    );
    expect(result.output).toBe('error');
  });

  it('memory_upsert returns error for invalid type', async () => {
    const embedding = new Float32Array([1, 0, 0]);
    const embeddingService = {
      embed: vi.fn(async () => embedding),
      embedBatch: vi.fn(),
      dims: 3,
    } as unknown as EmbeddingService;

    const memoryStore = {
      searchByEmbedding: vi.fn(() => []),
      insertMemory: vi.fn(),
      getAllActiveMemories: vi.fn(() => []),
    } as unknown as MemoryStore;

    const sandbox = new REPLSandbox({
      llmProvider: mockLLM(),
      embeddingService,
      memoryStore,
      sessionManager: null,
    });

    const result = await sandbox.execute(
      'const r = await memory_upsert("fact", "bogus"); print(r.action);',
      5000, 8192,
    );
    expect(result.output).toBe('error');
  });

  it('session_append_note returns false when no session manager', async () => {
    const sandbox = new REPLSandbox(nullDeps());
    const result = await sandbox.execute(
      'const ok = session_append_note("ch1", "a note"); print(ok);',
      5000, 8192,
    );
    expect(result.output).toBe('false');
  });

  it('session_append_note calls appendSystemNote on session manager', async () => {
    const sessionManager = {
      appendSystemNote: vi.fn(),
      getRecentMessages: vi.fn(() => []),
    } as unknown as SessionManager;

    const sandbox = new REPLSandbox({
      llmProvider: mockLLM(),
      embeddingService: null,
      memoryStore: null,
      sessionManager,
    });

    const result = await sandbox.execute(
      'const ok = session_append_note("test-channel", "important note"); print(ok);',
      5000, 8192,
    );
    expect(result.output).toBe('true');
    expect(sessionManager.appendSystemNote).toHaveBeenCalledWith('test-channel', 'important note');
  });

  it('getLocals excludes new builtins', async () => {
    const sandbox = new REPLSandbox(nullDeps());
    const locals = sandbox.getLocals();
    expect(locals.memory_upsert).toBeUndefined();
    expect(locals.session_append_note).toBeUndefined();
  });

  it('tracks new variable creation in variablesChanged', async () => {
    const sandbox = new REPLSandbox(nullDeps());
    const result = await sandbox.execute('var x = 1;\nvar y = 2;', 5000, 8192);
    expect(result.variablesChanged).toContain('x');
    expect(result.variablesChanged).toContain('y');
    expect(result.variablesChanged).toHaveLength(2);
  });

  it('tracks variable mutation in variablesChanged', async () => {
    const sandbox = new REPLSandbox(nullDeps());
    await sandbox.execute('var counter = 0;', 5000, 8192);
    const result = await sandbox.execute('counter = 5;', 5000, 8192);
    // counter is reassigned (globalThis.counter changes value), so it's "changed"
    // Note: simple assignment without var/let/const isn't transformed, but counter
    // already exists on globalThis from the first execute. Direct assignment to
    // an existing globalThis property works in the vm context.
    expect(result.variablesChanged).toContain('counter');
  });

  it('llm_query respects budget ref limit', async () => {
    const llm = mockLLM('response');
    const budgetRef: SandboxBudgetRef = { subQueries: 0, maxSubQueries: 2 };
    const sandbox = new REPLSandbox(nullDeps(llm), budgetRef);

    // First two should succeed
    await sandbox.execute('var r1 = await llm_query("q1");', 5000, 8192);
    await sandbox.execute('var r2 = await llm_query("q2");', 5000, 8192);
    expect(budgetRef.subQueries).toBe(2);

    // Third should return budget exceeded message
    const result = await sandbox.execute('var r3 = await llm_query("q3"); print(r3);', 5000, 8192);
    expect(result.output).toContain('Budget exceeded');
    expect(budgetRef.subQueries).toBe(2); // not incremented
  });

  it('llm_query works without budget ref', async () => {
    const llm = mockLLM('no-budget-response');
    const sandbox = new REPLSandbox(nullDeps(llm)); // no budgetRef
    const result = await sandbox.execute(
      'var r = await llm_query("test"); print(r);',
      5000, 8192,
    );
    expect(result.output).toBe('no-budget-response');
  });
});

describe('evidence collection', () => {
  it('collectEvidence drains accumulated evidence', async () => {
    const embedding = new Float32Array([1, 0, 0]);
    const embeddingService = {
      embed: vi.fn(async () => embedding),
      embedBatch: vi.fn(),
      dims: 3,
    } as unknown as EmbeddingService;
    const memoryStore = {
      searchByEmbedding: vi.fn(() => [
        { text: 'found memory', type: 'semantic', importance: 0.8, similarity: 0.9 },
      ]),
      getAllActiveMemories: vi.fn(() => []),
    } as unknown as MemoryStore;

    const sandbox = new REPLSandbox({
      llmProvider: mockLLM(),
      embeddingService,
      memoryStore,
      sessionManager: null,
    });

    await sandbox.execute('await memory_search("test query");', 5000, 8192);
    const evidence = sandbox.collectEvidence();
    expect(evidence).toHaveLength(1);
    expect(evidence[0].source).toBe('memory_search');
    expect(evidence[0].query).toBe('test query');
    expect(evidence[0].resultCount).toBe(1);
    expect(evidence[0].snippet).toBe('found memory');

    // Second call should return empty (drained)
    const evidence2 = sandbox.collectEvidence();
    expect(evidence2).toHaveLength(0);
  });

  it('records llm_query evidence', async () => {
    const llm = mockLLM('llm response text');
    const sandbox = new REPLSandbox(nullDeps(llm));
    await sandbox.execute('await llm_query("test prompt");', 5000, 8192);
    const evidence = sandbox.collectEvidence();
    expect(evidence).toHaveLength(1);
    expect(evidence[0].source).toBe('llm_query');
    expect(evidence[0].query).toBe('test prompt');
    expect(evidence[0].snippet).toBe('llm response text');
  });

  it('records session_messages evidence', async () => {
    const sessionManager = {
      getRecentMessages: vi.fn(() => [
        { role: 'user', content: 'hello there', timestamp: Date.now() },
        { role: 'assistant', content: 'hi!', timestamp: Date.now() },
      ]),
      appendSystemNote: vi.fn(),
    } as unknown as SessionManager;

    const sandbox = new REPLSandbox({
      llmProvider: mockLLM(),
      embeddingService: null,
      memoryStore: null,
      sessionManager,
    });

    await sandbox.execute('session_messages("chan1", 10);', 5000, 8192);
    const evidence = sandbox.collectEvidence();
    expect(evidence).toHaveLength(1);
    expect(evidence[0].source).toBe('session_messages');
    expect(evidence[0].query).toBe('chan1');
    expect(evidence[0].resultCount).toBe(2);
  });

  it('records memory_get_by_id evidence', async () => {
    const memoryStore = {
      getById: vi.fn(() => ({
        id: 'mem-123',
        text: 'remembered fact about cats',
        type: 'semantic',
        importance: 0.7,
        confidence: 0.9,
        emotionalValence: 0.3,
        salience: 0.8,
        sourceRef: 'test',
        tags: ['cats'],
      })),
      searchByEmbedding: vi.fn(() => []),
      getAllActiveMemories: vi.fn(() => []),
    } as unknown as MemoryStore;

    const sandbox = new REPLSandbox({
      llmProvider: mockLLM(),
      embeddingService: null,
      memoryStore,
      sessionManager: null,
    });

    await sandbox.execute('const m = memory_get_by_id("mem-123"); print(m.text);', 5000, 8192);
    const evidence = sandbox.collectEvidence();
    expect(evidence).toHaveLength(1);
    expect(evidence[0].source).toBe('memory_get_by_id');
    expect(evidence[0].query).toBe('mem-123');
    expect(evidence[0].snippet).toBe('remembered fact about cats');
    expect(evidence[0].resultCount).toBe(1);
  });

  it('memory_get_by_id records no evidence when memory not found', async () => {
    const memoryStore = {
      getById: vi.fn(() => null),
      searchByEmbedding: vi.fn(() => []),
      getAllActiveMemories: vi.fn(() => []),
    } as unknown as MemoryStore;

    const sandbox = new REPLSandbox({
      llmProvider: mockLLM(),
      embeddingService: null,
      memoryStore,
      sessionManager: null,
    });

    await sandbox.execute('const m = memory_get_by_id("nonexistent"); print(m);', 5000, 8192);
    expect(sandbox.collectEvidence()).toHaveLength(0);
  });

  it('collects no evidence for operations without hooks', async () => {
    const sandbox = new REPLSandbox(nullDeps());
    await sandbox.execute('print("hello");', 5000, 8192);
    expect(sandbox.collectEvidence()).toHaveLength(0);
  });

  it('truncates long snippets in evidence', async () => {
    const llm = mockLLM('x'.repeat(500));
    const sandbox = new REPLSandbox(nullDeps(llm));
    await sandbox.execute('await llm_query("prompt");', 5000, 8192);
    const evidence = sandbox.collectEvidence();
    expect(evidence[0].snippet.length).toBeLessThanOrEqual(200);
  });

  it('accumulates evidence across multiple execute calls', async () => {
    const llm = mockLLM('response');
    const sandbox = new REPLSandbox(nullDeps(llm));
    await sandbox.execute('await llm_query("q1");', 5000, 8192);
    await sandbox.execute('await llm_query("q2");', 5000, 8192);
    const evidence = sandbox.collectEvidence();
    expect(evidence).toHaveLength(2);
    expect(evidence[0].query).toBe('q1');
    expect(evidence[1].query).toBe('q2');
  });

  it('evidence has timestamp', async () => {
    const llm = mockLLM('resp');
    const sandbox = new REPLSandbox(nullDeps(llm));
    const before = Date.now();
    await sandbox.execute('await llm_query("q");', 5000, 8192);
    const after = Date.now();
    const evidence = sandbox.collectEvidence();
    expect(evidence[0].timestamp).toBeGreaterThanOrEqual(before);
    expect(evidence[0].timestamp).toBeLessThanOrEqual(after);
  });
});

describe('FinalAnswerSignal', () => {
  it('stores the answer', () => {
    const signal = new FinalAnswerSignal('test answer');
    expect(signal.answer).toBe('test answer');
  });
});
