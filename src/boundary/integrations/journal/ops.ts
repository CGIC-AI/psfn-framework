import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, normalize, relative, resolve, sep } from 'node:path';
import {
  appendJournalNoteAtomically,
  listBoundedJournalPaths,
  readJournalPage,
  searchBoundedJournal,
} from './bounded-io.js';

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);

export { JOURNAL_IO_CONTRACT } from './bounded-io.js';

export interface JournalListResult {
  root: string;
  notes: string[];
}

export interface JournalReadResult {
  path: string;
  content: string;
  offsetBytes: number;
  nextOffsetBytes: number | null;
  eof: boolean;
  truncated: boolean;
}

export interface JournalReadOptions {
  offsetBytes?: number;
}

export interface JournalWriteResult {
  path: string;
  mode: 'write' | 'append';
  created: boolean;
}

export interface JournalSearchResult {
  query: string;
  results: Array<{ path: string; snippet: string }>;
  complete: true;
  resultLimitReached: boolean;
  scannedFiles: number;
  scannedBytes: number;
}

export interface JournalOperations {
  list(): Promise<JournalListResult>;
  read(path: string, options?: JournalReadOptions): Promise<JournalReadResult>;
  write(path: string, content: string): Promise<JournalWriteResult>;
  append(path: string, content: string): Promise<JournalWriteResult>;
  search(query: string, limit?: number): Promise<JournalSearchResult>;
}

export class JournalOps implements JournalOperations {
  private readonly root: string;
  private readonly mutationTails = new Map<string, Promise<void>>();

  constructor(root: string) {
    const normalizedRoot = root.trim();
    if (!normalizedRoot) {
      throw new Error('JournalOps requires a journal root');
    }
    this.root = resolve(normalizedRoot);
  }

  async list(): Promise<JournalListResult> {
    await this.ensureRoot();
    return {
      root: this.root,
      notes: await this.listMarkdownNotes(),
    };
  }

  async read(path: string, options: JournalReadOptions = {}): Promise<JournalReadResult> {
    const resolved = this.resolveNotePath(path);
    const page = await readJournalPage(
      resolved.absolutePath,
      options.offsetBytes ?? 0,
    );
    return { path: resolved.relativePath, ...page };
  }

  async write(path: string, content: string): Promise<JournalWriteResult> {
    const resolved = this.resolveNotePath(path);
    const normalizedContent = requireContent(content);
    await mkdir(dirname(resolved.absolutePath), { recursive: true });
    return this.withMutationLock(resolved.absolutePath, async () => {
      const created = !existsSync(resolved.absolutePath);
      await writeFile(
        resolved.absolutePath,
        normalizedContent.endsWith('\n') ? normalizedContent : `${normalizedContent}\n`,
        'utf8',
      );
      return { path: resolved.relativePath, mode: 'write' as const, created };
    });
  }

  async append(path: string, content: string): Promise<JournalWriteResult> {
    const resolved = this.resolveNotePath(path);
    const normalizedContent = requireContent(content);
    await mkdir(dirname(resolved.absolutePath), { recursive: true });
    return this.withMutationLock(resolved.absolutePath, async () => {
      const created = await appendJournalNoteAtomically(
        resolved.absolutePath,
        normalizedContent,
      );
      return { path: resolved.relativePath, mode: 'append' as const, created };
    });
  }

  async search(query: string, limit = 20): Promise<JournalSearchResult> {
    const normalizedQuery = normalizeRequiredText(query, 'query').toLowerCase();
    const normalizedLimit = Math.max(1, Math.min(100, Math.floor(Number.isFinite(limit) ? limit : 20)));
    await this.ensureRoot();
    const result = await searchBoundedJournal(this.root, normalizedQuery, normalizedLimit);

    return {
      query: normalizedQuery,
      ...result,
    };
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  private resolveNotePath(input: string): { absolutePath: string; relativePath: string } {
    const normalizedInput = normalizeRequiredText(input, 'path').replace(/\\/g, '/');
    if (normalizedInput.startsWith('/') || normalizedInput.includes('\0')) {
      throw new Error('Journal path must be relative to the journal root');
    }
    const withExtension = MARKDOWN_EXTENSIONS.has(extname(normalizedInput).toLowerCase())
      ? normalizedInput
      : `${normalizedInput}.md`;
    const absolutePath = resolve(this.root, normalize(withExtension));
    const relativePath = relative(this.root, absolutePath);
    if (
      !relativePath
      || relativePath.startsWith('..')
      || relativePath.includes(`..${sep}`)
    ) {
      throw new Error('Journal path must stay inside the journal root');
    }
    if (!MARKDOWN_EXTENSIONS.has(extname(relativePath).toLowerCase())) {
      throw new Error('Journal notes must be markdown files');
    }
    return {
      absolutePath,
      relativePath: relativePath.replace(/\\/g, '/'),
    };
  }

  private async listMarkdownNotes(): Promise<string[]> {
    await this.ensureRoot();
    return listBoundedJournalPaths(this.root);
  }

  private async withMutationLock<T>(
    absolutePath: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.mutationTails.get(absolutePath) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const tail = previous.then(() => current);
    this.mutationTails.set(absolutePath, tail);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.mutationTails.get(absolutePath) === tail) {
        this.mutationTails.delete(absolutePath);
      }
    }
  }
}

function normalizeRequiredText(value: string, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Journal ${field} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Journal ${field} is required`);
  }
  return normalized;
}

function requireContent(content: string): string {
  if (typeof content !== 'string') {
    throw new Error('Journal content must be a string');
  }
  const normalized = content.trim();
  if (!normalized) {
    throw new Error('Journal content is required');
  }
  return normalized;
}
