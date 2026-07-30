import { basename, extname } from 'node:path';
import { loadPlacesRegistryConfig } from '../../channels/backplane/places-registry.js';
import {
  importMarkdownFiles,
  type MarkdownImportFile,
} from '../../faculties/wiki/bulk-import.js';
import { publishSiteWiki } from '../../faculties/wiki/places-wiki-publication.js';
import { sharedWorldScope } from '../../faculties/wiki/scope.js';
import { SharedWorldWikiStore, normalizeWikiDocumentId } from '../../faculties/wiki/store.js';
import {
  WIKI_SOURCE_CLASSES,
  type WikiDocumentUpsertInput,
  type WikiSourceClass,
} from '../../faculties/wiki/types.js';
import { assertNoUnknownKeys, isRecord } from '../../shared/utils/types.js';
import {
  VALID_SENSITIVITY_LEVELS,
  type SensitivityLevel,
} from '../../system/trust/types.js';

export type SharedWorldWikiDocumentWriteInput = Pick<
  WikiDocumentUpsertInput,
  | 'id'
  | 'title'
  | 'body'
  | 'tags'
  | 'sourceClass'
  | 'provenanceRefs'
  | 'sensitivity'
  | 'summary'
  | 'updatedBy'
>;

export type SharedWorldWikiWriteRequest =
  | {
      kind: 'shared_world_wiki';
      operation: 'publish_site';
      siteId: string;
      updatedBy: string;
    }
  | {
      kind: 'shared_world_wiki';
      operation: 'import_files';
      siteId: string;
      directory: string;
      files: MarkdownImportFile[];
      updatedBy: string;
    }
  | {
      kind: 'shared_world_wiki';
      operation: 'upsert_document';
      siteId: string;
      document: SharedWorldWikiDocumentWriteInput;
    };

const SHARED_WORLD_WIKI_PROTOCOL_BOUNDS = Object.freeze({
  stringLength: 4_096,
  stringListCount: 4_096,
  documentChars: 1_048_576,
  importFileCount: 512,
  importTotalChars: 8_388_608,
});

function isBoundedString(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= SHARED_WORLD_WIKI_PROTOCOL_BOUNDS.stringLength;
}

function parseSiteId(value: unknown): string {
  if (!isBoundedString(value)) {
    throw new Error('system.data.write shared-world wiki siteId must be a bounded string');
  }
  const siteId = value.trim();
  sharedWorldScope(siteId);
  return siteId;
}

function parseUpdatedBy(value: unknown): string {
  if (!isBoundedString(value)) {
    throw new Error('system.data.write shared-world wiki updatedBy must be a bounded string');
  }
  return value.trim();
}

function parseStringList(
  value: unknown,
  field: string,
): readonly string[] | string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    if (value.length > SHARED_WORLD_WIKI_PROTOCOL_BOUNDS.stringLength) {
      throw new Error(`system.data.write shared-world wiki ${field} is too long`);
    }
    return value;
  }
  if (!Array.isArray(value)
    || value.length > SHARED_WORLD_WIKI_PROTOCOL_BOUNDS.stringListCount) {
    throw new Error(`system.data.write shared-world wiki ${field} must be a bounded string array`);
  }
  if (!value.every(isBoundedString)) {
    throw new Error(`system.data.write shared-world wiki ${field} contains an invalid string`);
  }
  return value;
}

function parseDocument(value: unknown): SharedWorldWikiDocumentWriteInput {
  if (!isRecord(value)) {
    throw new Error('system.data.write shared-world wiki document must be an object');
  }
  assertNoUnknownKeys(
    value,
    [
      'id',
      'title',
      'body',
      'tags',
      'sourceClass',
      'provenanceRefs',
      'sensitivity',
      'summary',
      'updatedBy',
    ],
    'system.data.write shared-world wiki document',
  );
  if (!isBoundedString(value.id)) {
    throw new Error('system.data.write shared-world wiki document id must be a bounded string');
  }
  const id = normalizeWikiDocumentId(value.id);
  if (!isBoundedString(value.title)) {
    throw new Error('system.data.write shared-world wiki document title must be a bounded string');
  }
  if (typeof value.body !== 'string'
    || value.body.length === 0
    || value.body.length > SHARED_WORLD_WIKI_PROTOCOL_BOUNDS.documentChars) {
    throw new Error('system.data.write shared-world wiki document body is invalid');
  }
  if (value.sourceClass !== undefined
    && (typeof value.sourceClass !== 'string'
      || !WIKI_SOURCE_CLASSES.includes(value.sourceClass as WikiSourceClass))) {
    throw new Error('system.data.write shared-world wiki document sourceClass is invalid');
  }
  if (value.sensitivity !== undefined
    && (typeof value.sensitivity !== 'string'
      || !VALID_SENSITIVITY_LEVELS.includes(value.sensitivity as SensitivityLevel))) {
    throw new Error('system.data.write shared-world wiki document sensitivity is invalid');
  }
  if (value.summary !== undefined && !isBoundedString(value.summary)) {
    throw new Error('system.data.write shared-world wiki document summary is invalid');
  }
  if (value.updatedBy !== undefined && !isBoundedString(value.updatedBy)) {
    throw new Error('system.data.write shared-world wiki document updatedBy is invalid');
  }
  const tags = parseStringList(value.tags, 'tags');
  const provenanceRefs = parseStringList(value.provenanceRefs, 'provenanceRefs');
  return {
    id,
    title: value.title.trim(),
    body: value.body,
    ...(tags !== undefined ? { tags } : {}),
    ...(value.sourceClass !== undefined
      ? { sourceClass: value.sourceClass as WikiSourceClass }
      : {}),
    ...(provenanceRefs !== undefined ? { provenanceRefs } : {}),
    ...(value.sensitivity !== undefined
      ? { sensitivity: value.sensitivity as SensitivityLevel }
      : {}),
    ...(value.summary !== undefined ? { summary: value.summary.trim() } : {}),
    ...(value.updatedBy !== undefined ? { updatedBy: value.updatedBy.trim() } : {}),
  };
}

function parseImportFiles(value: unknown): MarkdownImportFile[] {
  if (!Array.isArray(value)
    || value.length > SHARED_WORLD_WIKI_PROTOCOL_BOUNDS.importFileCount) {
    throw new Error('system.data.write shared-world wiki files must be a bounded array');
  }
  let totalChars = 0;
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`system.data.write shared-world wiki file ${index} must be an object`);
    }
    assertNoUnknownKeys(
      entry,
      ['file', 'title', 'body'],
      `system.data.write shared-world wiki file ${index}`,
    );
    if (!isBoundedString(entry.file)
      || basename(entry.file) !== entry.file
      || extname(entry.file).toLowerCase() !== '.md') {
      throw new Error(`system.data.write shared-world wiki file ${index} has an invalid name`);
    }
    if (!isBoundedString(entry.title)) {
      throw new Error(`system.data.write shared-world wiki file ${index} has an invalid title`);
    }
    if (typeof entry.body !== 'string'
      || entry.body.length > SHARED_WORLD_WIKI_PROTOCOL_BOUNDS.documentChars) {
      throw new Error(`system.data.write shared-world wiki file ${index} has an invalid body`);
    }
    totalChars += entry.body.length;
    if (totalChars > SHARED_WORLD_WIKI_PROTOCOL_BOUNDS.importTotalChars) {
      throw new Error('system.data.write shared-world wiki import payload is too large');
    }
    return {
      file: entry.file,
      title: entry.title,
      body: entry.body,
    };
  });
}

export function parseSharedWorldWikiWriteRequest(
  value: Record<string, unknown>,
): SharedWorldWikiWriteRequest {
  if (value.operation === 'publish_site') {
    assertNoUnknownKeys(
      value,
      ['kind', 'operation', 'siteId', 'updatedBy'],
      'system.data.write shared-world wiki publish params',
    );
    return {
      kind: 'shared_world_wiki',
      operation: 'publish_site',
      siteId: parseSiteId(value.siteId),
      updatedBy: parseUpdatedBy(value.updatedBy),
    };
  }
  if (value.operation === 'import_files') {
    assertNoUnknownKeys(
      value,
      ['kind', 'operation', 'siteId', 'directory', 'files', 'updatedBy'],
      'system.data.write shared-world wiki import params',
    );
    if (!isBoundedString(value.directory)) {
      throw new Error('system.data.write shared-world wiki directory must be a bounded string');
    }
    return {
      kind: 'shared_world_wiki',
      operation: 'import_files',
      siteId: parseSiteId(value.siteId),
      directory: value.directory.trim(),
      files: parseImportFiles(value.files),
      updatedBy: parseUpdatedBy(value.updatedBy),
    };
  }
  if (value.operation === 'upsert_document') {
    assertNoUnknownKeys(
      value,
      ['kind', 'operation', 'siteId', 'document'],
      'system.data.write shared-world wiki upsert params',
    );
    return {
      kind: 'shared_world_wiki',
      operation: 'upsert_document',
      siteId: parseSiteId(value.siteId),
      document: parseDocument(value.document),
    };
  }
  throw new Error('system.data.write shared-world wiki operation is unsupported');
}

export function executeSharedWorldWikiWrite(
  request: SharedWorldWikiWriteRequest,
  systemDataDir: string,
): void {
  const store = new SharedWorldWikiStore(systemDataDir, request.siteId);
  switch (request.operation) {
    case 'publish_site':
      publishSiteWiki(
        store,
        loadPlacesRegistryConfig(systemDataDir),
        request.siteId,
        { updatedBy: request.updatedBy },
      );
      break;
    case 'import_files':
      importMarkdownFiles({
        directory: request.directory,
        files: request.files,
        store,
        scope: store.scope,
        personalFactGuard: true,
        updatedBy: request.updatedBy,
        failOnWriteError: true,
      });
      break;
    case 'upsert_document':
      store.upsert(request.document);
      break;
  }
}
