import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';

const MAX_SEARCH_SNIPPET_CHARS = 180;
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);

export interface JournalListResult {
  root: string;
  notes: string[];
}

export interface JournalReadResult {
  path: string;
  content: string;
}

export interface JournalWriteResult {
  path: string;
  mode: 'write' | 'append';
  created: boolean;
}

export interface JournalSearchResult {
  query: string;
  results: Array<{ path: string; snippet: string }>;
}

export interface JournalOperations {
  list(): Promise<JournalListResult>;
  read(path: string): Promise<JournalReadResult>;
  write(path: string, content: string): Promise<JournalWriteResult>;
  append(path: string, content: string): Promise<JournalWriteResult>;
  search(query: string, limit?: number): Promise<JournalSearchResult>;
}

export class JournalOps implements JournalOperations {
  private readonly root: string;

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

  async read(path: string): Promise<JournalReadResult> {
    const resolved = this.resolveNotePath(path);
    const content = await readFile(resolved.absolutePath, 'utf8');
    return { path: resolved.relativePath, content };
  }

  async write(path: string, content: string): Promise<JournalWriteResult> {
    const resolved = this.resolveNotePath(path);
    const normalizedContent = requireContent(content);
    const created = !existsSync(resolved.absolutePath);
    await mkdir(dirname(resolved.absolutePath), { recursive: true });
    await writeFile(resolved.absolutePath, normalizedContent.endsWith('\n') ? normalizedContent : `${normalizedContent}\n`, 'utf8');
    return { path: resolved.relativePath, mode: 'write', created };
  }

  async append(path: string, content: string): Promise<JournalWriteResult> {
    const resolved = this.resolveNotePath(path);
    const normalizedContent = requireContent(content);
    const created = !existsSync(resolved.absolutePath);
    await mkdir(dirname(resolved.absolutePath), { recursive: true });
    const existing = created ? '' : await readFile(resolved.absolutePath, 'utf8');
    const separator = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
    await writeFile(resolved.absolutePath, `${existing}${separator}${normalizedContent}\n`, 'utf8');
    return { path: resolved.relativePath, mode: 'append', created };
  }

  async search(query: string, limit = 20): Promise<JournalSearchResult> {
    const normalizedQuery = normalizeRequiredText(query, 'query').toLowerCase();
    const normalizedLimit = Math.max(1, Math.min(100, Math.floor(Number.isFinite(limit) ? limit : 20)));
    const notes = await this.listMarkdownNotes();
    const results: Array<{ path: string; snippet: string }> = [];

    for (const notePath of notes) {
      if (results.length >= normalizedLimit) break;
      const content = await readFile(join(this.root, notePath), 'utf8');
      const matchIndex = content.toLowerCase().indexOf(normalizedQuery);
      if (matchIndex < 0) continue;
      results.push({
        path: notePath,
        snippet: buildSnippet(content, matchIndex),
      });
    }

    return {
      query: normalizedQuery,
      results,
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
    const notes: string[] = [];
    await collectMarkdownNotes(this.root, this.root, notes);
    return notes.sort((left, right) => left.localeCompare(right));
  }
}

async function collectMarkdownNotes(root: string, dir: string, notes: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const absolutePath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectMarkdownNotes(root, absolutePath, notes);
      continue;
    }
    if (!entry.isFile()) continue;
    const extension = extname(entry.name).toLowerCase();
    if (!MARKDOWN_EXTENSIONS.has(extension)) continue;
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile()) continue;
    notes.push(relative(root, absolutePath).replace(/\\/g, '/'));
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

function buildSnippet(content: string, matchIndex: number): string {
  const start = Math.max(0, matchIndex - Math.floor(MAX_SEARCH_SNIPPET_CHARS / 2));
  const end = Math.min(content.length, start + MAX_SEARCH_SNIPPET_CHARS);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < content.length ? '...' : '';
  return `${prefix}${content.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`;
}
