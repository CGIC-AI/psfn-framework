import {
  existsSync,
  lstatSync,
} from 'node:fs';
import {
  open,
  opendir,
  stat,
} from 'node:fs/promises';
import {
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from 'node:path';
import type { SkillsRuntimeConfig } from '../../system/config/skills-config.js';
import { createComponentLogger } from '../../shared/logger.js';
import { createRateLimitedLogEmitter } from '../../shared/log-rate-limit.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { isRecord } from '../../shared/utils/types.js';
import type {
  SkillDirectorySpec,
  SkillCollectionLimits,
  SkillCollectionStats,
  SkillEntry,
  SkillFileCandidate,
  SkillFrontmatter,
  SkillRootScan,
  SkillSkipRecord,
  SkillSource,
} from './types.js';

const SKILL_FILE_NAME = 'SKILL.md';
const DEFAULT_DIRECTORIES = ['skills'];
const MISSING_ROOT_WARN_WINDOW_MS = 10 * 60_000;

const log = createComponentLogger('SkillsLoader');
const missingRootWarnLimiter = createRateLimitedLogEmitter({
  windowMs: MISSING_ROOT_WARN_WINDOW_MS,
});

export type SkillRootWarnFn = (
  message: string,
  context: { path: string; absolutePath: string; source: SkillSource },
) => void;

export interface ScanSkillRootsOptions {
  /** Override the WARN emitter (tests). Defaults to a rate-limited component logger. */
  warnMissingRoot?: SkillRootWarnFn;
  collectionLimits?: Partial<SkillCollectionLimits>;
}

export interface SkillScanResult {
  files: SkillFileCandidate[];
  roots: SkillRootScan[];
  skipped: SkillSkipRecord[];
  collection: SkillCollectionStats;
}

export const DEFAULT_SKILL_COLLECTION_LIMITS: Readonly<SkillCollectionLimits> = Object.freeze({
  maxDiscoveryEntries: 16_384,
  maxCandidates: 2_048,
  maxMetadataBytes: 16 * 1024 * 1024,
  maxRetainedBytes: 24 * 1024 * 1024,
  maxManagedContentBytes: 16 * 1024 * 1024,
  yieldEvery: 32,
});

const defaultWarnMissingRoot: SkillRootWarnFn = (message, context) => {
  missingRootWarnLimiter(`skills-root:${context.absolutePath}`, () => {
    log.warn(message, context);
  });
};

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

function normalizeCollectionLimits(
  overrides: Partial<SkillCollectionLimits> = {},
): SkillCollectionLimits {
  const limits = { ...DEFAULT_SKILL_COLLECTION_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Invalid skill collection limit ${name}: expected a positive integer`);
    }
  }
  return limits;
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>(resolveYield => setImmediate(resolveYield));
}

async function maybeYield(index: number, every: number): Promise<void> {
  if (index > 0 && index % every === 0) {
    await yieldToEventLoop();
  }
}

export async function cooperativeSort<T>(
  values: T[],
  compare: (left: T, right: T) => number,
  yieldEvery: number,
): Promise<T[]> {
  const chunks: T[][] = [];
  for (let offset = 0; offset < values.length; offset += yieldEvery) {
    chunks.push(values.slice(offset, offset + yieldEvery).sort(compare));
    await yieldToEventLoop();
  }
  while (chunks.length > 1) {
    const merged: T[][] = [];
    for (let index = 0; index < chunks.length; index += 2) {
      const left = chunks[index] ?? [];
      const right = chunks[index + 1] ?? [];
      const next: T[] = [];
      let leftIndex = 0;
      let rightIndex = 0;
      while (leftIndex < left.length || rightIndex < right.length) {
        if (rightIndex >= right.length || (
          leftIndex < left.length
          && compare(left[leftIndex]!, right[rightIndex]!) <= 0
        )) {
          next.push(left[leftIndex++]!);
        } else {
          next.push(right[rightIndex++]!);
        }
        await maybeYield(next.length, yieldEvery);
      }
      merged.push(next);
    }
    chunks.splice(0, chunks.length, ...merged);
  }
  return chunks[0] ?? [];
}

function uniqStrings(values: string[]): string[] {
  return [...new Set(values.map(v => v.trim()).filter(Boolean))];
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return undefined;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (/^-?\d+$/.test(trimmed)) {
      return Number.parseInt(trimmed, 10);
    }
  }

  return undefined;
}

function readStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return uniqStrings(value.filter((entry): entry is string => typeof entry === 'string'));
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    return [trimmed];
  }

  return [];
}

function pickFirstString(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = readString(record[key]);
    if (value) return value;
  }
  return undefined;
}

function pickFirstInteger(
  record: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const value = readInteger(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function readIsoTimestamp(
  value: unknown,
  field: string,
  sourcePath: string,
): string | undefined {
  const text = readString(value);
  if (!text) return undefined;
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid skill frontmatter at ${sourcePath}: ${field} must be ISO-8601 timestamp`);
  }
  return new Date(parsed).toISOString();
}

function parseScalar(raw: string): unknown {
  const value = raw.trim();
  if (!value) return '';

  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }

  if (value.startsWith('\'') && value.endsWith('\'')) {
    return value
      .slice(1, -1)
      .replace(/''/g, '\'');
  }

  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;

  if (/^-?\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }

  if (/^-?\d+\.\d+$/.test(value)) {
    return Number.parseFloat(value);
  }

  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner
      .split(',')
      .map(item => parseScalar(item));
  }

  return value;
}

function nextNonBlankLine(lines: string[], index: number): number {
  let cursor = index;
  while (cursor < lines.length) {
    const trimmed = lines[cursor]?.trim() ?? '';
    if (trimmed && !trimmed.startsWith('#')) {
      break;
    }
    cursor += 1;
  }
  return cursor;
}

function lineIndent(line: string): number {
  let count = 0;
  while (count < line.length && line[count] === ' ') count += 1;
  return count;
}

interface ParsedYamlNode {
  value: unknown;
  nextIndex: number;
}

function parseYamlArray(lines: string[], index: number, indent: number): ParsedYamlNode {
  const output: unknown[] = [];
  let cursor = index;

  while (cursor < lines.length) {
    cursor = nextNonBlankLine(lines, cursor);
    if (cursor >= lines.length) break;

    const rawLine = lines[cursor] ?? '';
    const currentIndent = lineIndent(rawLine);
    if (currentIndent < indent) break;
    if (currentIndent > indent) break;

    const trimmed = rawLine.slice(currentIndent);
    if (!trimmed.startsWith('- ')) break;

    const itemValue = trimmed.slice(2).trim();
    if (!itemValue) {
      const nestedStart = nextNonBlankLine(lines, cursor + 1);
      if (nestedStart >= lines.length || lineIndent(lines[nestedStart] ?? '') <= currentIndent) {
        output.push({});
        cursor += 1;
        continue;
      }

      const nested = parseYamlNode(lines, nestedStart, currentIndent + 2);
      output.push(nested.value);
      cursor = nested.nextIndex;
      continue;
    }

    output.push(parseScalar(itemValue));
    cursor += 1;
  }

  return { value: output, nextIndex: cursor };
}

function parseYamlMap(lines: string[], index: number, indent: number): ParsedYamlNode {
  const output: Record<string, unknown> = {};
  let cursor = index;

  while (cursor < lines.length) {
    cursor = nextNonBlankLine(lines, cursor);
    if (cursor >= lines.length) break;

    const rawLine = lines[cursor] ?? '';
    const currentIndent = lineIndent(rawLine);
    if (currentIndent < indent) break;
    if (currentIndent > indent) break;

    const trimmed = rawLine.slice(currentIndent);
    if (trimmed.startsWith('- ')) break;

    const separator = trimmed.indexOf(':');
    if (separator <= 0) {
      throw new Error(`Invalid YAML frontmatter near line ${cursor + 1}`);
    }

    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    if (!key) {
      throw new Error(`Invalid YAML key near line ${cursor + 1}`);
    }

    if (rawValue) {
      output[key] = parseScalar(rawValue);
      cursor += 1;
      continue;
    }

    const nestedStart = nextNonBlankLine(lines, cursor + 1);
    if (nestedStart >= lines.length || lineIndent(lines[nestedStart] ?? '') <= currentIndent) {
      output[key] = {};
      cursor += 1;
      continue;
    }

    const nested = parseYamlNode(lines, nestedStart, currentIndent + 2);
    output[key] = nested.value;
    cursor = nested.nextIndex;
  }

  return { value: output, nextIndex: cursor };
}

function parseYamlNode(lines: string[], index: number, indent: number): ParsedYamlNode {
  const start = nextNonBlankLine(lines, index);
  if (start >= lines.length) {
    return { value: {}, nextIndex: start };
  }

  const line = lines[start] ?? '';
  const currentIndent = lineIndent(line);
  if (currentIndent < indent) {
    return { value: {}, nextIndex: start };
  }

  const trimmed = line.slice(currentIndent);
  if (trimmed.startsWith('- ')) {
    return parseYamlArray(lines, start, indent);
  }

  return parseYamlMap(lines, start, indent);
}

function parseYamlFrontmatter(raw: string): Record<string, unknown> {
  const lines = raw
    .split(/\r?\n/)
    .map(line => line.replace(/\t/g, '  ').replace(/\s+$/, ''));

  const parsed = parseYamlNode(lines, 0, 0).value;
  if (!isRecord(parsed)) {
    throw new Error('YAML frontmatter must parse to an object');
  }
  return parsed;
}

function parseFrontmatter(document: string): { yaml: string; body: string } {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(document);
  if (!match) {
    throw new Error('Missing YAML frontmatter delimited by ---');
  }

  const body = document.slice(match[0].length).trim();
  return {
    yaml: match[1],
    body,
  };
}

function normalizeFrontmatter(raw: Record<string, unknown>, sourcePath: string): SkillFrontmatter {
  const metadata = isRecord(raw.metadata) ? raw.metadata : {};
  const requires = isRecord(raw.requires) ? raw.requires : {};

  const name = pickFirstString(raw, ['name', 'id']);
  if (!name) {
    throw new Error(`Invalid skill frontmatter at ${sourcePath}: missing name`);
  }

  const description = pickFirstString(raw, ['description', 'summary']);
  if (!description) {
    throw new Error(`Invalid skill frontmatter at ${sourcePath}: missing description`);
  }

  const category = pickFirstString(raw, ['category']) ?? pickFirstString(metadata, ['category']);
  const version = pickFirstInteger(raw, ['version']) ?? pickFirstInteger(metadata, ['version']);
  if (version !== undefined && (!Number.isInteger(version) || version < 1)) {
    throw new Error(`Invalid skill frontmatter at ${sourcePath}: version must be a positive integer`);
  }

  const createdAt = readIsoTimestamp(raw.createdAt, 'createdAt', sourcePath)
    ?? readIsoTimestamp(raw.created, 'created', sourcePath)
    ?? readIsoTimestamp(metadata.createdAt, 'metadata.createdAt', sourcePath)
    ?? readIsoTimestamp(metadata.created, 'metadata.created', sourcePath);
  const updatedAt = readIsoTimestamp(raw.updatedAt, 'updatedAt', sourcePath)
    ?? readIsoTimestamp(raw.updated, 'updated', sourcePath)
    ?? readIsoTimestamp(metadata.updatedAt, 'metadata.updatedAt', sourcePath)
    ?? readIsoTimestamp(metadata.updated, 'metadata.updated', sourcePath);

  const always = readBoolean(raw.always) ?? readBoolean(metadata.always) ?? false;

  const binaries = uniqStrings([
    ...readStringArray(requires.binary),
    ...readStringArray(requires.binaries),
    ...readStringArray(requires.bin),
    ...readStringArray(requires.bins),
    ...readStringArray(requires.command),
    ...readStringArray(requires.commands),
  ]);

  const env = uniqStrings([
    ...readStringArray(requires.env),
    ...readStringArray(requires.environment),
    ...readStringArray(requires.envVars),
  ]);

  const config = uniqStrings([
    ...readStringArray(requires.config),
    ...readStringArray(requires.settings),
  ]);

  return {
    name,
    description,
    category,
    createdAt,
    updatedAt,
    version,
    always,
    requires: {
      binaries,
      env,
      config,
    },
    raw,
  };
}

function sourceFromPath(displayPath: string): SkillSource {
  if (displayPath === 'skills' || displayPath.startsWith('skills/')) {
    return 'bundled';
  }
  return 'extra';
}

function toDisplayPath(root: string, absolutePath: string): string {
  const relativePath = toPosix(relative(root, absolutePath));
  if (relativePath && !relativePath.startsWith('..')) {
    return relativePath;
  }

  return toPosix(absolutePath);
}

/**
 * Walk an existing skills root for SKILL.md files. Callers must verify the
 * root is an existing directory first (scanSkillRoots does); a root that
 * disappears mid-walk fails loudly via readdirSync rather than yielding [].
 */
interface SkillDiscoveryBudget {
  limits: SkillCollectionLimits;
  discoveryEntries: number;
  candidatesSeen: number;
  candidateBytesRetained: number;
  limitedReason?: string;
}

async function walkSkillFiles(
  baseDir: SkillDirectorySpec,
  budget: SkillDiscoveryBudget,
): Promise<SkillFileCandidate[]> {
  const files: SkillFileCandidate[] = [];
  const stack = [baseDir.absolutePath];

  while (stack.length > 0 && !budget.limitedReason) {
    const current = stack.pop();
    if (!current) continue;

    const directory = await opendir(current);
    for await (const entry of directory) {
      budget.discoveryEntries += 1;
      if (budget.discoveryEntries > budget.limits.maxDiscoveryEntries) {
        budget.limitedReason = `Skill discovery exceeded ${String(budget.limits.maxDiscoveryEntries)} filesystem entries`;
        break;
      }
      await maybeYield(budget.discoveryEntries, budget.limits.yieldEvery);
      const absolutePath = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }
      if (!entry.isFile() || entry.name !== SKILL_FILE_NAME) continue;

      const fileStats = await stat(absolutePath);
      const relativeFromDirectory = toPosix(relative(baseDir.absolutePath, absolutePath));
      const relativePath = relativeFromDirectory
        ? `${baseDir.relativePath}/${relativeFromDirectory}`
        : baseDir.relativePath;
      budget.candidatesSeen += 1;
      const candidateBytes = Buffer.byteLength(absolutePath) + Buffer.byteLength(relativePath);
      if (budget.candidatesSeen > budget.limits.maxCandidates) {
        budget.limitedReason = `Skill collection exceeded ${String(budget.limits.maxCandidates)} SKILL.md candidates`;
        break;
      }
      if (budget.candidateBytesRetained + candidateBytes > budget.limits.maxRetainedBytes) {
        budget.limitedReason = `Skill candidate paths exceeded the ${String(budget.limits.maxRetainedBytes)} byte retained-data limit`;
        break;
      }
      budget.candidateBytesRetained += candidateBytes;

      files.push({
        absolutePath,
        relativePath,
        directory: baseDir,
        mtimeMs: fileStats.mtimeMs,
        birthtimeMs: fileStats.birthtimeMs,
        size: fileStats.size,
      });
    }
  }

  return files;
}

export function parseSkillDocument(document: string, sourcePath: string): {
  frontmatter: SkillFrontmatter;
  body: string;
} {
  const parsed = parseFrontmatter(document);
  const rawFrontmatter = parseYamlFrontmatter(parsed.yaml);
  const frontmatter = normalizeFrontmatter(rawFrontmatter, sourcePath);
  return {
    frontmatter,
    body: parsed.body,
  };
}

export function parseSkillMetadata(documentPrefix: string, sourcePath: string): SkillFrontmatter {
  const parsed = parseFrontmatter(documentPrefix);
  return normalizeFrontmatter(parseYamlFrontmatter(parsed.yaml), sourcePath);
}

export function resolveSkillDirectories(
  config: SkillsRuntimeConfig,
  repoRoot: string,
): SkillDirectorySpec[] {
  const normalizedRepoRoot = repoRoot.trim();
  if (!normalizedRepoRoot) {
    throw new Error('resolveSkillDirectories requires an explicit repoRoot');
  }
  const configuredBase = config.directories.length > 0
    ? config.directories
    : DEFAULT_DIRECTORIES;

  const ordered = uniqStrings([
    ...DEFAULT_DIRECTORIES,
    ...configuredBase,
    ...config.extraDirectories,
  ]);

  return ordered.map((path, index) => {
    const absolutePath = resolve(normalizedRepoRoot, path);
    const displayPath = isAbsolute(path)
      ? toDisplayPath(normalizedRepoRoot, normalize(path))
      : toPosix(normalize(path));

    return {
      absolutePath,
      relativePath: displayPath,
      source: sourceFromPath(displayPath),
      precedence: index,
    };
  });
}

/**
 * Scan every configured skills root and report per-root provenance alongside
 * the discovered files. A missing (or non-directory) root is never a silent
 * empty: it is recorded as exists=false and — for non-managed roots — emits a
 * WARN naming the path. The managed ('custom') root is created lazily on
 * first skill creation, so its absence is expected and only surfaced via the
 * provenance payload.
 */
export async function scanSkillRoots(
  directories: SkillDirectorySpec[],
  options: ScanSkillRootsOptions = {},
): Promise<SkillScanResult> {
  const warnMissingRoot = options.warnMissingRoot ?? defaultWarnMissingRoot;
  const limits = normalizeCollectionLimits(options.collectionLimits);
  const budget: SkillDiscoveryBudget = {
    limits,
    discoveryEntries: 0,
    candidatesSeen: 0,
    candidateBytesRetained: 0,
  };
  const roots: SkillRootScan[] = [];
  const files: SkillFileCandidate[] = [];

  for (const directory of directories) {
    let rootStats;
    try {
      rootStats = await stat(directory.absolutePath);
    } catch (error) {
      const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';
      if (code !== 'ENOENT') throw error;
    }
    const exists = rootStats !== undefined;
    const isDirectory = rootStats?.isDirectory() ?? false;

    if (!isDirectory) {
      const message = exists
        ? `Skills root is not a directory; no skills can load from it: ${directory.absolutePath}`
        : `Skills root missing; no skills can load from it: ${directory.absolutePath}`;
      if (directory.source !== 'custom') {
        warnMissingRoot(message, {
          path: directory.relativePath,
          absolutePath: directory.absolutePath,
          source: directory.source,
        });
      }
      roots.push({
        path: directory.relativePath,
        absolutePath: directory.absolutePath,
        exists: false,
        skillCount: 0,
        source: directory.source,
        precedence: directory.precedence,
        ...(directory.source !== 'custom' ? { message } : {}),
      });
      continue;
    }

    const rootFiles = await walkSkillFiles(directory, budget);
    roots.push({
      path: directory.relativePath,
      absolutePath: directory.absolutePath,
      exists: true,
      skillCount: rootFiles.length,
      source: directory.source,
      precedence: directory.precedence,
    });
    files.push(...rootFiles);
    if (budget.limitedReason) break;
  }

  const limited = budget.limitedReason !== undefined;
  const reportedRoots = limited
    ? roots.map(root => ({
        ...root,
        skillCount: 0,
        message: budget.limitedReason,
      }))
    : roots;
  const orderedFiles = limited
    ? []
    : await cooperativeSort(files, (left, right) => {
        if (left.directory.precedence !== right.directory.precedence) {
          return left.directory.precedence - right.directory.precedence;
        }
        return left.relativePath.localeCompare(right.relativePath);
      }, limits.yieldEvery);
  return {
    files: limited ? [] : orderedFiles,
    roots: reportedRoots,
    skipped: limited
      ? [{
          kind: 'collection_limit',
          name: 'skill collection',
          relativePath: reportedRoots.at(-1)?.path ?? 'skills',
          source: reportedRoots.at(-1)?.source ?? 'bundled',
          reason: budget.limitedReason!,
          details: ['collection work stopped; no partial skill set was accepted'],
        }]
      : [],
    collection: {
      discoveryEntries: budget.discoveryEntries,
      candidatesSeen: budget.candidatesSeen,
      candidateBytesRetained: budget.candidateBytesRetained,
      metadataBytesRead: 0,
      metadataBytesRetained: 0,
      limited,
      limits,
    },
  };
}

export async function scanSkillFiles(
  directories: SkillDirectorySpec[],
): Promise<SkillFileCandidate[]> {
  return (await scanSkillRoots(directories)).files;
}

interface SkillDocumentReadOptions {
  maxDocumentBytes?: number;
  maxFrontmatterBytes?: number;
  collectionLimits?: Partial<SkillCollectionLimits>;
  initialRetainedBytes?: number;
}

class OversizedSkillDocumentError extends Error {
  constructor(
    readonly actualBytes: number,
    readonly maxBytes: number,
    message: string,
  ) {
    super(message);
    this.name = 'OversizedSkillDocumentError';
  }
}

async function readStableSkillBytes(
  path: string,
  options: SkillDocumentReadOptions,
  mode: 'frontmatter' | 'document',
): Promise<Buffer> {
  const maxDocumentBytes = options.maxDocumentBytes ?? 1_000_000;
  const maxFrontmatterBytes = options.maxFrontmatterBytes ?? 64 * 1024;
  const handle = await open(path, 'r');

  try {
    const before = await handle.stat();
    if (before.size > maxDocumentBytes) {
      throw new OversizedSkillDocumentError(
        before.size,
        maxDocumentBytes,
        `SKILL.md is ${String(before.size)} bytes; hard limit is ${String(maxDocumentBytes)} bytes`,
      );
    }

    const readLimit = mode === 'document'
      ? before.size
      : Math.min(before.size, maxFrontmatterBytes);
    const bytes = Buffer.allocUnsafe(readLimit);
    let bytesRead = 0;
    while (bytesRead < readLimit) {
      const result = await handle.read(bytes, bytesRead, readLimit - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }

    const after = await handle.stat();
    if (after.size !== before.size || bytesRead !== readLimit) {
      throw new Error('SKILL.md changed while it was being read; retry after the write completes');
    }

    const result = bytes.subarray(0, bytesRead);
    if (
      mode === 'frontmatter'
      && before.size > maxFrontmatterBytes
      && !/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/.test(result.toString('utf8'))
    ) {
      throw new OversizedSkillDocumentError(
        before.size,
        maxFrontmatterBytes,
        `SKILL.md frontmatter exceeds the ${String(maxFrontmatterBytes)} byte metadata limit`,
      );
    }
    return result;
  } finally {
    await handle.close();
  }
}

export async function readSkillContent(
  file: Pick<SkillFileCandidate, 'absolutePath' | 'relativePath'>,
  options: SkillDocumentReadOptions = {},
): Promise<string> {
  const document = (await readStableSkillBytes(file.absolutePath, options, 'document')).toString('utf8');
  return parseSkillDocument(document, file.relativePath).body;
}

export async function loadSkillEntries(
  files: SkillFileCandidate[],
  options: SkillDocumentReadOptions = {},
): Promise<{
  entries: SkillEntry[];
  skipped: SkillSkipRecord[];
  metadataBytesRead: number;
  metadataBytesRetained: number;
}> {
  const entries: SkillEntry[] = [];
  const skipped: SkillSkipRecord[] = [];
  let metadataBytesRead = 0;
  const limits = normalizeCollectionLimits(options.collectionLimits);
  const maxDocumentBytes = options.maxDocumentBytes ?? 1_000_000;
  const maxFrontmatterBytes = options.maxFrontmatterBytes ?? 64 * 1024;
  const projectedMetadataBytes = files.reduce((total, file) => (
    total + (file.size > maxDocumentBytes ? 0 : Math.min(file.size, maxFrontmatterBytes))
  ), 0);
  const initialRetainedBytes = options.initialRetainedBytes ?? 0;
  if (
    projectedMetadataBytes > limits.maxMetadataBytes
    || initialRetainedBytes + projectedMetadataBytes > limits.maxRetainedBytes
  ) {
    const reason = projectedMetadataBytes > limits.maxMetadataBytes
      ? `Skill metadata collection requires ${String(projectedMetadataBytes)} bytes; aggregate read limit is ${String(limits.maxMetadataBytes)} bytes`
      : `Skill collection requires ${String(initialRetainedBytes + projectedMetadataBytes)} retained bytes; aggregate limit is ${String(limits.maxRetainedBytes)} bytes`;
    return {
      entries: [],
      skipped: [{
        kind: 'collection_limit',
        name: 'skill collection',
        relativePath: files[0]?.directory.relativePath ?? 'skills',
        source: files[0]?.directory.source ?? 'bundled',
        reason,
        details: ['metadata reads were not started; no partial skill set was accepted'],
      }],
      metadataBytesRead: 0,
      metadataBytesRetained: 0,
    };
  }

  for (const [index, file] of files.entries()) {
    try {
      const documentPrefixBytes = await readStableSkillBytes(
        file.absolutePath,
        options,
        'frontmatter',
      );
      metadataBytesRead += documentPrefixBytes.byteLength;
      const documentPrefix = documentPrefixBytes.toString('utf8');
      const frontmatter = parseSkillMetadata(documentPrefix, file.relativePath);
      entries.push({
        id: `${frontmatter.name}@${file.relativePath}`,
        name: frontmatter.name,
        description: frontmatter.description,
        category: frontmatter.category,
        createdAt: frontmatter.createdAt,
        updatedAt: frontmatter.updatedAt,
        version: frontmatter.version,
        always: frontmatter.always,
        requires: frontmatter.requires,
        absolutePath: file.absolutePath,
        relativePath: file.relativePath,
        source: file.directory.source,
        precedence: file.directory.precedence,
        mtimeMs: file.mtimeMs,
        birthtimeMs: file.birthtimeMs,
        size: file.size,
      });
    } catch (error) {
      const message = toErrorMessage(error);
      skipped.push({
        kind: error instanceof OversizedSkillDocumentError ? 'oversized' : 'parse_error',
        name: file.relativePath,
        relativePath: file.relativePath,
        source: file.directory.source,
        reason: message,
      });
    }
    await maybeYield(index + 1, limits.yieldEvery);
  }

  return {
    entries,
    skipped,
    metadataBytesRead,
    metadataBytesRetained: metadataBytesRead,
  };
}

export async function applySkillPrecedence(
  entries: SkillEntry[],
  yieldEvery = DEFAULT_SKILL_COLLECTION_LIMITS.yieldEvery,
): Promise<{
  entries: SkillEntry[];
  skipped: SkillSkipRecord[];
}> {
  const ordered = await cooperativeSort(entries, (left, right) => {
    if (left.precedence !== right.precedence) {
      return left.precedence - right.precedence;
    }
    return left.relativePath.localeCompare(right.relativePath);
  }, yieldEvery);

  const chosen = new Map<string, SkillEntry>();
  const skipped: SkillSkipRecord[] = [];

  for (const [index, entry] of ordered.entries()) {
    await maybeYield(index + 1, yieldEvery);
    const existing = chosen.get(entry.name);
    if (!existing) {
      chosen.set(entry.name, entry);
      continue;
    }

    skipped.push({
      kind: 'shadowed',
      name: entry.name,
      relativePath: entry.relativePath,
      source: entry.source,
      reason: `Shadowed by higher precedence skill at ${existing.relativePath}`,
      details: [existing.relativePath],
    });
  }

  return {
    entries: [...chosen.values()],
    skipped,
  };
}

export async function buildSkillFileSignature(
  files: SkillFileCandidate[],
  yieldEvery = DEFAULT_SKILL_COLLECTION_LIMITS.yieldEvery,
): Promise<string> {
  const parts: string[] = [];
  for (const [index, file] of files.entries()) {
    parts.push(`${file.relativePath}|${file.mtimeMs}|${file.size}|${file.directory.precedence}`);
    await maybeYield(index + 1, yieldEvery);
  }
  return parts.join('||');
}

export function safeFileExists(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}
