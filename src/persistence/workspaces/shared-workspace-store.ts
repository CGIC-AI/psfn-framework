import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  realpathSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, extname, join, normalize, relative, resolve } from 'node:path';
import { isStrictSubpath } from '../layout.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import { isRecord } from '../../shared/utils/types.js';
import { SHARED_WORKSPACE_POLICY } from './provisioning.js';

const MAX_ARTIFACT_BYTES = 1_000_000;
const ALLOWED_ARTIFACT_EXTENSIONS = new Set(['.md', '.txt', '.json']);
const REVIEW_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface SharedWorkspaceActor {
  id: string;
  role: 'operator';
}

export interface SharedWorkspaceProposalInput {
  artifactPath: string;
  content: string;
  mediaType: 'text/markdown' | 'text/plain' | 'application/json';
  actor: SharedWorkspaceActor;
  provenance: string;
}

export interface SharedWorkspaceReviewInput {
  reviewId: string;
  reviewer: SharedWorkspaceActor;
  decision: 'approve' | 'reject';
  cogSecDecision: 'approved' | 'rejected';
  note?: string;
}

export interface SharedWorkspaceReviewRecord {
  reviewId: string;
  artifactPath: string;
  content: string;
  mediaType: SharedWorkspaceProposalInput['mediaType'];
  proposer: SharedWorkspaceActor;
  provenance: string;
  proposedAt: string;
  baseRevision: string | null;
  proposedRevision: string;
  status: 'pending' | 'approved' | 'rejected';
  reviewer?: SharedWorkspaceActor;
  reviewedAt?: string;
  cogSecDecision?: SharedWorkspaceReviewInput['cogSecDecision'];
  note?: string;
}

function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} must be a non-empty string`);
  if (trimmed.length > 4_096) throw new Error(`${field} exceeds the maximum length`);
  return trimmed;
}

function resolveArtifactPath(root: string, artifactPath: string): { relativePath: string; absolutePath: string } {
  const normalized = normalize(requireNonEmpty(artifactPath, 'artifactPath')).replace(/\\/g, '/');
  if (normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')) {
    throw new Error('Shared workspace artifactPath must be relative and contained');
  }
  if (normalized.split('/').some(segment => segment.startsWith('.'))) {
    throw new Error('Shared workspace artifacts cannot use hidden path segments');
  }
  if (!ALLOWED_ARTIFACT_EXTENSIONS.has(extname(normalized).toLowerCase())) {
    throw new Error('Shared workspace artifacts must be .md, .txt, or .json (executable formats are forbidden)');
  }
  const artifactsRoot = resolve(root, 'artifacts');
  const absolutePath = resolve(artifactsRoot, normalized);
  if (!isStrictSubpath(absolutePath, artifactsRoot)) {
    throw new Error('Shared workspace artifactPath escapes the artifacts root');
  }
  const canonicalArtifactsRoot = realpathSync(artifactsRoot);
  let existingAncestor = absolutePath;
  while (!existsSync(existingAncestor)) existingAncestor = dirname(existingAncestor);
  const canonicalAncestor = realpathSync(existingAncestor);
  if (canonicalAncestor !== canonicalArtifactsRoot
    && !isStrictSubpath(canonicalAncestor, canonicalArtifactsRoot)) {
    throw new Error('Shared workspace artifactPath resolves through a symlink outside the artifacts root');
  }
  return { relativePath: normalized, absolutePath };
}

function parseReview(path: string): SharedWorkspaceReviewRecord {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(parsed)
    || typeof parsed.reviewId !== 'string'
    || typeof parsed.artifactPath !== 'string'
    || typeof parsed.content !== 'string'
    || (parsed.status !== 'pending' && parsed.status !== 'approved' && parsed.status !== 'rejected')) {
    throw new Error(`Malformed Shared Companion Workspace review record: ${path}`);
  }
  return parsed as unknown as SharedWorkspaceReviewRecord;
}

function writeTextAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

export class SharedCompanionWorkspaceStore {
  constructor(private readonly root: string) {}

  getPolicy(): typeof SHARED_WORKSPACE_POLICY {
    return SHARED_WORKSPACE_POLICY;
  }

  listReviews(): SharedWorkspaceReviewRecord[] {
    const reviewsDir = join(this.root, 'reviews');
    return readdirSync(reviewsDir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => parseReview(join(reviewsDir, entry.name)))
      .sort((a, b) => b.proposedAt.localeCompare(a.proposedAt));
  }

  listArtifacts(): Array<{ artifactPath: string; revision: string }> {
    const artifactsRoot = join(this.root, 'artifacts');
    const results: Array<{ artifactPath: string; revision: string }> = [];
    const visit = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (entry.isFile()) {
          const content = readFileSync(path, 'utf8');
          results.push({
            artifactPath: relative(artifactsRoot, path).replace(/\\/g, '/'),
            revision: hashContent(content),
          });
        }
      }
    };
    visit(artifactsRoot);
    return results.sort((a, b) => a.artifactPath.localeCompare(b.artifactPath));
  }

  readArtifact(artifactPath: string): { artifactPath: string; content: string; revision: string } {
    const resolved = resolveArtifactPath(this.root, artifactPath);
    const content = readFileSync(resolved.absolutePath, 'utf8');
    return { artifactPath: resolved.relativePath, content, revision: hashContent(content) };
  }

  propose(input: SharedWorkspaceProposalInput): SharedWorkspaceReviewRecord {
    const resolved = resolveArtifactPath(this.root, input.artifactPath);
    requireNonEmpty(input.actor.id, 'actor.id');
    const provenance = requireNonEmpty(input.provenance, 'provenance');
    if (Buffer.byteLength(input.content, 'utf8') > MAX_ARTIFACT_BYTES) {
      throw new Error(`Shared workspace artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`);
    }
    if (input.mediaType === 'application/json') JSON.parse(input.content);
    const baseContent = existsSync(resolved.absolutePath)
      ? readFileSync(resolved.absolutePath, 'utf8')
      : null;
    const record: SharedWorkspaceReviewRecord = {
      reviewId: randomUUID(),
      artifactPath: resolved.relativePath,
      content: input.content,
      mediaType: input.mediaType,
      proposer: input.actor,
      provenance,
      proposedAt: new Date().toISOString(),
      baseRevision: baseContent === null ? null : hashContent(baseContent),
      proposedRevision: hashContent(input.content),
      status: 'pending',
    };
    writeFileSync(join(this.root, 'reviews', `${record.reviewId}.json`), `${JSON.stringify(record, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    this.appendProvenance('proposed', record);
    return record;
  }

  review(input: SharedWorkspaceReviewInput): SharedWorkspaceReviewRecord {
    requireNonEmpty(input.reviewer.id, 'reviewer.id');
    const reviewId = requireNonEmpty(input.reviewId, 'reviewId');
    if (!REVIEW_ID_PATTERN.test(reviewId)) throw new Error('reviewId must be a UUID');
    const reviewPath = join(this.root, 'reviews', `${reviewId}.json`);
    const record = parseReview(reviewPath);
    if (record.status !== 'pending') throw new Error(`Shared workspace review ${record.reviewId} is already resolved`);
    if (record.proposer.id === input.reviewer.id) {
      throw new Error('Shared workspace publication requires an independent reviewer');
    }
    if (input.decision === 'approve' && input.cogSecDecision !== 'approved') {
      throw new Error('Shared workspace publication requires CogSec approval');
    }

    const resolved = resolveArtifactPath(this.root, record.artifactPath);
    const lockPath = join(this.root, '.locks', `${createHash('sha256').update(record.artifactPath).digest('hex')}.lock`);
    const lock = openSync(lockPath, 'wx', 0o600);
    closeSync(lock);
    try {
      if (input.decision === 'approve') {
        const current = existsSync(resolved.absolutePath)
          ? hashContent(readFileSync(resolved.absolutePath, 'utf8'))
          : null;
        if (current !== record.baseRevision) {
          throw new Error('Shared workspace artifact changed after proposal; review is stale');
        }
        writeTextAtomic(resolved.absolutePath, record.content);
      }
      const updated: SharedWorkspaceReviewRecord = {
        ...record,
        status: input.decision === 'approve' ? 'approved' : 'rejected',
        reviewer: input.reviewer,
        reviewedAt: new Date().toISOString(),
        cogSecDecision: input.cogSecDecision,
        ...(input.note?.trim() ? { note: input.note.trim() } : {}),
      };
      writeJsonAtomic(reviewPath, updated);
      this.appendProvenance(updated.status, updated);
      return updated;
    } finally {
      unlinkSync(lockPath);
    }
  }

  private appendProvenance(event: string, record: SharedWorkspaceReviewRecord): void {
    appendFileSync(join(this.root, 'provenance', 'ledger.jsonl'), `${JSON.stringify({
      event,
      at: new Date().toISOString(),
      reviewId: record.reviewId,
      artifactPath: record.artifactPath,
      proposedRevision: record.proposedRevision,
      proposer: record.proposer,
      provenance: record.provenance,
      ...(record.reviewer ? { reviewer: record.reviewer } : {}),
      ...(record.cogSecDecision ? { cogSecDecision: record.cogSecDecision } : {}),
    })}\n`, 'utf8');
  }
}
