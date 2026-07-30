import { basename, extname } from 'node:path';
import { loadPlacesRegistryConfig } from '../../channels/backplane/places-registry.js';
import {
  importMarkdownFiles,
  type MarkdownImportFile,
  type WikiImportEntry,
  type WikiImportRejection,
  type WikiImportReport,
} from '../../faculties/wiki/bulk-import.js';
import {
  publishSiteWiki,
  type PlacesWikiPublicationReport,
} from '../../faculties/wiki/places-wiki-publication.js';
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

export type SharedWorldWikiWriteResult =
  | {
      ok: true;
      kind: 'shared_world_wiki';
      operation: 'publish_site';
      report: PlacesWikiPublicationReport;
    }
  | {
      ok: true;
      kind: 'shared_world_wiki';
      operation: 'import_files';
      report: WikiImportReport;
    }
  | {
      ok: true;
      kind: 'shared_world_wiki';
      operation: 'upsert_document';
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
  const updatedBy = value.trim();
  if (!updatedBy) {
    throw new Error('system.data.write shared-world wiki updatedBy must be non-empty');
  }
  return updatedBy;
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
    ...(value.updatedBy !== undefined ? { updatedBy: parseUpdatedBy(value.updatedBy) } : {}),
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
): SharedWorldWikiWriteResult {
  const store = new SharedWorldWikiStore(systemDataDir, request.siteId);
  switch (request.operation) {
    case 'publish_site': {
      const report = publishSiteWiki(
        store,
        loadPlacesRegistryConfig(systemDataDir),
        request.siteId,
        { updatedBy: request.updatedBy },
      );
      return {
        ok: true,
        kind: 'shared_world_wiki',
        operation: 'publish_site',
        report,
      };
    }
    case 'import_files': {
      const report = importMarkdownFiles({
        directory: request.directory,
        files: request.files,
        store,
        scope: store.scope,
        personalFactGuard: true,
        updatedBy: request.updatedBy,
      });
      return {
        ok: true,
        kind: 'shared_world_wiki',
        operation: 'import_files',
        report,
      };
    }
    case 'upsert_document':
      store.upsert(request.document);
      return {
        ok: true,
        kind: 'shared_world_wiki',
        operation: 'upsert_document',
      };
  }
}

function parseStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)
    || value.length > SHARED_WORLD_WIKI_PROTOCOL_BOUNDS.stringListCount
    || !value.every(isBoundedString)) {
    throw new Error(`Gateway shared-world wiki ${field} is invalid`);
  }
  return value;
}

function parsePublicationReport(
  value: unknown,
  siteId: string,
): PlacesWikiPublicationReport {
  if (!isRecord(value)) {
    throw new Error('Gateway shared-world wiki publication report is invalid');
  }
  assertNoUnknownKeys(
    value,
    ['siteId', 'created', 'updated', 'unchanged', 'deleted'],
    'Gateway shared-world wiki publication report',
  );
  if (value.siteId !== siteId) {
    throw new Error('Gateway shared-world wiki publication report has the wrong siteId');
  }
  return {
    siteId,
    created: parseStringArray(value.created, 'created'),
    updated: parseStringArray(value.updated, 'updated'),
    unchanged: parseStringArray(value.unchanged, 'unchanged'),
    deleted: parseStringArray(value.deleted, 'deleted'),
  };
}

function parseImportEntries(value: unknown): WikiImportEntry[] {
  if (!Array.isArray(value)
    || value.length > SHARED_WORLD_WIKI_PROTOCOL_BOUNDS.importFileCount) {
    throw new Error('Gateway shared-world wiki imported entries are invalid');
  }
  return value.map((entry) => {
    if (!isRecord(entry)) {
      throw new Error('Gateway shared-world wiki imported entry is invalid');
    }
    assertNoUnknownKeys(
      entry,
      ['file', 'id', 'title'],
      'Gateway shared-world wiki imported entry',
    );
    if (!isBoundedString(entry.file)
      || !isBoundedString(entry.id)
      || !isBoundedString(entry.title)) {
      throw new Error('Gateway shared-world wiki imported entry is invalid');
    }
    return { file: entry.file, id: entry.id, title: entry.title };
  });
}

function parseImportRejections(value: unknown): WikiImportRejection[] {
  if (!Array.isArray(value)
    || value.length > SHARED_WORLD_WIKI_PROTOCOL_BOUNDS.importFileCount) {
    throw new Error('Gateway shared-world wiki import rejections are invalid');
  }
  return value.map((entry) => {
    if (!isRecord(entry)) {
      throw new Error('Gateway shared-world wiki import rejection is invalid');
    }
    assertNoUnknownKeys(
      entry,
      ['file', 'reason'],
      'Gateway shared-world wiki import rejection',
    );
    if (!isBoundedString(entry.file) || !isBoundedString(entry.reason)) {
      throw new Error('Gateway shared-world wiki import rejection is invalid');
    }
    return { file: entry.file, reason: entry.reason };
  });
}

function parseImportReport(
  value: unknown,
  request: Extract<SharedWorldWikiWriteRequest, { operation: 'import_files' }>,
): WikiImportReport {
  if (!isRecord(value)) {
    throw new Error('Gateway shared-world wiki import report is invalid');
  }
  assertNoUnknownKeys(
    value,
    ['directory', 'scope', 'personalFactGuard', 'imported', 'rejected'],
    'Gateway shared-world wiki import report',
  );
  const expectedScope = sharedWorldScope(request.siteId);
  if (value.directory !== request.directory
    || value.scope !== expectedScope
    || value.personalFactGuard !== true) {
    throw new Error('Gateway shared-world wiki import report metadata is invalid');
  }
  return {
    directory: request.directory,
    scope: expectedScope,
    personalFactGuard: true,
    imported: parseImportEntries(value.imported),
    rejected: parseImportRejections(value.rejected),
  };
}

export function parseSharedWorldWikiWriteResult(
  request: SharedWorldWikiWriteRequest,
  value: unknown,
): SharedWorldWikiWriteResult {
  if (!isRecord(value)
    || value.ok !== true
    || value.kind !== 'shared_world_wiki'
    || value.operation !== request.operation) {
    throw new Error('Gateway shared-world wiki writer returned an invalid response');
  }
  if (request.operation === 'publish_site') {
    assertNoUnknownKeys(
      value,
      ['ok', 'kind', 'operation', 'report'],
      'Gateway shared-world wiki publish response',
    );
    return {
      ok: true,
      kind: 'shared_world_wiki',
      operation: 'publish_site',
      report: parsePublicationReport(value.report, request.siteId),
    };
  }
  if (request.operation === 'import_files') {
    assertNoUnknownKeys(
      value,
      ['ok', 'kind', 'operation', 'report'],
      'Gateway shared-world wiki import response',
    );
    return {
      ok: true,
      kind: 'shared_world_wiki',
      operation: 'import_files',
      report: parseImportReport(value.report, request),
    };
  }
  assertNoUnknownKeys(
    value,
    ['ok', 'kind', 'operation'],
    'Gateway shared-world wiki upsert response',
  );
  return {
    ok: true,
    kind: 'shared_world_wiki',
    operation: 'upsert_document',
  };
}
