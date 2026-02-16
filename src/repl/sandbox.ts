// ── RLM Sandbox ──
// node:vm-based code execution with injected context functions.
// The real security boundary is Docker --network=none; vm is convenience isolation.

import vm from 'node:vm';
import type { LLMProvider, EmbeddingService } from '../agent-loop.js';
import type { MemoryStore } from '../memory/store.js';
import type { SessionManager } from '../session/manager.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import type { TaskState, TaskType } from '../scheduler/types.js';
import type { EventBus, EventName } from '../event-bus.js';
import { MemoryWriter } from '../memory/writer.js';
import type { MemoryType } from '../memory/types.js';
import { VALID_MEMORY_TYPES } from '../memory/types.js';
import type { ThinkEvidence } from './types.js';
import * as helpers from './helpers.js';

interface ScheduleView {
  id: string;
  name: string;
  type: TaskType;
  intervalMs: number;
  runAt?: number;
  state: TaskState;
}

interface ScheduleMutationResult {
  ok: boolean;
  id?: string;
  error?: string;
}

const REPL_EVENT_ALLOWLIST: ReadonlySet<EventName> = new Set([
  'schedule.tick',
  'schedule.task.run',
  'schedule.heartbeat',
]);

const VALID_TASK_STATES: ReadonlySet<TaskState> = new Set([
  'idle',
  'active',
  'paused',
  'complete',
]);

function nextReplTaskId(): string {
  return `repl:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseRunAt(value: number | string | Date): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (value instanceof Date) {
    const ts = value.getTime();
    return Number.isNaN(ts) ? null : ts;
  }
  return null;
}

export class FinalAnswerSignal {
  readonly answer: string;
  constructor(answer: string) {
    this.answer = answer;
  }
}

export interface SandboxDeps {
  llmProvider: LLMProvider;
  embeddingService: EmbeddingService | null;
  memoryStore: MemoryStore | null;
  sessionManager: SessionManager | null;
  scheduler?: Scheduler | null;
  eventBus?: EventBus | null;
}

export interface SandboxBudgetRef {
  subQueries: number;
  maxSubQueries: number;
}

export interface ExecuteResult {
  output: string;
  error: string | null;
  finalAnswer: string | null;
  variablesChanged: string[];
}

export class REPLSandbox {
  private context: vm.Context;
  private outputBuffer: string[] = [];
  private deps: SandboxDeps;
  private budgetRef: SandboxBudgetRef | undefined;
  private builtinKeysSet: Set<string>;
  private currentEvidence: ThinkEvidence[] = [];

  constructor(deps: SandboxDeps, budgetRef?: SandboxBudgetRef) {
    this.deps = deps;
    this.budgetRef = budgetRef;

    const print = (...args: unknown[]) => {
      this.outputBuffer.push(args.map(a => {
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a, null, 2); }
        catch { return String(a); }
      }).join(' '));
    };

    const FINAL = (answer: string) => {
      throw new FinalAnswerSignal(String(answer));
    };

    const BUDGET_EXCEEDED_MESSAGE = '[Budget exceeded: max sub-queries reached]';

    const runSubQuery = async (prompt: string, evidenceQuery: string, attempt?: number): Promise<string> => {
      if (this.budgetRef && this.budgetRef.subQueries >= this.budgetRef.maxSubQueries) {
        return BUDGET_EXCEEDED_MESSAGE;
      }
      if (this.budgetRef) this.budgetRef.subQueries++;
      const response = await this.deps.llmProvider.complete(
        { systemPrompt: 'You are a helpful assistant. Answer concisely.', messages: [{ role: 'user', content: prompt }] },
        'extraction',
      );
      this.currentEvidence.push({
        source: 'llm_query',
        query: evidenceQuery.slice(0, 100),
        snippet: response.content.slice(0, 200),
        attempt,
        timestamp: Date.now(),
      });
      return response.content;
    };

    const llm_query = async (prompt: string): Promise<string> => {
      return runSubQuery(prompt, prompt);
    };

    const llm_query_strict = async (
      prompt: string,
      validatePattern?: string,
      maxRetries?: number,
    ): Promise<string> => {
      const retries = typeof maxRetries === 'number' && Number.isFinite(maxRetries)
        ? Math.max(1, Math.floor(maxRetries))
        : 3;
      let lastResult = '';

      for (let attempt = 0; attempt < retries; attempt++) {
        const effectivePrompt = attempt === 0
          ? prompt
          : `${prompt}\n\nYour previous response was invalid (attempt ${attempt}/${retries}). ` +
            `Output must match pattern: ${validatePattern}\n` +
            `Previous output: ${lastResult.slice(0, 200)}`;

        const result = await runSubQuery(effectivePrompt, prompt, attempt + 1);
        if (result === BUDGET_EXCEEDED_MESSAGE) return result;
        lastResult = result;

        if (!validatePattern) return lastResult;

        try {
          if (new RegExp(validatePattern).test(lastResult)) return lastResult;
        } catch {
          return lastResult;
        }
      }

      return lastResult;
    };

    const llm_query_json = async (prompt: string, maxRetries?: number): Promise<unknown> => {
      const result = await llm_query_strict(
        `${prompt}\n\nRespond with valid JSON only, no markdown.`,
        '^\\s*[\\{\\[]',
        maxRetries,
      );
      try {
        return JSON.parse(result);
      } catch {
        return null;
      }
    };

    const memory_search = async (query: string, limit = 10): Promise<Array<{ text: string; type: string; importance: number; similarity: number }>> => {
      if (!this.deps.embeddingService || !this.deps.memoryStore) return [];
      const embedding = await this.deps.embeddingService.embed(query);
      const results = this.deps.memoryStore.searchByEmbedding(embedding, 0.3, limit);
      this.currentEvidence.push({
        source: 'memory_search',
        query,
        snippet: results[0]?.text.slice(0, 200) ?? '',
        resultCount: results.length,
        timestamp: Date.now(),
      });
      return results.map(m => ({
        text: m.text,
        type: m.type,
        importance: m.importance,
        similarity: m.similarity,
      }));
    };

    const memory_count = (): number => {
      if (!this.deps.memoryStore) return 0;
      return this.deps.memoryStore.getAllActiveMemories().length;
    };

    const session_messages = (channelId: string, limit = 20): Array<{ role: string; content: string; timestamp: number }> => {
      if (!this.deps.sessionManager) return [];
      const entries = this.deps.sessionManager.getRecentMessages(channelId, limit);
      this.currentEvidence.push({
        source: 'session_messages',
        query: channelId,
        snippet: entries.length > 0 ? entries[0].content.slice(0, 200) : '',
        resultCount: entries.length,
        timestamp: Date.now(),
      });
      return entries.map(e => ({
        role: e.role,
        content: e.content,
        timestamp: e.timestamp,
      }));
    };

    // Create MemoryWriter if both deps are available
    const writer = (this.deps.embeddingService && this.deps.memoryStore)
      ? new MemoryWriter(this.deps.memoryStore, this.deps.embeddingService)
      : null;

    const memory_write = async (
      text: string,
      type: string,
      importance?: number,
      emotionalValence?: number,
      tags?: string,
    ): Promise<{ action: string; id: string }> => {
      if (!writer) return { action: 'error', id: 'no memory system' };
      if (!VALID_MEMORY_TYPES.includes(type as MemoryType)) {
        return { action: 'error', id: `invalid type: ${type}` };
      }
      const result = await writer.write({
        text,
        type: type as MemoryType,
        importance,
        emotionalValence,
        tags: tags ? tags.split(',').map(t => t.trim().toLowerCase()).filter(Boolean) : undefined,
        sourceRef: 'repl:memory_write',
      });
      return { action: result.action, id: result.memory.id };
    };

    const memory_import_batch = async (
      records: Array<{ text: string; type: string; importance?: number; emotional_valence?: number; tags?: string }>,
    ): Promise<{ written: number; deduplicated: number; errors: number }> => {
      if (!writer) return { written: 0, deduplicated: 0, errors: 0 };
      const opts = records.map(r => ({
        text: r.text,
        type: r.type as MemoryType,
        importance: r.importance,
        emotionalValence: r.emotional_valence,
        tags: r.tags ? r.tags.split(',').map((t: string) => t.trim().toLowerCase()).filter(Boolean) : undefined,
        sourceRef: 'repl:memory_import',
      }));
      const result = await writer.importBatch(opts);
      return { written: result.written, deduplicated: result.deduplicated, errors: result.errors };
    };

    const memory_upsert = async (
      text: string,
      type: string,
      importance?: number,
      emotionalValence?: number,
      tags?: string,
    ): Promise<{ action: string; id: string; superseded: boolean }> => {
      if (!writer) return { action: 'error', id: 'no memory system', superseded: false };
      if (!VALID_MEMORY_TYPES.includes(type as MemoryType)) {
        return { action: 'error', id: `invalid type: ${type}`, superseded: false };
      }
      const result = await writer.upsert({
        text,
        type: type as MemoryType,
        importance,
        emotionalValence,
        tags: tags ? tags.split(',').map(t => t.trim().toLowerCase()).filter(Boolean) : undefined,
        sourceRef: 'repl:memory_upsert',
      });
      return { action: result.action, id: result.memory.id, superseded: result.action === 'superseded' };
    };

    const session_append_note = (channelId: string, note: string): boolean => {
      if (!this.deps.sessionManager) return false;
      this.deps.sessionManager.appendSystemNote(channelId, note);
      return true;
    };

    const memory_get_by_id = (id: string): Record<string, unknown> | null => {
      if (!this.deps.memoryStore) return null;
      const mem = this.deps.memoryStore.getById(id);
      if (!mem) return null;
      this.currentEvidence.push({
        source: 'memory_get_by_id',
        query: id,
        snippet: mem.text.slice(0, 200),
        resultCount: 1,
        timestamp: Date.now(),
      });
      return {
        id: mem.id,
        text: mem.text,
        type: mem.type,
        importance: mem.importance,
        confidence: mem.confidence,
        emotionalValence: mem.emotionalValence,
        salience: mem.salience,
        sourceRef: mem.sourceRef,
        tags: mem.tags,
      };
    };

    const schedule_list = (): ScheduleView[] => {
      if (!this.deps.scheduler) return [];
      return this.deps.scheduler.listTasks().map(task => ({
        id: task.id,
        name: task.name,
        type: task.type,
        intervalMs: task.intervalMs,
        runAt: task.runAt,
        state: task.state,
      }));
    };

    const schedule_add_every = (
      name: string,
      intervalMs: number,
      handler: unknown,
    ): ScheduleMutationResult => {
      if (!this.deps.scheduler) return { ok: false, error: 'no scheduler' };
      const taskName = typeof name === 'string' ? name.trim() : '';
      if (!taskName) return { ok: false, error: 'name is required' };
      if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
        return { ok: false, error: 'intervalMs must be > 0' };
      }
      if (typeof handler !== 'function') {
        return { ok: false, error: 'handler must be a function' };
      }

      const id = nextReplTaskId();
      this.deps.scheduler.register({
        id,
        name: taskName,
        type: 'every',
        intervalMs,
        handler: async () => {
          await Promise.resolve((handler as () => unknown).call(this.context));
        },
        state: 'idle',
      });
      return { ok: true, id };
    };

    const schedule_add_once = (
      name: string,
      at: number | string | Date,
      handler: unknown,
    ): ScheduleMutationResult => {
      if (!this.deps.scheduler) return { ok: false, error: 'no scheduler' };
      const taskName = typeof name === 'string' ? name.trim() : '';
      if (!taskName) return { ok: false, error: 'name is required' };
      if (typeof handler !== 'function') {
        return { ok: false, error: 'handler must be a function' };
      }
      const runAt = parseRunAt(at);
      if (runAt === null) return { ok: false, error: 'invalid runAt time' };

      const id = nextReplTaskId();
      this.deps.scheduler.register({
        id,
        name: taskName,
        type: 'one-shot',
        intervalMs: 0,
        runAt,
        handler: async () => {
          await Promise.resolve((handler as () => unknown).call(this.context));
        },
        state: 'idle',
      });
      return { ok: true, id };
    };

    const schedule_update = (
      id: string,
      updates: {
        intervalMs?: number;
        state?: string;
        name?: string;
        runAt?: number | string | Date;
      },
    ): ScheduleMutationResult => {
      if (!this.deps.scheduler) return { ok: false, error: 'no scheduler' };
      const taskId = typeof id === 'string' ? id.trim() : '';
      if (!taskId) return { ok: false, error: 'task id is required' };
      if (!updates || typeof updates !== 'object') {
        return { ok: false, error: 'updates object is required' };
      }

      const next: { intervalMs?: number; state?: TaskState; name?: string; runAt?: number } = {};

      if (updates.intervalMs !== undefined) {
        if (!Number.isFinite(updates.intervalMs) || updates.intervalMs <= 0) {
          return { ok: false, error: 'intervalMs must be > 0' };
        }
        next.intervalMs = updates.intervalMs;
      }

      if (updates.state !== undefined) {
        if (typeof updates.state !== 'string' || !VALID_TASK_STATES.has(updates.state as TaskState)) {
          return { ok: false, error: `invalid state: ${updates.state}` };
        }
        next.state = updates.state as TaskState;
      }

      if (updates.name !== undefined) {
        if (typeof updates.name !== 'string') return { ok: false, error: 'name must be a string' };
        const taskName = updates.name.trim();
        if (!taskName) return { ok: false, error: 'name must be non-empty' };
        next.name = taskName;
      }

      if (updates.runAt !== undefined) {
        const runAt = parseRunAt(updates.runAt);
        if (runAt === null) return { ok: false, error: 'invalid runAt time' };
        next.runAt = runAt;
      }

      if (Object.keys(next).length === 0) {
        return { ok: false, error: 'no updates provided' };
      }

      const updated = this.deps.scheduler.updateTask(taskId, next);
      return updated ? { ok: true } : { ok: false, error: `task "${taskId}" not found` };
    };

    const event_emit = async (eventName: string, data: unknown): Promise<ScheduleMutationResult> => {
      if (!this.deps.eventBus) return { ok: false, error: 'no event bus' };
      const normalized = typeof eventName === 'string' ? eventName.trim() : '';
      if (!normalized) return { ok: false, error: 'eventName is required' };
      if (!REPL_EVENT_ALLOWLIST.has(normalized as EventName)) {
        return { ok: false, error: `event "${normalized}" is not allowlisted` };
      }
      await this.deps.eventBus.emit(normalized as EventName, data as never);
      return { ok: true };
    };

    this.context = vm.createContext({
      // Injected functions
      print,
      console: { log: print, warn: print, error: print },
      FINAL,
      llm_query,
      llm_query_strict,
      llm_query_json,
      memory_search,
      memory_count,
      memory_write,
      memory_upsert,
      memory_import_batch,
      memory_get_by_id,
      session_messages,
      session_append_note,
      schedule_list,
      schedule_add_every,
      schedule_add_once,
      schedule_update,
      event_emit,

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
    });

    // Make globalThis point to the context itself so var assignments persist
    this.context.globalThis = this.context;

    // Initialize builtin keys set for variable tracking and getLocals
    this.builtinKeysSet = new Set([
      'print', 'console', 'FINAL', 'llm_query', 'llm_query_strict', 'llm_query_json', 'memory_search',
      'memory_count', 'memory_write', 'memory_upsert', 'memory_import_batch',
      'memory_get_by_id', 'session_messages', 'session_append_note',
      'schedule_list', 'schedule_add_every', 'schedule_add_once', 'schedule_update', 'event_emit',
      'search', 'grep', 'grep_v', 'between', 'head', 'tail',
      'word_frequency', 'diff', 'text_similarity', 'dedupe', 'group_by', 'partition',
      'JSON', 'Math', 'Date',
      'Array', 'Object', 'String', 'Number', 'Boolean', 'Map', 'Set',
      'RegExp', 'Promise', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
      'undefined', 'null', 'true', 'false', 'Infinity', 'NaN', 'setTimeout',
      'globalThis',
    ]);
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
      const script = new vm.Script(wrapped, { filename: 'repl' });
      const promise = script.runInContext(this.context, { timeout: timeoutMs });
      await promise;

      const output = this.truncate(this.outputBuffer.join('\n'), truncationLimit);
      const variablesChanged = this.diffVars(before);
      return { output, error: null, finalAnswer: null, variablesChanged };
    } catch (err) {
      if (err instanceof FinalAnswerSignal) {
        const output = this.truncate(this.outputBuffer.join('\n'), truncationLimit);
        const variablesChanged = this.diffVars(before);
        return { output, error: null, finalAnswer: err.answer, variablesChanged };
      }

      const errorMsg = err instanceof Error ? err.message : String(err);
      const output = this.truncate(this.outputBuffer.join('\n'), truncationLimit);
      const variablesChanged = this.diffVars(before);
      return { output, error: errorMsg, finalAnswer: null, variablesChanged };
    }
  }

  private diffVars(before: Map<string, unknown>): string[] {
    const changed: string[] = [];
    const after = this.snapshotUserVars();
    // Check for new or modified vars
    for (const [key, val] of after) {
      if (!before.has(key) || before.get(key) !== val) {
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
