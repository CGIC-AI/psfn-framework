import { describe, it, expect, vi } from 'vitest';
import { REPLSandbox, FinalAnswerSignal } from './sandbox.js';
import type { LLMProvider, EmbeddingService } from '../agent-loop.js';
import type { MemoryStore } from '../memory/store.js';
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
  });

  it('persists variables across execute calls', async () => {
    const sandbox = new REPLSandbox(nullDeps());
    await sandbox.execute('var counter = 10;', 5000, 8192);
    const result = await sandbox.execute('print(counter + 5);', 5000, 8192);
    expect(result.output).toBe('15');
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
});

describe('FinalAnswerSignal', () => {
  it('stores the answer', () => {
    const signal = new FinalAnswerSignal('test answer');
    expect(signal.answer).toBe('test answer');
  });
});
