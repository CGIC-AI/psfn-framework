// ── Core companion artifact-created emission helper (psfn-framework-kbdvl.1) ──
//
// Redacted EventBus emission choke point for `companion.artifact.created`
// (w9hj.1). Kept in `shared/` so post-turn scheduling can emit redacted
// artifact announcements onto the EventBus without importing host channel
// backplane relay implementations.

import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { EventBus } from './event-bus.js';
import type { Attachment } from './contracts/runtime.js';
import type { CompanionArtifactCreatedPayload } from './contracts/companion-relay.js';
import { createComponentLogger } from './logger.js';
import { toErrorMessage } from './utils/errors.js';

const log = createComponentLogger('CompanionArtifactEmission');

const IMAGE_GENERATION_PROVENANCE = 'image_generation';
const MAX_ID_LENGTH = 160;
const MAX_LABEL_LENGTH = 120;
const MAX_PROVENANCE_LENGTH = 120;
const MAX_MEDIA_TYPE_LENGTH = 100;

function clampText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function toIsoTimestamp(epochMs: number): string {
  if (!Number.isFinite(epochMs)) {
    throw new Error('Cannot redact event: non-finite timestamp');
  }
  return new Date(epochMs).toISOString();
}

function requireId(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Cannot redact event: missing ${fieldName}`);
  }
  return clampText(normalized, MAX_ID_LENGTH);
}

export function newCompanionArtifactId(): string {
  return `art-${randomUUID()}`;
}

export function redactArtifactCreated(input: {
  artifactId: string;
  label: string;
  mediaType: string;
  provenance: string;
  createdAtMs: number;
  previewable: boolean;
}): CompanionArtifactCreatedPayload {
  return {
    id: requireId(input.artifactId, 'artifact id'),
    label: clampText(input.label, MAX_LABEL_LENGTH) || 'artifact',
    mediaType: clampText(input.mediaType, MAX_MEDIA_TYPE_LENGTH) || 'application/octet-stream',
    provenance: clampText(input.provenance, MAX_PROVENANCE_LENGTH) || 'unknown',
    createdAt: toIsoTimestamp(input.createdAtMs),
    previewable: input.previewable === true,
  };
}

/**
 * Emission choke point for `companion.artifact.created` (w9hj.1): announces
 * generated media the moment attachments are collected for an outbound turn.
 * Payloads are redacted here — the file path travels only in the in-process
 * `preview` sidecar and never inside the payload. An attachment we cannot
 * stat is announced as non-previewable (fail closed) rather than skipped.
 */
export async function emitCompanionArtifactCreatedEvents(options: {
  eventBus: EventBus;
  attachments: readonly Attachment[];
  channelId?: string;
  provenance?: string;
}): Promise<void> {
  const provenance = options.provenance ?? IMAGE_GENERATION_PROVENANCE;
  for (const attachment of options.attachments) {
    const artifactId = newCompanionArtifactId();
    const mediaType = attachment.contentType.trim() || 'application/octet-stream';
    const localPath = attachment.localPath?.trim();

    let sizeBytes: number | null = null;
    if (localPath) {
      try {
        const stats = await stat(localPath);
        if (stats.isFile() && stats.size > 0) {
          sizeBytes = stats.size;
        }
      } catch (error) {
        log.warn('Announcing artifact without preview: stat failed', {
          artifactId,
          error: toErrorMessage(error),
        });
      }
    }

    const previewable = Boolean(
      localPath
      && sizeBytes !== null
      && mediaType.toLowerCase().startsWith('image/'),
    );

    await options.eventBus.emit('companion.artifact.created', {
      payload: redactArtifactCreated({
        artifactId,
        label: attachment.name,
        mediaType,
        provenance,
        createdAtMs: Date.now(),
        previewable,
      }),
      ...(previewable && localPath && sizeBytes !== null
        ? {
          preview: {
            artifactId,
            localPath,
            mediaType,
            sizeBytes,
          },
        }
        : {}),
      ...(options.channelId ? { channelId: options.channelId } : {}),
      timestamp: Date.now(),
    });
  }
}
