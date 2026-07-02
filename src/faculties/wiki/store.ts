import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import {
  resolvePersonalWikiDir,
} from '../../persistence/layout.js';
import { resolveWorkspaceRoot } from '../../boundary/gateway/filesystem-paths.js';
import { isRecord } from '../../shared/utils/types.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import {
  VALID_SENSITIVITY_LEVELS,
  type SensitivityLevel,
} from '../../system/trust/types.js';
import {
  WIKI_BODY_FORMATS,
  WIKI_SOURCE_CLASSES,
  type WikiDocument,
  type WikiDocumentListEntry,
  type WikiDocumentMetadata,
  type WikiDocumentUpsertInput,
  type WikiSearchInput,
  type WikiSearchMatch,
  type WikiSearchResult,
  type WikiSourceClass,
  type WikiStorePort,
} from './types.js';

const WIKI_DOCUMENTS_DIRNAME = 'documents';
const WIKI_METADATA_DIRNAME = 'metadata';
const WIKI_DOCUMENT_EXTENSION = '.md';
const WIKI_METADATA_EXTENSION = '.json';
const WIKI_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const MAX_TITLE_CHARS = 180;
const MAX_SUMMARY_CHARS = 500;
const MAX_TAG_CHARS = 64;
const MAX_PROVENANCE_REF_CHARS = 512;
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 100;
const SOURCE_CLASSES_REQUIRING_PROVENANCE = new Set<WikiSourceClass>([
  'imported_partner_vault_note',
  'parsed_document',
  'generated_synthesis',
  'external_reference',
]);

interface WikiStoreOptions {
  now?: () => Date;
  /**
   * E8.3: fired after a document is committed to the canonical workspace, so a
   * pgvector projection can mirror it. The hook receives whatever was written
   * and must be side-effect-only from the store's perspective: it runs after
   * the write has durably landed and must never throw back into the write path
   * (projection failures fail closed for search, never block wiki writes). It
   * tolerates concurrent writers because it only projects the committed doc.
   */
  onUpsert?: (document: WikiDocument) => void;
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeNonEmptyString(value: unknown, field: string, maxChars?: number): string {
  if (typeof value !== 'string') {
    throw new Error(`wiki ${field} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`wiki ${field} must be non-empty`);
  }
  if (maxChars !== undefined && normalized.length > maxChars) {
    throw new Error(`wiki ${field} exceeds ${String(maxChars)} characters`);
  }
  return normalized;
}

function normalizeBody(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('wiki body must be a string');
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new Error('wiki body must be non-empty');
  }
  return normalized.endsWith('\n') ? normalized : `${normalized}\n`;
}

function slugifyTitle(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 96)
    .replace(/[._-]+$/g, '');
  if (!slug || !/^[a-z0-9]/.test(slug)) {
    throw new Error('wiki title cannot produce a safe document id');
  }
  return slug;
}

export function normalizeWikiDocumentId(value: unknown, fallbackTitle?: string): string {
  const candidate = typeof value === 'string' && value.trim()
    ? value.trim().toLowerCase()
    : (fallbackTitle ? slugifyTitle(fallbackTitle) : '');
  if (!candidate) {
    throw new Error('wiki id is required');
  }
  if (!WIKI_ID_PATTERN.test(candidate) || candidate.includes('..')) {
    throw new Error('wiki id contains invalid characters');
  }
  return candidate;
}

function normalizeStringArray(
  value: readonly string[] | string | undefined,
  field: string,
  maxItemChars: number,
  lowerCase = false,
): string[] {
  if (value === undefined) return [];
  const rawItems = typeof value === 'string' ? value.split(',') : value;
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const item of rawItems) {
    const trimmed = normalizeNonEmptyString(item, field, maxItemChars);
    const final = lowerCase ? trimmed.toLowerCase() : trimmed;
    if (seen.has(final)) continue;
    seen.add(final);
    normalized.push(final);
  }
  return normalized;
}

function normalizeSourceClass(value: unknown): WikiSourceClass {
  if (value === undefined) return 'companion_authored_note';
  if (typeof value !== 'string' || !WIKI_SOURCE_CLASSES.includes(value as WikiSourceClass)) {
    throw new Error(`wiki sourceClass must be one of: ${WIKI_SOURCE_CLASSES.join(', ')}`);
  }
  return value as WikiSourceClass;
}

function normalizeSensitivity(value: unknown): SensitivityLevel {
  if (value === undefined) return 'personal';
  if (typeof value !== 'string' || !VALID_SENSITIVITY_LEVELS.includes(value as SensitivityLevel)) {
    throw new Error(`wiki sensitivity must be one of: ${VALID_SENSITIVITY_LEVELS.join(', ')}`);
  }
  return value as SensitivityLevel;
}

function normalizeIsoTimestamp(value: unknown, field: string): string {
  const normalized = normalizeNonEmptyString(value, field);
  const parsed = Date.parse(normalized);
  if (Number.isNaN(parsed)) {
    throw new Error(`wiki ${field} must be valid ISO-8601`);
  }
  return new Date(parsed).toISOString();
}

function normalizePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`wiki ${field} must be an integer >= 1`);
  }
  return value;
}

function clampSearchLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_SEARCH_LIMIT;
  }
  return Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(value)));
}

function ensureProvenance(sourceClass: WikiSourceClass, provenanceRefs: string[]): void {
  if (SOURCE_CLASSES_REQUIRING_PROVENANCE.has(sourceClass) && provenanceRefs.length === 0) {
    throw new Error(`wiki sourceClass=${sourceClass} requires at least one provenance ref`);
  }
}

function previewText(value: string, maxChars = 240): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars)}...`;
}

function normalizePersistedMetadata(raw: unknown, body: string): WikiDocumentMetadata {
  if (!isRecord(raw)) {
    throw new Error('wiki metadata must be an object');
  }
  if (raw.schemaVersion !== 1) {
    throw new Error('wiki metadata schemaVersion must be 1');
  }
  const bodyFormat = raw.bodyFormat;
  if (typeof bodyFormat !== 'string' || !WIKI_BODY_FORMATS.includes(bodyFormat as 'markdown')) {
    throw new Error(`wiki bodyFormat must be one of: ${WIKI_BODY_FORMATS.join(', ')}`);
  }
  const metadata: WikiDocumentMetadata = {
    schemaVersion: 1,
    id: normalizeWikiDocumentId(raw.id),
    title: normalizeNonEmptyString(raw.title, 'title', MAX_TITLE_CHARS),
    bodyPath: normalizeNonEmptyString(raw.bodyPath, 'bodyPath'),
    bodyFormat: 'markdown',
    tags: normalizeStringArray(
      Array.isArray(raw.tags) ? raw.tags.filter((item): item is string => typeof item === 'string') : undefined,
      'tag',
      MAX_TAG_CHARS,
      true,
    ),
    sourceClass: normalizeSourceClass(raw.sourceClass),
    provenanceRefs: normalizeStringArray(
      Array.isArray(raw.provenanceRefs)
        ? raw.provenanceRefs.filter((item): item is string => typeof item === 'string')
        : undefined,
      'provenanceRef',
      MAX_PROVENANCE_REF_CHARS,
    ),
    sensitivity: normalizeSensitivity(raw.sensitivity),
    ...(typeof raw.summary === 'string' && raw.summary.trim()
      ? { summary: normalizeNonEmptyString(raw.summary, 'summary', MAX_SUMMARY_CHARS) }
      : {}),
    createdAt: normalizeIsoTimestamp(raw.createdAt, 'createdAt'),
    updatedAt: normalizeIsoTimestamp(raw.updatedAt, 'updatedAt'),
    updatedBy: normalizeNonEmptyString(raw.updatedBy, 'updatedBy', 120),
    version: normalizePositiveInteger(raw.version, 'version'),
    bodySha256: normalizeNonEmptyString(raw.bodySha256, 'bodySha256'),
  };
  ensureProvenance(metadata.sourceClass, metadata.provenanceRefs);
  if (metadata.bodySha256 !== sha256(body)) {
    throw new Error(`wiki body checksum mismatch: ${metadata.id}`);
  }
  return metadata;
}

export class WikiStore implements WikiStorePort {
  private readonly workspaceRoot: string;
  private readonly wikiRoot: string;
  private readonly documentsDir: string;
  private readonly metadataDir: string;
  private readonly now: () => Date;
  private readonly onUpsert?: (document: WikiDocument) => void;

  constructor(workspacePath: string, options: WikiStoreOptions = {}) {
    this.workspaceRoot = resolveWorkspaceRoot(workspacePath);
    this.wikiRoot = resolvePersonalWikiDir(this.workspaceRoot);
    this.documentsDir = join(this.wikiRoot, WIKI_DOCUMENTS_DIRNAME);
    this.metadataDir = join(this.wikiRoot, WIKI_METADATA_DIRNAME);
    this.now = options.now ?? (() => new Date());
    this.onUpsert = options.onUpsert;
  }

  getRootInfo() {
    return {
      workspaceRoot: this.workspaceRoot,
      wikiRoot: this.wikiRoot,
      documentsDir: this.documentsDir,
      metadataDir: this.metadataDir,
    };
  }

  list(): WikiDocumentListEntry[] {
    if (!existsSync(this.metadataDir)) return [];
    return readdirSync(this.metadataDir)
      .filter(file => file.endsWith(WIKI_METADATA_EXTENSION))
      .map(file => this.readDocumentById(basename(file, WIKI_METADATA_EXTENSION)))
      .map(document => ({
        ...this.metadataFromDocument(document),
        preview: document.summary ?? previewText(document.body),
        bodyCharCount: document.body.length,
      }))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.title.localeCompare(right.title));
  }

  get(id: string): WikiDocument | null {
    const normalizedId = normalizeWikiDocumentId(id);
    if (!existsSync(this.metadataPath(normalizedId))) return null;
    return this.readDocumentById(normalizedId);
  }

  upsert(input: WikiDocumentUpsertInput): WikiDocument {
    const title = normalizeNonEmptyString(input.title, 'title', MAX_TITLE_CHARS);
    const id = normalizeWikiDocumentId(input.id, title);
    const body = normalizeBody(input.body);
    const sourceClass = normalizeSourceClass(input.sourceClass);
    const provenanceRefs = normalizeStringArray(input.provenanceRefs, 'provenanceRef', MAX_PROVENANCE_REF_CHARS);
    ensureProvenance(sourceClass, provenanceRefs);

    const existing = this.get(id);
    const timestamp = this.now().toISOString();
    const bodyPath = this.bodyPath(id);
    const metadata: WikiDocumentMetadata = {
      schemaVersion: 1,
      id,
      title,
      bodyPath: toPosix(relative(this.wikiRoot, bodyPath)),
      bodyFormat: 'markdown',
      tags: normalizeStringArray(input.tags, 'tag', MAX_TAG_CHARS, true),
      sourceClass,
      provenanceRefs,
      sensitivity: normalizeSensitivity(input.sensitivity),
      ...(input.summary !== undefined
        ? { summary: normalizeNonEmptyString(input.summary, 'summary', MAX_SUMMARY_CHARS) }
        : {}),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      updatedBy: input.updatedBy ?? 'agent',
      version: existing ? existing.version + 1 : 1,
      bodySha256: sha256(body),
    };

    this.ensureDirs();
    writeFileSync(bodyPath, body, 'utf-8');
    writeJsonAtomic(this.metadataPath(id), metadata);
    const document: WikiDocument = { ...metadata, body };
    if (this.onUpsert) {
      // Projection is a best-effort mirror: never let a projection error escape
      // into the write path. The canonical workspace document is already
      // committed above.
      try {
        this.onUpsert(document);
      } catch {
        // Fail closed for search only; the write itself has succeeded.
      }
    }
    return document;
  }

  search(input: WikiSearchInput): WikiSearchResult {
    const query = normalizeNonEmptyString(input.query, 'query').toLowerCase();
    const limit = clampSearchLimit(input.limit);
    const matches: WikiSearchMatch[] = [];
    for (const document of this.list().map(entry => this.readDocumentById(entry.id))) {
      const haystacks = [
        document.title,
        document.summary ?? '',
        document.tags.join(' '),
        document.body,
      ].map(value => value.toLowerCase());
      if (!haystacks.some(value => value.includes(query))) continue;
      matches.push({
        id: document.id,
        title: document.title,
        sourceClass: document.sourceClass,
        sensitivity: document.sensitivity,
        path: document.bodyPath,
        preview: this.buildSearchPreview(document, query),
      });
      if (matches.length >= limit) break;
    }
    return {
      query: input.query.trim(),
      count: matches.length,
      matches,
    };
  }

  private metadataFromDocument(document: WikiDocument): WikiDocumentMetadata {
    const { body: _body, ...metadata } = document;
    return metadata;
  }

  private ensureDirs(): void {
    mkdirSync(this.documentsDir, { recursive: true });
    mkdirSync(this.metadataDir, { recursive: true });
  }

  private bodyPath(id: string): string {
    return resolve(this.documentsDir, `${id}${WIKI_DOCUMENT_EXTENSION}`);
  }

  private metadataPath(id: string): string {
    return resolve(this.metadataDir, `${id}${WIKI_METADATA_EXTENSION}`);
  }

  private readDocumentById(id: string): WikiDocument {
    const normalizedId = normalizeWikiDocumentId(id);
    const body = readFileSync(this.bodyPath(normalizedId), 'utf-8');
    const metadata = normalizePersistedMetadata(
      JSON.parse(readFileSync(this.metadataPath(normalizedId), 'utf-8')) as unknown,
      body,
    );
    return { ...metadata, body };
  }

  private buildSearchPreview(document: WikiDocument, lowerQuery: string): string {
    const lines = document.body.split(/\r?\n/);
    const matchingLine = lines.find(line => line.toLowerCase().includes(lowerQuery));
    return previewText(matchingLine ?? document.summary ?? document.body);
  }
}
