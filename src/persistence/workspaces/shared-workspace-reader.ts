import { existsSync, realpathSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, extname, join, normalize, resolve } from 'node:path';
import { isRecord } from '../../shared/utils/types.js';
import { isStrictSubpath } from '../layout.js';
import {
  resumeSharedWorkspaceListing,
  selectSharedWorkspacePage,
  type SharedWorkspaceArtifactPage,
  type SharedWorkspaceListBounds,
} from './shared-workspace-bounds.js';

const REVIEWED_ARTIFACT_EXTENSIONS = new Set(['.md', '.txt', '.json']);
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

interface ApprovedArtifactProof {
  artifactPath: string;
  proposedRevision: string;
  reviewId: string;
  approvedAt: string;
}

function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function normalizeArtifactPath(requestedPath: unknown): string {
  if (typeof requestedPath !== 'string' || !requestedPath.trim()) {
    throw new Error('shared.workspace.read requires a non-empty artifactPath');
  }
  const artifactPath = normalize(requestedPath.trim()).replace(/\\/g, '/');
  if (artifactPath.startsWith('/')
    || artifactPath === '..'
    || artifactPath.startsWith('../')
    || artifactPath.split('/').some(segment => segment.startsWith('.'))
    || !REVIEWED_ARTIFACT_EXTENSIONS.has(extname(artifactPath).toLowerCase())) {
    throw new Error('Shared workspace artifact path is not a reviewed readable artifact');
  }
  return artifactPath;
}

/**
 * Phase one of a governed read: parse one approval event. Every field check the
 * event itself carries stays here, so a malformed approval anywhere in the
 * corpus still fails the whole listing. Only the cross-check against the review
 * record moves to phase two — the review embeds the full proposed content, and
 * reading every review on every list is exactly the unbounded aggregate cost
 * this path had to shed (psfn-framework-9jld5).
 */
function parseApprovalEvent(eventPath: string): ApprovedArtifactProof {
  const parsed: unknown = JSON.parse(readFileSync(eventPath, 'utf8'));
  if (!isRecord(parsed)
    || parsed.schemaVersion !== 1
    || parsed.event !== 'approved'
    || typeof parsed.at !== 'string'
    || !Number.isFinite(Date.parse(parsed.at))
    || typeof parsed.reviewId !== 'string'
    || basename(eventPath) !== `${parsed.reviewId}.approved.json`
    || typeof parsed.artifactPath !== 'string'
    || typeof parsed.proposedRevision !== 'string'
    || !SHA256_PATTERN.test(parsed.proposedRevision)) {
    throw new Error(`Malformed Shared Companion Workspace approval event: ${eventPath}`);
  }
  return {
    artifactPath: normalizeArtifactPath(parsed.artifactPath),
    proposedRevision: parsed.proposedRevision,
    reviewId: parsed.reviewId,
    approvedAt: parsed.at,
  };
}

/**
 * Phase two: prove the approval event against the review it claims. No artifact
 * is ever served without this, so paging bounds the work without weakening the
 * provenance an approved read asserts.
 */
function requireMatchingReview(root: string, proof: ApprovedArtifactProof): void {
  const reviewPath = join(root, 'reviews', `${proof.reviewId}.json`);
  if (!existsSync(reviewPath)) {
    throw new Error(`Shared Companion Workspace approval is missing its review: ${proof.reviewId}`);
  }
  const review: unknown = JSON.parse(readFileSync(reviewPath, 'utf8'));
  if (!isRecord(review)
    || review.status !== 'approved'
    || review.reviewId !== proof.reviewId
    || review.artifactPath !== proof.artifactPath
    || review.proposedRevision !== proof.proposedRevision) {
    throw new Error(`Shared Companion Workspace approval does not match its review: ${proof.reviewId}`);
  }
}

function loadLatestApprovedProofs(root: string): Map<string, ApprovedArtifactProof> {
  const eventsDir = join(root, 'provenance', 'events');
  if (!existsSync(eventsDir)) return new Map();
  const proofs = new Map<string, ApprovedArtifactProof>();
  for (const entry of readdirSync(eventsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.approved.json')) continue;
    const proof = parseApprovalEvent(join(eventsDir, entry.name));
    const previous = proofs.get(proof.artifactPath);
    if (!previous
      || proof.approvedAt > previous.approvedAt
      || (proof.approvedAt === previous.approvedAt && proof.reviewId > previous.reviewId)) {
      proofs.set(proof.artifactPath, proof);
    }
  }
  return proofs;
}

/**
 * Cheap byte cost of an approved artifact, used to fill a page's byte budget
 * before anything is read. A proof whose artifact is missing reports zero here
 * and fails legibly in {@link readApprovedArtifact} once the page selects it.
 */
function approvedArtifactBytes(root: string, proof: ApprovedArtifactProof): number {
  const absolutePath = resolve(root, 'artifacts', proof.artifactPath);
  try {
    return statSync(absolutePath).size;
  } catch {
    return 0;
  }
}

function readApprovedArtifact(
  root: string,
  proof: ApprovedArtifactProof,
): { artifactPath: string; content: string; revision: string } {
  const artifactsRoot = resolve(root, 'artifacts');
  const absolutePath = resolve(artifactsRoot, proof.artifactPath);
  if (!isStrictSubpath(absolutePath, artifactsRoot) || !existsSync(absolutePath)) {
    throw new Error('Shared workspace approved artifact does not exist');
  }
  const canonicalRoot = realpathSync(artifactsRoot);
  const canonicalPath = realpathSync(absolutePath);
  if (!isStrictSubpath(canonicalPath, canonicalRoot)) {
    throw new Error('Shared workspace artifact resolves outside the reviewed artifact root');
  }
  const content = readFileSync(canonicalPath, 'utf8');
  const revision = hashContent(content);
  if (revision !== proof.proposedRevision) {
    throw new Error(`Shared workspace artifact no longer matches its approved revision: ${proof.artifactPath}`);
  }
  return { artifactPath: proof.artifactPath, content, revision };
}

/** Deliberately read-only adapter; no proposal, review, autoload, or write API. */
export class SharedCompanionWorkspaceReader {
  constructor(private readonly root: string) {}

  /**
   * List reviewed artifacts one operator-bounded page at a time. Every artifact
   * a page returns is re-read and re-hashed against its approval, so an
   * out-of-band mutation still fails the call it appears in; what the bound
   * removes is the obligation to do that for the entire corpus at once.
   */
  listArtifacts(request: {
    bounds: SharedWorkspaceListBounds;
    cursor?: string;
  }): SharedWorkspaceArtifactPage {
    const ordered = [...loadLatestApprovedProofs(this.root).values()]
      .sort((a, b) => a.artifactPath.localeCompare(b.artifactPath));
    const remaining = resumeSharedWorkspaceListing(
      ordered,
      request.cursor,
      proof => proof.artifactPath,
    );
    const page = selectSharedWorkspacePage(
      remaining,
      request.bounds,
      proof => approvedArtifactBytes(this.root, proof),
    );
    const artifacts = page.entries.map(proof => {
      requireMatchingReview(this.root, proof);
      const artifact = readApprovedArtifact(this.root, proof);
      return { artifactPath: artifact.artifactPath, revision: artifact.revision };
    });
    const last = artifacts[artifacts.length - 1];
    return {
      artifacts,
      nextCursor: page.exhausted || !last ? null : last.artifactPath,
    };
  }

  readArtifact(artifactPath: unknown): { artifactPath: string; content: string; revision: string } {
    const normalizedPath = normalizeArtifactPath(artifactPath);
    const proof = loadLatestApprovedProofs(this.root).get(normalizedPath);
    if (!proof) throw new Error('Shared workspace artifact has no approved review');
    requireMatchingReview(this.root, proof);
    return readApprovedArtifact(this.root, proof);
  }
}
