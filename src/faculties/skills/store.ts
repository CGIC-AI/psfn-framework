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
import { parseSkillDocument } from './loader.js';

const MANAGED_SKILLS_DIR = 'skills';
const SKILL_FILE_NAME = 'SKILL.md';
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

interface SkillStoreOptions {
  repoRoot?: string;
  now?: () => Date;
}

export function normalizeSkillName(name: string): string {
  return normalizeSegment(name, 'name', SKILL_NAME_PATTERN);
}

export function normalizeSkillCategory(category: string): string {
  return normalizeSegment(category, 'category', SKILL_CATEGORY_PATTERN);
}

export class SkillStore {
  private readonly managedRootDir: string;
  private readonly repoRoot: string;
  private readonly now: () => Date;

  constructor(dataDir: string, options: SkillStoreOptions = {}) {
    this.managedRootDir = resolve(dataDir, MANAGED_SKILLS_DIR);
    this.repoRoot = resolve(options.repoRoot ?? process.cwd());
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

  create(input: SkillCreateInput): ManagedSkillRecord {
    const name = normalizeSkillName(input.name);
    const category = normalizeSkillCategory(input.category);
    const content = normalizeContent(input.content);
    const existing = this.getByName(name);
    if (existing) {
      throw new Error(`Skill "${name}" already exists`);
    }

    const description = normalizeDescription(input.description ?? deriveDescription(content));
    const timestamp = this.now().toISOString();
    const absolutePath = this.resolveSkillFilePath(category, name);

    this.writeSkillDocument(absolutePath, {
      name,
      description,
      category,
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 1,
      content,
    });

    return this.readSkillRecord(absolutePath);
  }

  update(input: SkillUpdateInput): ManagedSkillRecord {
    const name = normalizeSkillName(input.name);
    const existing = this.getByName(name);
    if (!existing) {
      throw new Error(`Skill "${name}" does not exist`);
    }

    const content = normalizeContent(input.content);
    const description = normalizeDescription(input.description ?? existing.description);
    const updatedAt = this.now().toISOString();

    this.writeSkillDocument(existing.absolutePath, {
      name: existing.name,
      description,
      category: existing.category,
      createdAt: existing.createdAt,
      updatedAt,
      version: existing.version + 1,
      content,
    });

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

  private writeSkillDocument(absolutePath: string, payload: SkillDocumentPayload): void {
    ensurePathWithinRoot(this.managedRootDir, absolutePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, renderSkillDocument(payload), 'utf-8');
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
