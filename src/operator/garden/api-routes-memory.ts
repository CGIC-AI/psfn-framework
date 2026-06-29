import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../../channels/backplane/http/primitives.js';
import { VALID_MEMORY_TYPES, type MemoryRetentionClass, type MemoryType } from '../../faculties/memory/types.js';
import { VALID_SENSITIVITY_LEVELS, type SensitivityLevel } from '../../system/trust/types.js';
import { parseAdminJsonBody } from './request-body.js';
import { parseRequestUrl } from './request-url.js';
import {
  exactPath,
  paramWithSuffix,
  prefixedParamPath,
} from './route-matchers.js';
import { toSanitizedMessage } from './routes/shared.js';
import type { AdminApiRoute } from './routes/types.js';
import type { AdminMemoryService } from './services/types.js';

function toMemoryType(value: string | null): MemoryType | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  return VALID_MEMORY_TYPES.includes(normalized as MemoryType)
    ? normalized as MemoryType
    : undefined;
}

function toSensitivityLevel(value: string | null): SensitivityLevel | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  return VALID_SENSITIVITY_LEVELS.includes(normalized as SensitivityLevel)
    ? normalized as SensitivityLevel
    : undefined;
}

function toMemoryRetentionClass(value: string | null): MemoryRetentionClass | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === 'standard' || normalized === 'durable'
    ? normalized
    : undefined;
}

function toDateFilter(value: string | null, boundary: 'start' | 'end'): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateOnly) {
    const year = Number.parseInt(dateOnly[1], 10);
    const monthIndex = Number.parseInt(dateOnly[2], 10) - 1;
    const day = Number.parseInt(dateOnly[3], 10);
    const validatedDate = new Date(Date.UTC(year, monthIndex, day));
    if (
      validatedDate.getUTCFullYear() !== year
      || validatedDate.getUTCMonth() !== monthIndex
      || validatedDate.getUTCDate() !== day
    ) {
      return undefined;
    }
    if (boundary === 'start') {
      return Date.UTC(year, monthIndex, day, 0, 0, 0, 0);
    }
    return Date.UTC(year, monthIndex, day, 23, 59, 59, 999);
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return undefined;
  return parsed;
}

export function buildAdminMemoryRoutes(options: {
  memoryService: AdminMemoryService;
  withBody: (req: IncomingMessage, res: ServerResponse, cb: (body: string) => void) => void;
}): AdminApiRoute[] {
  const { memoryService, withBody } = options;

  return [
    {
      method: 'GET',
      match: exactPath('/api/admin/memory'),
      handle: (req, res) => {
        const url = parseRequestUrl(req, '/api/admin/memory');
        const typeFilter = toMemoryType(url.searchParams.get('type'));
        if (url.searchParams.get('type') && !typeFilter) {
          sendJson(res, 400, { error: 'Invalid memory type filter' });
          return;
        }
        const sensitivityFilter = toSensitivityLevel(url.searchParams.get('sensitivity'));
        if (url.searchParams.get('sensitivity') && !sensitivityFilter) {
          sendJson(res, 400, { error: 'Invalid memory sensitivity filter' });
          return;
        }
        const retentionFilter = toMemoryRetentionClass(url.searchParams.get('retention'));
        if (url.searchParams.get('retention') && !retentionFilter) {
          sendJson(res, 400, { error: 'Invalid memory retention filter' });
          return;
        }
        const startDate = toDateFilter(url.searchParams.get('startDate'), 'start');
        if (url.searchParams.get('startDate') && startDate === undefined) {
          sendJson(res, 400, { error: 'Invalid startDate filter' });
          return;
        }
        const endDate = toDateFilter(url.searchParams.get('endDate'), 'end');
        if (url.searchParams.get('endDate') && endDate === undefined) {
          sendJson(res, 400, { error: 'Invalid endDate filter' });
          return;
        }
        if (startDate !== undefined && endDate !== undefined && startDate > endDate) {
          sendJson(res, 400, { error: 'startDate must be before or equal to endDate' });
          return;
        }
        memoryService.listMemories(url.searchParams).then(
          (data) => sendJson(res, 200, {
            ...data,
            contactsById: Object.fromEntries(data.contactsById.entries()),
          }),
          (error) => sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to list memories') }),
        );
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/admin/memory/search'),
      handle: (req, res) => {
        const url = parseRequestUrl(req, '/api/admin/memory/search');
        const query = url.searchParams.get('q')?.trim() ?? '';
        if (!query) {
          sendJson(res, 400, { error: 'Missing q query parameter' });
          return;
        }
        memoryService.searchMemories(query).then(
          result => sendJson(res, 200, {
            ...result,
            contactsById: Object.fromEntries(result.contactsById.entries()),
          }),
          error => sendJson(res, 500, { error: String(error) }),
        );
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/admin/memory/scopes'),
      handle: (req, res) => {
        const url = parseRequestUrl(req, '/api/admin/memory/scopes');
        const kind = url.searchParams.get('kind');
        if (kind && !['project', 'north_star'].includes(kind.trim().toLowerCase())) {
          sendJson(res, 400, { error: 'Invalid managed memory scope kind' });
          return;
        }
        memoryService.listManagedScopes(url.searchParams).then(
          (data) => sendJson(res, 200, data),
          (error) => sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to list managed scopes') }),
        );
      },
    },
    {
      method: 'GET',
      match: paramWithSuffix('/api/admin/memory/scopes/', 'scopeKey', '/detail'),
      handle: (_req, res, { scopeKey }) => {
        const separator = scopeKey.indexOf(':');
        const kind = separator >= 0 ? scopeKey.slice(0, separator) : '';
        const id = separator >= 0 ? scopeKey.slice(separator + 1) : '';
        memoryService.getManagedScopeDetail(kind, id).then(
          (detail) => {
            if (!detail) {
              sendJson(res, 404, { error: 'Managed memory scope not found' });
              return;
            }
            sendJson(res, 200, detail);
          },
          (error) => {
            sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to load managed scope detail') });
          },
        );
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/admin/memory/scope-update'),
      handle: (req, res) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const payload = parsed.value as Record<string, unknown>;
          const id = typeof payload.id === 'string' ? payload.id.trim() : '';
          const rawScopeRef = payload.scopeRef;
          const scopeRef = rawScopeRef === null
            ? null
            : (typeof rawScopeRef === 'object'
              ? rawScopeRef as { kind?: string; id?: string; label?: string }
              : undefined);
          const scopeTags = Array.isArray(payload.scopeTags)
            ? payload.scopeTags.filter((value): value is string => typeof value === 'string')
            : undefined;
          const repair = payload.repair === true;

          if (!id) {
            sendJson(res, 400, { error: 'Memory id is required' });
            return;
          }
          if (scopeRef === undefined && scopeTags === undefined && !repair) {
            sendJson(res, 400, { error: 'scopeRef, scopeTags, or repair=true is required' });
            return;
          }

          memoryService.updateMemoryScope(id, { scopeRef, scopeTags, repair }).then(
            (result) => {
              if (!result.ok) {
                const status = result.message === 'Memory not found' ? 404 : 400;
                sendJson(res, status, { error: result.message ?? 'Failed to update memory scope' });
                return;
              }
              sendJson(res, 200, result);
            },
            (error) => sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to update memory scope') }),
          );
        });
      },
    },
    // ── Memory Linking ──
    {
      method: 'POST',
      match: exactPath('/api/admin/memory/link'),
      handle: (req, res) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const payload = parsed.value as Record<string, unknown>;
          const id1 = typeof payload.id1 === 'string' ? payload.id1.trim() : '';
          const id2 = typeof payload.id2 === 'string' ? payload.id2.trim() : '';
          const linkType = typeof payload.linkType === 'string' ? payload.linkType.trim() : undefined;

          if (!id1 || !id2) {
            sendJson(res, 400, { error: 'Both id1 and id2 are required' });
            return;
          }

          memoryService.linkMemories(id1, id2, linkType).then(
            (result) => {
              if (!result.ok) {
                sendJson(res, 400, { error: result.message ?? 'Failed to create link' });
                return;
              }
              sendJson(res, 201, result);
            },
            (error) => sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to create memory link') }),
          );
        });
      },
    },
    {
      method: 'DELETE',
      match: exactPath('/api/admin/memory/link'),
      handle: (req, res) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const payload = parsed.value as Record<string, unknown>;
          const id1 = typeof payload.id1 === 'string' ? payload.id1.trim() : '';
          const id2 = typeof payload.id2 === 'string' ? payload.id2.trim() : '';

          if (!id1 || !id2) {
            sendJson(res, 400, { error: 'Both id1 and id2 are required' });
            return;
          }

          memoryService.unlinkMemories(id1, id2).then(
            (result) => {
              if (!result.ok) {
                sendJson(res, 404, { error: result.message ?? 'Link not found' });
                return;
              }
              sendJson(res, 200, { ok: true });
            },
            (error) => sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to remove memory link') }),
          );
        });
      },
    },
    // ── Bulk Operations ──
    {
      method: 'POST',
      match: exactPath('/api/admin/memory/bulk-delete'),
      handle: (req, res) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const payload = parsed.value as Record<string, unknown>;
          const ids = Array.isArray(payload.ids)
            ? payload.ids.filter((v): v is string => typeof v === 'string')
            : [];

          if (!ids.length) {
            sendJson(res, 400, { error: 'ids array is required and must not be empty' });
            return;
          }

          memoryService.bulkDelete(ids).then(
            (result) => {
              if (!result.ok) {
                sendJson(res, 400, { error: result.message ?? 'Bulk delete failed' });
                return;
              }
              sendJson(res, 200, result);
            },
            (error) => sendJson(res, 500, { error: toSanitizedMessage(error, 'Bulk delete failed') }),
          );
        });
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/admin/memory/bulk-update'),
      handle: (req, res) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const payload = parsed.value as Record<string, unknown>;
          const ids = Array.isArray(payload.ids)
            ? payload.ids.filter((v): v is string => typeof v === 'string')
            : [];
          const fields = typeof payload.fields === 'object' && payload.fields !== null
            ? payload.fields as Record<string, unknown>
            : {};

          if (!ids.length) {
            sendJson(res, 400, { error: 'ids array is required and must not be empty' });
            return;
          }

          const memoryType = typeof fields.memoryType === 'string' ? fields.memoryType : undefined;
          const sensitivity = typeof fields.sensitivity === 'string' ? fields.sensitivity : undefined;
          const retentionClass = typeof fields.retentionClass === 'string' ? fields.retentionClass : undefined;

          if (!memoryType && !sensitivity && !retentionClass) {
            sendJson(res, 400, { error: 'At least one field (memoryType, sensitivity, retentionClass) is required' });
            return;
          }

          memoryService.bulkUpdate(ids, { memoryType, sensitivity, retentionClass }).then(
            (result) => {
              if (!result.ok) {
                sendJson(res, 400, { error: result.message ?? 'Bulk update failed' });
                return;
              }
              sendJson(res, 200, result);
            },
            (error) => sendJson(res, 500, { error: toSanitizedMessage(error, 'Bulk update failed') }),
          );
        });
      },
    },
    // Sub-path route MUST come before generic prefixed param route
    {
      method: 'GET',
      match: paramWithSuffix('/api/admin/memory/', 'id', '/links'),
      handle: (_req, res, { id }) => {
        memoryService.getMemoryLinks(id).then(
          (links) => sendJson(res, 200, { links }),
          (error) => sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to load memory links') }),
        );
      },
    },
    {
      method: 'PATCH',
      match: paramWithSuffix('/api/admin/memory/', 'id', '/patch'),
      handle: (req, res, { id }) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const payload = parsed.value as Record<string, unknown>;
          const text = typeof payload.text === 'string' ? payload.text.trim() : '';
          const reason = typeof payload.reason === 'string' ? payload.reason.trim() : undefined;
          const referencePath = typeof payload.referencePath === 'string' ? payload.referencePath.trim() : undefined;
          if (!text) {
            sendJson(res, 400, { error: 'Replacement text is required' });
            return;
          }

          const patchMemory = (
            memoryService as AdminMemoryService & {
              patchMemory?: (
                memoryId: string,
                fields: { text: string; reason?: string; referencePath?: string },
              ) => Promise<{ ok: boolean; message?: string }>;
            }
          ).patchMemory;
          if (typeof patchMemory !== 'function') {
            sendJson(res, 400, { error: 'Memory patching is not available' });
            return;
          }

          void patchMemory(id, { text, reason, referencePath })
            .then((result) => {
              if (!result.ok) {
                const status = result.message === 'Memory not found' ? 404 : 400;
                sendJson(res, status, { error: result.message ?? 'Failed to patch memory' });
                return;
              }
              sendJson(res, 200, result);
            })
            .catch((error) => {
              sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
            });
        });
      },
    },
    {
      method: 'GET',
      match: prefixedParamPath('/api/admin/memory/', 'id'),
      handle: (_req, res, { id }) => {
        memoryService.getMemoryDetail(id).then(
          (detail) => {
            if (!detail) {
              sendJson(res, 404, { error: 'Memory not found' });
              return;
            }
            sendJson(res, 200, detail);
          },
          (error) => {
            sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to load memory detail') });
          },
        );
      },
    },
    {
      method: 'DELETE',
      match: prefixedParamPath('/api/admin/memory/', 'id'),
      handle: (_req, res, { id }) => {
        memoryService.supersedeMemory(id).then(
          (result) => {
            if (!result.ok) {
              sendJson(res, 404, { error: result.message ?? 'Memory not found' });
              return;
            }
            sendJson(res, 200, { ok: true });
          },
          (error) => sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to supersede memory') }),
        );
      },
    },
  ];
}
