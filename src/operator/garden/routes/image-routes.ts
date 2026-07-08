import type { ServerResponse } from 'node:http';
import { sendJson } from '../../../channels/backplane/http/primitives.js';
import { handleMultipartUpload } from '../multipart.js';
import { parseAdminJsonBody } from '../request-body.js';
import { parseRequestUrl } from '../request-url.js';
import { exactPath, paramWithSuffix, prefixedParamPath } from '../route-matchers.js';
import type {
  AdminGeneratedImageArtifactRef,
  AdminGeneratedImageCompanionNoteRef,
  AdminGeneratedImageConversationLink,
  AdminGeneratedImageListQuery,
  AdminGeneratedImageUpdateInput,
  AdminImagesService,
} from '../services/types.js';
import type { AdminAuditDecision } from '../types.js';
import { ADMIN_DYNAMIC_JSON_HEADERS, toSanitizedMessage } from './shared.js';
import type { AdminApiRoute, AdminAuditTimelineAppender, AdminBodyReader } from './types.js';

function sendImageBlob(
  res: ServerResponse,
  blob: { fileName: string; contentType: string; data: Buffer },
): void {
  res.writeHead(200, {
    'Content-Type': blob.contentType,
    'Content-Length': blob.data.length,
    'Cache-Control': 'private, max-age=60',
    'Content-Disposition': `inline; filename="${blob.fileName.replaceAll('"', '')}"`,
  });
  res.end(blob.data);
}

function parseReferenceTagsQuery(value: string | null): string[] {
  return value?.split(',').map((tag) => tag.trim()).filter(Boolean) ?? [];
}

function parseBooleanQuery(value: string | null): boolean | undefined {
  if (value === null) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes'].includes(normalized)) return true;
  if (['0', 'false', 'no'].includes(normalized)) return false;
  return undefined;
}

function parseGeneratedImagesQuery(req: Parameters<AdminApiRoute['handle']>[0]): AdminGeneratedImageListQuery {
  const url = parseRequestUrl(req, '/api/admin/images/generated');
  return {
    ...(parseReferenceTagsQuery(url.searchParams.get('tags')).length > 0
      ? { tags: parseReferenceTagsQuery(url.searchParams.get('tags')) }
      : {}),
    ...(parseBooleanQuery(url.searchParams.get('favorite')) !== undefined
      ? { favorite: parseBooleanQuery(url.searchParams.get('favorite')) }
      : {}),
    ...(parseBooleanQuery(url.searchParams.get('meaningful')) !== undefined
      ? { meaningful: parseBooleanQuery(url.searchParams.get('meaningful')) }
      : {}),
    ...(url.searchParams.get('q')?.trim() ? { search: url.searchParams.get('q')!.trim() } : {}),
  };
}

function parseSetDefaultQuery(value: string | null): boolean {
  return value === '1' || value === 'true' || value === 'yes';
}

function statusFromReferenceError(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('not found') ? 404 : 400;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseConversationLink(value: unknown): AdminGeneratedImageConversationLink | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return {
    ...(stringValue(record.channelId) !== undefined ? { channelId: stringValue(record.channelId) } : {}),
    ...(stringValue(record.channelType) !== undefined ? { channelType: stringValue(record.channelType) } : {}),
    ...(stringValue(record.turnId) !== undefined ? { turnId: stringValue(record.turnId) } : {}),
    ...(stringValue(record.requestId) !== undefined ? { requestId: stringValue(record.requestId) } : {}),
    ...(stringValue(record.sourceMessageId) !== undefined ? { sourceMessageId: stringValue(record.sourceMessageId) } : {}),
    ...(numberValue(record.userSessionEntryId) !== undefined ? { userSessionEntryId: numberValue(record.userSessionEntryId) } : {}),
    ...(numberValue(record.assistantSessionEntryId) !== undefined ? { assistantSessionEntryId: numberValue(record.assistantSessionEntryId) } : {}),
  };
}

function parseCompanionNoteRefs(value: unknown): AdminGeneratedImageCompanionNoteRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((entry): entry is Record<string, unknown> => (
      entry !== null && typeof entry === 'object' && !Array.isArray(entry)
    ))
    .map((entry) => ({
      ...(stringValue(entry.id) !== undefined ? { id: stringValue(entry.id)! } : { id: '' }),
      ...(stringValue(entry.label) !== undefined ? { label: stringValue(entry.label) } : {}),
      ...(stringValue(entry.url) !== undefined ? { url: stringValue(entry.url) } : {}),
    }))
    .filter((entry) => entry.id.trim().length > 0);
}

function parseArtifactRefs(value: unknown): AdminGeneratedImageArtifactRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((entry): entry is Record<string, unknown> => (
      entry !== null && typeof entry === 'object' && !Array.isArray(entry)
    ))
    .map((entry) => ({
      kind: entry.kind,
      ...(stringValue(entry.refId) !== undefined ? { refId: stringValue(entry.refId) } : {}),
      ...(stringValue(entry.label) !== undefined ? { label: stringValue(entry.label) } : {}),
      ...(stringValue(entry.url) !== undefined ? { url: stringValue(entry.url) } : {}),
      ...(stringValue(entry.localPath) !== undefined ? { localPath: stringValue(entry.localPath) } : {}),
    }))
    .filter((entry): entry is AdminGeneratedImageArtifactRef => (
      entry.kind === 'generated_image'
      || entry.kind === 'shared_image'
      || entry.kind === 'conversation_turn'
      || entry.kind === 'companion_note'
      || entry.kind === 'l0_artifact'
    ));
}

function parseGeneratedImageUpdatePayload(payload: Record<string, unknown>): AdminGeneratedImageUpdateInput {
  const meaningfulMoment = payload.meaningfulMoment;
  const parsedMeaningfulMoment = meaningfulMoment !== undefined
    && meaningfulMoment !== null
    && typeof meaningfulMoment === 'object'
    && !Array.isArray(meaningfulMoment)
    ? meaningfulMoment as Record<string, unknown>
    : undefined;
  return {
    ...(typeof payload.favorite === 'boolean' ? { favorite: payload.favorite } : {}),
    ...(Array.isArray(payload.tags)
      ? { tags: payload.tags.filter((tag): tag is string => typeof tag === 'string') }
      : {}),
    ...(parsedMeaningfulMoment
      && typeof parsedMeaningfulMoment.marked === 'boolean'
      ? {
          meaningfulMoment: {
            marked: parsedMeaningfulMoment.marked,
            ...(stringValue(parsedMeaningfulMoment.note) !== undefined ? { note: stringValue(parsedMeaningfulMoment.note) } : {}),
          },
        }
      : {}),
    ...(payload.conversation !== undefined ? { conversation: parseConversationLink(payload.conversation) ?? {} } : {}),
    ...(parseCompanionNoteRefs(payload.companionNoteRefs) !== undefined
      ? { companionNoteRefs: parseCompanionNoteRefs(payload.companionNoteRefs) }
      : {}),
    ...(parseArtifactRefs(payload.artifactRefs) !== undefined
      ? { artifactRefs: parseArtifactRefs(payload.artifactRefs) }
      : {}),
  };
}

export function buildAdminImageRoutes(options: {
  imagesService: AdminImagesService;
  appendAuditTimelineEntry?: AdminAuditTimelineAppender;
  withBody: AdminBodyReader;
}): AdminApiRoute[] {
  const { imagesService, appendAuditTimelineEntry, withBody } = options;

  const appendIdentityMutationAudit = (
    decision: AdminAuditDecision,
    narrative: string,
    details: Array<string | null | undefined> = [],
  ): void => {
    appendAuditTimelineEntry?.('identity_edit', decision, narrative, details, 'operator');
  };

  return [
    {
      method: 'GET',
      match: exactPath('/api/admin/images/generated'),
      handle: (req, res) => {
        imagesService.listGeneratedImages(parseGeneratedImagesQuery(req)).then(
          payload => sendJson(res, 200, payload, ADMIN_DYNAMIC_JSON_HEADERS),
          error => sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to list generated images') }),
        );
      },
    },
    {
      method: 'GET',
      match: paramWithSuffix('/api/admin/images/generated/', 'id', '/blob'),
      handle: (_req, res, { id }) => {
        imagesService.getGeneratedImageBlob(id).then(
          (blob) => {
            if (!blob) {
              sendJson(res, 404, { error: 'Generated image not found' });
              return;
            }
            sendImageBlob(res, blob);
          },
          error => sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to load generated image') }),
        );
      },
    },
    {
      method: 'PATCH',
      match: prefixedParamPath('/api/admin/images/generated/', 'id'),
      handle: (req, res, { id }) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          if (parsed.value === null || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
            sendJson(res, 400, { error: 'Generated image update payload must be a JSON object' });
            return;
          }
          imagesService.updateGeneratedImage(id, parseGeneratedImageUpdatePayload(parsed.value as Record<string, unknown>)).then(
            image => sendJson(res, 200, { ok: true, image }, ADMIN_DYNAMIC_JSON_HEADERS),
            error => {
              const safeError = toSanitizedMessage(error, 'Failed to update generated image');
              sendJson(res, safeError.includes('not found') ? 404 : 400, { error: safeError });
            },
          );
        });
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/admin/image-references'),
      handle: (_req, res) => {
        imagesService.listReferencePhotos().then(
          payload => sendJson(res, 200, payload, ADMIN_DYNAMIC_JSON_HEADERS),
          error => sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to list reference photos') }),
        );
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/admin/image-references/upload'),
      handle: (req, res) => {
        const url = parseRequestUrl(req, '/api/admin/image-references/upload');
        handleMultipartUpload(req, res, { maxBytes: 12 * 1024 * 1024 }).then(
          (uploadResult) => {
            if (!uploadResult.ok) {
              const safeError = toSanitizedMessage(uploadResult.error, 'Reference photo upload failed');
              appendIdentityMutationAudit(
                'denied',
                `Operator reference photo upload failed: ${safeError}`,
              );
              sendJson(res, uploadResult.status, { error: safeError });
              return;
            }
            imagesService.addReferencePhoto({
              filename: uploadResult.file.filename,
              contentType: uploadResult.file.contentType,
              data: uploadResult.file.data,
              description: url.searchParams.get('description') ?? undefined,
              tags: parseReferenceTagsQuery(url.searchParams.get('tags')),
              setDefault: parseSetDefaultQuery(url.searchParams.get('setDefault')),
            }).then(
              reference => {
                appendIdentityMutationAudit(
                  'allowed',
                  'Operator uploaded identity reference photo.',
                  [
                    `referenceId=${reference.id}`,
                    reference.isDefault ? 'default=true' : null,
                    reference.tags.length ? `tags=${reference.tags.join(',')}` : null,
                  ],
                );
                sendJson(res, 201, { ok: true, reference }, ADMIN_DYNAMIC_JSON_HEADERS);
              },
              error => {
                const safeError = toSanitizedMessage(error, 'Reference photo upload failed');
                appendIdentityMutationAudit(
                  'denied',
                  `Operator reference photo upload failed: ${safeError}`,
                  [`filename=${uploadResult.file.filename}`],
                );
                sendJson(res, statusFromReferenceError(error), { error: safeError });
              },
            );
          },
          (error) => {
            const safeError = toSanitizedMessage(error, 'Reference photo upload failed unexpectedly');
            appendIdentityMutationAudit(
              'denied',
              `Operator reference photo upload failed: ${safeError}`,
            );
            sendJson(res, 500, { error: safeError });
          },
        );
      },
    },
    {
      method: 'GET',
      match: paramWithSuffix('/api/admin/image-references/', 'id', '/blob'),
      handle: (_req, res, { id }) => {
        imagesService.getReferencePhotoBlob(id).then(
          (blob) => {
            if (!blob) {
              sendJson(res, 404, { error: 'Reference photo not found' });
              return;
            }
            sendImageBlob(res, blob);
          },
          error => sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to load reference photo') }),
        );
      },
    },
    {
      method: 'POST',
      match: paramWithSuffix('/api/admin/image-references/', 'id', '/default'),
      handle: (_req, res, { id }) => {
        imagesService.setDefaultReferencePhoto(id).then(
          reference => {
            appendIdentityMutationAudit(
              'allowed',
              'Operator set default identity reference photo.',
              [`referenceId=${reference.id}`],
            );
            sendJson(res, 200, { ok: true, reference }, ADMIN_DYNAMIC_JSON_HEADERS);
          },
          error => {
            const safeError = toSanitizedMessage(error, 'Failed to set default reference photo');
            appendIdentityMutationAudit(
              'denied',
              `Operator default reference photo update failed: ${safeError}`,
              [`referenceId=${id}`],
            );
            sendJson(res, statusFromReferenceError(error), { error: safeError });
          },
        );
      },
    },
    {
      method: 'PATCH',
      match: prefixedParamPath('/api/admin/image-references/', 'id'),
      handle: (req, res, { id }) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          if (parsed.value === null || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
            sendJson(res, 400, { error: 'Reference photo update payload must be a JSON object' });
            return;
          }
          const payload = parsed.value as Record<string, unknown>;
          imagesService.updateReferencePhoto(id, {
            ...(typeof payload.description === 'string' ? { description: payload.description } : {}),
            ...(Array.isArray(payload.tags)
              ? { tags: payload.tags.filter((tag): tag is string => typeof tag === 'string') }
              : {}),
            ...(typeof payload.setDefault === 'boolean' ? { setDefault: payload.setDefault } : {}),
          }).then(
            reference => {
              appendIdentityMutationAudit(
                'allowed',
                'Operator updated identity reference photo.',
                [`referenceId=${reference.id}`],
              );
              sendJson(res, 200, { ok: true, reference }, ADMIN_DYNAMIC_JSON_HEADERS);
            },
            error => {
              const safeError = toSanitizedMessage(error, 'Failed to update reference photo');
              appendIdentityMutationAudit(
                'denied',
                `Operator reference photo update failed: ${safeError}`,
                [`referenceId=${id}`],
              );
              sendJson(res, statusFromReferenceError(error), { error: safeError });
            },
          );
        });
      },
    },
    {
      method: 'DELETE',
      match: prefixedParamPath('/api/admin/image-references/', 'id'),
      handle: (_req, res, { id }) => {
        imagesService.deleteReferencePhoto(id).then(
          () => {
            appendIdentityMutationAudit(
              'allowed',
              'Operator deleted identity reference photo.',
              [`referenceId=${id}`],
            );
            sendJson(res, 200, { ok: true }, ADMIN_DYNAMIC_JSON_HEADERS);
          },
          error => {
            const safeError = toSanitizedMessage(error, 'Failed to delete reference photo');
            appendIdentityMutationAudit(
              'denied',
              `Operator reference photo deletion failed: ${safeError}`,
              [`referenceId=${id}`],
            );
            sendJson(res, statusFromReferenceError(error), { error: safeError });
          },
        );
      },
    },
  ];
}
