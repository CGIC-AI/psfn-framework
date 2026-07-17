import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SANDBOX_HELPER_CATALOG,
  SANDBOX_HELPER_OWNER_TOOL,
  isSandboxHelperPresent,
  runSandboxHelperProbes,
  type SandboxHelperGate,
} from './sandbox-helper-probe.js';
import { REPLSandbox, type SandboxDeps } from '../../tools/analysis-workbench/sandbox.js';
import { withChildProcessSandboxExecutionPort } from '../../../boundary/sandbox/sandbox-execution-port.js';
import type { SandboxExecutionPort } from '../../../boundary/sandbox/capabilities/contracts.js';
import type { LLMProviderPort } from '../contracts.js';
import type { CapabilityTier } from '../../../system/capabilities/tier-types.js';

const SANDBOX_SOURCE = resolve('src/core/tools/analysis-workbench/sandbox.ts');

// ── Real-wiring observation helpers (bead 65rk.7 finding 2) ──
//
// Construct the ACTUAL REPLSandbox with inert dependencies and read the actual
// host-helper KEYS it wires. No helper is ever invoked and no LLM is called —
// only the constructor's gate spreads are exercised. This is what makes the gate
// non-hollow: a change in sandbox.ts that unconditionalizes a gated helper (e.g.
// `write_file`) is observed here as a real key under the denied config.

function inertLLM(): LLMProviderPort {
  const response = {
    content: '', toolCalls: [], model: 'inert', inputTokens: 0, outputTokens: 0, stopReason: 'stop',
  };
  return {
    stream: async () => response,
    complete: async () => response,
  } as unknown as LLMProviderPort;
}

function brokeredExecutionPort(): SandboxExecutionPort {
  const base = withChildProcessSandboxExecutionPort(null);
  return {
    boundary: { kind: 'sandbox_broker', isolatedFromGatewaySecrets: true },
    codeExecutionBoundary: base.codeExecutionBoundary,
    // Present but NEVER called — only its existence flips hasShellExecPort.
    shellExec: (async () => ({
      command: 'node', args: [], cwd: '/app/workspace', exitCode: 0,
      stdout: '', stderr: '', timedOut: false, truncated: false, durationMs: 0,
    })) as SandboxExecutionPort['shellExec'],
    executeCode: base.executeCode,
  };
}

function inertBaseDeps(): SandboxDeps {
  return {
    llmProvider: inertLLM(),
    executionPort: null,
    embeddingService: null,
    memoryStore: null,
    sessionManager: null,
    scheduler: null,
    eventBus: null,
  };
}

function deniedSandboxHelperKeys(): string[] {
  const sandbox = new REPLSandbox({
    ...inertBaseDeps(),
    getCapabilityTier: () => 'nursery' as CapabilityTier,
    mutationPolicy: { allowRepoMutation: false, allowWorkspaceWrite: false },
    // no runNestedAnalysis, no broker execution port → every gate denied.
  });
  return Object.keys((sandbox as unknown as { hostHelpers: Record<string, unknown> }).hostHelpers);
}

function allowedSandboxHelperKeys(): string[] {
  const sandbox = new REPLSandbox({
    ...inertBaseDeps(),
    executionPort: brokeredExecutionPort(),
    getCapabilityTier: () => 'autonomous' as CapabilityTier,
    mutationPolicy: { allowRepoMutation: true, allowWorkspaceWrite: true },
    runNestedAnalysis: (async () => ({})) as SandboxDeps['runNestedAnalysis'],
  });
  return Object.keys((sandbox as unknown as { hostHelpers: Record<string, unknown> }).hostHelpers);
}

const ORIGINAL_MODULE_REGISTRY_PATH = process.env.MODULE_REGISTRY_PATH;
beforeAll(() => {
  // createModuleCapabilities reads this at construction; mirror sandbox.test.ts.
  process.env.MODULE_REGISTRY_PATH = ORIGINAL_MODULE_REGISTRY_PATH ?? 'companion/modules/repl-registry.json';
});
afterAll(() => {
  if (ORIGINAL_MODULE_REGISTRY_PATH === undefined) delete process.env.MODULE_REGISTRY_PATH;
  else process.env.MODULE_REGISTRY_PATH = ORIGINAL_MODULE_REGISTRY_PATH;
});

/** Extract the helper names assigned inside the `this.hostHelpers = { … }` block. */
function extractWiredHelperNames(): string[] {
  const source = readFileSync(SANDBOX_SOURCE, 'utf-8');
  const marker = 'this.hostHelpers = {';
  const start = source.indexOf(marker);
  if (start < 0) throw new Error('could not locate this.hostHelpers assignment in sandbox.ts');
  let depth = 0;
  let end = -1;
  for (let i = start + marker.length - 1; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) throw new Error('could not locate end of this.hostHelpers block');
  const block = source.slice(start + marker.length, end);
  const names = new Set<string>();
  for (const match of block.matchAll(/(\w+):/g)) {
    names.add(match[1]);
  }
  return [...names].sort();
}

describe('sandbox helper probe catalog drift guard (bead 65rk.7)', () => {
  it('matches the host helpers actually wired in sandbox.ts exactly', () => {
    const wired = extractWiredHelperNames();
    const cataloged = [...SANDBOX_HELPER_CATALOG.map(entry => entry.name)].sort();
    expect(cataloged).toEqual(wired);
  });

  it('marks exactly the conditionally-wired helpers as gated', () => {
    const gatedInSource = new Set(['nested_analysis', 'repo_apply_patch', 'repo_commit', 'write_file', 'shell_exec']);
    for (const entry of SANDBOX_HELPER_CATALOG) {
      const shouldBeGated = gatedInSource.has(entry.name);
      const isGated = entry.gate !== 'always';
      expect(isGated, `${entry.name} gate classification`).toBe(shouldBeGated);
    }
  });
});

describe('sandbox helper probe REAL-wiring gate (bead 65rk.7 finding 2)', () => {
  // These assertions observe the ACTUAL REPLSandbox.hostHelpers keys, not the
  // catalog's own booleans. Making any gated helper unconditional in sandbox.ts
  // (e.g. dropping the `...(allowWorkspaceWrite ? { write_file } : {})` guard)
  // surfaces that helper under the denied config and fails these tests.

  const alwaysNames = SANDBOX_HELPER_CATALOG.filter(e => e.gate === 'always').map(e => e.name);
  const gatedNames = SANDBOX_HELPER_CATALOG.filter(e => e.gate !== 'always').map(e => e.name);

  it('wires every always-helper and NO gated helper under a fully-denied config', () => {
    const denied = new Set(deniedSandboxHelperKeys());
    for (const name of alwaysNames) {
      expect(denied.has(name), `always-helper "${name}" must be wired even when denied`).toBe(true);
    }
    for (const name of gatedNames) {
      expect(denied.has(name), `gated helper "${name}" must be WITHHELD under a denied config`).toBe(false);
    }
  });

  it('wires the complete cataloged helper set under a fully-allowed config', () => {
    const allowed = new Set(allowedSandboxHelperKeys());
    for (const entry of SANDBOX_HELPER_CATALOG) {
      expect(allowed.has(entry.name), `helper "${entry.name}" must be wired when allowed`).toBe(true);
    }
    // No real helper escapes the catalog: the actual allowed keys equal the catalog.
    expect([...allowed].sort()).toEqual(SANDBOX_HELPER_CATALOG.map(e => e.name).slice().sort());
  });

  it('exactly the gated helpers flip from withheld to wired', () => {
    const denied = new Set(deniedSandboxHelperKeys());
    const allowed = new Set(allowedSandboxHelperKeys());
    const flipped = [...allowed].filter(name => !denied.has(name)).sort();
    expect(flipped).toEqual(gatedNames.slice().sort());
  });

  it('binds every catalog gate classification to the real wiring', () => {
    const deniedConfig = { runNestedAnalysis: false, allowRepoMutation: false, allowWorkspaceWrite: false, allowShellExec: false };
    const allowedConfig = { runNestedAnalysis: true, allowRepoMutation: true, allowWorkspaceWrite: true, allowShellExec: true };
    const denied = new Set(deniedSandboxHelperKeys());
    const allowed = new Set(allowedSandboxHelperKeys());
    for (const entry of SANDBOX_HELPER_CATALOG) {
      expect(denied.has(entry.name), `${entry.name} denied wiring vs catalog gate`)
        .toBe(isSandboxHelperPresent(entry.gate, deniedConfig));
      expect(allowed.has(entry.name), `${entry.name} allowed wiring vs catalog gate`)
        .toBe(isSandboxHelperPresent(entry.gate, allowedConfig));
    }
  });
});

describe('sandbox helper gate semantics', () => {
  const denied = { runNestedAnalysis: false, allowRepoMutation: false, allowWorkspaceWrite: false, allowShellExec: false };
  const allowed = { runNestedAnalysis: true, allowRepoMutation: true, allowWorkspaceWrite: true, allowShellExec: true };

  it('always helpers are present regardless of capability config', () => {
    expect(isSandboxHelperPresent('always', denied)).toBe(true);
    expect(isSandboxHelperPresent('always', allowed)).toBe(true);
  });

  it('gated helpers flip from withheld to wired with their capability', () => {
    const gates: SandboxHelperGate[] = ['nested_analysis', 'repo_mutation', 'workspace_write', 'shell_exec'];
    for (const gate of gates) {
      expect(isSandboxHelperPresent(gate, denied), `${gate} denied`).toBe(false);
      expect(isSandboxHelperPresent(gate, allowed), `${gate} allowed`).toBe(true);
    }
  });
});

describe('runSandboxHelperProbes', () => {
  it('emits one passing sandbox_helper probe per cataloged helper', () => {
    const probes = runSandboxHelperProbes(() => 0);
    expect(probes).toHaveLength(SANDBOX_HELPER_CATALOG.length);
    for (const probe of probes) {
      expect(probe.toolName).toBe(SANDBOX_HELPER_OWNER_TOOL);
      expect(probe.probeKind).toBe('sandbox_helper');
      expect(probe.ok, `${probe.action} should pass`).toBe(true);
      expect(probe.classification).toBeUndefined();
    }
  });

  it('covers the LLM helpers as presence-only checks (never invoked)', () => {
    const probes = runSandboxHelperProbes(() => 0);
    for (const name of ['llm_query', 'llm_query_strict', 'llm_query_json']) {
      const probe = probes.find(p => p.action === name);
      expect(probe, `${name} probe present`).toBeDefined();
      expect(probe?.ok).toBe(true);
    }
  });
});
