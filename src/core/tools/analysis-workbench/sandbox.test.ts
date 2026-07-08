import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import { REPLSandbox, FinalAnswerSignal } from './sandbox.js';
import type { SandboxBudgetRef } from './sandbox.js';
import type { LLMProviderPort, EmbeddingProviderPort } from '../../agent/contracts.js';
import type { MemoryStore } from '../../../faculties/memory/store.js';
import type { SessionManager } from '../../session/manager.js';
import type { LLMResponse } from '../../../shared/contracts/runtime.js';
import { EventBus } from '../../../shared/event-bus.js';
import { Scheduler } from '../../scheduler/scheduler.js';
import type { SandboxExecutionPort } from '../../../boundary/sandbox/capabilities/contracts.js';
import { withChildProcessSandboxExecutionPort } from '../../../boundary/sandbox/sandbox-execution-port.js';
import type { REPLMutationPolicy } from './types.js';

const ORIGINAL_MODULE_REGISTRY_PATH = process.env.MODULE_REGISTRY_PATH;

beforeAll(() => {
  process.env.MODULE_REGISTRY_PATH = ORIGINAL_MODULE_REGISTRY_PATH ?? 'companion/modules/repl-registry.json';
});

afterAll(() => {
  if (ORIGINAL_MODULE_REGISTRY_PATH === undefined) {
    delete process.env.MODULE_REGISTRY_PATH;
  } else {
    process.env.MODULE_REGISTRY_PATH = ORIGINAL_MODULE_REGISTRY_PATH;
  }
});

function mockLLM(content = 'llm response'): LLMProviderPort {
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

function mockSequentialLLM(contents: string[]): LLMProviderPort {
  let callIdx = 0;
  return {
    stream: vi.fn(async () => ({
      content: contents[callIdx] || contents[contents.length - 1] || '',
      toolCalls: [],
      model: 'mock',
      inputTokens: 10,
      outputTokens: 20,
      stopReason: 'stop',
    } satisfies LLMResponse)),
    complete: vi.fn(async () => {
      const content = contents[callIdx] || contents[contents.length - 1] || '';
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

function nullDeps(
  llm?: LLMProviderPort,
  executionPort?: SandboxExecutionPort | null,
  mutationPolicy?: REPLMutationPolicy,
) {
  return {
    llmProvider: llm ?? mockLLM(),
    executionPort: executionPort ?? null,
    embeddingService: null,
    memoryStore: null,
    sessionManager: null,
    scheduler: null,
    eventBus: null,
    mutationPolicy,
  };
}

function makeExecutionPort(
  overrides: Partial<SandboxExecutionPort> = {},
): SandboxExecutionPort {
  const base = withChildProcessSandboxExecutionPort(null);
  return {
    boundary: overrides.boundary ?? base.boundary,
    codeExecutionBoundary: overrides.codeExecutionBoundary ?? base.codeExecutionBoundary,
    shellExec: overrides.shellExec ?? base.shellExec,
    executeCode: overrides.executeCode ?? base.executeCode,
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

  it('nested_analysis calls the nested analysis runner and returns only the conclusion string', async () => {
    const runNestedAnalysis = vi.fn(async (task: string) => `child:${task}`);
    const sandbox = new REPLSandbox({
      ...nullDeps(),
      runNestedAnalysis,
    });
    const result = await sandbox.execute(
      'const answer = await nested_analysis("inspect memories"); print(answer);',
      5000,
      8192,
    );

    expect(result.output).toBe('child:inspect memories');
    expect(runNestedAnalysis).toHaveBeenCalledWith('inspect memories', undefined);
  });

  it('llm_query_strict retries until regex matches', async () => {
    const llm = mockSequentialLLM(['invalid', 'ID-42']);
    const budgetRef: SandboxBudgetRef = { subQueries: 0, maxSubQueries: 5 };
    const sandbox = new REPLSandbox(nullDeps(llm, null, {
      allowWorkspaceWrite: true,
    }), budgetRef);
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
    const sandbox = new REPLSandbox(nullDeps(llm, null, {
      allowWorkspaceWrite: true,
    }), budgetRef);
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
    const sandbox = new REPLSandbox(nullDeps(llm, null, {
      allowWorkspaceWrite: true,
    }), budgetRef);
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
    } as unknown as LLMProviderPort;
    const sandbox = new REPLSandbox(nullDeps(llm, null, {
      allowRepoMutation: true,
    }));

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
    } as unknown as LLMProviderPort;
    const sandbox = new REPLSandbox(nullDeps(llm, null, {
      allowRepoMutation: true,
    }));

    const result = await sandbox.execute(
      'const r = await repo_apply_patch("../secrets.txt", "oops"); print(r.ok, r.error);',
      5000,
      8192,
    );

    expect(result.output).toContain('false');
    expect(result.output).toContain('path not allowed');
    expect((llm as any).gitApplyPatch).not.toHaveBeenCalled();
  });

  it('web browse/search use the gateway webFetch path', async () => {
    const llm = {
      ...mockSequentialLLM([
        '["https://example.com/a","https://example.com/b"]',
      ]),
      webFetch: vi.fn(async (url: string) => `content for ${url}`),
    } as unknown as LLMProviderPort;
    const sandbox = new REPLSandbox(nullDeps(llm));
    const result = await sandbox.execute(
      [
        'const c = await web("browse", "https://example.com/a"); print(c);',
        'const r = await web("search", "test query", { maxUrls: 2 });',
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
    expect((llm as any).webFetch).toHaveBeenCalledWith('https://example.com/a', undefined, 'local_crawler');
  });

  it('read_file/write_file/list_files/web helpers call gateway RPC capabilities', async () => {
    const llm = {
      ...mockLLM(),
      fsRead: vi.fn(async (path: string) => `read:${path}`),
      fsWrite: vi.fn(async () => {}),
      fsList: vi.fn(async () => ({
        paths: ['src/a.ts', 'src/b.ts'],
        scannedEntries: 2,
        maxEntries: 10,
        maxScannedEntries: 5000,
        truncated: false,
        scanLimitReached: false,
        entryLimitReached: false,
      })),
      webFetch: vi.fn(async (url: string) => `fetched:${url}`),
    } as unknown as LLMProviderPort;
    const sandbox = new REPLSandbox(nullDeps(llm, null, {
      allowWorkspaceWrite: true,
    }));

    const result = await sandbox.execute(
      [
        'const content = await read_file("/app/workspace/a.txt"); print(content);',
        'const write = await write_file("/app/workspace/out.txt", "hello"); print(write.ok);',
        'const listed = await list_files("src/**/*.ts", 10);',
        'print(Array.isArray(listed.paths), listed.paths.length, listed.truncated);',
        'const page = await web("fetch", "https://example.com"); print(page);',
      ].join('\n'),
      5000,
      8192,
    );

    expect(result.output).toContain('read:/app/workspace/a.txt');
    expect(result.output).toContain('true');
    expect(result.output).toContain('true 2 false');
    expect(result.output).toContain('fetched:https://example.com');
    expect((llm as any).fsRead).toHaveBeenCalledWith('/app/workspace/a.txt');
    expect((llm as any).fsWrite).toHaveBeenCalledWith('/app/workspace/out.txt', 'hello');
    expect((llm as any).fsList).toHaveBeenCalledWith('src/**/*.ts', 10);
    expect((llm as any).webFetch).toHaveBeenCalledWith('https://example.com', undefined, 'default');
  });

  it('omits repo and workspace mutation helpers under the default read-only parent policy', async () => {
    const sandbox = new REPLSandbox(nullDeps(mockLLM()));
    const result = await sandbox.execute(
      [
        'print(typeof repo_apply_patch);',
        'print(typeof repo_commit);',
        'print(typeof write_file);',
      ].join('\n'),
      5000,
      8192,
    );

    expect(result.output).toBe(['undefined', 'undefined', 'undefined'].join('\n'));
  });

  it('routes code execution through the sandbox execution port', async () => {
    const fallbackPort = withChildProcessSandboxExecutionPort(null);
    const executeCode = vi.fn(fallbackPort.executeCode);
    const sandbox = new REPLSandbox(nullDeps(mockLLM(), makeExecutionPort({
      executeCode,
    })));

    const result = await sandbox.execute(
      'var counter = 1; print(counter);',
      5000,
      8192,
    );

    expect(result.output).toBe('1');
    expect(result.error).toBeNull();
    expect(executeCode).toHaveBeenCalledTimes(1);
    expect(executeCode).toHaveBeenCalledWith(expect.objectContaining({
      timeoutMs: 5000,
      code: expect.stringContaining('globalThis.counter = 1;'),
    }));
  });

  it('reports child-process code execution as default-deny even when shell uses a broker', () => {
    const executionPort = withChildProcessSandboxExecutionPort({
      boundary: {
        kind: 'sandbox_broker',
        isolatedFromGatewaySecrets: true,
        brokerId: 'brokered-shell-only',
      },
      shellExec: vi.fn(async () => ({
        command: 'node',
        args: ['-v'],
        cwd: '/app/workspace',
        exitCode: 0,
        stdout: 'v22.0.0',
        stderr: '',
        timedOut: false,
        truncated: false,
        durationMs: 12,
      })),
    });
    const sandbox = new REPLSandbox(nullDeps(mockLLM(), executionPort));

    expect(executionPort.boundary).toMatchObject({
      kind: 'sandbox_broker',
      isolatedFromGatewaySecrets: true,
    });
    expect(sandbox.getExecutionBoundary()).toEqual({
      kind: 'child_process',
      isolatedFromGatewaySecrets: true,
      securityPosture: 'out_of_process_default_deny',
      protocol: 'analysis-workbench-child-v1',
      deniedCapabilities: expect.arrayContaining([
        'filesystem',
        'network',
        'process',
        'module_import',
        'global_escape',
      ]),
      reason: expect.stringContaining('child process'),
    });
  });

  it('fails closed when code execution is configured with a non-child-process boundary', () => {
    expect(() => withChildProcessSandboxExecutionPort({
      boundary: {
        kind: 'sandbox_broker',
        isolatedFromGatewaySecrets: true,
      },
      shellExec: vi.fn(),
      codeExecutionBoundary: {
        kind: 'node_vm',
        isolatedFromGatewaySecrets: false,
        reason: 'legacy false claim',
      } as any,
    })).toThrow('requires an out-of-process child_process sandbox boundary');
  });

  it('shell_exec helper calls the sandbox execution port when allowed', async () => {
    const executionPort = makeExecutionPort({
      boundary: {
        kind: 'sandbox_broker',
        isolatedFromGatewaySecrets: true,
      },
      shellExec: vi.fn(async () => ({
        command: 'node',
        args: ['-v'],
        cwd: '/app/workspace',
        exitCode: 0,
        stdout: 'v22.0.0',
        stderr: '',
        timedOut: false,
        truncated: false,
        durationMs: 12,
      })),
    });
    const sandbox = new REPLSandbox(nullDeps(mockLLM(), executionPort));

    const result = await sandbox.execute(
      'const r = await shell_exec("node", ["-v"]); print(r.ok, r.stdout);',
      5000,
      8192,
    );

    expect(result.output).toContain('true v22.0.0');
    expect(executionPort.shellExec).toHaveBeenCalledWith('node', ['-v'], {});
  });

  it('fails closed when the execution port returns an invalid shell result shape', async () => {
    const executionPort = makeExecutionPort({
      boundary: {
        kind: 'sandbox_broker',
        isolatedFromGatewaySecrets: true,
      },
      shellExec: vi.fn(async () => ({ exitCode: 0 })),
    });
    const sandbox = new REPLSandbox(nullDeps(mockLLM(), executionPort));

    const result = await sandbox.execute(
      'const r = await shell_exec("node", ["-v"]); print(r.ok, r.error);',
      5000,
      8192,
    );

    expect(result.output).toContain('false shell_exec returned invalid result shape');
    expect(executionPort.shellExec).toHaveBeenCalledWith('node', ['-v'], {});
  });

  it('omits shell_exec helper when execution boundary is still the gateway process', async () => {
    const sandbox = new REPLSandbox(nullDeps(mockLLM(), makeExecutionPort({
      boundary: {
        kind: 'gateway_process',
        isolatedFromGatewaySecrets: false,
        reason: 'legacy gateway shell.exec path',
      },
      shellExec: vi.fn(async () => ({
        command: 'node',
        args: ['-v'],
        cwd: '/app/workspace',
        exitCode: 0,
        stdout: 'v22.0.0',
        stderr: '',
        timedOut: false,
        truncated: false,
        durationMs: 12,
      })),
    })));
    const result = await sandbox.execute(
      'print(typeof shell_exec);',
      5000,
      8192,
    );
    expect(result.output).toBe('undefined');
  });

  it('omits shell_exec helper when execution port is unavailable', async () => {
    const sandbox = new REPLSandbox({
      ...nullDeps(),
      getCapabilityTier: () => 'autonomous',
    });
    const result = await sandbox.execute(
      'print(typeof shell_exec);',
      5000,
      8192,
    );
    expect(result.output).toBe('undefined');
  });

  it('omits shell_exec helper for non-autonomous capability tiers', async () => {
    const sandbox = new REPLSandbox({
      ...nullDeps(),
      getCapabilityTier: () => 'nursery',
    });
    const result = await sandbox.execute(
      'print(typeof shell_exec);',
      5000,
      8192,
    );
    expect(result.output).toBe('undefined');
  });

  it('enforces max tool calls across read_file/write_file/list_files/web', async () => {
    const llm = {
      ...mockLLM(),
      fsRead: vi.fn(async (path: string) => `read:${path}`),
      fsWrite: vi.fn(async () => {}),
      fsList: vi.fn(async () => ({
        paths: ['one.ts'],
        scannedEntries: 1,
        maxEntries: 200,
        maxScannedEntries: 5000,
        truncated: false,
        scanLimitReached: false,
        entryLimitReached: false,
      })),
      webFetch: vi.fn(async () => 'web'),
    } as unknown as LLMProviderPort;
    const budgetRef: SandboxBudgetRef = {
      subQueries: 0,
      maxSubQueries: 10,
      toolCalls: 0,
      maxToolCalls: 2,
    };
    const sandbox = new REPLSandbox(nullDeps(llm, null, {
      allowWorkspaceWrite: true,
    }), budgetRef);
    const result = await sandbox.execute(
      [
        'const a = await read_file("a.txt");',
        'const b = await web("fetch", "https://example.com");',
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

  it('web browse surfaces TLS diagnostics from gateway errors', async () => {
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
    } as unknown as LLMProviderPort;
    const sandbox = new REPLSandbox(nullDeps(llm));
    const result = await sandbox.execute(
      'const c = await web("browse", "https://1.1.1.1/"); print(c);',
      5000,
      8192,
    );

    expect(result.output).toContain('UNABLE_TO_GET_ISSUER_CERT_LOCALLY');
    expect(result.output).toContain('code=-32003');
  });

  it('module read APIs inspect module registry via gateway fs methods', async () => {
    const stored = JSON.stringify([{
      id: 'mod-1',
      name: 'planner',
      source: 'export default {};',
      enabled: true,
      installedAt: 1,
      updatedAt: 2,
      version: 1,
    }]);
    const llm = {
      ...mockLLM(),
      fsRead: vi.fn(async () => stored),
      fsWrite: vi.fn(),
    } as unknown as LLMProviderPort;
    const sandbox = new REPLSandbox(nullDeps(llm));

    const result = await sandbox.execute(
      [
        'const list = await module_list(); print(list.length);',
        'print(list[0].name, list[0].enabled);',
        'const health = await module_health("planner"); print(health[0].health);',
      ].join('\n'),
      5000,
      8192,
    );

    expect(result.output).toContain('1');
    expect(result.output).toContain('planner true');
    expect(result.output).toContain('ready');
    expect((llm as any).fsWrite).not.toHaveBeenCalled();
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
    } as unknown as EmbeddingProviderPort;

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
    const result = await sandbox.execute('print(await memory_count());', 5000, 8192);
    expect(result.output).toBe('0');
  });

  it('memory_count uses countActiveMemories when available', async () => {
    const memoryStore = {
      countActiveMemories: vi.fn(async () => 7),
    } as unknown as MemoryStore;

    const sandbox = new REPLSandbox({
      llmProvider: mockLLM(),
      embeddingService: null,
      memoryStore,
      sessionManager: null,
    });

    const result = await sandbox.execute('print(await memory_count());', 5000, 8192);

    expect(result.output).toBe('7');
    expect((memoryStore.countActiveMemories as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
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

  it('denies import, filesystem, network, process, and global escape attempts by default', async () => {
    const sandbox = new REPLSandbox(nullDeps());

    const result = await sandbox.execute(
      [
        'const checks = [];',
        'checks.push(`process:${typeof process}`);',
        'checks.push(`require:${typeof require}`);',
        'checks.push(`Buffer:${typeof Buffer}`);',
        'checks.push(`fetch:${typeof fetch}`);',
        'checks.push(`WebSocket:${typeof WebSocket}`);',
        'try { await import("node:fs"); checks.push("fs-import:allowed"); }',
        'catch (error) { checks.push("fs-import:denied"); }',
        'try { await import("node:net"); checks.push("net-import:allowed"); }',
        'catch (error) { checks.push("net-import:denied"); }',
        'try { await import("node:child_process"); checks.push("child-process-import:allowed"); }',
        'catch (error) { checks.push("child-process-import:denied"); }',
        'try { globalThis.constructor.constructor("return process")(); checks.push("global-escape:allowed"); }',
        'catch (error) { checks.push("global-escape:denied"); }',
        'try { Function("return process")(); checks.push("function-escape:allowed"); }',
        'catch (error) { checks.push("function-escape:denied"); }',
        'try { Object.constructor("return process")(); checks.push("object-constructor-escape:allowed"); }',
        'catch (error) { checks.push("object-constructor-escape:denied"); }',
        'print(checks.join("\\n"));',
      ].join('\n'),
      5000,
      8192,
    );

    expect(result.error).toBeNull();
    expect(result.output).toContain('process:undefined');
    expect(result.output).toContain('require:undefined');
    expect(result.output).toContain('Buffer:undefined');
    expect(result.output).toContain('fetch:undefined');
    expect(result.output).toContain('WebSocket:undefined');
    expect(result.output).toContain('fs-import:denied');
    expect(result.output).toContain('net-import:denied');
    expect(result.output).toContain('child-process-import:denied');
    expect(result.output).toContain('global-escape:denied');
    expect(result.output).toContain('function-escape:denied');
    expect(result.output).toContain('object-constructor-escape:denied');
    expect(result.output).not.toContain('allowed');
  });

  it('declares default-deny child-process code execution capabilities', () => {
    const sandbox = new REPLSandbox(nullDeps());
    expect(sandbox.getExecutionBoundary()).toMatchObject({
      kind: 'child_process',
      isolatedFromGatewaySecrets: true,
      securityPosture: 'out_of_process_default_deny',
      protocol: 'analysis-workbench-child-v1',
      deniedCapabilities: expect.arrayContaining([
        'filesystem',
        'network',
        'process',
        'module_import',
        'global_escape',
        'child_process',
        'environment',
      ]),
    });
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

  it('does not expose mutating helpers in default analysis_workbench locals', async () => {
    const sandbox = new REPLSandbox(nullDeps());
    const result = await sandbox.execute(
      [
        'const names = [',
        '  "memory_write", "memory_upsert", "memory_import_batch", "memory_redact",',
        '  "session_append_note",',
        '  "schedule_add_every", "schedule_add_once", "schedule_update", "event_emit",',
        '  "module_install", "module_enable", "module_disable",',
        '];',
        'print(names.map(name => `${name}:${typeof globalThis[name]}`).join("\\n"));',
      ].join('\n'),
      5000,
      8192,
    );

    expect(result.error).toBeNull();
    for (const line of result.output.split('\n')) {
      expect(line).toMatch(/:undefined$/);
    }
  });

  it('getLocals excludes new builtins', async () => {
    const sandbox = new REPLSandbox(nullDeps());
    const locals = sandbox.getLocals();
    expect(locals.memory_upsert).toBeUndefined();
    expect(locals.memory_redact).toBeUndefined();
    expect(locals.session_append_note).toBeUndefined();
    expect(locals.schedule_list).toBeUndefined();
    expect(locals.schedule_add_every).toBeUndefined();
    expect(locals.schedule_add_once).toBeUndefined();
    expect(locals.schedule_update).toBeUndefined();
    expect(locals.event_emit).toBeUndefined();
    expect(locals.llm_query_strict).toBeUndefined();
    expect(locals.llm_query_json).toBeUndefined();
    expect(locals.nested_analysis).toBeUndefined();
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
    expect(locals.web).toBeUndefined();
    expect(locals.web_fetch).toBeUndefined();
    expect(locals.crawler_fetch).toBeUndefined();
    expect(locals.web_research).toBeUndefined();
    expect(locals.shell_exec).toBeUndefined();
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
      'const tasks = await schedule_list(); print(tasks.length); print(Boolean(tasks[0].handler));',
      5000, 8192,
    );
    expect(result.output).toBe('1\nfalse');
  });

  it('schedule functions fail cleanly when scheduler is unavailable', async () => {
    const sandbox = new REPLSandbox({
      ...nullDeps(),
      scheduler: null,
      eventBus: new EventBus(),
    });

    const result = await sandbox.execute(
      [
        'const list = await schedule_list();',
        'print(list.length);',
      ].join('\n'),
      5000,
      8192,
    );
    expect(result.output).toBe('0');
  });
});

describe('evidence collection', () => {
  it('collectEvidence drains accumulated evidence', async () => {
    const embedding = new Float32Array([1, 0, 0]);
    const embeddingService = {
      embed: vi.fn(async () => embedding),
      embedBatch: vi.fn(),
      dims: 3,
    } as unknown as EmbeddingProviderPort;
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
