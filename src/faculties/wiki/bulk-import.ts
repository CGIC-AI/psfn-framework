// ── Wiki bulk directory import (S10 vinz.27) ──
//
// An OPERATOR/CARETAKER maintenance surface that imports a directory of Markdown
// files into a wiki store. Two modes, one code path:
//
//   - shared-world import (personalFactGuard: true): every file is run through
//     the deterministic personal-fact guard (`filterPersonalFactProposals`).
//     Any file containing a personal fact is REJECTED with a per-file reason and
//     NEVER written — never silently dropped or scrubbed. Clean files land in the
//     target site's shared-world scope. Fail closed on an unknown siteId (the
//     SharedWorldWikiStore ctor validates the token; the maintenance CLI checks
//     the site exists in places.json before constructing the store).
//
//   - personal import (personalFactGuard: false): the same path into a
//     companion's own personal WikiStore, WITHOUT the shared gate — personal
//     facts are legitimate in a companion's personal wiki.
//
// This never weakens the W5b companion-side rejection: the shared store is only
// ever constructed by this operator-owned surface, not by any companion tool.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { filterPersonalFactProposals } from './sleeptime-wiki-pass.js';
import { normalizeWikiDocumentId, type WikiDocumentStore } from './store.js';
import type { WikiSourceClass } from './types.js';

export interface MarkdownImportFile {
  /** File basename (e.g. `kitchen.md`). */
  file: string;
  title: string;
  body: string;
}

export interface WikiImportEntry {
  file: string;
  id: string;
  title: string;
}

export interface WikiImportRejection {
  file: string;
  reason: string;
}

export interface WikiImportReport {
  /** Absolute directory that was imported. */
  directory: string;
  scope: 'personal' | `shared_world:${string}`;
  personalFactGuard: boolean;
  imported: WikiImportEntry[];
  rejected: WikiImportRejection[];
}

/** Derive a title from the first Markdown H1, else the filename (sans extension). */
export function deriveMarkdownTitle(file: string, body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^#\s+(.+?)\s*$/);
    if (match?.[1]) return match[1].trim();
  }
  const stem = basename(file, extname(file)).replace(/[-_]+/g, ' ').trim();
  return stem || basename(file);
}

/** Read every `*.md` file in a directory (sorted, deterministic). Fail closed on a missing dir. */
export function readMarkdownDirectory(directory: string): MarkdownImportFile[] {
  const stat = statSync(directory);
  if (!stat.isDirectory()) {
    throw new Error(`wiki import source "${directory}" is not a directory`);
  }
  return readdirSync(directory)
    .filter(name => name.toLowerCase().endsWith('.md'))
    .sort((left, right) => left.localeCompare(right))
    .map((name) => {
      const body = readFileSync(join(directory, name), 'utf-8');
      return { file: name, title: deriveMarkdownTitle(name, body), body };
    });
}

/**
 * Deterministic personal-fact guard for a single import file. Reuses the exact
 * `filterPersonalFactProposals` guard the sleeptime pass uses (no re-invented
 * grammar): with no cited memories the content-based checks — first-person
 * relational markers — decide. Returns the rejection reason, or null if clean.
 */
export function guardImportFileForSharedWorld(input: { title: string; body: string }): string | null {
  const guarded = filterPersonalFactProposals(
    [{
      operation: 'create',
      title: input.title,
      body: input.body,
      tags: [],
      sourceEpisodeIds: [],
      sourceMemoryIds: [],
    }],
    [],
  );
  return guarded.rejected[0]?.reason ?? null;
}

export interface WikiImportOptions {
  directory: string;
  store: WikiDocumentStore;
  /** Target scope label for the report (the store enforces the real scope). */
  scope: 'personal' | `shared_world:${string}`;
  /** When true, run the personal-fact guard and reject any file that fails it. */
  personalFactGuard: boolean;
  sourceClass?: WikiSourceClass;
  updatedBy?: string;
  /** When true, run the guard + resolve ids but do NOT write (preview). */
  dryRun?: boolean;
}

/**
 * Import a directory of Markdown files into a wiki store. Personal-fact-guarded
 * per-file for shared-world targets; every rejection is reported, never dropped
 * silently. Idempotent per file: the document id is derived from the filename,
 * so re-importing updates in place.
 */
export function importMarkdownDirectory(options: WikiImportOptions): WikiImportReport {
  const { directory, store, scope, personalFactGuard } = options;
  const sourceClass: WikiSourceClass = options.sourceClass ?? 'operator_authored_note';
  const updatedBy = options.updatedBy ?? 'wiki-bulk-import';

  const files = readMarkdownDirectory(directory);
  const report: WikiImportReport = {
    directory,
    scope,
    personalFactGuard,
    imported: [],
    rejected: [],
  };

  for (const entry of files) {
    if (personalFactGuard) {
      const reason = guardImportFileForSharedWorld(entry);
      if (reason) {
        report.rejected.push({ file: entry.file, reason });
        continue;
      }
    }
    try {
      const id = normalizeWikiDocumentId(undefined, basename(entry.file, extname(entry.file)));
      if (options.dryRun) {
        report.imported.push({ file: entry.file, id, title: entry.title });
        continue;
      }
      const written = store.upsert({
        id,
        title: entry.title,
        body: entry.body,
        sourceClass,
        provenanceRefs: [`import:${entry.file}`],
        updatedBy,
      });
      report.imported.push({ file: entry.file, id: written.id, title: written.title });
    } catch (error) {
      report.rejected.push({
        file: entry.file,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return report;
}
