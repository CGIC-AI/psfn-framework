import { randomUUID } from 'node:crypto';
import {
  open,
  opendir,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { basename, dirname, extname, join, relative } from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { readUtf8TextFilePage } from '../filesystem/text-file-paging.js';
import type { JournalMutationTarget } from './mutation-coordinator.js';

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);
const MAX_SEARCH_SNIPPET_CHARS = 180;

/**
 * Code-owned safety contract for the local Markdown journal.
 *
 * Reads always page. List and search report explicit completeness metadata
 * when their file bounds omit notes. Corpus-byte and tree-entry violations
 * still fail before any valid-looking partial search result is returned.
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
  complete: boolean;
  resultLimitReached: boolean;
  scannedFiles: number;
  scannedBytes: number;
  totalFiles: number;
  skippedOversizedFiles: string[];
}

export interface BoundedJournalListResult {
  paths: string[];
  truncated: boolean;
  totalFiles: number;
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
  target: JournalMutationTarget,
  content: string,
): Promise<boolean> {
  const parent = dirname(target.stablePath);
  const temporaryPath = join(
    parent,
    `.${basename(target.stablePath)}.journal-append-${process.pid}-${randomUUID()}.tmp`,
  );

  // Make timer/admin work observable even when the source is already hot in
  // the kernel page cache. The expensive copy remains outside the JS heap.
  await yieldToEventLoop();
  try {
    const handle = await open(temporaryPath, 'wx+', 0o666);
    try {
      await preserveExistingMetadata(target, handle);
      if (target.existingHandle) {
        await copyHandleCompletely(target.existingHandle, handle);
      }
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
    await target.assertNamespaceUnchanged();
    await rename(temporaryPath, target.stablePath);
    await target.assertParentAttached();
    return !target.existed;
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function writeJournalNoteAtomically(
  target: JournalMutationTarget,
  content: string,
): Promise<boolean> {
  const parent = dirname(target.stablePath);
  const temporaryPath = join(
    parent,
    `.${basename(target.stablePath)}.journal-write-${process.pid}-${randomUUID()}.tmp`,
  );

  try {
    const handle = await open(temporaryPath, 'wx', 0o666);
    try {
      await preserveExistingMetadata(target, handle);
      await writeBufferCompletely(handle, Buffer.from(content, 'utf8'));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await target.assertNamespaceUnchanged();
    await rename(temporaryPath, target.stablePath);
    await target.assertParentAttached();
    return !target.existed;
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function searchBoundedJournal(
  root: string,
  normalizedQuery: string,
  limit: number,
): Promise<BoundedJournalSearchResult> {
  const {
    candidates,
    complete,
    skippedOversizedFiles,
    totalFiles,
  } = await collectBoundedSearchCandidates(root);
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
    complete,
    resultLimitReached,
    scannedFiles: candidates.length,
    scannedBytes,
    totalFiles,
    skippedOversizedFiles,
  };
}

export async function listBoundedJournalPaths(root: string): Promise<BoundedJournalListResult> {
  const state: JournalScanState = { operation: 'list', scannedEntries: 0 };
  const paths: string[] = [];
  for await (const candidate of walkMarkdownFiles(root, root, state)) {
    paths.push(candidate.relativePath);
  }
  paths.sort((left, right) => left.localeCompare(right));
  return {
    paths: paths.slice(0, JOURNAL_IO_CONTRACT.listMaxFiles),
    truncated: paths.length > JOURNAL_IO_CONTRACT.listMaxFiles,
    totalFiles: paths.length,
  };
}

async function collectBoundedSearchCandidates(root: string): Promise<{
  candidates: SearchCandidate[];
  complete: boolean;
  skippedOversizedFiles: string[];
  totalFiles: number;
}> {
  const state: JournalScanState = { operation: 'search', scannedEntries: 0 };
  const discovered: SearchCandidate[] = [];
  for await (const candidate of walkMarkdownFiles(root, root, state)) {
    discovered.push(candidate);
  }
  discovered.sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  const selected = discovered.slice(0, JOURNAL_IO_CONTRACT.searchMaxFiles);
  const skippedOversizedFiles = selected
    .filter(candidate => candidate.size > JOURNAL_IO_CONTRACT.searchMaxFileBytes)
    .map(candidate => candidate.relativePath);
  const candidates = selected.filter(
    candidate => candidate.size <= JOURNAL_IO_CONTRACT.searchMaxFileBytes,
  );
  let corpusBytes = 0;
  for (const candidate of candidates) {
    if (corpusBytes + candidate.size > JOURNAL_IO_CONTRACT.searchMaxCorpusBytes) {
      throw searchBoundError(
        `the corpus exceeds ${String(JOURNAL_IO_CONTRACT.searchMaxCorpusBytes)} bytes`,
      );
    }
    corpusBytes += candidate.size;
  }

  return {
    candidates,
    complete: discovered.length <= JOURNAL_IO_CONTRACT.searchMaxFiles
      && skippedOversizedFiles.length === 0,
    skippedOversizedFiles,
    totalFiles: discovered.length,
  };
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

async function copyHandleCompletely(
  source: Awaited<ReturnType<typeof open>>,
  destination: Awaited<ReturnType<typeof open>>,
): Promise<void> {
  const preflightStats = await source.stat();
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  for (;;) {
    const { bytesRead } = await source.read(
      buffer,
      0,
      buffer.length,
      position,
    );
    if (bytesRead === 0) break;
    await writeBufferCompletely(destination, buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  const completedStats = await source.stat();
  if (
    completedStats.size !== preflightStats.size
    || completedStats.mtimeMs !== preflightStats.mtimeMs
    || position !== preflightStats.size
  ) {
    throw new Error(
      'Journal append source was modified concurrently while its existing content was copied',
    );
  }
}

async function preserveExistingMetadata(
  target: JournalMutationTarget,
  destination: Awaited<ReturnType<typeof open>>,
): Promise<void> {
  if (!target.existingHandle) return;
  const existingStats = await target.existingHandle.stat();
  await destination.chown(existingStats.uid, existingStats.gid);
  await destination.chmod(existingStats.mode & 0o7777);
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
