import { existsSync, realpathSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, extname, join, normalize, resolve } from 'node:path';
import { isRecord } from '../../shared/utils/types.js';
import { isStrictSubpath } from '../layout.js';

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

function parseApprovedProof(root: string, eventPath: string): ApprovedArtifactProof {
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
  const artifactPath = normalizeArtifactPath(parsed.artifactPath);
  const reviewPath = join(root, 'reviews', `${parsed.reviewId}.json`);
  if (!existsSync(reviewPath)) {
    throw new Error(`Shared Companion Workspace approval is missing its review: ${parsed.reviewId}`);
  }
  const review: unknown = JSON.parse(readFileSync(reviewPath, 'utf8'));
  if (!isRecord(review)
    || review.status !== 'approved'
    || review.reviewId !== parsed.reviewId
    || review.artifactPath !== artifactPath
    || review.proposedRevision !== parsed.proposedRevision) {
    throw new Error(`Shared Companion Workspace approval does not match its review: ${parsed.reviewId}`);
  }
  return {
    artifactPath,
    proposedRevision: parsed.proposedRevision,
    reviewId: parsed.reviewId,
    approvedAt: parsed.at,
  };
}

function loadLatestApprovedProofs(root: string): Map<string, ApprovedArtifactProof> {
  const eventsDir = join(root, 'provenance', 'events');
  if (!existsSync(eventsDir)) return new Map();
  const proofs = new Map<string, ApprovedArtifactProof>();
  for (const entry of readdirSync(eventsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.approved.json')) continue;
    const proof = parseApprovedProof(root, join(eventsDir, entry.name));
    const previous = proofs.get(proof.artifactPath);
    if (!previous
      || proof.approvedAt > previous.approvedAt
      || (proof.approvedAt === previous.approvedAt && proof.reviewId > previous.reviewId)) {
      proofs.set(proof.artifactPath, proof);
    }
  }
  return proofs;
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

  listArtifacts(): Array<{ artifactPath: string; revision: string }> {
    return [...loadLatestApprovedProofs(this.root).values()]
      .map(proof => {
        const artifact = readApprovedArtifact(this.root, proof);
        return { artifactPath: artifact.artifactPath, revision: artifact.revision };
      })
      .sort((a, b) => a.artifactPath.localeCompare(b.artifactPath));
  }

  readArtifact(artifactPath: unknown): { artifactPath: string; content: string; revision: string } {
    const normalizedPath = normalizeArtifactPath(artifactPath);
    const proof = loadLatestApprovedProofs(this.root).get(normalizedPath);
    if (!proof) throw new Error('Shared workspace artifact has no approved review');
    return readApprovedArtifact(this.root, proof);
  }
}
