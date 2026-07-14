import {
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
  role: 'proposer' | 'reviewer' | 'cogsec';
}

export interface SharedWorkspaceProposalInput {
  artifactPath: string;
  content: string;
  mediaType: 'text/markdown' | 'text/plain' | 'application/json';
  actor: SharedWorkspaceActor;
  provenance: string;
}

export interface SharedWorkspaceCogSecInput {
  reviewId: string;
  reviewer: SharedWorkspaceActor;
  decision: 'approved' | 'rejected';
  note?: string;
}

export interface SharedWorkspaceReviewInput {
  reviewId: string;
  reviewer: SharedWorkspaceActor;
  decision: 'approve' | 'reject';
  note?: string;
}

export interface SharedWorkspaceCogSecDecisionRecord {
  reviewId: string;
  proposedRevision: string;
  reviewer: SharedWorkspaceActor;
  decision: 'approved' | 'rejected';
  decidedAt: string;
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
  cogSecDecision?: SharedWorkspaceCogSecDecisionRecord;
  reviewer?: SharedWorkspaceActor;
  reviewedAt?: string;
  note?: string;
}

interface SharedWorkspaceProvenanceEvent {
  schemaVersion: 1;
  event: 'proposed' | 'approved' | 'rejected';
  at: string;
  reviewId: string;
  artifactPath: string;
  proposedRevision: string;
  proposer: SharedWorkspaceActor;
  provenance: string;
  reviewer?: SharedWorkspaceActor;
  cogSecDecision?: SharedWorkspaceCogSecDecisionRecord;
}

interface SharedWorkspacePublicationTransaction {
  schemaVersion: 1;
  transactionId: string;
  reviewId: string;
  artifactPath: string;
  baseRevision: string | null;
  proposedRevision: string;
  content: string;
  decision: 'approve' | 'reject';
  updatedReview: SharedWorkspaceReviewRecord;
  provenanceEvent: SharedWorkspaceProvenanceEvent;
}

export interface SharedWorkspaceStoreOptions {
  faultInjection?: (stage: 'after_artifact' | 'after_review') => void;
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

function requireReviewId(value: string): string {
  const reviewId = requireNonEmpty(value, 'reviewId');
  if (!REVIEW_ID_PATTERN.test(reviewId)) throw new Error('reviewId must be a UUID');
  return reviewId;
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

function isActor(value: unknown, role?: SharedWorkspaceActor['role']): value is SharedWorkspaceActor {
  return isRecord(value)
    && typeof value.id === 'string'
    && (value.role === 'proposer' || value.role === 'reviewer' || value.role === 'cogsec')
    && (role === undefined || value.role === role);
}

function parseReview(path: string): SharedWorkspaceReviewRecord {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(parsed)
    || typeof parsed.reviewId !== 'string'
    || typeof parsed.artifactPath !== 'string'
    || typeof parsed.content !== 'string'
    || typeof parsed.proposedRevision !== 'string'
    || !isActor(parsed.proposer, 'proposer')
    || (parsed.status !== 'pending' && parsed.status !== 'approved' && parsed.status !== 'rejected')) {
    throw new Error(`Malformed Shared Companion Workspace review record: ${path}`);
  }
  return parsed as unknown as SharedWorkspaceReviewRecord;
}

function parseCogSecDecision(path: string): SharedWorkspaceCogSecDecisionRecord {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(parsed)
    || typeof parsed.reviewId !== 'string'
    || typeof parsed.proposedRevision !== 'string'
    || !isActor(parsed.reviewer, 'cogsec')
    || (parsed.decision !== 'approved' && parsed.decision !== 'rejected')
    || typeof parsed.decidedAt !== 'string') {
    throw new Error(`Malformed Shared Companion Workspace CogSec decision: ${path}`);
  }
  return parsed as unknown as SharedWorkspaceCogSecDecisionRecord;
}

function parseTransaction(path: string): SharedWorkspacePublicationTransaction {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(parsed)
    || parsed.schemaVersion !== 1
    || typeof parsed.transactionId !== 'string'
    || typeof parsed.reviewId !== 'string'
    || typeof parsed.artifactPath !== 'string'
    || typeof parsed.proposedRevision !== 'string'
    || typeof parsed.content !== 'string'
    || (parsed.decision !== 'approve' && parsed.decision !== 'reject')
    || !isRecord(parsed.updatedReview)
    || !isRecord(parsed.provenanceEvent)) {
    throw new Error(`Malformed Shared Companion Workspace publication transaction: ${path}`);
  }
  return parsed as unknown as SharedWorkspacePublicationTransaction;
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

function writeImmutableJson(path: string, value: unknown): void {
  const encoded = `${JSON.stringify(value, null, 2)}\n`;
  if (existsSync(path)) {
    if (readFileSync(path, 'utf8') !== encoded) {
      throw new Error(`Immutable Shared Companion Workspace record conflicts at ${path}`);
    }
    return;
  }
  writeFileSync(path, encoded, { encoding: 'utf8', flag: 'wx' });
}

export class SharedCompanionWorkspaceStore {
  private readonly faultInjection?: SharedWorkspaceStoreOptions['faultInjection'];

  constructor(private readonly root: string, options: SharedWorkspaceStoreOptions = {}) {
    this.faultInjection = options.faultInjection;
    this.recoverTransactions();
  }

  getPolicy(): typeof SHARED_WORKSPACE_POLICY {
    return SHARED_WORKSPACE_POLICY;
  }

  listReviews(): SharedWorkspaceReviewRecord[] {
    this.recoverTransactions();
    const reviewsDir = join(this.root, 'reviews');
    return readdirSync(reviewsDir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => parseReview(join(reviewsDir, entry.name)))
      .sort((a, b) => b.proposedAt.localeCompare(a.proposedAt));
  }

  listArtifacts(): Array<{ artifactPath: string; revision: string }> {
    this.recoverTransactions();
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
    this.recoverTransactions();
    const resolved = resolveArtifactPath(this.root, artifactPath);
    const content = readFileSync(resolved.absolutePath, 'utf8');
    return { artifactPath: resolved.relativePath, content, revision: hashContent(content) };
  }

  propose(input: SharedWorkspaceProposalInput): SharedWorkspaceReviewRecord {
    this.recoverTransactions();
    const resolved = resolveArtifactPath(this.root, input.artifactPath);
    requireNonEmpty(input.actor.id, 'actor.id');
    if (input.actor.role !== 'proposer') throw new Error('Shared workspace proposal actor must be an authenticated proposer');
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
    this.writeProvenanceEvent(this.buildProvenanceEvent('proposed', record));
    return record;
  }

  recordCogSecDecision(input: SharedWorkspaceCogSecInput): SharedWorkspaceCogSecDecisionRecord {
    this.recoverTransactions();
    const reviewId = requireReviewId(input.reviewId);
    requireNonEmpty(input.reviewer.id, 'reviewer.id');
    if (input.reviewer.role !== 'cogsec') throw new Error('CogSec decision actor must be an authenticated CogSec principal');
    return this.withLock(`review-${reviewId}`, () => {
      const record = parseReview(join(this.root, 'reviews', `${reviewId}.json`));
      if (record.status !== 'pending') throw new Error(`Shared workspace review ${reviewId} is already resolved`);
      if (record.proposer.id === input.reviewer.id) {
        throw new Error('Shared workspace CogSec decision requires an independent principal');
      }
      const decision: SharedWorkspaceCogSecDecisionRecord = {
        reviewId,
        proposedRevision: record.proposedRevision,
        reviewer: input.reviewer,
        decision: input.decision,
        decidedAt: new Date().toISOString(),
        ...(input.note?.trim() ? { note: input.note.trim() } : {}),
      };
      writeImmutableJson(join(this.root, 'cogsec-decisions', `${reviewId}.json`), decision);
      return decision;
    });
  }

  review(input: SharedWorkspaceReviewInput): SharedWorkspaceReviewRecord {
    this.recoverTransactions();
    requireNonEmpty(input.reviewer.id, 'reviewer.id');
    if (input.reviewer.role !== 'reviewer') throw new Error('Review actor must be an authenticated reviewer');
    const reviewId = requireReviewId(input.reviewId);
    return this.withLock(`review-${reviewId}`, () => {
      // Re-read only after holding the review lock. A stale pre-lock snapshot is
      // never used to authorize or publish a decision.
      const reviewPath = join(this.root, 'reviews', `${reviewId}.json`);
      const record = parseReview(reviewPath);
      if (record.status !== 'pending') throw new Error(`Shared workspace review ${record.reviewId} is already resolved`);
      if (record.proposer.id === input.reviewer.id) {
        throw new Error('Shared workspace publication requires an independent reviewer');
      }
      const cogSecPath = join(this.root, 'cogsec-decisions', `${reviewId}.json`);
      if (!existsSync(cogSecPath)) {
        throw new Error('Shared workspace publication requires an authoritative CogSec decision artifact');
      }
      const cogSecDecision = parseCogSecDecision(cogSecPath);
      if (cogSecDecision.proposedRevision !== record.proposedRevision) {
        throw new Error('Shared workspace CogSec decision does not match the proposed revision');
      }
      if (cogSecDecision.reviewer.id === input.reviewer.id) {
        throw new Error('Shared workspace review and CogSec decision require distinct principals');
      }
      if (input.decision === 'approve' && cogSecDecision.decision !== 'approved') {
        throw new Error('Shared workspace publication requires CogSec approval');
      }

      const reviewedAt = new Date().toISOString();
      const updated: SharedWorkspaceReviewRecord = {
        ...record,
        status: input.decision === 'approve' ? 'approved' : 'rejected',
        cogSecDecision,
        reviewer: input.reviewer,
        reviewedAt,
        ...(input.note?.trim() ? { note: input.note.trim() } : {}),
      };
      const transaction: SharedWorkspacePublicationTransaction = {
        schemaVersion: 1,
        transactionId: randomUUID(),
        reviewId,
        artifactPath: record.artifactPath,
        baseRevision: record.baseRevision,
        proposedRevision: record.proposedRevision,
        content: record.content,
        decision: input.decision,
        updatedReview: updated,
        provenanceEvent: this.buildProvenanceEvent(
          input.decision === 'approve' ? 'approved' : 'rejected',
          updated,
        ),
      };
      const transactionPath = join(this.root, 'transactions', `${reviewId}.json`);
      this.withArtifactLock(record.artifactPath, () => {
        if (input.decision === 'approve') {
          const artifact = resolveArtifactPath(this.root, record.artifactPath);
          const currentRevision = existsSync(artifact.absolutePath)
            ? hashContent(readFileSync(artifact.absolutePath, 'utf8'))
            : null;
          if (currentRevision !== record.baseRevision) {
            throw new Error('Shared workspace artifact changed after proposal; review is stale');
          }
        }
        // Journal only after the stale-revision precondition passes, but before
        // any artifact/review/provenance mutation becomes visible.
        writeJsonAtomic(transactionPath, transaction);
        this.applyTransaction(transaction, reviewPath, transactionPath, true);
      });
      return updated;
    });
  }

  private buildProvenanceEvent(
    event: SharedWorkspaceProvenanceEvent['event'],
    record: SharedWorkspaceReviewRecord,
  ): SharedWorkspaceProvenanceEvent {
    return {
      schemaVersion: 1,
      event,
      at: event === 'proposed' ? record.proposedAt : record.reviewedAt!,
      reviewId: record.reviewId,
      artifactPath: record.artifactPath,
      proposedRevision: record.proposedRevision,
      proposer: record.proposer,
      provenance: record.provenance,
      ...(record.reviewer ? { reviewer: record.reviewer } : {}),
      ...(record.cogSecDecision ? { cogSecDecision: record.cogSecDecision } : {}),
    };
  }

  private writeProvenanceEvent(event: SharedWorkspaceProvenanceEvent): void {
    writeImmutableJson(
      join(this.root, 'provenance', 'events', `${event.reviewId}.${event.event}.json`),
      event,
    );
  }

  private withArtifactLock<T>(artifactPath: string, action: () => T): T {
    const digest = createHash('sha256').update(artifactPath).digest('hex');
    return this.withLock(`artifact-${digest}`, action);
  }

  private withLock<T>(name: string, action: () => T): T {
    const lockPath = join(this.root, '.locks', `${name}.lock`);
    let descriptor: number;
    try {
      descriptor = openSync(lockPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`Shared workspace operation is busy: ${name}`);
      }
      throw error;
    }
    closeSync(descriptor);
    try {
      return action();
    } finally {
      unlinkSync(lockPath);
    }
  }

  private applyTransaction(
    transaction: SharedWorkspacePublicationTransaction,
    reviewPath: string,
    transactionPath: string,
    injectFaults: boolean,
  ): void {
    if (transaction.decision === 'approve') {
      const artifact = resolveArtifactPath(this.root, transaction.artifactPath);
      const currentRevision = existsSync(artifact.absolutePath)
        ? hashContent(readFileSync(artifact.absolutePath, 'utf8'))
        : null;
      if (currentRevision === transaction.baseRevision) {
        writeTextAtomic(artifact.absolutePath, transaction.content);
      } else if (currentRevision !== transaction.proposedRevision) {
        throw new Error('Shared workspace artifact changed after proposal; review is stale');
      }
    }
    if (injectFaults) this.faultInjection?.('after_artifact');
    writeJsonAtomic(reviewPath, transaction.updatedReview);
    if (injectFaults) this.faultInjection?.('after_review');
    this.writeProvenanceEvent(transaction.provenanceEvent);
    unlinkSync(transactionPath);
  }

  private recoverTransactions(): void {
    const transactionsDir = join(this.root, 'transactions');
    if (!existsSync(transactionsDir)) return;
    for (const entry of readdirSync(transactionsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const transactionPath = join(transactionsDir, entry.name);
      const transaction = parseTransaction(transactionPath);
      const reviewId = requireReviewId(transaction.reviewId);
      this.withLock(`review-${reviewId}`, () => {
        this.withArtifactLock(transaction.artifactPath, () => {
          this.applyTransaction(
            transaction,
            join(this.root, 'reviews', `${reviewId}.json`),
            transactionPath,
            false,
          );
        });
      });
    }
  }
}
