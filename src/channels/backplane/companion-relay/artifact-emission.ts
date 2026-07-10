import { stat } from 'node:fs/promises';
import type { EventBus } from '../../../shared/event-bus.js';
import type { Attachment } from '../../../shared/contracts/runtime.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import { redactArtifactCreated } from './redaction.js';
import { newCompanionArtifactId } from './relay.js';

const log = createComponentLogger('CompanionArtifactEmission');

const IMAGE_GENERATION_PROVENANCE = 'image_generation';

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
