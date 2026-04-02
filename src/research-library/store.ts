import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  extname,
  join,
  relative,
  resolve,
} from 'node:path';
import { createComponentLogger } from '../logger.js';
import {
  resolveGeneratedImagesDir,
  resolveResearchLibraryDir,
  resolveResearchLibraryEntriesDir,
  resolveResearchLibraryEntryDir,
} from '../persistence/layout.js';
import { writeJsonAtomic } from '../utils/fs.js';
import type {
  ResearchLibraryEntryDetail,
  ResearchLibraryEntryManifest,
  ResearchLibraryEntryProvenance,
  ResearchLibraryEntrySummary,
  ResearchLibraryFileImportInput,
  ResearchLibraryStoredAsset,
  ResearchLibraryTextImportInput,
} from './types.js';

const log = createComponentLogger('ResearchLibraryStore');
const MANIFEST_FILE_NAME = 'manifest.json';
const NOTE_FILE_NAME = 'content.md';
const PREVIEW_MAX_CHARS = 12_000;

export interface ResearchLibraryStoreOptions {
  companionDataDir: string;
  workspacePath?: string;
}

function isStrictSubpath(path: string, root: string): boolean {
  const relativePath = relative(resolve(root), resolve(path));
  return relativePath.length > 0 && !relativePath.startsWith('..');
}

function assertNonEmpty(value: string | undefined, field: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${field} is required.`);
  }
  return normalized;
}

function sanitizeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'entry';
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'artifact';
}

function inferContentType(fileName: string): string {
  const extension = extname(fileName).trim().toLowerCase();
  switch (extension) {
    case '.md':
      return 'text/markdown';
    case '.txt':
    case '.log':
      return 'text/plain';
    case '.json':
      return 'application/json';
    case '.pdf':
      return 'application/pdf';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    default:
      return 'application/octet-stream';
  }
}

function canPreviewAsText(asset: ResearchLibraryStoredAsset): boolean {
  return asset.contentType.startsWith('text/') || asset.contentType === 'application/json';
}

function previewText(path: string): string | undefined {
  const content = readFileSync(path, 'utf-8');
  return content.length > PREVIEW_MAX_CHARS
    ? `${content.slice(0, PREVIEW_MAX_CHARS)}\n... (truncated)`
    : content;
}

function normalizeManifest(raw: unknown, manifestPath: string): ResearchLibraryEntryManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Invalid research-library manifest at ${manifestPath}`);
  }

  const manifest = raw as Record<string, unknown>;
  const asset = manifest.asset;
  const provenance = manifest.provenance;
  if (!asset || typeof asset !== 'object' || Array.isArray(asset)) {
    throw new Error(`Invalid research-library asset metadata at ${manifestPath}`);
  }
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) {
    throw new Error(`Invalid research-library provenance metadata at ${manifestPath}`);
  }

  return manifest as unknown as ResearchLibraryEntryManifest;
}

export class ResearchLibraryStore {
  readonly companionDataDir: string;
  readonly libraryDir: string;
  readonly entriesDir: string;
  private readonly workspaceRoot: string | null;
  private readonly generatedImagesDir: string;

  constructor(options: ResearchLibraryStoreOptions) {
    this.companionDataDir = resolve(options.companionDataDir);
    this.libraryDir = resolveResearchLibraryDir(this.companionDataDir);
    this.entriesDir = resolveResearchLibraryEntriesDir(this.companionDataDir);
    this.workspaceRoot = options.workspacePath ? resolve(options.workspacePath) : null;
    this.generatedImagesDir = resolve(resolveGeneratedImagesDir(this.companionDataDir));
    mkdirSync(this.entriesDir, { recursive: true });
  }

  listEntries(): ResearchLibraryEntrySummary[] {
    return readdirSync(this.entriesDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map((entry) => this.readManifest(entry.name))
      .map((manifest) => ({
        id: manifest.id,
        title: manifest.title,
        kind: manifest.kind,
        importedAt: manifest.importedAt,
        asset: manifest.asset,
        provenance: manifest.provenance,
      } satisfies ResearchLibraryEntrySummary))
      .sort((left, right) => right.importedAt.localeCompare(left.importedAt));
  }

  getEntry(id: string): ResearchLibraryEntryDetail | null {
    const normalizedId = assertNonEmpty(id, 'id');
    const entryDir = resolveResearchLibraryEntryDir(this.companionDataDir, normalizedId);
    if (!existsSync(entryDir)) {
      return null;
    }

    const manifest = this.readManifest(normalizedId);
    const absolutePath = join(this.libraryDir, manifest.asset.relativePath);
    return {
      manifest,
      ...(canPreviewAsText(manifest.asset) ? { previewText: previewText(absolutePath) } : {}),
      absolutePath,
    };
  }

  importText(input: ResearchLibraryTextImportInput): ResearchLibraryEntryManifest {
    const title = assertNonEmpty(input.title, 'title');
    const content = assertNonEmpty(input.content, 'content');
    const id = randomUUID();
    const entryDir = resolveResearchLibraryEntryDir(this.companionDataDir, id);
    const absoluteAssetPath = join(entryDir, NOTE_FILE_NAME);
    mkdirSync(entryDir, { recursive: true });
    writeFileSync(absoluteAssetPath, `${content}\n`, 'utf-8');
    const assetStats = statSync(absoluteAssetPath);
    const manifest = this.writeManifest(entryDir, {
      schemaVersion: 1,
      id,
      slug: sanitizeSlug(title),
      title,
      kind: 'note',
      importedAt: new Date().toISOString(),
      asset: {
        relativePath: relative(this.libraryDir, absoluteAssetPath),
        fileName: NOTE_FILE_NAME,
        contentType: 'text/markdown',
        sizeBytes: assetStats.size,
      },
      provenance: this.normalizeProvenance(input.provenance),
    });
    log.info('Imported direct text into research library', {
      id: manifest.id,
      title: manifest.title,
      sourceKind: manifest.provenance.sourceKind,
    });
    return manifest;
  }

  importFile(input: ResearchLibraryFileImportInput): ResearchLibraryEntryManifest {
    const sourcePath = this.resolveAllowedSourcePath(assertNonEmpty(input.path, 'path'));
    if (!existsSync(sourcePath)) {
      throw new Error(`Artifact not found: ${sourcePath}`);
    }
    const sourceStats = statSync(sourcePath);
    if (!sourceStats.isFile()) {
      throw new Error(`Artifact must be a file: ${sourcePath}`);
    }

    const id = randomUUID();
    const entryDir = resolveResearchLibraryEntryDir(this.companionDataDir, id);
    mkdirSync(entryDir, { recursive: true });
    const originalName = basename(sourcePath);
    const targetName = sanitizeFileName(originalName);
    const absoluteAssetPath = join(entryDir, targetName);
    copyFileSync(sourcePath, absoluteAssetPath);
    const assetStats = statSync(absoluteAssetPath);
    const title = input.title?.trim() || basename(originalName, extname(originalName));
    const manifest = this.writeManifest(entryDir, {
      schemaVersion: 1,
      id,
      slug: sanitizeSlug(title),
      title,
      kind: 'file',
      importedAt: new Date().toISOString(),
      asset: {
        relativePath: relative(this.libraryDir, absoluteAssetPath),
        fileName: targetName,
        contentType: inferContentType(targetName),
        sizeBytes: assetStats.size,
      },
      provenance: this.normalizeProvenance({
        ...input.provenance,
        sourceKind: this.resolveSourceKind(sourcePath),
        sourcePath,
      }),
    });
    log.info('Imported file into research library', {
      id: manifest.id,
      title: manifest.title,
      sourceKind: manifest.provenance.sourceKind,
      sourcePath,
    });
    return manifest;
  }

  promoteScratchpadEntry(params: {
    scratchpadEntryId: string;
    content: string;
    title?: string;
    note?: string;
    importedBy?: string;
  }): ResearchLibraryEntryManifest {
    const content = assertNonEmpty(params.content, 'content');
    const scratchpadEntryId = assertNonEmpty(params.scratchpadEntryId, 'scratchpadEntryId');
    const title = params.title?.trim() || `Scratchpad ${scratchpadEntryId}`;
    return this.importText({
      title,
      content,
      provenance: {
        sourceKind: 'scratchpad',
        scratchpadEntryId,
        ...(params.note?.trim() ? { note: params.note.trim() } : {}),
        ...(params.importedBy?.trim() ? { importedBy: params.importedBy.trim() } : {}),
      },
    });
  }

  private readManifest(entryId: string): ResearchLibraryEntryManifest {
    const manifestPath = join(resolveResearchLibraryEntryDir(this.companionDataDir, entryId), MANIFEST_FILE_NAME);
    const body = readFileSync(manifestPath, 'utf-8');
    return normalizeManifest(JSON.parse(body), manifestPath);
  }

  private writeManifest(entryDir: string, manifest: ResearchLibraryEntryManifest): ResearchLibraryEntryManifest {
    writeJsonAtomic(join(entryDir, MANIFEST_FILE_NAME), manifest);
    return manifest;
  }

  private resolveAllowedSourcePath(path: string): string {
    const resolved = resolve(path);
    if (isStrictSubpath(resolved, this.generatedImagesDir) || resolved === this.generatedImagesDir) {
      return resolved;
    }
    if (this.workspaceRoot && (isStrictSubpath(resolved, this.workspaceRoot) || resolved === this.workspaceRoot)) {
      return resolved;
    }
    throw new Error(
      'Only workspace files and previously generated media artifacts can be promoted into the research library.',
    );
  }

  private resolveSourceKind(sourcePath: string): ResearchLibraryEntryProvenance['sourceKind'] {
    const resolved = resolve(sourcePath);
    if (isStrictSubpath(resolved, this.generatedImagesDir) || resolved === this.generatedImagesDir) {
      return 'generated_media';
    }
    return 'workspace_file';
  }

  private normalizeProvenance(provenance: ResearchLibraryEntryProvenance): ResearchLibraryEntryProvenance {
    return {
      sourceKind: provenance.sourceKind,
      ...(provenance.scratchpadEntryId ? { scratchpadEntryId: provenance.scratchpadEntryId } : {}),
      ...(provenance.sourcePath ? { sourcePath: resolve(provenance.sourcePath) } : {}),
      ...(provenance.sourceUrl?.trim() ? { sourceUrl: provenance.sourceUrl.trim() } : {}),
      ...(provenance.note?.trim() ? { note: provenance.note.trim() } : {}),
      ...(provenance.importedBy?.trim() ? { importedBy: provenance.importedBy.trim() } : {}),
    };
  }
}
