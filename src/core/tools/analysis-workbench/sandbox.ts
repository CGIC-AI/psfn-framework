// ── RLM Sandbox ──
// Out-of-process REPL orchestration with explicit host-helper IPC.

import type { AnalysisWorkbenchEvidence } from './types.js';
import type {
  ExecuteResult,
  GatewayREPLCapabilities,
  SandboxCodeExecutionBoundary,
  SandboxBudgetRef,
  SandboxDeps,
  SandboxExecutionPort,
  SandboxHostHelper,
} from '../../../boundary/sandbox/capabilities/contracts.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import { withChildProcessSandboxExecutionPort } from '../../../boundary/sandbox/sandbox-execution-port.js';
import {
  createLLMCapabilities,
  createMemoryCapabilities,
  createModuleCapabilities,
  createRepoCapabilities,
  createSchedulerCapabilities,
  createShellCapabilities,
  createAnalysisCapabilities,
  createToolchainCapabilities,
  createWebCapabilities,
} from '../../../boundary/sandbox/capabilities/index.js';

export type { SandboxDeps, SandboxBudgetRef, ExecuteResult } from '../../../boundary/sandbox/capabilities/contracts.js';

export interface SandboxLimits {
  memoryCeilingBytes?: number;
}

export class FinalAnswerSignal {
  readonly answer: string;
  constructor(answer: string) {
    this.answer = answer;
  }
}

export class REPLSandbox {
  private deps: SandboxDeps;
  private budgetRef: SandboxBudgetRef | undefined;
  private currentEvidence: AnalysisWorkbenchEvidence[] = [];
  private memoryCeilingBytes: number | undefined;
  private executionPort: SandboxExecutionPort;
  private hostHelpers: Record<string, SandboxHostHelper>;
  private locals: Record<string, unknown> = {};

  constructor(deps: SandboxDeps, budgetRef?: SandboxBudgetRef, limits?: SandboxLimits) {
    this.deps = deps;
    this.budgetRef = budgetRef;
    this.memoryCeilingBytes = limits?.memoryCeilingBytes;
    this.executionPort = withChildProcessSandboxExecutionPort(this.deps.executionPort ?? null);

    const gatewayCaps = this.deps.llmProvider as unknown as GatewayREPLCapabilities;
    const pushEvidence = (entry: AnalysisWorkbenchEvidence): void => {
      this.currentEvidence.push(entry);
    };

    const llm = createLLMCapabilities({
      llmProvider: this.deps.llmProvider,
      budgetRef: this.budgetRef,
      pushEvidence,
      requestMetadata: this.deps.requestMetadata,
    });
    const nestedAnalysis = this.deps.runNestedAnalysis
      ? createAnalysisCapabilities({
        runNestedAnalysis: this.deps.runNestedAnalysis,
      })
      : null;

    const memory = createMemoryCapabilities({
      llmProvider: this.deps.llmProvider,
      embeddingService: this.deps.embeddingService,
      memoryStore: this.deps.memoryStore,
      sessionManager: this.deps.sessionManager,
      pushEvidence,
    });

    const scheduler = createSchedulerCapabilities({
      scheduler: this.deps.scheduler ?? null,
      eventBus: this.deps.eventBus ?? null,
      getSandboxContext: () => this.locals,
    });

    const modules = createModuleCapabilities({
      gatewayCaps,
      pushEvidence,
      getCapabilityTier: this.deps.getCapabilityTier,
      confirmationQueue: this.deps.moduleInstallConfirmationQueue,
      onModuleRegistryMutation: this.deps.onModuleRegistryMutation,
    });

    const repo = createRepoCapabilities({
      gatewayCaps,
      pushEvidence,
    });

    const web = createWebCapabilities({
      gatewayCaps,
      pushEvidence,
      budgetRef: this.budgetRef,
      llm_query_json: llm.llm_query_json,
    });

    const toolchain = createToolchainCapabilities({
      gatewayCaps,
      budgetRef: this.budgetRef,
    });

    const shell = createShellCapabilities({
      executionPort: this.executionPort,
      budgetRef: this.budgetRef,
    });

    const capabilityTier = this.deps.getCapabilityTier?.();
    const allowShellExec = capabilityTier === undefined
      || capabilityTier === 'autonomous'
      || capabilityTier === 'custom';
    const allowRepoMutation = this.deps.mutationPolicy?.allowRepoMutation === true;
    const allowWorkspaceWrite = this.deps.mutationPolicy?.allowWorkspaceWrite === true;
    const hasShellExecPort = Boolean(
      this.executionPort.boundary.kind === 'sandbox_broker'
      && typeof this.executionPort.shellExec === 'function',
    );

    this.hostHelpers = {
      llm_query: llm.llm_query,
      llm_query_strict: llm.llm_query_strict,
      llm_query_json: llm.llm_query_json,
      ...(nestedAnalysis ? { nested_analysis: nestedAnalysis.nested_analysis } : {}),
      memory_search: memory.memory_search,
      memory_count: memory.memory_count,
      memory_get_by_id: memory.memory_get_by_id,
      session_messages: memory.session_messages,
      session_search: memory.session_search,
      schedule_list: scheduler.schedule_list,
      module_list: modules.module_list,
      module_health: modules.module_health,
      repo_status: repo.repo_status,
      repo_diff: repo.repo_diff,
      read_file: toolchain.read_file,
      list_files: toolchain.list_files,
      web: web.web,
      web_fetch: web.web_fetch,
      crawler_fetch: web.crawler_fetch,
      web_research: web.web_research,
      ...(allowRepoMutation
        ? {
          repo_apply_patch: repo.repo_apply_patch,
          repo_commit: repo.repo_commit,
        }
        : {}),
      ...(allowWorkspaceWrite
        ? {
          write_file: toolchain.write_file,
        }
        : {}),
      ...((allowShellExec && hasShellExecPort) ? { shell_exec: shell.shell_exec } : {}),
    };
  }

  /** Drain collected evidence since last call */
  collectEvidence(): AnalysisWorkbenchEvidence[] {
    const evidence = this.currentEvidence;
    this.currentEvidence = [];
    return evidence;
  }

  getExecutionBoundary(): SandboxCodeExecutionBoundary {
    return this.executionPort.codeExecutionBoundary;
  }

  private snapshotUserVars(): Map<string, string> {
    const snap = new Map<string, string>();
    for (const [key, value] of Object.entries(this.locals)) {
      snap.set(key, this.stableValueKey(value));
    }
    return snap;
  }

  private stableValueKey(value: unknown): string {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  async execute(code: string, timeoutMs: number, truncationLimit: number): Promise<ExecuteResult> {
    const before = this.snapshotUserVars();

    // Transform top-level var/let/const to globalThis assignments so they persist
    // across execute() calls (async IIFE creates a new scope otherwise).
    const transformed = code.replace(
      /^(var|let|const)\s+(\w+)\s*=/gm,
      'globalThis.$2 =',
    );
    const wrapped = `(async () => {\n${transformed}\n})()`;

    try {
      const response = await this.executionPort.executeCode({
        code: wrapped,
        timeoutMs,
        memoryCeilingBytes: this.memoryCeilingBytes,
        initialLocals: this.locals,
        helperNames: Object.keys(this.hostHelpers),
        hostHelpers: this.hostHelpers,
      });
      this.locals = response.locals;

      const output = this.truncate(response.output.join('\n'), truncationLimit);
      const variablesChanged = this.diffVars(before);
      return {
        output,
        error: response.error,
        finalAnswer: response.finalAnswer,
        variablesChanged,
      };
    } catch (err) {
      if (err instanceof FinalAnswerSignal) {
        const variablesChanged = this.diffVars(before);
        return { output: '', error: null, finalAnswer: err.answer, variablesChanged };
      }

      const errorMsg = toErrorMessage(err);
      const variablesChanged = this.diffVars(before);
      return { output: '', error: errorMsg, finalAnswer: null, variablesChanged };
    }
  }

  private diffVars(before: Map<string, string>): string[] {
    const changed: string[] = [];
    const after = this.snapshotUserVars();

    // Check for new or modified vars.
    for (const [key, value] of after) {
      if (!before.has(key) || before.get(key) !== value) {
        changed.push(key);
      }
    }
    return changed;
  }

  getLocals(): Record<string, unknown> {
    return { ...this.locals };
  }

  private truncate(text: string, limit: number): string {
    if (text.length <= limit) return text;
    return text.slice(0, limit) + `\n... [truncated, ${text.length - limit} chars omitted]`;
  }
}
