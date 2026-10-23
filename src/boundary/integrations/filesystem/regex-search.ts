import { Worker } from 'node:worker_threads';
import type { FilesystemSearchMatch } from './ops.js';

export const SEARCH_TIME_BUDGET_MS = 2_000;
export const MAX_SEARCH_LINE_CHARS = 8_192;
export const MAX_PREVIEW_CHARS = 500;
const MAX_SEARCH_WORKERS = 4;
const SEARCH_WORKER_HEAP_MB = 16;
const SEARCH_WORKER_STACK_MB = 4;

export class SearchBudgetExceededError extends Error {
  constructor() {
    super('fs search budget exceeded: pattern took too long to evaluate and was aborted');
    this.name = 'SearchBudgetExceededError';
  }
}

export class SearchAbortedError extends Error {
  constructor() {
    super('fs search aborted');
    this.name = 'SearchAbortedError';
  }
}

class SearchRegexExecutionError extends Error {
  constructor(reason: 'invalid' | 'resources') {
    super(reason === 'invalid' ? 'fs search regex is invalid' : 'fs search regex resources unavailable');
    this.name = 'SearchRegexExecutionError';
  }
}

// Only trusted source is evaluated. Agent patterns and bounded file pages travel
// as structured messages; compilation and every native RegExp.exec stay here.
const SEARCH_REGEX_WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require('node:worker_threads');
  let regex;
  parentPort.on('message', request => {
    try {
      if (request.query !== undefined) {
        try { regex = new RegExp(request.query, 'g'); }
        catch { parentPort.postMessage({ error: 'invalid' }); return; }
        parentPort.postMessage({ matches: [] });
        return;
      }
      const lines = request.content.split('\n');
      const matches = [];
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex].slice(0, workerData.lineChars);
        regex.lastIndex = 0;
        let match = regex.exec(line);
        while (match) {
          const start = Math.max(0, lineIndex - request.contextLines);
          const end = Math.min(lines.length - 1, lineIndex + request.contextLines);
          const preview = lines.slice(start, end + 1).join('\n');
          matches.push({
            path: request.path,
            line: lineIndex + 1,
            column: match.index + 1,
            preview: preview.length <= workerData.previewChars ? preview
              : preview.slice(0, workerData.previewChars) + '\n... (truncated)',
          });
          if (matches.length >= request.remainingMatches) {
            parentPort.postMessage({ matches });
            return;
          }
          if (match[0].length === 0) regex.lastIndex += 1;
          match = regex.exec(line);
        }
      }
      parentPort.postMessage({ matches });
    } catch {
      parentPort.postMessage({ error: 'resources' });
    }
  });
`;

const activeSearches = new Set<RegexSearch>();

/** One search, one bounded worker, no queue and no overlapping page transfers. */
export class RegexSearch {
  private readonly worker: Worker;
  private readonly timer: ReturnType<typeof setTimeout>;
  private pending: {
    resolve: (matches: FilesystemSearchMatch[]) => void;
    reject: (error: Error) => void;
  } | undefined;
  private failure: Error | undefined;
  private closing: Promise<void> | undefined;
  private readonly abort = (): void => { void this.close(new SearchAbortedError()); };

  constructor(readonly signal?: AbortSignal) {
    if (signal?.aborted) throw new SearchAbortedError();
    if (activeSearches.size >= MAX_SEARCH_WORKERS) throw new SearchRegexExecutionError('resources');
    try {
      this.worker = new Worker(SEARCH_REGEX_WORKER_SOURCE, {
        eval: true,
        execArgv: [],
        workerData: { lineChars: MAX_SEARCH_LINE_CHARS, previewChars: MAX_PREVIEW_CHARS },
        resourceLimits: {
          maxOldGenerationSizeMb: SEARCH_WORKER_HEAP_MB,
          maxYoungGenerationSizeMb: SEARCH_WORKER_HEAP_MB,
          stackSizeMb: SEARCH_WORKER_STACK_MB,
        },
      });
    } catch {
      throw new SearchRegexExecutionError('resources');
    }
    activeSearches.add(this);
    this.timer = setTimeout(() => { void this.close(new SearchBudgetExceededError()); }, SEARCH_TIME_BUDGET_MS);
    this.signal?.addEventListener('abort', this.abort, { once: true });
    this.worker.on('message', (reply: { matches?: FilesystemSearchMatch[]; error?: string }) => {
      if (this.closing) return;
      if (reply.error || !Array.isArray(reply.matches)) {
        void this.close(new SearchRegexExecutionError(reply.error === 'invalid' ? 'invalid' : 'resources'));
        return;
      }
      const pending = this.pending;
      this.pending = undefined;
      pending?.resolve(reply.matches);
    });
    this.worker.on('error', () => { void this.close(new SearchRegexExecutionError('resources')); });
    this.worker.on('exit', () => {
      if (!this.closing) void this.close(new SearchRegexExecutionError('resources'));
    });
  }

  private request(message: object): Promise<FilesystemSearchMatch[]> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closing || this.pending) return Promise.reject(new SearchRegexExecutionError('resources'));
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      try { this.worker.postMessage(message); }
      catch { void this.close(new SearchRegexExecutionError('resources')); }
    });
  }

  async compile(query: string): Promise<void> {
    await this.request({ query });
  }

  match(path: string, content: string, contextLines: number, remainingMatches: number): Promise<FilesystemSearchMatch[]> {
    return this.request({ path, content, contextLines, remainingMatches });
  }

  close(error?: Error): Promise<void> {
    if (this.closing) return this.closing;
    this.failure = error;
    clearTimeout(this.timer);
    this.signal?.removeEventListener('abort', this.abort);
    // Keep the admission slot until termination completes. Reject only after
    // joining, so a settled search cannot leave a busy evaluator behind.
    this.closing = this.worker.terminate().then(() => {
      activeSearches.delete(this);
      const pending = this.pending;
      this.pending = undefined;
      pending?.reject(error ?? new SearchAbortedError());
    });
    return this.closing;
  }
}
