// ── RLM Sandbox ──
// node:vm-based code execution with injected context functions.
// The real security boundary is Docker --network=none; vm is convenience isolation.

import vm from 'node:vm';
import type { LLMProvider, EmbeddingService } from '../agent-loop.js';
import type { MemoryStore } from '../memory/store.js';
import type { SessionManager } from '../session/manager.js';
import { MemoryWriter } from '../memory/writer.js';
import type { MemoryType } from '../memory/types.js';
import { VALID_MEMORY_TYPES } from '../memory/types.js';
import * as helpers from './helpers.js';

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
}

export interface ExecuteResult {
  output: string;
  error: string | null;
  finalAnswer: string | null;
}

export class REPLSandbox {
  private context: vm.Context;
  private outputBuffer: string[] = [];
  private deps: SandboxDeps;

  constructor(deps: SandboxDeps) {
    this.deps = deps;

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

    const llm_query = async (prompt: string): Promise<string> => {
      const response = await this.deps.llmProvider.complete(
        { systemPrompt: 'You are a helpful assistant. Answer concisely.', messages: [{ role: 'user', content: prompt }] },
        'extraction',
      );
      return response.content;
    };

    const memory_search = async (query: string, limit = 10): Promise<Array<{ text: string; type: string; importance: number; similarity: number }>> => {
      if (!this.deps.embeddingService || !this.deps.memoryStore) return [];
      const embedding = await this.deps.embeddingService.embed(query);
      const results = this.deps.memoryStore.searchByEmbedding(embedding, 0.3, limit);
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

    this.context = vm.createContext({
      // Injected functions
      print,
      console: { log: print, warn: print, error: print },
      FINAL,
      llm_query,
      memory_search,
      memory_count,
      memory_write,
      memory_upsert,
      memory_import_batch,
      memory_get_by_id,
      session_messages,
      session_append_note,

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
  }

  async execute(code: string, timeoutMs: number, truncationLimit: number): Promise<ExecuteResult> {
    this.outputBuffer = [];

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
      return { output, error: null, finalAnswer: null };
    } catch (err) {
      if (err instanceof FinalAnswerSignal) {
        const output = this.truncate(this.outputBuffer.join('\n'), truncationLimit);
        return { output, error: null, finalAnswer: err.answer };
      }

      const errorMsg = err instanceof Error ? err.message : String(err);
      const output = this.truncate(this.outputBuffer.join('\n'), truncationLimit);
      return { output, error: errorMsg, finalAnswer: null };
    }
  }

  getLocals(): Record<string, unknown> {
    const builtinKeys = new Set([
      'print', 'console', 'FINAL', 'llm_query', 'memory_search',
      'memory_count', 'memory_write', 'memory_upsert', 'memory_import_batch',
      'memory_get_by_id', 'session_messages', 'session_append_note',
      'search', 'grep', 'grep_v', 'between', 'head', 'tail',
      'word_frequency', 'diff', 'text_similarity', 'dedupe', 'group_by', 'partition',
      'JSON', 'Math', 'Date',
      'Array', 'Object', 'String', 'Number', 'Boolean', 'Map', 'Set',
      'RegExp', 'Promise', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
      'undefined', 'null', 'true', 'false', 'Infinity', 'NaN', 'setTimeout',
      'globalThis',
    ]);

    const locals: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(this.context)) {
      if (!builtinKeys.has(key)) {
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
