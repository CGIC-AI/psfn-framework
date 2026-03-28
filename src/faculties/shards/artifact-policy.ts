import { isRecord } from '../../shared/utils/types.js';
import type { ShardResultLineageEnvelope } from './result-lineage.js';

export type ShardArtifactMergePolicy = 'review_required';

export interface ShardArtifactReturnProvenance {
  lineage: ShardResultLineageEnvelope;
  turnIndex: number;
  turnMessageId: string;
}

export interface ShardReturnedArtifact {
  schemaVersion: 1;
  kind: 'attachment';
  mergePolicy: ShardArtifactMergePolicy;
  artifactId: string;
  url: string;
  contentType: string;
  name: string;
  localPath?: string;
  provenance: ShardArtifactReturnProvenance;
}

function normalizeNonEmptyString(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Shard artifact ${fieldName} cannot be empty`);
  }
  return normalized;
}

function readAttachmentString(
  attachment: Record<string, unknown>,
  key: 'url' | 'contentType' | 'name' | 'localPath',
  artifactId: string,
): string {
  const value = attachment[key];
  if (typeof value !== 'string') {
    throw new Error(`Shard artifact "${artifactId}" attachment field "${key}" must be a string`);
  }
  return value;
}

function normalizeArtifactAttachment(
  attachment: Record<string, unknown>,
  artifactId: string,
  provenance: ShardArtifactReturnProvenance,
): ShardReturnedArtifact {
  const url = normalizeNonEmptyString(readAttachmentString(attachment, 'url', artifactId), `attachment "${artifactId}" url`);
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`Shard artifact "${artifactId}" url must be a valid URL`);
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(`Shard artifact "${artifactId}" url must use http or https`);
  }

  const contentType = normalizeNonEmptyString(
    readAttachmentString(attachment, 'contentType', artifactId),
    `attachment "${artifactId}" contentType`,
  );
  if (!contentType.toLowerCase().startsWith('image/')) {
    throw new Error(`Shard artifact "${artifactId}" contentType "${contentType}" is ambiguous; only image returns are allowed`);
  }

  const name = normalizeNonEmptyString(readAttachmentString(attachment, 'name', artifactId), `attachment "${artifactId}" name`);
  const rawLocalPath = attachment.localPath;
  const localPath = typeof rawLocalPath === 'string' ? rawLocalPath.trim() : '';

  return {
    schemaVersion: 1,
    kind: 'attachment',
    mergePolicy: 'review_required',
    artifactId,
    url,
    contentType,
    name,
    ...(localPath ? { localPath } : {}),
    provenance,
  };
}

export function buildShardReturnedArtifacts(input: {
  lineage: ShardResultLineageEnvelope;
  turnIndex: number;
  turnMessageId: string;
  attachments: readonly unknown[] | undefined;
}): ShardReturnedArtifact[] {
  if (!input.attachments || input.attachments.length === 0) {
    return [];
  }

  const turnIndex = Number.isInteger(input.turnIndex) && input.turnIndex > 0
    ? input.turnIndex
    : (() => { throw new Error('Shard artifact turnIndex must be a positive integer'); })();
  const turnMessageId = normalizeNonEmptyString(input.turnMessageId, 'turn message id');

  return input.attachments.map((attachment, index) => {
    if (!isRecord(attachment)) {
      throw new Error(`Shard artifact attachment[${index}] is malformed`);
    }

    const artifactId = `artifact-${input.lineage.shardId}-${turnIndex}-${index + 1}`;
    return normalizeArtifactAttachment(attachment, artifactId, {
      lineage: input.lineage,
      turnIndex,
      turnMessageId,
    });
  });
}
