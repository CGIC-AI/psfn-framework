import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isStrictSubpath } from '../../persistence/layout.js';
import { isRecord } from '../../shared/utils/types.js';

export const COGSEC_FORENSIC_ARTIFACT_VERSION = 1 as const;

export type CogSecForensicArtifactKind =
  | 'l0_rows'
  | 'transcript_projection_rows'
  | 'summary'
  | 'memory'
  | 'embedding_source'
  | 'profile_artifact'
  | 'other';

export interface CogSecForensicSealInput {
  caseId: string;
  kind: CogSecForensicArtifactKind;
  payload: unknown;
  sourceChannelId?: string;
  logicalSessionId?: string;
  createdAt?: string;
}

export interface CogSecForensicArtifactMetadata {
  ref: string;
  artifactId: string;
  caseId: string;
  kind: CogSecForensicArtifactKind;
  sha256: string;
  byteLength: number;
  createdAt: string;
  sourceChannelId?: string;
  logicalSessionId?: string;
}

export interface CogSecForensicArtifact extends CogSecForensicArtifactMetadata {
  version: typeof COGSEC_FORENSIC_ARTIFACT_VERSION;
  payload: unknown;
}

const CASE_ID_PATTERN = /^cogsec_[A-Za-z0-9_-]+$/u;
const ARTIFACT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REF_PATTERN = /^cogsec-forensic:\/\/(cogsec_[A-Za-z0-9_-]+)\/([0-9a-f-]+)\.json$/u;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const ARTIFACT_KINDS: ReadonlySet<CogSecForensicArtifactKind> = new Set([
  'l0_rows',
  'transcript_projection_rows',
  'summary',
  'memory',
  'embedding_source',
  'profile_artifact',
  'other',
]);

function normalizeRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} must be non-empty`);
  }
  return normalized;
}

function normalizeOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return normalizeRequiredString(value, field);
}

function parseCaseId(value: unknown, field: string): string {
  const normalized = normalizeRequiredString(value, field);
  if (!CASE_ID_PATTERN.test(normalized)) {
    throw new Error(`${field} must match cogsec_[A-Za-z0-9_-]+`);
  }
  return normalized;
}

function parseArtifactId(value: unknown, field: string): string {
  const normalized = normalizeRequiredString(value, field);
  if (!ARTIFACT_ID_PATTERN.test(normalized)) {
    throw new Error(`${field} must be a UUID artifact id`);
  }
  return normalized;
}

function parseKind(value: unknown, field: string): CogSecForensicArtifactKind {
  if (typeof value === 'string' && ARTIFACT_KINDS.has(value as CogSecForensicArtifactKind)) {
    return value as CogSecForensicArtifactKind;
  }
  throw new Error(`${field} has unsupported value "${String(value)}"`);
}

function parseIsoInstant(value: unknown, field: string): string {
  const normalized = normalizeRequiredString(value, field);
  if (!ISO_INSTANT_PATTERN.test(normalized) || Number.isNaN(Date.parse(normalized))) {
    throw new Error(`${field} must be an ISO instant`);
  }
  return normalized;
}

function parseRef(ref: string): { caseId: string; artifactId: string } {
  const match = REF_PATTERN.exec(ref);
  if (!match) {
    throw new Error('CogSec forensic ref is malformed');
  }
  return {
    caseId: parseCaseId(match[1], 'caseId'),
    artifactId: parseArtifactId(match[2], 'artifactId'),
  };
}

export function assertInsideRoot(rootDir: string, filePath: string): void {
  const root = resolve(rootDir);
  const target = resolve(filePath);
  if (target !== root && !isStrictSubpath(target, root)) {
    throw new Error('CogSec forensic path escaped archive root');
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function sha256(payload: string): string {
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

function buildRef(caseId: string, artifactId: string): string {
  return `cogsec-forensic://${caseId}/${artifactId}.json`;
}

function parseArtifact(raw: unknown, ref: string): CogSecForensicArtifact {
  if (!isRecord(raw)) {
    throw new Error('CogSec forensic artifact must be an object');
  }
  const expected = parseRef(ref);
  if (raw.version !== COGSEC_FORENSIC_ARTIFACT_VERSION) {
    throw new Error(`unsupported CogSec forensic artifact version: ${String(raw.version)}`);
  }
  const artifactId = parseArtifactId(raw.artifactId, 'artifact.artifactId');
  const caseId = parseCaseId(raw.caseId, 'artifact.caseId');
  if (artifactId !== expected.artifactId || caseId !== expected.caseId) {
    throw new Error('CogSec forensic artifact ref does not match stored identity');
  }
  const storedRef = normalizeRequiredString(raw.ref, 'artifact.ref');
  if (storedRef !== ref) {
    throw new Error('CogSec forensic artifact stored ref mismatch');
  }
  const hash = normalizeRequiredString(raw.sha256, 'artifact.sha256');
  if (!/^sha256:[a-f0-9]{64}$/u.test(hash)) {
    throw new Error('artifact.sha256 must be a sha256 digest');
  }
  if (!Number.isInteger(raw.byteLength) || (raw.byteLength as number) < 0) {
    throw new Error('artifact.byteLength must be a non-negative integer');
  }
  return {
    version: COGSEC_FORENSIC_ARTIFACT_VERSION,
    ref,
    artifactId,
    caseId,
    kind: parseKind(raw.kind, 'artifact.kind'),
    sha256: hash,
    byteLength: raw.byteLength as number,
    createdAt: parseIsoInstant(raw.createdAt, 'artifact.createdAt'),
    ...(raw.sourceChannelId !== undefined
      ? { sourceChannelId: normalizeRequiredString(raw.sourceChannelId, 'artifact.sourceChannelId') }
      : {}),
    ...(raw.logicalSessionId !== undefined
      ? { logicalSessionId: normalizeRequiredString(raw.logicalSessionId, 'artifact.logicalSessionId') }
      : {}),
    payload: raw.payload,
  };
}

function metadataFromArtifact(artifact: CogSecForensicArtifact): CogSecForensicArtifactMetadata {
  return {
    ref: artifact.ref,
    artifactId: artifact.artifactId,
    caseId: artifact.caseId,
    kind: artifact.kind,
    sha256: artifact.sha256,
    byteLength: artifact.byteLength,
    createdAt: artifact.createdAt,
    ...(artifact.sourceChannelId ? { sourceChannelId: artifact.sourceChannelId } : {}),
    ...(artifact.logicalSessionId ? { logicalSessionId: artifact.logicalSessionId } : {}),
  };
}

export class CogSecForensicArchive {
  private readonly rootDir: string;
  private readonly now: () => Date;

  constructor(rootDir: string, options: { now?: () => Date } = {}) {
    this.rootDir = rootDir;
    this.now = options.now ?? (() => new Date());
  }

  sealArtifact(input: CogSecForensicSealInput): CogSecForensicArtifactMetadata {
    const caseId = parseCaseId(input.caseId, 'caseId');
    const kind = parseKind(input.kind, 'kind');
    const artifactId = randomUUID();
    const createdAt = input.createdAt ? parseIsoInstant(input.createdAt, 'createdAt') : this.now().toISOString();
    const ref = buildRef(caseId, artifactId);
    const payloadText = stableJson(input.payload);
    const digest = sha256(payloadText);
    const artifact: CogSecForensicArtifact = {
      version: COGSEC_FORENSIC_ARTIFACT_VERSION,
      ref,
      artifactId,
      caseId,
      kind,
      sha256: digest,
      byteLength: Buffer.byteLength(payloadText, 'utf-8'),
      createdAt,
      ...(input.sourceChannelId ? { sourceChannelId: normalizeOptionalString(input.sourceChannelId, 'sourceChannelId') } : {}),
      ...(input.logicalSessionId ? { logicalSessionId: normalizeOptionalString(input.logicalSessionId, 'logicalSessionId') } : {}),
      payload: input.payload,
    };

    const filePath = this.resolveRefPath(ref);
    if (existsSync(filePath)) {
      throw new Error(`CogSec forensic artifact already exists: ${ref}`);
    }
    mkdirSync(join(this.rootDir, caseId), { recursive: true });
    writeFileSync(filePath, `${stableJson(artifact)}\n`, { encoding: 'utf-8', flag: 'wx' });
    return metadataFromArtifact(artifact);
  }

  readArtifact(ref: string): CogSecForensicArtifact {
    const filePath = this.resolveRefPath(ref);
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
    return parseArtifact(parsed, ref);
  }

  getArtifactMetadata(ref: string): CogSecForensicArtifactMetadata {
    return metadataFromArtifact(this.readArtifact(ref));
  }

  private resolveRefPath(ref: string): string {
    const { caseId, artifactId } = parseRef(ref);
    const filePath = join(this.rootDir, caseId, `${artifactId}.json`);
    assertInsideRoot(this.rootDir, filePath);
    return filePath;
  }
}
