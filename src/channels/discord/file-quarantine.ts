import { extname } from 'node:path';
import {
  inferOfficeExpectedContentTypeFromName,
  inspectOfficeOpenXmlDocument,
  OFFICE_MACRO_OR_LEGACY_CONTENT_TYPES,
  OFFICE_MACRO_OR_LEGACY_EXTENSION_CONTENT_TYPES,
} from './office-document.js';
import { listZipEntryNames } from './zip-container.js';

const QUARANTINE_STATUS = 'quarantined_pending_review';
export const DISCORD_ATTACHMENT_QUARANTINE_STATUS = QUARANTINE_STATUS;
const ARCHIVE_EXTENSIONS = new Set([
  '.7z',
  '.bz2',
  '.gz',
  '.rar',
  '.tar',
  '.tgz',
  '.txz',
  '.xz',
  '.zip',
  '.zst',
]);
const RISKY_CODE_OR_SCRIPT_EXTENSIONS = new Set([
  '.bat',
  '.c',
  '.cc',
  '.cjs',
  '.class',
  '.cmd',
  '.com',
  '.cpp',
  '.cs',
  '.dll',
  '.dylib',
  '.exe',
  '.fish',
  '.go',
  '.h',
  '.hpp',
  '.jar',
  '.java',
  '.js',
  '.jsx',
  '.kt',
  '.kts',
  '.lua',
  '.mjs',
  '.php',
  '.pl',
  '.ps1',
  '.py',
  '.rb',
  '.rs',
  '.run',
  '.sh',
  '.so',
  '.sql',
  '.swift',
  '.ts',
  '.tsx',
  '.vb',
  '.wasm',
  '.zsh',
]);
const ARCHIVE_CONTENT_TYPES = new Set([
  'application/gzip',
  'application/java-archive',
  'application/rar',
  'application/vnd.rar',
  'application/x-7z-compressed',
  'application/x-bzip2',
  'application/x-compressed',
  'application/x-gtar',
  'application/x-gzip',
  'application/x-rar-compressed',
  'application/x-tar',
  'application/x-xz',
  'application/zip',
]);
const EXECUTABLE_CONTENT_TYPES = new Set([
  'application/java-archive',
  'application/vnd.microsoft.portable-executable',
  'application/wasm',
  'application/x-dosexec',
  'application/x-executable',
  'application/x-mach-binary',
  'application/x-msdownload',
  'application/x-sharedlib',
]);
const CODE_OR_SCRIPT_CONTENT_TYPES = new Set([
  'application/javascript',
  'application/json+codex-plugin',
  'application/typescript',
  'application/x-httpd-php',
  'application/x-javascript',
  'application/x-python',
  'application/x-python-code',
  'application/x-ruby',
  'application/x-sh',
  'application/x-shellscript',
  'text/ecmascript',
  'text/javascript',
  'text/jsx',
  'text/x-go',
  'text/x-java-source',
  'text/x-lua',
  'text/x-php',
  'text/x-python',
  'text/x-ruby',
  'text/x-script.python',
  'text/x-sh',
  'text/x-shellscript',
  'text/x-typescript',
  'text/tsx',
]);
const EXPECTED_EXTENSION_CONTENT_TYPES: Readonly<Partial<Record<string, string>>> = Object.freeze({
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.zip': 'application/zip',
});
const MAX_ARCHIVE_ENTRIES_TO_REPORT = 5;

export type DiscordAttachmentQuarantineStatus = typeof QUARANTINE_STATUS;

export interface DiscordAttachmentQuarantineDecision {
  quarantined: boolean;
  status: DiscordAttachmentQuarantineStatus;
  reasons: string[];
  sniffedContentType?: string;
}

export function normalizeDiscordAttachmentContentType(value: string | null | undefined): string {
  return (value ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
}

function addReason(reasons: Set<string>, reason: string): void {
  if (reason.trim()) reasons.add(reason);
}

function normalizeAttachmentPath(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase();
}

function isSkillManifestName(name: string): boolean {
  const normalized = normalizeAttachmentPath(name);
  return normalized === 'skill.md' || normalized.endsWith('/skill.md');
}

function isPluginManifestName(name: string): boolean {
  const normalized = normalizeAttachmentPath(name);
  return normalized === 'plugin.json'
    || normalized.endsWith('/plugin.json')
    || normalized.endsWith('/.codex-plugin/plugin.json');
}

function extensionOf(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.tar.gz')) return '.tgz';
  if (lower.endsWith('.tar.xz')) return '.txz';
  return extname(lower);
}

function inferExpectedContentTypeFromName(name: string): string | null {
  const extension = extensionOf(name);
  return EXPECTED_EXTENSION_CONTENT_TYPES[extension]
    ?? inferOfficeExpectedContentTypeFromName(name)
    ?? null;
}

function isArchiveExtension(name: string): boolean {
  return ARCHIVE_EXTENSIONS.has(extensionOf(name));
}

function appendNameQuarantineReasons(name: string, reasons: Set<string>): void {
  const extension = extensionOf(name);
  if (RISKY_CODE_OR_SCRIPT_EXTENSIONS.has(extension)) {
    addReason(reasons, `risky_extension:${extension}`);
  }
  if (OFFICE_MACRO_OR_LEGACY_EXTENSION_CONTENT_TYPES.has(extension)) {
    addReason(reasons, `office_macro_or_legacy_extension:${extension}`);
  }
  if (isArchiveExtension(name)) {
    addReason(reasons, `archive_extension:${extension}`);
  }
  if (isSkillManifestName(name)) {
    addReason(reasons, 'skill_manifest_name');
  }
  if (isPluginManifestName(name)) {
    addReason(reasons, 'plugin_manifest_name');
  }
}

function appendContentTypeQuarantineReasons(contentType: string, reasons: Set<string>): void {
  if (!contentType || contentType === 'application/octet-stream') return;
  if (ARCHIVE_CONTENT_TYPES.has(contentType)) {
    addReason(reasons, `archive_mime:${contentType}`);
  }
  if (EXECUTABLE_CONTENT_TYPES.has(contentType)) {
    addReason(reasons, `executable_mime:${contentType}`);
  }
  if (CODE_OR_SCRIPT_CONTENT_TYPES.has(contentType)) {
    addReason(reasons, `code_mime:${contentType}`);
  }
  if (OFFICE_MACRO_OR_LEGACY_CONTENT_TYPES.has(contentType)) {
    addReason(reasons, `office_macro_or_legacy_mime:${contentType}`);
  }
}

function appendDeclaredExtensionMismatchReasons(
  name: string,
  contentType: string,
  reasons: Set<string>,
): void {
  if (!contentType || contentType === 'application/octet-stream') return;
  const expectedContentType = inferExpectedContentTypeFromName(name);
  if (!expectedContentType || areCompatibleContentTypes(contentType, expectedContentType)) return;
  addReason(
    reasons,
    `declared_extension_mismatch:declared=${contentType};expected=${expectedContentType}`,
  );
}

function hasExecutableModeBits(mode: number | undefined): boolean {
  return typeof mode === 'number' && Number.isFinite(mode) && (Math.trunc(mode) & 0o111) !== 0;
}

function startsWithBytes(bytes: Uint8Array, values: readonly number[]): boolean {
  if (bytes.byteLength < values.length) return false;
  return values.every((value, index) => bytes[index] === value);
}

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return startsWithBytes(bytes, [0xef, 0xbb, 0xbf]);
}

function hasShebang(bytes: Uint8Array): boolean {
  const offset = hasUtf8Bom(bytes) ? 3 : 0;
  return bytes.byteLength >= offset + 2 && bytes[offset] === 0x23 && bytes[offset + 1] === 0x21;
}

function isProbablyText(bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0) return true;

  let suspicious = 0;
  const sampleLength = Math.min(bytes.byteLength, 4096);
  for (let index = 0; index < sampleLength; index += 1) {
    const byte = bytes[index];
    if (byte === 0) return false;
    const isAllowedControl = byte === 0x09 || byte === 0x0a || byte === 0x0d;
    const isPrintableAscii = byte >= 0x20 && byte <= 0x7e;
    const isUtf8ContinuationOrHigh = byte >= 0x80;
    if (!isAllowedControl && !isPrintableAscii && !isUtf8ContinuationOrHigh) {
      suspicious += 1;
    }
  }

  return suspicious / sampleLength < 0.02;
}

interface SniffedAttachmentContent {
  contentType: string;
  kind:
    | 'archive'
    | 'binary'
    | 'executable'
    | 'image'
    | 'office'
    | 'json'
    | 'pdf'
    | 'script'
    | 'tar'
    | 'text';
  officeQuarantineReasons?: string[];
}

function sniffDiscordAttachmentContent(bytes: Uint8Array): SniffedAttachmentContent {
  if (hasShebang(bytes)) return { kind: 'script', contentType: 'text/x-shellscript' };
  if (startsWithBytes(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return { kind: 'pdf', contentType: 'application/pdf' };
  }
  if (startsWithBytes(bytes, [0x50, 0x4b, 0x03, 0x04])
    || startsWithBytes(bytes, [0x50, 0x4b, 0x05, 0x06])
    || startsWithBytes(bytes, [0x50, 0x4b, 0x07, 0x08])) {
    const office = inspectOfficeOpenXmlDocument(bytes);
    if (office.kind === 'docx') {
      return {
        kind: 'office',
        contentType: office.contentType,
        officeQuarantineReasons: office.quarantineReasons,
      };
    }
    return { kind: 'archive', contentType: 'application/zip' };
  }
  if (startsWithBytes(bytes, [0x1f, 0x8b])) return { kind: 'archive', contentType: 'application/gzip' };
  if (startsWithBytes(bytes, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) {
    return { kind: 'archive', contentType: 'application/vnd.rar' };
  }
  if (startsWithBytes(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) {
    return { kind: 'archive', contentType: 'application/x-7z-compressed' };
  }
  if (startsWithBytes(bytes, [0x7f, 0x45, 0x4c, 0x46])) {
    return { kind: 'executable', contentType: 'application/x-executable' };
  }
  if (startsWithBytes(bytes, [0x4d, 0x5a])) return { kind: 'executable', contentType: 'application/x-dosexec' };
  if (startsWithBytes(bytes, [0x00, 0x61, 0x73, 0x6d])) return { kind: 'executable', contentType: 'application/wasm' };
  if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { kind: 'image', contentType: 'image/png' };
  }
  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) return { kind: 'image', contentType: 'image/jpeg' };
  if (startsWithBytes(bytes, [0x47, 0x49, 0x46, 0x38])) return { kind: 'image', contentType: 'image/gif' };
  if (isTarArchive(bytes)) return { kind: 'tar', contentType: 'application/x-tar' };
  if (isProbablyText(bytes)) {
    const text = decodeUtf8Preview(bytes, 4096).trimStart();
    if ((text.startsWith('{') || text.startsWith('[')) && parsesAsJson(text)) {
      return { kind: 'json', contentType: 'application/json' };
    }
    return { kind: 'text', contentType: 'text/plain' };
  }
  return { kind: 'binary', contentType: 'application/octet-stream' };
}

function decodeUtf8Preview(bytes: Uint8Array, maxBytes: number): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, maxBytes)).replace(/^\uFEFF/, '');
}

function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function areCompatibleContentTypes(left: string, right: string): boolean {
  if (left === right) return true;
  if (CODE_OR_SCRIPT_CONTENT_TYPES.has(left) || CODE_OR_SCRIPT_CONTENT_TYPES.has(right)) return false;
  if (left.startsWith('text/') && right.startsWith('text/')) return true;
  if (left === 'application/json' && right === 'text/plain') return true;
  if (left === 'text/plain' && right === 'application/json') return true;
  if (left === 'text/markdown' && right === 'text/plain') return true;
  if (left === 'text/plain' && right === 'text/markdown') return true;
  return false;
}

function appendSniffMismatchReasons(input: {
  name: string;
  contentType: string;
  declaredContentType: string;
  sniffedContentType: string;
  reasons: Set<string>;
}): void {
  const comparisonContentType = input.declaredContentType && input.declaredContentType !== 'application/octet-stream'
    ? input.declaredContentType
    : input.contentType;
  if (comparisonContentType
    && comparisonContentType !== 'application/octet-stream'
    && !areCompatibleContentTypes(comparisonContentType, input.sniffedContentType)) {
    addReason(
      input.reasons,
      `mime_sniff_mismatch:declared=${comparisonContentType};sniffed=${input.sniffedContentType}`,
    );
  }

  const expectedContentType = inferExpectedContentTypeFromName(input.name);
  if (expectedContentType && !areCompatibleContentTypes(expectedContentType, input.sniffedContentType)) {
    addReason(
      input.reasons,
      `extension_sniff_mismatch:expected=${expectedContentType};sniffed=${input.sniffedContentType}`,
    );
  }
}

function isPluginManifestJson(bytes: Uint8Array): boolean {
  const text = decodeUtf8Preview(bytes, 64 * 1024).trim();
  if (!text.startsWith('{')) return false;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object') return false;
    const record = parsed as Record<string, unknown>;
    return typeof record.name === 'string'
      && typeof record.version === 'string'
      && typeof record.interface === 'object'
      && record.interface !== null
      && (
        typeof record.skills === 'string'
        || typeof record.apps === 'string'
        || typeof record.mcpServers === 'string'
        || typeof record.mcp_servers === 'string'
      );
  } catch {
    return false;
  }
}

function isTarArchive(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 265
    && bytes[257] === 0x75
    && bytes[258] === 0x73
    && bytes[259] === 0x74
    && bytes[260] === 0x61
    && bytes[261] === 0x72;
}

function readTarString(bytes: Uint8Array, start: number, length: number): string {
  const end = Math.min(bytes.byteLength, start + length);
  let actualEnd = start;
  while (actualEnd < end && bytes[actualEnd] !== 0) actualEnd += 1;
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(start, actualEnd)).trim();
}

function readTarOctal(bytes: Uint8Array, start: number, length: number): number {
  const value = readTarString(bytes, start, length).replace(/\0/g, '').trim();
  if (!value) return 0;
  const parsed = Number.parseInt(value, 8);
  return Number.isFinite(parsed) ? parsed : 0;
}

function listTarEntries(bytes: Uint8Array): string[] {
  const entries: string[] = [];
  let offset = 0;
  while (offset + 512 <= bytes.byteLength && entries.length < MAX_ARCHIVE_ENTRIES_TO_REPORT * 4) {
    const block = bytes.slice(offset, offset + 512);
    if (block.every(byte => byte === 0)) break;
    const name = readTarString(block, 0, 100);
    const prefix = readTarString(block, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    if (fullName) entries.push(fullName);
    const size = readTarOctal(block, 124, 12);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function listZipLocalEntries(bytes: Uint8Array): string[] {
  try {
    return listZipEntryNames(bytes).slice(0, MAX_ARCHIVE_ENTRIES_TO_REPORT * 4);
  } catch {
    return [];
  }
}

function listArchiveEntries(bytes: Uint8Array, sniffedContentType: string): string[] {
  if (sniffedContentType === 'application/zip') return listZipLocalEntries(bytes);
  if (sniffedContentType === 'application/x-tar') return listTarEntries(bytes);
  return [];
}

function appendArchiveEntryReasons(
  bytes: Uint8Array,
  sniffedContentType: string,
  reasons: Set<string>,
): void {
  const entries = listArchiveEntries(bytes, sniffedContentType);
  let reported = 0;
  for (const entry of entries) {
    if (reported >= MAX_ARCHIVE_ENTRIES_TO_REPORT) break;
    const entryReasons = new Set<string>();
    appendNameQuarantineReasons(entry, entryReasons);
    if (entryReasons.size === 0) continue;
    addReason(reasons, `archive_contains_risky_entry:${entry}(${Array.from(entryReasons).join(',')})`);
    reported += 1;
  }
}

export function classifyDiscordAttachmentQuarantineRisk(input: {
  name: string;
  contentType?: string | null;
  declaredContentType?: string | null;
  bytes?: Uint8Array;
  mode?: number | null;
}): DiscordAttachmentQuarantineDecision {
  const reasons = new Set<string>();
  const contentType = normalizeDiscordAttachmentContentType(input.contentType);
  const declaredContentType = normalizeDiscordAttachmentContentType(input.declaredContentType ?? input.contentType);
  appendNameQuarantineReasons(input.name, reasons);
  appendContentTypeQuarantineReasons(declaredContentType || contentType, reasons);
  appendDeclaredExtensionMismatchReasons(input.name, declaredContentType || contentType, reasons);

  if (hasExecutableModeBits(input.mode ?? undefined)) {
    addReason(reasons, 'executable_mode_bits');
  }

  let sniffedContentType: string | undefined;
  if (input.bytes) {
    const sniffed = sniffDiscordAttachmentContent(input.bytes);
    sniffedContentType = sniffed.contentType;
    if (sniffed.kind === 'script') addReason(reasons, 'shebang');
    if (sniffed.kind === 'archive' || sniffed.kind === 'tar') {
      addReason(reasons, `archive_signature:${sniffed.contentType}`);
      appendArchiveEntryReasons(input.bytes, sniffed.contentType, reasons);
    }
    if (sniffed.kind === 'office') {
      for (const reason of sniffed.officeQuarantineReasons ?? []) {
        addReason(reasons, reason);
      }
      appendArchiveEntryReasons(input.bytes, 'application/zip', reasons);
    }
    if (sniffed.kind === 'executable') {
      addReason(reasons, `executable_signature:${sniffed.contentType}`);
    }
    appendSniffMismatchReasons({
      name: input.name,
      contentType,
      declaredContentType,
      sniffedContentType: sniffed.contentType,
      reasons,
    });
    if (isPluginManifestJson(input.bytes)) {
      addReason(reasons, 'plugin_manifest_content');
    }
  }

  return {
    quarantined: reasons.size > 0,
    status: QUARANTINE_STATUS,
    reasons: Array.from(reasons).sort(),
    ...(sniffedContentType ? { sniffedContentType } : {}),
  };
}

export function hasDiscordAttachmentMetadataQuarantineRisk(input: {
  name?: string | null;
  contentType?: string | null;
  mode?: number | null;
}): boolean {
  const name = input.name?.trim() || 'attachment';
  return classifyDiscordAttachmentQuarantineRisk({
    name,
    contentType: input.contentType,
    declaredContentType: input.contentType,
    ...(input.mode !== null && input.mode !== undefined ? { mode: input.mode } : {}),
  }).quarantined;
}
