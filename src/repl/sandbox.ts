// ── RLM Sandbox ──
// node:vm-based code execution with injected context functions.
// The real security boundary is Docker --network=none; vm is convenience isolation.

import vm from 'node:vm';
import type { ThinkEvidence } from './types.js';
import * as helpers from './helpers.js';
import type {
  ExecuteResult,
  GatewayREPLCapabilities,
  SandboxBudgetRef,
  SandboxDeps,
} from '../boundary/sandbox/capabilities/contracts.js';
import { toErrorMessage } from '../shared/utils/errors.js';
import {
  createLLMCapabilities,
  createMemoryCapabilities,
  createModuleCapabilities,
  createRepoCapabilities,
  createSchedulerCapabilities,
  createShellCapabilities,
  createThinkCapabilities,
  createToolchainCapabilities,
  createWebCapabilities,
} from '../boundary/sandbox/capabilities/index.js';

export type { SandboxDeps, SandboxBudgetRef, ExecuteResult } from '../boundary/sandbox/capabilities/contracts.js';

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
  private context: vm.Context;
  private outputBuffer: string[] = [];
  private deps: SandboxDeps;
  private budgetRef: SandboxBudgetRef | undefined;
  private builtinKeysSet: Set<string>;
  private currentEvidence: ThinkEvidence[] = [];
  private memoryCeilingBytes: number | undefined;

  constructor(deps: SandboxDeps, budgetRef?: SandboxBudgetRef, limits?: SandboxLimits) {
    this.deps = deps;
    this.budgetRef = budgetRef;
    this.memoryCeilingBytes = limits?.memoryCeilingBytes;

    const print = (...args: unknown[]) => {
      this.outputBuffer.push(args.map(value => {
        if (typeof value === 'string') return value;
        try {
          return JSON.stringify(value, null, 2);
        } catch {
          return String(value);
        }
      }).join(' '));
    };

    const FINAL = (answer: string) => {
      throw new FinalAnswerSignal(String(answer));
    };

    const gatewayCaps = this.deps.llmProvider as unknown as GatewayREPLCapabilities;
    const pushEvidence = (entry: ThinkEvidence): void => {
      this.currentEvidence.push(entry);
    };

    const llm = createLLMCapabilities({
      llmProvider: this.deps.llmProvider,
      budgetRef: this.budgetRef,
      pushEvidence,
      requestMetadata: this.deps.requestMetadata,
    });
    const nestedThink = this.deps.runNestedThink
      ? createThinkCapabilities({
        runNestedThink: this.deps.runNestedThink,
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
      getSandboxContext: () => this.context,
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
      executionPort: this.deps.executionPort ?? null,
      budgetRef: this.budgetRef,
    });

    const capabilityTier = this.deps.getCapabilityTier?.();
    const allowShellExec = capabilityTier === undefined
      || capabilityTier === 'autonomous'
      || capabilityTier === 'custom';
    const hasShellExecPort = Boolean(
      this.deps.executionPort
      && this.deps.executionPort.boundary.kind === 'sandbox_broker'
      && typeof this.deps.executionPort.shellExec === 'function',
    );

    const contextValues: Record<string, unknown> = {
      // Injected functions
      print,
      console: { log: print, warn: print, error: print },
      FINAL,
      llm_query: llm.llm_query,
      llm_query_strict: llm.llm_query_strict,
      llm_query_json: llm.llm_query_json,
      ...(nestedThink ? { sub_think: nestedThink.sub_think } : {}),
      memory_search: memory.memory_search,
      memory_count: memory.memory_count,
      memory_write: memory.memory_write,
      memory_upsert: memory.memory_upsert,
      memory_import_batch: memory.memory_import_batch,
      memory_redact: memory.memory_redact,
      memory_get_by_id: memory.memory_get_by_id,
      session_messages: memory.session_messages,
      session_search: memory.session_search,
      session_append_note: memory.session_append_note,
      schedule_list: scheduler.schedule_list,
      schedule_add_every: scheduler.schedule_add_every,
      schedule_add_once: scheduler.schedule_add_once,
      schedule_update: scheduler.schedule_update,
      event_emit: scheduler.event_emit,
      module_list: modules.module_list,
      module_install: modules.module_install,
      module_enable: modules.module_enable,
      module_disable: modules.module_disable,
      module_health: modules.module_health,
      repo_status: repo.repo_status,
      repo_diff: repo.repo_diff,
      repo_apply_patch: repo.repo_apply_patch,
      repo_commit: repo.repo_commit,
      read_file: toolchain.read_file,
      write_file: toolchain.write_file,
      list_files: toolchain.list_files,
      web_fetch: web.web_fetch,
      crawler_fetch: web.crawler_fetch,
      web_research: web.web_research,
      ...((allowShellExec && hasShellExecPort) ? { shell_exec: shell.shell_exec } : {}),

      // Text analysis helpers
      search: helpers.search,
      grep: helpers.grep,
      grep_v: helpers.grep_v,
      between: helpers.between,
      head: helpers.head,
      tail: helpers.tail,
      word_frequency: helpers.word_frequency,
      diff: helpers.diff,
      text_similarity: helpers.text_similarity,
      dedupe: helpers.dedupe,
      group_by: helpers.group_by,
      partition: helpers.partition,

      // Safe builtins
      JSON,
      Math,
      Date,
      Array,
      Object,
      String,
      Number,
      Boolean,
      Map,
      Set,
      RegExp,
      Promise,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      undefined,
      null: null,
      true: true,
      false: false,
      Infinity,
      NaN,

      // For async IIFE support
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    };

    this.context = vm.createContext(contextValues);

    // Make globalThis point to the context itself so var assignments persist.
    this.context.globalThis = this.context;

    // Initialize builtin keys set for variable tracking and getLocals.
    this.builtinKeysSet = new Set([...Object.keys(contextValues), 'globalThis']);
  }

  /** Drain collected evidence since last call */
  collectEvidence(): ThinkEvidence[] {
    const evidence = this.currentEvidence;
    this.currentEvidence = [];
    return evidence;
  }

  private snapshotUserVars(): Map<string, unknown> {
    const snap = new Map<string, unknown>();
    for (const key of Object.getOwnPropertyNames(this.context)) {
      if (!this.builtinKeysSet.has(key)) {
        snap.set(key, this.context[key]);
      }
    }
    return snap;
  }

  private assertMemoryCeiling(): void {
    if (!this.memoryCeilingBytes || this.memoryCeilingBytes <= 0) {
      return;
    }

    const heapUsedBytes = process.memoryUsage().heapUsed;
    if (heapUsedBytes > this.memoryCeilingBytes) {
      const usedMb = (heapUsedBytes / (1024 * 1024)).toFixed(1);
      const limitMb = (this.memoryCeilingBytes / (1024 * 1024)).toFixed(1);
      throw new Error(`Sandbox memory ceiling exceeded (${usedMb}MB > ${limitMb}MB)`);
    }
  }

  async execute(code: string, timeoutMs: number, truncationLimit: number): Promise<ExecuteResult> {
    this.outputBuffer = [];
    const before = this.snapshotUserVars();

    // Transform top-level var/let/const to globalThis assignments so they persist
    // across execute() calls (async IIFE creates a new scope otherwise)
    const transformed = code.replace(
      /^(var|let|const)\s+(\w+)\s*=/gm,
      'globalThis.$2 =',
    );
    const wrapped = `(async () => {\n${transformed}\n})()`;

    try {
      this.assertMemoryCeiling();
      const script = new vm.Script(wrapped, { filename: 'repl' });
      const promise = Promise.resolve(script.runInContext(this.context, { timeout: timeoutMs }));
      let timeoutHandle: NodeJS.Timeout | undefined;
      let memoryGuardHandle: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`Execution timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      });
      const memoryGuard = new Promise<never>((_resolve, reject) => {
        if (!this.memoryCeilingBytes || this.memoryCeilingBytes <= 0) return;
        memoryGuardHandle = setInterval(() => {
          try {
            this.assertMemoryCeiling();
          } catch (error) {
            if (memoryGuardHandle) {
              clearInterval(memoryGuardHandle);
              memoryGuardHandle = undefined;
            }
            reject(error);
          }
        }, 20);
      });
      try {
        await Promise.race([promise, timeout, memoryGuard]);
        this.assertMemoryCeiling();
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (memoryGuardHandle) clearInterval(memoryGuardHandle);
      }

      const output = this.truncate(this.outputBuffer.join('\n'), truncationLimit);
      const variablesChanged = this.diffVars(before);
      return { output, error: null, finalAnswer: null, variablesChanged };
    } catch (err) {
      if (err instanceof FinalAnswerSignal) {
        const output = this.truncate(this.outputBuffer.join('\n'), truncationLimit);
        const variablesChanged = this.diffVars(before);
        return { output, error: null, finalAnswer: err.answer, variablesChanged };
      }

      const errorMsg = toErrorMessage(err);
      const output = this.truncate(this.outputBuffer.join('\n'), truncationLimit);
      const variablesChanged = this.diffVars(before);
      return { output, error: errorMsg, finalAnswer: null, variablesChanged };
    }
  }

  private diffVars(before: Map<string, unknown>): string[] {
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
    const locals: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(this.context)) {
      if (!this.builtinKeysSet.has(key)) {
        locals[key] = this.context[key];
      }
    }
    return locals;
  }

  private truncate(text: string, limit: number): string {
    if (text.length <= limit) return text;
    return text.slice(0, limit) + `\n... [truncated, ${text.length - limit} chars omitted]`;
  }
}
