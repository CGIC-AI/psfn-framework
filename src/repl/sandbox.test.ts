import { describe, it, expect, vi } from 'vitest';
import { REPLSandbox, FinalAnswerSignal } from './sandbox.js';
import type { SandboxBudgetRef } from './sandbox.js';
import type { LLMProvider, EmbeddingService } from '../agent-loop.js';
import type { MemoryStore } from '../memory/store.js';
import type { SessionManager } from '../session/manager.js';
import type { LLMResponse } from '../types.js';
import { EventBus } from '../event-bus.js';
import { Scheduler } from '../scheduler/scheduler.js';

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

function mockSequentialLLM(contents: string[]): LLMProvider {
  let callIdx = 0;
  return {
    stream: vi.fn(async () => ({
      content: contents[callIdx] ?? contents[contents.length - 1] ?? '',
      toolCalls: [],
      model: 'mock',
      inputTokens: 10,
      outputTokens: 20,
      stopReason: 'stop',
    } satisfies LLMResponse)),
    complete: vi.fn(async () => {
      const content = contents[callIdx] ?? contents[contents.length - 1] ?? '';
      callIdx++;
      return {
        content,
        toolCalls: [],
        model: 'mock',
        inputTokens: 10,
        outputTokens: 20,
        stopReason: 'stop',
      } satisfies LLMResponse;
    }),
  };
}

function nullDeps(llm?: LLMProvider) {
  return {
    llmProvider: llm ?? mockLLM(),
    embeddingService: null,
    memoryStore: null,
    sessionManager: null,
    scheduler: null,
    eventBus: null,
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

  it('enforces timeout for async code paths', async () => {
    const sandbox = new REPLSandbox(nullDeps());
    const result = await sandbox.execute(
      'await new Promise((resolve) => setTimeout(resolve, 50)); print("done");',
      10,
      8192,
    );
    expect(result.error).toContain('Execution timed out');
    expect(result.output).toBe('');
  });

  it('enforces configured memory ceiling (best effort)', async () => {
    const sandbox = new REPLSandbox(
      nullDeps(),
      undefined,
      { memoryCeilingBytes: 1 },
    );
    const result = await sandbox.execute('print("hello");', 5000, 8192);
    expect(result.error).toContain('memory ceiling exceeded');
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

  it('llm_query_strict retries until regex matches', async () => {
    const llm = mockSequentialLLM(['invalid', 'ID-42']);
    const budgetRef: SandboxBudgetRef = { subQueries: 0, maxSubQueries: 5 };
    const sandbox = new REPLSandbox(nullDeps(llm), budgetRef);
    const result = await sandbox.execute(
      'const answer = await llm_query_strict("Give me an ID", "^ID-\\\\d+$", 3); print(answer);',
      5000, 8192,
    );

    expect(result.output).toBe('ID-42');
    expect(llm.complete).toHaveBeenCalledTimes(2);
    expect(budgetRef.subQueries).toBe(2);

    const evidence = sandbox.collectEvidence();
    expect(evidence).toHaveLength(2);
    expect(evidence[0].attempt).toBe(1);
    expect(evidence[1].attempt).toBe(2);
  });

  it('llm_query_strict returns last attempt when retries are exhausted', async () => {
    const llm = mockSequentialLLM(['bad-1', 'bad-2', 'bad-3']);
    const budgetRef: SandboxBudgetRef = { subQueries: 0, maxSubQueries: 5 };
    const sandbox = new REPLSandbox(nullDeps(llm), budgetRef);
    const result = await sandbox.execute(
      'const answer = await llm_query_strict("Give me ok", "^ok$", 3); print(answer);',
      5000, 8192,
    );

    expect(result.output).toBe('bad-3');
    expect(llm.complete).toHaveBeenCalledTimes(3);
    expect(budgetRef.subQueries).toBe(3);
  });

  it('llm_query_strict handles invalid regex without crashing', async () => {
    const llm = mockSequentialLLM(['first-response', 'second-response']);
    const budgetRef: SandboxBudgetRef = { subQueries: 0, maxSubQueries: 5 };
    const sandbox = new REPLSandbox(nullDeps(llm), budgetRef);
    const result = await sandbox.execute(
      'const answer = await llm_query_strict("test", "[a-", 5); print(answer);',
      5000, 8192,
    );

    expect(result.error).toBeNull();
    expect(result.output).toBe('first-response');
    expect(llm.complete).toHaveBeenCalledTimes(1);
    expect(budgetRef.subQueries).toBe(1);
  });

  it('llm_query_json retries and parses JSON responses', async () => {
    const llm = mockSequentialLLM(['not json', '{"ok":true,"count":2}']);
    const budgetRef: SandboxBudgetRef = { subQueries: 0, maxSubQueries: 5 };
    const sandbox = new REPLSandbox(nullDeps(llm), budgetRef);
    const result = await sandbox.execute(
      'const obj = await llm_query_json("Return JSON", 2); print(obj.ok, obj.count);',
      5000, 8192,
    );

    expect(result.output).toBe('true 2');
    expect(llm.complete).toHaveBeenCalledTimes(2);
    expect(budgetRef.subQueries).toBe(2);
  });

  it('llm_query_json returns null when JSON parsing fails', async () => {
    const llm = mockSequentialLLM(['{bad json}']);
    const sandbox = new REPLSandbox(nullDeps(llm));
    const result = await sandbox.execute(
      'const obj = await llm_query_json("Return JSON", 1); print(obj === null);',
      5000, 8192,
    );

    expect(result.output).toBe('true');
  });

  it('repo_* helpers call gateway git methods when available', async () => {
    const llm = {
      ...mockLLM(),
      gitStatus: vi.fn(async () => ({
        branch: 'feature/test',
        ahead: 0,
        behind: 0,
        staged: ['src/a.ts'],
        modified: ['src/b.ts'],
        untracked: [],
      })),
      gitDiff: vi.fn(async () => ({
        staged: 'staged diff',
        unstaged: 'unstaged diff',
      })),
      gitApplyPatch: vi.fn(async () => {}),
      gitCommit: vi.fn(async () => ({
        hash: 'abc1234',
        message: 'test commit',
        filesChanged: 1,
      })),
    } as unknown as LLMProvider;
    const sandbox = new REPLSandbox(nullDeps(llm));

    const result = await sandbox.execute(
      [
        'const s = await repo_status(); print(s.branch);',
        'const d = await repo_diff(false); print(d.unstaged);',
        'const a = await repo_apply_patch("src/file.ts", "export const x = 1;"); print(a.ok);',
        'const c = await repo_commit("message", "intent"); print(c.hash);',
      ].join('\n'),
      5000,
      8192,
    );

    expect(result.output).toContain('feature/test');
    expect(result.output).toContain('unstaged diff');
    expect(result.output).toContain('true');
    expect(result.output).toContain('abc1234');
  });

  it('repo_apply_patch rejects disallowed paths before calling git', async () => {
    const llm = {
      ...mockLLM(),
      gitApplyPatch: vi.fn(async () => {}),
    } as unknown as LLMProvider;
    const sandbox = new REPLSandbox(nullDeps(llm));

    const result = await sandbox.execute(
      'const r = await repo_apply_patch("../secrets.txt", "oops"); print(r.ok, r.error);',
      5000,
      8192,
    );

    expect(result.output).toContain('false');
    expect(result.output).toContain('path not allowed');
    expect((llm as any).gitApplyPatch).not.toHaveBeenCalled();
  });

  it('crawler_fetch and web_research use gateway webFetch path', async () => {
    const llm = {
      ...mockSequentialLLM([
        '["https://example.com/a","https://example.com/b"]',
      ]),
      webFetch: vi.fn(async (url: string) => `content for ${url}`),
    } as unknown as LLMProvider;
    const sandbox = new REPLSandbox(nullDeps(llm));
    const result = await sandbox.execute(
      [
        'const c = await crawler_fetch("https://example.com/a"); print(c);',
        'const r = await web_research("test query", 2);',
        'print(r.length);',
        'print(r[0].url);',
      ].join('\n'),
      5000,
      8192,
    );

    expect(result.output).toContain('content for https://example.com/a');
    expect(result.output).toContain('2');
    expect(result.output).toContain('https://example.com/a');
    expect((llm as any).webFetch).toHaveBeenCalledTimes(3);
  });

  it('read_file/write_file/list_files/web_fetch helpers call gateway RPC capabilities', async () => {
    const llm = {
      ...mockLLM(),
      fsRead: vi.fn(async (path: string) => `read:${path}`),
      fsWrite: vi.fn(async () => {}),
      fsList: vi.fn(async () => ['src/a.ts', 'src/b.ts']),
      webFetch: vi.fn(async (url: string) => `fetched:${url}`),
    } as unknown as LLMProvider;
    const sandbox = new REPLSandbox(nullDeps(llm));

    const result = await sandbox.execute(
      [
        'const content = await read_file("/app/workspace/a.txt"); print(content);',
        'const write = await write_file("/app/workspace/out.txt", "hello"); print(write.ok);',
        'const listed = await list_files("src/**/*.ts", 10);',
        'print(Array.isArray(listed), listed.length);',
        'const page = await web_fetch("https://example.com"); print(page);',
      ].join('\n'),
      5000,
      8192,
    );

    expect(result.output).toContain('read:/app/workspace/a.txt');
    expect(result.output).toContain('true');
    expect(result.output).toContain('true 2');
    expect(result.output).toContain('fetched:https://example.com');
    expect((llm as any).fsRead).toHaveBeenCalledWith('/app/workspace/a.txt');
    expect((llm as any).fsWrite).toHaveBeenCalledWith('/app/workspace/out.txt', 'hello');
    expect((llm as any).fsList).toHaveBeenCalledWith('src/**/*.ts', 10);
    expect((llm as any).webFetch).toHaveBeenCalledWith('https://example.com', undefined);
  });

  it('enforces max tool calls across read_file/write_file/list_files/web_fetch', async () => {
    const llm = {
      ...mockLLM(),
      fsRead: vi.fn(async (path: string) => `read:${path}`),
      fsWrite: vi.fn(async () => {}),
      fsList: vi.fn(async () => ['one.ts']),
      webFetch: vi.fn(async () => 'web'),
    } as unknown as LLMProvider;
    const budgetRef: SandboxBudgetRef = {
      subQueries: 0,
      maxSubQueries: 10,
      toolCalls: 0,
      maxToolCalls: 2,
    };
    const sandbox = new REPLSandbox(nullDeps(llm), budgetRef);
    const result = await sandbox.execute(
      [
        'const a = await read_file("a.txt");',
        'const b = await web_fetch("https://example.com");',
        'const c = await list_files("src/**/*.ts");',
        'const d = await write_file("out.txt", "hello");',
        'print(a);',
        'print(b);',
        'print(c.error);',
        'print(d.ok, d.error);',
      ].join('\n'),
      5000,
      8192,
    );

    expect(result.output).toContain('read:a.txt');
    expect(result.output).toContain('web');
    expect(result.output).toContain('max tool calls reached');
    expect((llm as any).fsRead).toHaveBeenCalledTimes(1);
    expect((llm as any).webFetch).toHaveBeenCalledTimes(1);
    expect((llm as any).fsList).not.toHaveBeenCalled();
    expect((llm as any).fsWrite).not.toHaveBeenCalled();
    expect(budgetRef.toolCalls).toBe(2);
  });

  it('crawler_fetch surfaces TLS diagnostics from gateway errors', async () => {
    const fetchError = Object.assign(new Error('Fetch TLS failure: fetch failed'), {
      code: -32003,
      cause: {
        code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
        message: 'unable to get local issuer certificate',
      },
    });
    const llm = {
      ...mockLLM(),
      webFetch: vi.fn(async () => {
        throw fetchError;
      }),
    } as unknown as LLMProvider;
    const sandbox = new REPLSandbox(nullDeps(llm));
    const result = await sandbox.execute(
      'const c = await crawler_fetch("https://1.1.1.1/"); print(c);',
      5000,
      8192,
    );

    expect(result.output).toContain('UNABLE_TO_GET_ISSUER_CERT_LOCALLY');
    expect(result.output).toContain('code=-32003');
  });

  it('module_* APIs persist module registry via gateway fs methods', async () => {
    let stored = '[]';
    const llm = {
      ...mockLLM(),
      fsRead: vi.fn(async () => stored),
      fsWrite: vi.fn(async (_path: string, content: string) => { stored = content; }),
    } as unknown as LLMProvider;
    const sandbox = new REPLSandbox(nullDeps(llm));

    const result = await sandbox.execute(
      [
        'const install = await module_install("planner", "export default {};", true); print(install.ok);',
        'const list = await module_list(); print(list.length);',
        'print(list[0].name, list[0].enabled);',
        'const off = await module_disable("planner"); print(off.ok);',
        'const health = await module_health("planner"); print(health[0].health);',
      ].join('\n'),
      5000,
      8192,
    );

    expect(result.output).toContain('true');
    expect(result.output).toContain('1');
    expect(result.output).toContain('planner true');
    expect(result.output).toContain('disabled');
    expect((llm as any).fsWrite).toHaveBeenCalled();
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

  it('memory_write stamps repl provenance sourceRef', async () => {
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
      updateMemory: vi.fn(),
    } as unknown as MemoryStore;

    const sandbox = new REPLSandbox({
      llmProvider: mockLLM(),
      embeddingService,
      memoryStore,
      sessionManager: null,
    });

    const result = await sandbox.execute(
      'const r = await memory_write("from repl", "semantic"); print(r.action);',
      5000,
      8192,
    );

    expect(result.output).toBe('created');
    expect((memoryStore.insertMemory as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    const insertedMemory = (memoryStore.insertMemory as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(insertedMemory.sourceRef).toMatch(/^source:repl\|operation:memory_write\|invocation:repl-/);
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
    expect(locals.schedule_list).toBeUndefined();
    expect(locals.schedule_add_every).toBeUndefined();
    expect(locals.schedule_add_once).toBeUndefined();
    expect(locals.schedule_update).toBeUndefined();
    expect(locals.event_emit).toBeUndefined();
    expect(locals.llm_query_strict).toBeUndefined();
    expect(locals.llm_query_json).toBeUndefined();
    expect(locals.module_list).toBeUndefined();
    expect(locals.module_install).toBeUndefined();
    expect(locals.module_enable).toBeUndefined();
    expect(locals.module_disable).toBeUndefined();
    expect(locals.module_health).toBeUndefined();
    expect(locals.repo_status).toBeUndefined();
    expect(locals.repo_diff).toBeUndefined();
    expect(locals.repo_apply_patch).toBeUndefined();
    expect(locals.repo_commit).toBeUndefined();
    expect(locals.read_file).toBeUndefined();
    expect(locals.write_file).toBeUndefined();
    expect(locals.list_files).toBeUndefined();
    expect(locals.web_fetch).toBeUndefined();
    expect(locals.crawler_fetch).toBeUndefined();
    expect(locals.web_research).toBeUndefined();
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

  it('schedule_list returns tasks without handlers', async () => {
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, { tickIntervalMs: 1000, heartbeatIntervalMs: 1000 });
    scheduler.register({
      id: 'existing-task',
      name: 'Existing Task',
      type: 'every',
      intervalMs: 60_000,
      handler: () => {},
      state: 'idle',
    });

    const sandbox = new REPLSandbox({
      ...nullDeps(),
      scheduler,
      eventBus,
    });

    const result = await sandbox.execute(
      'const tasks = schedule_list(); print(tasks.length); print(Boolean(tasks[0].handler));',
      5000, 8192,
    );
    expect(result.output).toBe('1\nfalse');
  });

  it('schedule_add_every registers task and validates inputs', async () => {
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, { tickIntervalMs: 1000, heartbeatIntervalMs: 1000 });
    const sandbox = new REPLSandbox({
      ...nullDeps(),
      scheduler,
      eventBus,
    });

    const created = await sandbox.execute(
      [
        'const ok = schedule_add_every("Pulse", 50, () => { globalThis.hitCount = (globalThis.hitCount || 0) + 1; });',
        'print(ok.ok);',
        'print(ok.id.startsWith("repl:"));',
      ].join('\n'),
      5000,
      8192,
    );
    expect(created.output).toBe('true\ntrue');
    expect(scheduler.listTasks()).toHaveLength(1);

    await scheduler.tick();
    expect(sandbox.getLocals().hitCount).toBe(1);

    const guardrail = await sandbox.execute(
      'const bad = schedule_add_every("Pulse", 10, "not-fn"); print(bad.ok); print(bad.error);',
      5000,
      8192,
    );
    expect(guardrail.output).toBe('false\nhandler must be a function');
    expect(scheduler.listTasks()).toHaveLength(1);
  });

  it('schedule_add_once and schedule_update handle happy path + guardrails', async () => {
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, { tickIntervalMs: 1000, heartbeatIntervalMs: 1000 });
    const sandbox = new REPLSandbox({
      ...nullDeps(),
      scheduler,
      eventBus,
    });

    const addResult = await sandbox.execute(
      [
        'const created = schedule_add_once("One Shot", Date.now() + 1_000, () => { globalThis.onceHits = (globalThis.onceHits || 0) + 1; });',
        'globalThis.taskId = created.id;',
        'print(created.ok);',
      ].join('\n'),
      5000,
      8192,
    );
    expect(addResult.output).toBe('true');

    const updateResult = await sandbox.execute(
      [
        'const updated = schedule_update(taskId, {',
        '  name: "One Shot Renamed",',
        '  runAt: Date.now() - 100,',
        '  state: "idle",',
        '});',
        'print(updated.ok);',
      ].join('\n'),
      5000,
      8192,
    );
    expect(updateResult.output).toBe('true');

    await scheduler.tick();
    expect(sandbox.getLocals().onceHits).toBe(1);
    const updatedTask = scheduler.getTask(String(sandbox.getLocals().taskId));
    expect(updatedTask?.name).toBe('One Shot Renamed');
    expect(updatedTask?.state).toBe('complete');

    const badState = await sandbox.execute(
      'const bad = schedule_update(taskId, { state: "invalid" }); print(bad.ok); print(bad.error);',
      5000,
      8192,
    );
    expect(badState.output).toBe('false\ninvalid state: invalid');
  });

  it('schedule functions fail cleanly when scheduler is unavailable', async () => {
    const sandbox = new REPLSandbox({
      ...nullDeps(),
      scheduler: null,
      eventBus: new EventBus(),
    });

    const result = await sandbox.execute(
      [
        'const list = schedule_list();',
        'const add = schedule_add_every("Nope", 1000, () => {});',
        'const upd = schedule_update("missing", { state: "paused" });',
        'print(list.length);',
        'print(add.ok);',
        'print(upd.ok);',
      ].join('\n'),
      5000,
      8192,
    );
    expect(result.output).toBe('0\nfalse\nfalse');
  });

  it('event_emit enforces allowlist', async () => {
    const eventBus = new EventBus();
    const seen: Array<{ timestamp: number; taskCount: number }> = [];
    eventBus.on('schedule.heartbeat', payload => { seen.push(payload); });

    const sandbox = new REPLSandbox({
      ...nullDeps(),
      scheduler: null,
      eventBus,
    });

    const allowed = await sandbox.execute(
      'const ok = await event_emit("schedule.heartbeat", { timestamp: 1, taskCount: 2 }); print(ok.ok);',
      5000,
      8192,
    );
    expect(allowed.output).toBe('true');
    expect(seen).toEqual([{ timestamp: 1, taskCount: 2 }]);

    const denied = await sandbox.execute(
      'const bad = await event_emit("system.shutdown", {}); print(bad.ok); print(bad.error);',
      5000,
      8192,
    );
    expect(denied.output).toContain('false');
    expect(denied.output).toContain('not allowlisted');
  });

  it('event_emit returns an error when no event bus is wired', async () => {
    const sandbox = new REPLSandbox({
      ...nullDeps(),
      scheduler: null,
      eventBus: null,
    });
    const result = await sandbox.execute(
      'const emitted = await event_emit("schedule.heartbeat", { timestamp: 1, taskCount: 1 }); print(emitted.ok); print(emitted.error);',
      5000,
      8192,
    );
    expect(result.output).toBe('false\nno event bus');
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
