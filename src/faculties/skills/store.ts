import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { appendJsonLine, readJsonLines } from '../../persistence/jsonl.js';
import {
  detectDestructiveTextReplace,
  type DestructiveTextReplaceRisk,
} from '../../shared/utils/destructive-replace.js';
import { parseSkillDocument } from './loader.js';

const MANAGED_SKILLS_DIR = 'skills';
const SKILL_FILE_NAME = 'SKILL.md';
const SKILL_HISTORY_FILE_NAME = 'SKILL.history.jsonl';
const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SKILL_CATEGORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_DESCRIPTION_CHARS = 240;

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

function normalizeIsoTimestamp(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Skill ${field} timestamp must be non-empty`);
  }

  const parsed = Date.parse(normalized);
  if (Number.isNaN(parsed)) {
    throw new Error(`Skill ${field} timestamp is invalid ISO-8601`);
  }

  return new Date(parsed).toISOString();
}

function normalizeSegment(
  value: string,
  field: string,
  pattern: RegExp,
): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Skill ${field} must be non-empty`);
  }

  if (!pattern.test(normalized)) {
    throw new Error(`Skill ${field} contains invalid characters`);
  }

  return normalized;
}

function normalizeDescription(description: string): string {
  const normalized = description.trim();
  if (!normalized) {
    throw new Error('Skill description must be non-empty');
  }
  if (normalized.length > MAX_DESCRIPTION_CHARS) {
    throw new Error(`Skill description exceeds ${MAX_DESCRIPTION_CHARS} characters`);
  }
  return normalized;
}

function normalizeContent(content: string): string {
  const normalized = content.trim();
  if (!normalized) {
    throw new Error('Skill content must be non-empty');
  }
  return normalized;
}

function deriveDescription(content: string): string {
  const lines = content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (line.startsWith('```')) continue;
    const cleaned = line.replace(/^[#>*`\-\d.)\s]+/, '').trim();
    if (cleaned) {
      return cleaned.slice(0, MAX_DESCRIPTION_CHARS);
    }
  }

  throw new Error('Skill description is required when content has no readable summary line');
}

function escapeYaml(value: string): string {
  return JSON.stringify(value);
}

function ensurePathWithinRoot(root: string, candidate: string): void {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  if (normalizedCandidate === normalizedRoot) return;
  if (normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)) return;
  throw new Error('Resolved skill path escapes managed skills root');
}

interface SkillDocumentPayload {
  name: string;
  description: string;
  category: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  content: string;
}

function renderSkillDocument(payload: SkillDocumentPayload): string {
  const lines = [
    '---',
    `name: ${escapeYaml(payload.name)}`,
    `description: ${escapeYaml(payload.description)}`,
    `category: ${escapeYaml(payload.category)}`,
    `created: ${escapeYaml(payload.createdAt)}`,
    `updated: ${escapeYaml(payload.updatedAt)}`,
    `version: ${payload.version}`,
    '---',
    payload.content.trim(),
    '',
  ];
  return lines.join('\n');
}

export interface ManagedSkillRecord {
  name: string;
  description: string;
  category: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  content: string;
  absolutePath: string;
  relativePath: string;
}

export interface SkillCreateInput {
  name: string;
  category: string;
  content: string;
  description?: string;
}

export interface SkillUpdateInput {
  name: string;
  content: string;
  description?: string;
}

/**
 * Who performed a managed-skill write, recorded in the per-skill history
 * journal (charter 9.5 category-2 provenance). Required on every mutation —
 * there is no anonymous write path.
 */
export interface SkillWriteProvenance {
  updatedBy: string;
  reason?: string;
}

export type SkillHistoryAction = 'create' | 'update' | 'rollback';

/**
 * One append-only line in `<skill dir>/SKILL.history.jsonl`. `newDocument` is
 * the full rendered SKILL.md text after the action, so any prior version can
 * be restored byte-exactly. `previous*` fields are null for the create entry.
 */
export interface ManagedSkillHistoryEntry {
  action: SkillHistoryAction;
  /** Skill version resulting from this action. */
  version: number;
  timestamp: string;
  updatedBy: string;
  reason?: string;
  previousVersion: number | null;
  previousChecksum: string | null;
  newChecksum: string;
  previousDocument: string | null;
  newDocument: string;
}

function documentChecksum(document: string): string {
  return createHash('sha256').update(document).digest('hex').slice(0, 16);
}

function normalizeProvenance(provenance: SkillWriteProvenance): SkillWriteProvenance {
  const updatedBy = provenance.updatedBy.trim();
  if (!updatedBy) {
    throw new Error('Skill write provenance requires a non-empty updatedBy');
  }
  const reason = provenance.reason?.trim();
  return { updatedBy, ...(reason ? { reason } : {}) };
}

/**
 * Destructive-replace heuristic over skill body content (shared thresholds
 * with character-card versioning). Returns the risk when the update removes
 * most of a long existing skill body, otherwise null.
 */
export function detectDestructiveSkillContentReplace(
  previousContent: string,
  nextContent: string,
): DestructiveTextReplaceRisk | null {
  return detectDestructiveTextReplace(
    previousContent.trim().length,
    nextContent.trim().length,
  );
}

interface SkillStoreOptions {
  repoRoot: string;
  managedRootDir?: string;
  now?: () => Date;
}

export function normalizeSkillName(name: string): string {
  return normalizeSegment(name, 'name', SKILL_NAME_PATTERN);
}

export function normalizeSkillCategory(category: string): string {
  return normalizeSegment(category, 'category', SKILL_CATEGORY_PATTERN);
}

function requireSkillRepoRoot(repoRoot: string): string {
  const normalized = repoRoot.trim();
  if (!normalized) {
    throw new Error('SkillStore requires an explicit repoRoot');
  }
  return resolve(normalized);
}

export class SkillStore {
  private readonly managedRootDir: string;
  private readonly repoRoot: string;
  private readonly now: () => Date;

  constructor(dataDir: string, options: SkillStoreOptions) {
    this.managedRootDir = resolve(options.managedRootDir?.trim() || resolve(dataDir, MANAGED_SKILLS_DIR));
    this.repoRoot = requireSkillRepoRoot(options.repoRoot);
    this.now = options.now ?? (() => new Date());
  }

  getManagedRootDir(): string {
    return this.managedRootDir;
  }

  list(): ManagedSkillRecord[] {
    const files = this.listManagedSkillFiles();
    const records = files.map(path => this.readSkillRecord(path));
    return records.sort((left, right) => left.name.localeCompare(right.name));
  }

  getByName(name: string): ManagedSkillRecord | null {
    const normalizedName = normalizeSkillName(name).toLowerCase();
    const matches = this.list().filter(record => record.name.toLowerCase() === normalizedName);
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      throw new Error(`Multiple managed skills found with name "${name}"`);
    }
    return matches[0] ?? null;
  }

  create(input: SkillCreateInput, provenance: SkillWriteProvenance): ManagedSkillRecord {
    const name = normalizeSkillName(input.name);
    const category = normalizeSkillCategory(input.category);
    const content = normalizeContent(input.content);
    const normalizedProvenance = normalizeProvenance(provenance);
    const existing = this.getByName(name);
    if (existing) {
      throw new Error(`Skill "${name}" already exists`);
    }

    const description = normalizeDescription(input.description ?? deriveDescription(content));
    const timestamp = this.now().toISOString();
    const absolutePath = this.resolveSkillFilePath(category, name);

    const document = renderSkillDocument({
      name,
      description,
      category,
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 1,
      content,
    });
    this.appendHistoryEntry(absolutePath, {
      action: 'create',
      version: 1,
      timestamp,
      updatedBy: normalizedProvenance.updatedBy,
      ...(normalizedProvenance.reason ? { reason: normalizedProvenance.reason } : {}),
      previousVersion: null,
      previousChecksum: null,
      newChecksum: documentChecksum(document),
      previousDocument: null,
      newDocument: document,
    });
    this.writeSkillDocument(absolutePath, document);

    return this.readSkillRecord(absolutePath);
  }

  update(input: SkillUpdateInput, provenance: SkillWriteProvenance): ManagedSkillRecord {
    const name = normalizeSkillName(input.name);
    const existing = this.getByName(name);
    if (!existing) {
      throw new Error(`Skill "${name}" does not exist`);
    }

    const content = normalizeContent(input.content);
    const description = normalizeDescription(input.description ?? existing.description);
    return this.applyExistingSkillWrite(existing, { content, description }, provenance, 'update');
  }

  /**
   * Append-only per-skill history journal, oldest first. Every create/update/
   * rollback appends one entry carrying the full document text, so any prior
   * version remains restorable after later overwrites.
   */
  getHistory(name: string): ManagedSkillHistoryEntry[] {
    const existing = this.getByName(normalizeSkillName(name));
    if (!existing) {
      throw new Error(`Skill "${name}" does not exist`);
    }
    return this.readHistoryEntries(existing.absolutePath);
  }

  /**
   * Restore the skill document exactly as it was at `version`, as a NEW
   * version (append-only: rollback itself is journaled and reversible). The
   * restored body/description are byte-exact from the journaled document.
   */
  rollback(
    name: string,
    version: number,
    provenance: SkillWriteProvenance,
  ): ManagedSkillRecord {
    const normalizedName = normalizeSkillName(name);
    const existing = this.getByName(normalizedName);
    if (!existing) {
      throw new Error(`Skill "${normalizedName}" does not exist`);
    }
    if (!Number.isInteger(version) || version < 1) {
      throw new Error(`Skill rollback requires a positive integer version, got ${String(version)}`);
    }

    const entry = this.readHistoryEntries(existing.absolutePath)
      .find((candidate) => candidate.version === version);
    if (!entry) {
      throw new Error(
        `Skill "${normalizedName}" has no history entry for version ${version}; `
        + 'only journaled versions can be restored',
      );
    }

    const restored = parseSkillDocument(entry.newDocument, `history:v${version}`);
    const normalizedProvenance = normalizeProvenance(provenance);
    return this.applyExistingSkillWrite(
      existing,
      {
        content: normalizeContent(restored.body),
        description: normalizeDescription(restored.frontmatter.description),
      },
      {
        updatedBy: normalizedProvenance.updatedBy,
        reason: normalizedProvenance.reason ?? `Rollback to version ${version}`,
      },
      'rollback',
    );
  }

  private applyExistingSkillWrite(
    existing: ManagedSkillRecord,
    next: { content: string; description: string },
    provenance: SkillWriteProvenance,
    action: Extract<SkillHistoryAction, 'update' | 'rollback'>,
  ): ManagedSkillRecord {
    const normalizedProvenance = normalizeProvenance(provenance);
    const timestamp = this.now().toISOString();
    const previousDocument = readFileSync(existing.absolutePath, 'utf-8');
    const previousChecksum = documentChecksum(previousDocument);

    const nextDocument = renderSkillDocument({
      name: existing.name,
      description: next.description,
      category: existing.category,
      createdAt: existing.createdAt,
      updatedAt: timestamp,
      version: existing.version + 1,
      content: next.content,
    });

    // No-op writes (identical body + description) do not burn a version or a
    // history entry — mirrors character-card checksum short-circuiting.
    if (next.content === existing.content && next.description === existing.description) {
      return existing;
    }

    this.appendHistoryEntry(existing.absolutePath, {
      action,
      version: existing.version + 1,
      timestamp,
      updatedBy: normalizedProvenance.updatedBy,
      ...(normalizedProvenance.reason ? { reason: normalizedProvenance.reason } : {}),
      previousVersion: existing.version,
      previousChecksum,
      newChecksum: documentChecksum(nextDocument),
      previousDocument,
      newDocument: nextDocument,
    });
    this.writeSkillDocument(existing.absolutePath, nextDocument);

    return this.readSkillRecord(existing.absolutePath);
  }

  delete(name: string): void {
    const normalizedName = normalizeSkillName(name);
    const existing = this.getByName(normalizedName);
    if (!existing) {
      throw new Error(`Skill "${normalizedName}" does not exist`);
    }

    // Remove the skill directory (category/name/) containing the SKILL.md file
    const skillDir = dirname(existing.absolutePath);
    ensurePathWithinRoot(this.managedRootDir, skillDir);
    rmSync(skillDir, { recursive: true, force: true });

    // Try to remove the category directory if it's now empty
    const categoryDir = dirname(skillDir);
    if (existsSync(categoryDir) && lstatSync(categoryDir).isDirectory()) {
      const remaining = readdirSync(categoryDir);
      if (remaining.length === 0) {
        rmSync(categoryDir, { recursive: true, force: true });
      }
    }
  }

  private listManagedSkillFiles(): string[] {
    if (!existsSync(this.managedRootDir)) return [];
    if (!lstatSync(this.managedRootDir).isDirectory()) return [];

    const files: string[] = [];
    const categoryEntries = readdirSync(this.managedRootDir, { withFileTypes: true });
    for (const categoryEntry of categoryEntries) {
      if (categoryEntry.isSymbolicLink() || !categoryEntry.isDirectory()) continue;

      const categoryPath = join(this.managedRootDir, categoryEntry.name);
      const skillEntries = readdirSync(categoryPath, { withFileTypes: true });
      for (const skillEntry of skillEntries) {
        if (skillEntry.isSymbolicLink() || !skillEntry.isDirectory()) continue;

        const skillPath = join(categoryPath, skillEntry.name);
        const documentPath = join(skillPath, SKILL_FILE_NAME);
        if (!existsSync(documentPath)) continue;
        if (!lstatSync(documentPath).isFile()) continue;
        files.push(documentPath);
      }
    }

    return files;
  }

  private readSkillRecord(absolutePath: string): ManagedSkillRecord {
    ensurePathWithinRoot(this.managedRootDir, absolutePath);

    const document = readFileSync(absolutePath, 'utf-8');
    const relativePath = this.toDisplayPath(absolutePath);
    const parsed = parseSkillDocument(document, relativePath);
    const stats = statSync(absolutePath);
    const pathCategory = this.extractCategoryFromPath(absolutePath);

    const name = normalizeSkillName(parsed.frontmatter.name);
    const description = normalizeDescription(parsed.frontmatter.description);
    const category = normalizeSkillCategory(parsed.frontmatter.category ?? pathCategory);
    const version = parsed.frontmatter.version ?? 1;
    if (!Number.isInteger(version) || version < 1) {
      throw new Error(`Skill "${name}" has invalid version`);
    }

    const createdAt = normalizeIsoTimestamp(
      parsed.frontmatter.createdAt ?? stats.birthtime.toISOString(),
      'created',
    );
    const updatedAt = normalizeIsoTimestamp(
      parsed.frontmatter.updatedAt ?? stats.mtime.toISOString(),
      'updated',
    );

    return {
      name,
      description,
      category,
      version,
      createdAt,
      updatedAt,
      content: parsed.body.trim(),
      absolutePath,
      relativePath,
    };
  }

  private resolveSkillFilePath(category: string, name: string): string {
    const absolutePath = resolve(this.managedRootDir, category, name, SKILL_FILE_NAME);
    ensurePathWithinRoot(this.managedRootDir, absolutePath);
    return absolutePath;
  }

  private writeSkillDocument(absolutePath: string, document: string): void {
    ensurePathWithinRoot(this.managedRootDir, absolutePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, document, 'utf-8');
  }

  private resolveHistoryPath(skillDocumentPath: string): string {
    const historyPath = join(dirname(skillDocumentPath), SKILL_HISTORY_FILE_NAME);
    ensurePathWithinRoot(this.managedRootDir, historyPath);
    return historyPath;
  }

  private appendHistoryEntry(skillDocumentPath: string, entry: ManagedSkillHistoryEntry): void {
    appendJsonLine(this.resolveHistoryPath(skillDocumentPath), entry);
  }

  private readHistoryEntries(skillDocumentPath: string): ManagedSkillHistoryEntry[] {
    return readJsonLines<ManagedSkillHistoryEntry>(
      this.resolveHistoryPath(skillDocumentPath),
      raw => raw as ManagedSkillHistoryEntry,
      { warnLabel: 'Skipping unreadable managed skill history line' },
    ).entries;
  }

  private toDisplayPath(absolutePath: string): string {
    const rel = toPosix(relative(this.repoRoot, absolutePath));
    if (rel && !rel.startsWith('..')) return rel;
    return toPosix(absolutePath);
  }

  private extractCategoryFromPath(absolutePath: string): string {
    const rel = toPosix(relative(this.managedRootDir, absolutePath));
    const [category] = rel.split('/');
    if (!category) {
      throw new Error('Unable to determine skill category from path');
    }
    return category;
  }
}
