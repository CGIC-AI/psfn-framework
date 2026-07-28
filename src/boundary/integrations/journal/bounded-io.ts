import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  copyFile,
  open,
  opendir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, extname, join, relative } from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { readUtf8TextFilePage } from '../filesystem/text-file-paging.js';

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);
const MAX_SEARCH_SNIPPET_CHARS = 180;

/**
 * Code-owned safety contract for the local Markdown journal.
 *
 * Reads always page. Search is deliberately all-or-error: the complete
 * candidate corpus is statted against these bounds before any note content is
 * materialized, so a refusal can never look like a valid empty/partial result.
 */
export const JOURNAL_IO_CONTRACT = Object.freeze({
  readPageBytes: 12_000,
  listMaxFiles: 200,
  searchMaxFiles: 200,
  searchMaxFileBytes: 200_000,
  searchMaxCorpusBytes: 2_000_000,
  searchMaxScannedEntries: 5_000,
  cooperativeYieldEntries: 64,
});

export interface JournalPage {
  content: string;
  offsetBytes: number;
  nextOffsetBytes: number | null;
  eof: boolean;
  truncated: boolean;
}

export interface BoundedJournalSearchResult {
  results: Array<{ path: string; snippet: string }>;
  complete: true;
  resultLimitReached: boolean;
  scannedFiles: number;
  scannedBytes: number;
}

interface SearchCandidate {
  absolutePath: string;
  relativePath: string;
  size: number;
}

interface JournalScanState {
  operation: 'list' | 'search';
  scannedEntries: number;
}

export async function readJournalPage(
  absolutePath: string,
  offsetBytes: number,
): Promise<JournalPage> {
  return readUtf8TextFilePage(
    absolutePath,
    JOURNAL_IO_CONTRACT.readPageBytes,
    offsetBytes,
  );
}

export async function appendJournalNoteAtomically(
  absolutePath: string,
  content: string,
): Promise<boolean> {
  const created = !(await pathExists(absolutePath));
  const parent = dirname(absolutePath);
  const temporaryPath = join(
    parent,
    `.${basename(absolutePath)}.journal-append-${process.pid}-${randomUUID()}.tmp`,
  );

  // Make timer/admin work observable even when the source is already hot in
  // the kernel page cache. The expensive copy remains outside the JS heap.
  await yieldToEventLoop();
  try {
    if (created) {
      await writeFile(temporaryPath, '', {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o666,
      });
    } else {
      await copyFile(absolutePath, temporaryPath, constants.COPYFILE_EXCL);
    }

    const handle = await open(temporaryPath, 'a+');
    try {
      const temporaryStats = await handle.stat();
      let separator = '';
      if (temporaryStats.size > 0) {
        const lastByte = Buffer.alloc(1);
        const { bytesRead } = await handle.read(
          lastByte,
          0,
          1,
          temporaryStats.size - 1,
        );
        if (bytesRead !== 1) {
          throw new Error('Journal append could not inspect the existing note boundary');
        }
        separator = lastByte[0] === 0x0a ? '' : '\n';
      }
      await writeBufferCompletely(handle, Buffer.from(`${separator}${content}\n`, 'utf8'));
      await handle.sync();
    } finally {
      await handle.close();
    }

    // The old note stays visible until this single namespace operation. A
    // failure before rename leaves it byte-for-byte untouched.
    await rename(temporaryPath, absolutePath);
    return created;
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function searchBoundedJournal(
  root: string,
  normalizedQuery: string,
  limit: number,
): Promise<BoundedJournalSearchResult> {
  const candidates = await collectBoundedSearchCandidates(root);
  const results: Array<{ path: string; snippet: string }> = [];
  let resultLimitReached = false;
  let scannedBytes = 0;

  for (const candidate of candidates) {
    await yieldToEventLoop();
    const page = await readUtf8TextFilePage(
      candidate.absolutePath,
      Math.max(1, candidate.size),
      0,
    );
    if (!page.eof) {
      throw new Error(
        `Journal note changed while search was reading "${candidate.relativePath}"; retry the search`,
      );
    }
    scannedBytes += Buffer.byteLength(page.content, 'utf8');
    const matchIndex = page.content.toLowerCase().indexOf(normalizedQuery);
    if (matchIndex < 0) continue;
    if (results.length >= limit) {
      resultLimitReached = true;
      continue;
    }
    results.push({
      path: candidate.relativePath,
      snippet: buildSnippet(page.content, matchIndex),
    });
  }

  return {
    results,
    complete: true,
    resultLimitReached,
    scannedFiles: candidates.length,
    scannedBytes,
  };
}

export async function listBoundedJournalPaths(root: string): Promise<string[]> {
  const state: JournalScanState = { operation: 'list', scannedEntries: 0 };
  const paths: string[] = [];
  for await (const candidate of walkMarkdownFiles(root, root, state)) {
    if (paths.length >= JOURNAL_IO_CONTRACT.listMaxFiles) {
      throw new Error(
        `Journal list bound exceeded: the journal contains more than `
        + `${String(JOURNAL_IO_CONTRACT.listMaxFiles)} Markdown files. `
        + 'Search for a specific term, read a known note, or archive/narrow the journal root.',
      );
    }
    paths.push(candidate.relativePath);
  }
  return paths.sort((left, right) => left.localeCompare(right));
}

async function collectBoundedSearchCandidates(root: string): Promise<SearchCandidate[]> {
  const state: JournalScanState = { operation: 'search', scannedEntries: 0 };
  const candidates: SearchCandidate[] = [];
  let corpusBytes = 0;

  for await (const candidate of walkMarkdownFiles(root, root, state)) {
    if (candidate.size > JOURNAL_IO_CONTRACT.searchMaxFileBytes) {
      throw searchBoundError(
        `note "${candidate.relativePath}" is ${String(candidate.size)} bytes; `
        + `the per-note maximum is ${String(JOURNAL_IO_CONTRACT.searchMaxFileBytes)} bytes`,
      );
    }
    if (candidates.length >= JOURNAL_IO_CONTRACT.searchMaxFiles) {
      throw searchBoundError(
        `the corpus contains more than ${String(JOURNAL_IO_CONTRACT.searchMaxFiles)} Markdown files`,
      );
    }
    if (corpusBytes + candidate.size > JOURNAL_IO_CONTRACT.searchMaxCorpusBytes) {
      throw searchBoundError(
        `the corpus exceeds ${String(JOURNAL_IO_CONTRACT.searchMaxCorpusBytes)} bytes`,
      );
    }
    candidates.push(candidate);
    corpusBytes += candidate.size;
  }

  return candidates.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function* walkMarkdownFiles(
  root: string,
  directoryPath: string,
  state: JournalScanState,
): AsyncGenerator<SearchCandidate> {
  const directory = await opendir(directoryPath);
  for await (const entry of directory) {
    state.scannedEntries += 1;
    if (state.scannedEntries > JOURNAL_IO_CONTRACT.searchMaxScannedEntries) {
      const detail = `the journal tree exceeds `
        + `${String(JOURNAL_IO_CONTRACT.searchMaxScannedEntries)} filesystem entries`;
      if (state.operation === 'search') {
        throw searchBoundError(detail);
      }
      throw new Error(
        `Journal list bound exceeded: ${detail}. `
        + 'Search for a specific term, read a known note, or archive/narrow the journal root.',
      );
    }
    if (state.scannedEntries % JOURNAL_IO_CONTRACT.cooperativeYieldEntries === 0) {
      await yieldToEventLoop();
    }
    if (entry.name.startsWith('.')) continue;

    const absolutePath = join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      yield* walkMarkdownFiles(root, absolutePath, state);
      continue;
    }
    if (!entry.isFile() || !MARKDOWN_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      continue;
    }
    const fileStats = await stat(absolutePath);
    if (!fileStats.isFile()) continue;
    yield {
      absolutePath,
      relativePath: relative(root, absolutePath).replace(/\\/g, '/'),
      size: fileStats.size,
    };
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function writeBufferCompletely(
  handle: Awaited<ReturnType<typeof open>>,
  buffer: Buffer,
): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(
      buffer,
      offset,
      buffer.length - offset,
      null,
    );
    if (bytesWritten <= 0) {
      throw new Error('Journal append made no write progress');
    }
    offset += bytesWritten;
  }
}

function searchBoundError(detail: string): Error {
  return new Error(
    `Journal search bound exceeded: ${detail}. `
    + 'Read a known note with journal read paging, or archive/narrow the journal root before retrying.',
  );
}

function buildSnippet(content: string, matchIndex: number): string {
  const start = Math.max(0, matchIndex - Math.floor(MAX_SEARCH_SNIPPET_CHARS / 2));
  const end = Math.min(content.length, start + MAX_SEARCH_SNIPPET_CHARS);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < content.length ? '...' : '';
  return `${prefix}${content.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`;
}
