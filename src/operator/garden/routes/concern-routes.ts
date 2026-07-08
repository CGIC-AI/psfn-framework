import { sendJson } from '../../../channels/backplane/http/primitives.js';
import {
  ACTIVE_CONCERN_STATUSES,
  normalizeConcernEvidenceRefs,
  normalizeConcernStatus,
  type ActiveConcernEvidenceRef,
  type ActiveConcernStaleResolutionOptions,
  type ActiveConcernTransitionOptions,
} from '../../../core/intention/concerns.js';
import { isRecord } from '../../../shared/utils/types.js';
import { parseAdminJsonBody } from '../request-body.js';
import { parseRequestUrl } from '../request-url.js';
import { exactPath, paramWithSuffix } from '../route-matchers.js';
import type { AdminConcernService } from '../services/types.js';
import { ADMIN_DYNAMIC_JSON_HEADERS, toSanitizedMessage } from './shared.js';
import type { AdminApiRoute, AdminBodyReader } from './types.js';

function parseBooleanQuery(value: string | null): boolean | undefined {
  if (value === null) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return undefined;
}

function parsePositiveIntegerQuery(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return undefined;
  return parsed;
}

function parseOptionalText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string`);
  }
  const normalized = value.trim();
  return normalized || undefined;
}

function parseOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`${field} must be a boolean`);
  }
  return value;
}

function parseOptionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  return value;
}

function parseOptionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function parseEvidenceRefs(value: unknown): ActiveConcernEvidenceRef[] | undefined {
  if (value === undefined) return undefined;
  return normalizeConcernEvidenceRefs(value as ActiveConcernEvidenceRef[]);
}

function parseResolveInput(value: unknown): { outcome?: string; evidenceRef?: string } {
  if (value === null || value === undefined) return {};
  if (!isRecord(value)) {
    throw new Error('Concern action payload must be a JSON object');
  }
  const outcome = parseOptionalText(value.outcome, 'outcome');
  const evidenceRef = parseOptionalText(value.evidenceRef, 'evidenceRef');
  return {
    ...(outcome ? { outcome } : {}),
    ...(evidenceRef ? { evidenceRef } : {}),
  };
}

function parseTransitionInput(value: unknown): ActiveConcernTransitionOptions {
  if (!isRecord(value)) {
    throw new Error('Concern transition payload must be a JSON object');
  }
  if (value.status === undefined) {
    throw new Error('status is required');
  }
  const status = normalizeConcernStatus(value.status);
  const outcome = parseOptionalText(value.outcome, 'outcome');
  const transitionedAt = parseOptionalText(value.transitionedAt, 'transitionedAt');
  const nextReviewAt = parseOptionalText(value.nextReviewAt, 'nextReviewAt');
  const clearNextReview = parseOptionalBoolean(value.clearNextReview, 'clearNextReview');
  const salience = parseOptionalNumber(value.salience, 'salience');
  const evidenceRefs = parseEvidenceRefs(value.evidenceRefs);
  const resolutionEvidenceRefs = parseEvidenceRefs(value.resolutionEvidenceRefs);

  return {
    status,
    ...(outcome ? { outcome } : {}),
    ...(transitionedAt ? { transitionedAt } : {}),
    ...(nextReviewAt ? { nextReviewAt } : {}),
    ...(clearNextReview !== undefined ? { clearNextReview } : {}),
    ...(salience !== undefined ? { salience } : {}),
    ...(evidenceRefs ? { evidenceRefs } : {}),
    ...(resolutionEvidenceRefs ? { resolutionEvidenceRefs } : {}),
  };
}

function parseStaleInput(value: unknown): ActiveConcernStaleResolutionOptions {
  if (value === null || value === undefined) return {};
  if (!isRecord(value)) {
    throw new Error('Concern stale-resolution payload must be a JSON object');
  }
  const asOf = parseOptionalText(value.asOf, 'asOf');
  const outcome = parseOptionalText(value.outcome, 'outcome');
  const limit = parseOptionalPositiveInteger(value.limit, 'limit');
  const evidenceRefs = parseEvidenceRefs(value.evidenceRefs);
  let statuses: typeof ACTIVE_CONCERN_STATUSES[number][] | undefined;
  if (value.statuses !== undefined) {
    if (!Array.isArray(value.statuses)) {
      throw new Error('statuses must be an array');
    }
    statuses = value.statuses.map(status => normalizeConcernStatus(status));
  }

  return {
    ...(asOf ? { asOf } : {}),
    ...(outcome ? { outcome } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(statuses ? { statuses } : {}),
    ...(evidenceRefs ? { evidenceRefs } : {}),
  };
}

function withParsedBody<T>(
  withBody: AdminBodyReader,
  req: Parameters<AdminApiRoute['handle']>[0],
  res: Parameters<AdminApiRoute['handle']>[1],
  parser: (value: unknown) => T,
  handle: (value: T) => void,
): void {
  withBody(req, res, (body) => {
    const parsed = parseAdminJsonBody(body);
    if (!parsed.ok) {
      sendJson(res, 400, { error: parsed.error });
      return;
    }
    try {
      handle(parser(parsed.value));
    } catch (error) {
      sendJson(res, 400, { error: toSanitizedMessage(error, 'Invalid concern payload') });
    }
  });
}

export function buildAdminConcernRoutes(options: {
  concernService?: AdminConcernService | null;
  withBody: AdminBodyReader;
}): AdminApiRoute[] {
  const { concernService, withBody } = options;

  return [
    {
      method: 'GET',
      match: exactPath('/api/admin/concerns'),
      handle: (req, res) => {
        if (!concernService) {
          sendJson(res, 503, { error: 'Concern management backend unavailable' });
          return;
        }
        const url = parseRequestUrl(req, '/api/admin/concerns');
        const includeResolved = parseBooleanQuery(url.searchParams.get('includeResolved'));
        const includeExpired = parseBooleanQuery(url.searchParams.get('includeExpired'));
        const limit = parsePositiveIntegerQuery(url.searchParams.get('limit'));
        concernService.listConcerns({
          ...(url.searchParams.get('contactId') ? { contactId: url.searchParams.get('contactId') ?? undefined } : {}),
          ...(includeResolved !== undefined ? { includeResolved } : {}),
          ...(includeExpired !== undefined ? { includeExpired } : {}),
          ...(limit !== undefined ? { limit } : {}),
        }).then(
          payload => sendJson(res, 200, payload, ADMIN_DYNAMIC_JSON_HEADERS),
          error => sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to list concerns') }),
        );
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/admin/concerns/resolve-stale'),
      handle: (req, res) => {
        if (!concernService) {
          sendJson(res, 503, { error: 'Concern management backend unavailable' });
          return;
        }
        withParsedBody(withBody, req, res, parseStaleInput, (input) => {
          concernService.resolveStaleConcerns(input).then(
            payload => sendJson(res, 200, payload, ADMIN_DYNAMIC_JSON_HEADERS),
            error => sendJson(res, 400, { error: toSanitizedMessage(error, 'Failed to resolve stale concerns') }),
          );
        });
      },
    },
    {
      method: 'POST',
      match: paramWithSuffix('/api/admin/concerns/', 'concernId', '/resolve'),
      handle: (req, res, { concernId }) => {
        if (!concernService) {
          sendJson(res, 503, { error: 'Concern management backend unavailable' });
          return;
        }
        withParsedBody(withBody, req, res, parseResolveInput, (input) => {
          concernService.resolveConcern(concernId, input).then(
            (payload) => {
              sendJson(res, payload.ok ? 200 : 404, payload, ADMIN_DYNAMIC_JSON_HEADERS);
            },
            error => sendJson(res, 400, { error: toSanitizedMessage(error, 'Failed to resolve concern') }),
          );
        });
      },
    },
    {
      method: 'POST',
      match: paramWithSuffix('/api/admin/concerns/', 'concernId', '/suppress'),
      handle: (req, res, { concernId }) => {
        if (!concernService) {
          sendJson(res, 503, { error: 'Concern management backend unavailable' });
          return;
        }
        withParsedBody(withBody, req, res, parseResolveInput, (input) => {
          concernService.suppressConcern(concernId, input).then(
            (payload) => {
              sendJson(res, payload.ok ? 200 : 404, payload, ADMIN_DYNAMIC_JSON_HEADERS);
            },
            error => sendJson(res, 400, { error: toSanitizedMessage(error, 'Failed to suppress concern') }),
          );
        });
      },
    },
    {
      method: 'POST',
      match: paramWithSuffix('/api/admin/concerns/', 'concernId', '/transition'),
      handle: (req, res, { concernId }) => {
        if (!concernService) {
          sendJson(res, 503, { error: 'Concern management backend unavailable' });
          return;
        }
        withParsedBody(withBody, req, res, parseTransitionInput, (input) => {
          concernService.transitionConcern(concernId, input).then(
            (payload) => {
              sendJson(res, payload.ok ? 200 : 404, payload, ADMIN_DYNAMIC_JSON_HEADERS);
            },
            error => sendJson(res, 400, { error: toSanitizedMessage(error, 'Failed to transition concern') }),
          );
        });
      },
    },
  ];
}
