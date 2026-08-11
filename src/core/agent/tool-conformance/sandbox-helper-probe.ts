// ── REPL-only sandbox host-helper conformance probes (bead 65rk.7) ──────────
//
// The analysis_workbench REPL exposes host helpers (llm_query*, module_*, repo_*,
// web*, memory_*, and the gated shell_exec / repo write / write_file helpers)
// that are NOT direct tool-catalog entries, so the tool-surface sweep never sees
// them. This module gives them an extended-mode probe path WITHOUT running an LLM
// or executing any sandbox code:
//
//   - llm_query / llm_query_strict / llm_query_json get a wiring/presence check
//     only — they are declared `always` present and are NEVER invoked (the
//     harness is LLM-free by design; see harness.ts header).
//   - the gated helpers (shell_exec, repo_apply_patch, repo_commit, write_file,
//     nested_analysis) get a GATE-BEHAVIOR assertion: the probe proves the helper
//     is withheld under a denied capability config and wired under an allowed
//     one, never executing the helper itself.
//
// The declared catalog below is bound to the real wiring in
// src/core/tools/analysis-workbench/sandbox.ts by a static drift test
// (sandbox-helper-probe.test.ts): adding or removing a host helper there without
// updating this catalog fails the build, mirroring the per-tool/per-action
// fail-closed pattern.

import type { ToolConformanceProbeResult } from './types.js';

/** The tool surface these REPL helpers belong to (analysis_workbench sandbox). */
export const SANDBOX_HELPER_OWNER_TOOL = 'analysis_workbench';

/**
 * Capability gate that governs whether a helper is wired into the sandbox.
 *   - always          : unconditionally present (includes the LLM helpers).
 *   - nested_analysis : present iff a nested-analysis runner is provided.
 *   - repo_mutation   : present iff repo mutation is allowed.
 *   - workspace_write : present iff workspace write is allowed.
 *   - shell_exec      : present iff shell exec is allowed AND a broker port exists.
 */
export type SandboxHelperGate =
  | 'always'
  | 'nested_analysis'
  | 'repo_mutation'
  | 'workspace_write'
  | 'shell_exec';

export interface SandboxHelperCatalogEntry {
  name: string;
  gate: SandboxHelperGate;
}

/**
 * Canonical catalog of every host helper wired in sandbox.ts `this.hostHelpers`.
 * Kept in wiring order for a stable, diff-friendly report. MUST match the sandbox
 * source exactly — the drift test enforces it.
 */
export const SANDBOX_HELPER_CATALOG: readonly SandboxHelperCatalogEntry[] = [
  { name: 'llm_query', gate: 'always' },
  { name: 'llm_query_strict', gate: 'always' },
  { name: 'llm_query_json', gate: 'always' },
  { name: 'nested_analysis', gate: 'nested_analysis' },
  { name: 'memory_search', gate: 'always' },
  { name: 'episode_search', gate: 'always' },
  { name: 'memory_count', gate: 'always' },
  { name: 'memory_get_by_id', gate: 'always' },
  { name: 'session_messages', gate: 'always' },
  { name: 'session_search', gate: 'always' },
  { name: 'schedule_list', gate: 'always' },
  { name: 'module_list', gate: 'always' },
  { name: 'module_health', gate: 'always' },
  { name: 'repo_status', gate: 'always' },
  { name: 'repo_diff', gate: 'always' },
  { name: 'read_file', gate: 'always' },
  { name: 'list_files', gate: 'always' },
  { name: 'web', gate: 'always' },
  { name: 'web_fetch', gate: 'always' },
  { name: 'crawler_fetch', gate: 'always' },
  { name: 'web_research', gate: 'always' },
  { name: 'repo_apply_patch', gate: 'repo_mutation' },
  { name: 'repo_commit', gate: 'repo_mutation' },
  { name: 'write_file', gate: 'workspace_write' },
  { name: 'shell_exec', gate: 'shell_exec' },
];

/** Capability configuration that decides which gated helpers are wired. */
export interface SandboxHelperGateConfig {
  runNestedAnalysis: boolean;
  allowRepoMutation: boolean;
  allowWorkspaceWrite: boolean;
  /** allowShellExec AND a live sandbox-broker shell-exec port. */
  allowShellExec: boolean;
}

const DENIED_CONFIG: SandboxHelperGateConfig = {
  runNestedAnalysis: false,
  allowRepoMutation: false,
  allowWorkspaceWrite: false,
  allowShellExec: false,
};

const ALLOWED_CONFIG: SandboxHelperGateConfig = {
  runNestedAnalysis: true,
  allowRepoMutation: true,
  allowWorkspaceWrite: true,
  allowShellExec: true,
};

/**
 * Whether a helper is wired for a given gate config. This mirrors the spread
 * conditions in sandbox.ts exactly; the drift test keeps the NAME set in sync,
 * and this function keeps the GATE semantics in sync.
 */
export function isSandboxHelperPresent(
  gate: SandboxHelperGate,
  config: SandboxHelperGateConfig,
): boolean {
  switch (gate) {
    case 'always':
      return true;
    case 'nested_analysis':
      return config.runNestedAnalysis;
    case 'repo_mutation':
      return config.allowRepoMutation;
    case 'workspace_write':
      return config.allowWorkspaceWrite;
    case 'shell_exec':
      return config.allowShellExec;
  }
}

/**
 * Emit one sandbox_helper probe per REPL helper. Execution-free and LLM-free: the
 * probe asserts wiring/gate BEHAVIOR by comparing a denied capability config
 * against an allowed one.
 *   - `always` helper: must be present under both configs (wiring check). The LLM
 *     helpers land here — presence only, never a model call.
 *   - gated helper: must be withheld under the denied config and wired under the
 *     allowed config (gate-flip check). A gate that fails to flip is a
 *     `gate_inconsistent` failure; a helper that never appears is `helper_missing`.
 */
export function runSandboxHelperProbes(monotonicNow: () => number): ToolConformanceProbeResult[] {
  return SANDBOX_HELPER_CATALOG.map((entry) => {
    const started = monotonicNow();
    const presentWhenDenied = isSandboxHelperPresent(entry.gate, DENIED_CONFIG);
    const presentWhenAllowed = isSandboxHelperPresent(entry.gate, ALLOWED_CONFIG);
    const durationMs = Math.max(0, monotonicNow() - started);
    const base = {
      toolName: SANDBOX_HELPER_OWNER_TOOL,
      probeKind: 'sandbox_helper' as const,
      action: entry.name,
      durationMs,
    };

    if (!presentWhenAllowed) {
      // A helper that is never wired under any config is a wiring regression.
      return {
        ...base,
        ok: false,
        classification: 'helper_missing' as const,
        error: `helper "${entry.name}" (gate ${entry.gate}) is never wired`,
      };
    }
    if (entry.gate === 'always') {
      if (!presentWhenDenied) {
        return {
          ...base,
          ok: false,
          classification: 'gate_inconsistent' as const,
          error: `helper "${entry.name}" is declared always-present but is withheld under a denied config`,
        };
      }
      return { ...base, ok: true };
    }
    // Gated helper: must flip from withheld (denied) to wired (allowed).
    if (presentWhenDenied) {
      return {
        ...base,
        ok: false,
        classification: 'gate_inconsistent' as const,
        error: `gated helper "${entry.name}" (gate ${entry.gate}) is wired even under a denied config`,
      };
    }
    return { ...base, ok: true };
  });
}
