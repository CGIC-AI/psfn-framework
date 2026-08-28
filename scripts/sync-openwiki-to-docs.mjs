#!/usr/bin/env node
import { cp, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SELF_PATH = 'scripts/sync-openwiki-to-docs.mjs';
export const DEFAULT_WIKI_DIR = 'openwiki';
export const DEFAULT_DOCS_DIR = 'docs';
export const FROZEN_DOC_BASENAMES = new Set(['PSFN_PROJECT_CHARTER.md']);
export const SKIP_BASENAMES = new Set([
  'INSTRUCTIONS.md',
  'index.md',
  'log.md',
  'quickstart.md',
]);

/**
 * @param {string} relativePath
 * @returns {boolean}
 */
export function shouldPublishWikiPath(relativePath) {
  const posix = relativePath.split(path.sep).join('/');
  if (posix.split('/').some((part) => part.startsWith('.'))) return false;
  if (!posix.endsWith('.md')) return false;
  const basename = posix.split('/').pop() ?? '';
  if (SKIP_BASENAMES.has(basename)) return false;
  if (FROZEN_DOC_BASENAMES.has(basename)) return false;
  return true;
}

/**
 * @param {string} docsRoot
 * @param {string} relativePath
 */
export function resolvePublishedDocsPath(docsRoot, relativePath) {
  const destination = path.resolve(docsRoot, relativePath);
  const root = path.resolve(docsRoot);
  if (destination !== root && !destination.startsWith(`${root}${path.sep}`)) {
    throw new Error(`refusing to write outside docs/: ${relativePath}`);
  }
  const basename = path.basename(destination);
  if (FROZEN_DOC_BASENAMES.has(basename)) {
    throw new Error(`refusing to overwrite frozen doc: ${basename}`);
  }
  return destination;
}

/**
 * @param {string} wikiRoot
 * @returns {Promise<string[]>}
 */
export async function listPublishableWikiPages(wikiRoot) {
  /** @type {string[]} */
  const pages = [];

  async function walk(absDir, relDir) {
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        throw new Error(`OpenWiki output not found: ${wikiRoot}`);
      }
      throw error;
    }
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue;
        await walk(abs, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (shouldPublishWikiPath(rel)) pages.push(rel);
    }
  }

  await walk(wikiRoot, '');
  return pages.sort((left, right) => left.localeCompare(right));
}

/**
 * @param {{ wikiRoot: string, docsRoot: string }} roots
 */
export async function syncOpenWikiToDocs({ wikiRoot, docsRoot }) {
  const wikiStats = await stat(wikiRoot).catch(() => null);
  if (!wikiStats?.isDirectory()) {
    throw new Error(`OpenWiki output not found: ${wikiRoot}`);
  }
  await mkdir(docsRoot, { recursive: true });
  const pages = await listPublishableWikiPages(wikiRoot);
  const copied = [];
  for (const relativePath of pages) {
    const from = path.join(wikiRoot, relativePath);
    const to = resolvePublishedDocsPath(docsRoot, relativePath);
    await mkdir(path.dirname(to), { recursive: true });
    await cp(from, to);
    copied.push(relativePath);
  }
  return { copied };
}

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const wikiRoot = path.join(repoRoot, DEFAULT_WIKI_DIR);
  const docsRoot = path.join(repoRoot, DEFAULT_DOCS_DIR);
  const result = await syncOpenWikiToDocs({ wikiRoot, docsRoot });
  process.stdout.write(`copied ${result.copied.length} OpenWiki pages into docs/\n`);
  for (const relativePath of result.copied) {
    process.stdout.write(`  ${relativePath}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
