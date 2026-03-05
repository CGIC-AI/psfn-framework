import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import {
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from 'node:path';
import type { SkillsRuntimeConfig } from '../config/skills-config.js';
import { toErrorMessage } from '../utils/errors.js';
import { isRecord } from '../utils/types.js';
import type {
  SkillDirectorySpec,
  SkillEntry,
  SkillFileCandidate,
  SkillFrontmatter,
  SkillSkipRecord,
  SkillSource,
} from './types.js';

const SKILL_FILE_NAME = 'SKILL.md';
const DEFAULT_DIRECTORIES = ['psfn/skills', 'skills'];

function toPosix(path: string): string {
  return path.split(sep).join('/');
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
  if (displayPath === 'psfn/skills' || displayPath.startsWith('psfn/skills/')) {
    return 'psfn';
  }
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

function walkSkillFiles(baseDir: SkillDirectorySpec): SkillFileCandidate[] {
  if (!existsSync(baseDir.absolutePath)) return [];

  const stats = statSync(baseDir.absolutePath);
  if (!stats.isDirectory()) return [];

  const files: SkillFileCandidate[] = [];
  const stack = [baseDir.absolutePath];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }
      if (!entry.isFile() || entry.name !== SKILL_FILE_NAME) continue;

      const fileStats = statSync(absolutePath);
      const relativeFromDirectory = toPosix(relative(baseDir.absolutePath, absolutePath));
      const relativePath = relativeFromDirectory
        ? `${baseDir.relativePath}/${relativeFromDirectory}`
        : baseDir.relativePath;

      files.push({
        absolutePath,
        relativePath,
        directory: baseDir,
        mtimeMs: fileStats.mtimeMs,
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

export function resolveSkillDirectories(
  config: SkillsRuntimeConfig,
  repoRoot = process.cwd(),
): SkillDirectorySpec[] {
  const configuredBase = config.directories.length > 0
    ? config.directories
    : DEFAULT_DIRECTORIES;

  const ordered = uniqStrings([
    ...DEFAULT_DIRECTORIES,
    ...configuredBase,
    ...config.extraDirectories,
  ]);

  return ordered.map((path, index) => {
    const absolutePath = resolve(repoRoot, path);
    const displayPath = isAbsolute(path)
      ? toDisplayPath(repoRoot, normalize(path))
      : toPosix(normalize(path));

    return {
      absolutePath,
      relativePath: displayPath,
      source: sourceFromPath(displayPath),
      precedence: index,
    };
  });
}

export function scanSkillFiles(directories: SkillDirectorySpec[]): SkillFileCandidate[] {
  return directories
    .flatMap(directory => walkSkillFiles(directory))
    .sort((left, right) => {
      if (left.directory.precedence !== right.directory.precedence) {
        return left.directory.precedence - right.directory.precedence;
      }
      return left.relativePath.localeCompare(right.relativePath);
    });
}

export function loadSkillEntries(files: SkillFileCandidate[]): {
  entries: SkillEntry[];
  skipped: SkillSkipRecord[];
} {
  const entries: SkillEntry[] = [];
  const skipped: SkillSkipRecord[] = [];

  for (const file of files) {
    try {
      const document = readFileSync(file.absolutePath, 'utf-8');
      const parsed = parseSkillDocument(document, file.relativePath);
      entries.push({
        id: `${parsed.frontmatter.name}@${file.relativePath}`,
        name: parsed.frontmatter.name,
        description: parsed.frontmatter.description,
        category: parsed.frontmatter.category,
        createdAt: parsed.frontmatter.createdAt,
        updatedAt: parsed.frontmatter.updatedAt,
        version: parsed.frontmatter.version,
        always: parsed.frontmatter.always,
        requires: parsed.frontmatter.requires,
        content: parsed.body,
        absolutePath: file.absolutePath,
        relativePath: file.relativePath,
        source: file.directory.source,
        precedence: file.directory.precedence,
        mtimeMs: file.mtimeMs,
        size: file.size,
      });
    } catch (error) {
      const message = toErrorMessage(error);
      skipped.push({
        kind: 'parse_error',
        name: file.relativePath,
        relativePath: file.relativePath,
        source: file.directory.source,
        reason: message,
      });
    }
  }

  return { entries, skipped };
}

export function applySkillPrecedence(entries: SkillEntry[]): {
  entries: SkillEntry[];
  skipped: SkillSkipRecord[];
} {
  const ordered = [...entries].sort((left, right) => {
    if (left.precedence !== right.precedence) {
      return left.precedence - right.precedence;
    }
    return left.relativePath.localeCompare(right.relativePath);
  });

  const chosen = new Map<string, SkillEntry>();
  const skipped: SkillSkipRecord[] = [];

  for (const entry of ordered) {
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

export function buildSkillFileSignature(files: SkillFileCandidate[]): string {
  return files
    .map(file => `${file.relativePath}|${file.mtimeMs}|${file.size}|${file.directory.precedence}`)
    .sort()
    .join('||');
}

export function safeFileExists(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}
