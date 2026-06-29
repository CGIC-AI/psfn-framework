import { extname } from 'node:path';
import { findZipEntry, readZipEntries, readZipEntryData, type ZipEntry } from './zip-container.js';

export const DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const DOCM_CONTENT_TYPE = 'application/vnd.ms-word.document.macroenabled.12';

const DOCX_MAIN_DOCUMENT_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const DOCM_MAIN_DOCUMENT_CONTENT_TYPE =
  'application/vnd.ms-word.document.macroenabled.main+xml';
const VBA_PROJECT_CONTENT_TYPE = 'application/vnd.ms-office.vbaproject';
const CONTENT_TYPES_ENTRY_NAME = '[Content_Types].xml';
const DOCX_MAIN_DOCUMENT_ENTRY_NAME = 'word/document.xml';
const MAX_OFFICE_XML_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_UNICODE_CODE_POINT = 0x10ffff;

const SUPPORTED_OFFICE_EXTENSION_CONTENT_TYPES = new Map<string, string>([
  ['.docx', DOCX_CONTENT_TYPE],
]);

export const OFFICE_MACRO_OR_LEGACY_EXTENSION_CONTENT_TYPES = new Map<string, string>([
  ['.doc', 'application/msword'],
  ['.docm', DOCM_CONTENT_TYPE],
  ['.dotm', 'application/vnd.ms-word.template.macroenabled.12'],
  ['.xls', 'application/vnd.ms-excel'],
  ['.xlsb', 'application/vnd.ms-excel.sheet.binary.macroenabled.12'],
  ['.xlsm', 'application/vnd.ms-excel.sheet.macroenabled.12'],
  ['.xltm', 'application/vnd.ms-excel.template.macroenabled.12'],
  ['.xlam', 'application/vnd.ms-excel.addin.macroenabled.12'],
  ['.ppt', 'application/vnd.ms-powerpoint'],
  ['.pptm', 'application/vnd.ms-powerpoint.presentation.macroenabled.12'],
  ['.potm', 'application/vnd.ms-powerpoint.template.macroenabled.12'],
  ['.ppam', 'application/vnd.ms-powerpoint.addin.macroenabled.12'],
  ['.ppsm', 'application/vnd.ms-powerpoint.slideshow.macroenabled.12'],
]);

export const OFFICE_MACRO_OR_LEGACY_CONTENT_TYPES = new Set<string>(
  OFFICE_MACRO_OR_LEGACY_EXTENSION_CONTENT_TYPES.values(),
);

export interface OfficeOpenXmlInspection {
  kind: 'docx' | 'unknown';
  contentType: string;
  entries: string[];
  quarantineReasons: string[];
}

export function inferSupportedOfficeContentTypeFromName(name: string): string | null {
  return SUPPORTED_OFFICE_EXTENSION_CONTENT_TYPES.get(extname(name).toLowerCase()) ?? null;
}

export function isSupportedOfficeDocumentContentType(contentType: string): boolean {
  return contentType === DOCX_CONTENT_TYPE;
}

export function inferOfficeExpectedContentTypeFromName(name: string): string | null {
  const extension = extname(name.toLowerCase());
  return SUPPORTED_OFFICE_EXTENSION_CONTENT_TYPES.get(extension)
    ?? OFFICE_MACRO_OR_LEGACY_EXTENSION_CONTENT_TYPES.get(extension)
    ?? null;
}

function readZipTextEntry(
  bytes: Uint8Array,
  entries: readonly ZipEntry[],
  name: string,
  maxBytes: number,
): string | null {
  const entry = findZipEntry(entries, name);
  if (!entry) return null;
  return readZipEntryData({ bytes, entry, maxUncompressedBytes: maxBytes }).toString('utf8');
}

function normalizeZipEntryName(name: string): string {
  return name.replace(/\\/g, '/').toLowerCase();
}

function inspectOfficeEntryRisk(entries: readonly string[]): string[] {
  const reasons = new Set<string>();
  for (const entryName of entries) {
    const normalized = normalizeZipEntryName(entryName);
    if (normalized.endsWith('/vbaproject.bin')) {
      reasons.add(`office_macro_entry:${entryName}`);
    }
    if (normalized === 'word/vbadata.xml' || normalized.endsWith('/vbadata.xml')) {
      reasons.add(`office_macro_entry:${entryName}`);
    }
    if (normalized.startsWith('word/activex/') || normalized.includes('/activex/')) {
      reasons.add(`office_active_content_entry:${entryName}`);
    }
    if (normalized.startsWith('word/embeddings/') || normalized.includes('/embeddings/')) {
      reasons.add(`office_embedded_object_entry:${entryName}`);
    }
  }
  return Array.from(reasons).sort();
}

function contentTypesIndicateMacroDocument(contentTypesXml: string): boolean {
  const normalized = contentTypesXml.toLowerCase();
  return normalized.includes(DOCM_MAIN_DOCUMENT_CONTENT_TYPE)
    || normalized.includes(VBA_PROJECT_CONTENT_TYPE)
    || normalized.includes('macroenabled');
}

export function inspectOfficeOpenXmlDocument(bytes: Uint8Array): OfficeOpenXmlInspection {
  let entries: ZipEntry[];
  try {
    entries = readZipEntries(bytes);
  } catch {
    return {
      kind: 'unknown',
      contentType: 'application/zip',
      entries: [],
      quarantineReasons: [],
    };
  }

  const entryNames = entries.map(entry => entry.name);
  const mainDocumentEntry = findZipEntry(entries, DOCX_MAIN_DOCUMENT_ENTRY_NAME);
  const contentTypesEntry = findZipEntry(entries, CONTENT_TYPES_ENTRY_NAME);
  if (!mainDocumentEntry || !contentTypesEntry) {
    return {
      kind: 'unknown',
      contentType: 'application/zip',
      entries: entryNames,
      quarantineReasons: [],
    };
  }

  let contentTypesXml = '';
  try {
    contentTypesXml = readZipTextEntry(
      bytes,
      entries,
      CONTENT_TYPES_ENTRY_NAME,
      MAX_OFFICE_XML_ENTRY_BYTES,
    ) ?? '';
  } catch {
    return {
      kind: 'unknown',
      contentType: 'application/zip',
      entries: entryNames,
      quarantineReasons: ['office_content_types_unreadable'],
    };
  }

  const normalizedContentTypes = contentTypesXml.toLowerCase();
  const macroEnabled = contentTypesIndicateMacroDocument(normalizedContentTypes);
  const hasDocxMainDocumentType = normalizedContentTypes.includes(DOCX_MAIN_DOCUMENT_CONTENT_TYPE);
  const hasDocmMainDocumentType = normalizedContentTypes.includes(DOCM_MAIN_DOCUMENT_CONTENT_TYPE);
  if (!hasDocxMainDocumentType && !hasDocmMainDocumentType) {
    return {
      kind: 'unknown',
      contentType: 'application/zip',
      entries: entryNames,
      quarantineReasons: [],
    };
  }

  const quarantineReasons = inspectOfficeEntryRisk(entryNames);
  if (macroEnabled) {
    quarantineReasons.push('office_macro_enabled');
  }

  return {
    kind: 'docx',
    contentType: macroEnabled ? DOCM_CONTENT_TYPE : DOCX_CONTENT_TYPE,
    entries: entryNames,
    quarantineReasons: Array.from(new Set(quarantineReasons)).sort(),
  };
}

function decodeXmlEntity(entity: string): string {
  if (entity === 'amp') return '&';
  if (entity === 'lt') return '<';
  if (entity === 'gt') return '>';
  if (entity === 'quot') return '"';
  if (entity === 'apos') return "'";
  if (entity.startsWith('#x')) {
    const parsed = Number.parseInt(entity.slice(2), 16);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX_UNICODE_CODE_POINT
      ? String.fromCodePoint(parsed)
      : `&${entity};`;
  }
  if (entity.startsWith('#')) {
    const parsed = Number.parseInt(entity.slice(1), 10);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX_UNICODE_CODE_POINT
      ? String.fromCodePoint(parsed)
      : `&${entity};`;
  }
  return `&${entity};`;
}

function decodeXmlText(text: string): string {
  return text.replace(/&([a-zA-Z]+|#x[0-9a-fA-F]+|#\d+);/g, (_match, entity: string) => decodeXmlEntity(entity));
}

function extractWordprocessingText(documentXml: string): string {
  const pieces: string[] = [];
  const tokenPattern = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:(?:br|cr)\b[^>]*\/>|<\/w:p>/g;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(documentXml)) !== null) {
    const token = match[0];
    const textMatch = match.at(1);
    if (token.startsWith('<w:t') && textMatch !== undefined) {
      pieces.push(decodeXmlText(textMatch));
    } else if (token.startsWith('<w:tab')) {
      pieces.push('\t');
    } else {
      pieces.push('\n');
    }
  }
  return pieces.join('');
}

export function parseDocxDocument(bytes: Uint8Array): string {
  const inspection = inspectOfficeOpenXmlDocument(bytes);
  if (
    inspection.kind !== 'docx'
    || inspection.contentType !== DOCX_CONTENT_TYPE
    || inspection.quarantineReasons.length > 0
  ) {
    throw new Error('unsupported or unsafe Office document container');
  }

  const entries = readZipEntries(bytes);
  const documentXml = readZipTextEntry(
    bytes,
    entries,
    DOCX_MAIN_DOCUMENT_ENTRY_NAME,
    MAX_OFFICE_XML_ENTRY_BYTES,
  );
  if (documentXml === null) {
    throw new Error('DOCX document.xml is missing');
  }
  return extractWordprocessingText(documentXml);
}
