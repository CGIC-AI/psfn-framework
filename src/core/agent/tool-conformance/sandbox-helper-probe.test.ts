import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SANDBOX_HELPER_CATALOG,
  SANDBOX_HELPER_OWNER_TOOL,
  isSandboxHelperPresent,
  runSandboxHelperProbes,
  type SandboxHelperGate,
} from './sandbox-helper-probe.js';

const SANDBOX_SOURCE = resolve('src/core/tools/analysis-workbench/sandbox.ts');

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
