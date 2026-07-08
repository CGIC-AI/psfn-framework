// ── Garden hub-identity enrollment routes (S10 Workstream F1 / Decision 4) ──
// Additive, isolated route module for the operator enrollment surface.
// Registered from buildAdminApiRoutes when an enrollment service is wired.
//
//   GET    /api/admin/enrollments                  — list hub-identity ↔ contact bindings
//   POST   /api/admin/enrollments                  — bind an opaque handle to an EXISTING contact
//   DELETE /api/admin/enrollments/:hubIdentityId    — revoke an active binding
//
// Human-in-the-loop only. No biometric payload appears anywhere here — only the
// opaque hub-identity handle and the contact reference. Enroll fails closed when
// the contact does not exist (never auto-creates a contact).

import { sendJson } from '../../channels/backplane/http/primitives.js';
import { parseAdminJsonBody } from './request-body.js';
import { parseRequestUrl } from './request-url.js';
import { isRecord } from '../../shared/utils/types.js';
import {
  exactPath,
  prefixedParamPath,
} from './route-matchers.js';
import { ADMIN_DYNAMIC_JSON_HEADERS, toSanitizedMessage } from './routes/shared.js';
import type { AdminApiRoute, AdminBodyReader } from './routes/types.js';
import type { AdminEnrollmentService } from './services/enrollment-service.js';

function optionalString(value: unknown, field: string): { ok: true; value?: string } | { ok: false; error: string } {
  if (value === undefined) return { ok: true };
  if (typeof value !== 'string') return { ok: false, error: `${field} must be a string` };
  const trimmed = value.trim();
  return { ok: true, ...(trimmed ? { value: trimmed } : {}) };
}

export function buildAdminEnrollmentRoutes(options: {
  enrollmentService: AdminEnrollmentService;
  withBody: AdminBodyReader;
}): AdminApiRoute[] {
  const { enrollmentService, withBody } = options;

  return [
    {
      method: 'GET',
      match: exactPath('/api/admin/enrollments'),
      handle: (_req, res) => {
        enrollmentService.listEnrollments().then(
          (data) => sendJson(res, 200, data, ADMIN_DYNAMIC_JSON_HEADERS),
          (error) => sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to list enrollments') }),
        );
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/admin/enrollments'),
      handle: (req, res) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          if (!isRecord(parsed.value)) {
            sendJson(res, 400, { error: 'Enrollment payload must be a JSON object' });
            return;
          }
          const payload = parsed.value;
          if (typeof payload.hubIdentityId !== 'string' || !payload.hubIdentityId.trim()) {
            sendJson(res, 400, { error: 'hubIdentityId is required' });
            return;
          }
          if (typeof payload.canonicalContactId !== 'string' || !payload.canonicalContactId.trim()) {
            sendJson(res, 400, { error: 'canonicalContactId is required' });
            return;
          }
          const satelliteId = optionalString(payload.satelliteId, 'satelliteId');
          if (!satelliteId.ok) { sendJson(res, 400, { error: satelliteId.error }); return; }
          const endpointId = optionalString(payload.endpointId, 'endpointId');
          if (!endpointId.ok) { sendJson(res, 400, { error: endpointId.error }); return; }
          const actor = optionalString(payload.actor, 'actor');
          if (!actor.ok) { sendJson(res, 400, { error: actor.error }); return; }

          enrollmentService.enroll({
            hubIdentityId: payload.hubIdentityId,
            canonicalContactId: payload.canonicalContactId,
            ...(satelliteId.value ? { satelliteId: satelliteId.value } : {}),
            ...(endpointId.value ? { endpointId: endpointId.value } : {}),
            ...(actor.value ? { actor: actor.value } : {}),
          }).then(
            (binding) => sendJson(res, 201, { ok: true, binding }, ADMIN_DYNAMIC_JSON_HEADERS),
            (error) => sendJson(res, 400, { error: toSanitizedMessage(error, 'Failed to enroll hub identity') }),
          );
        });
      },
    },
    {
      method: 'DELETE',
      match: prefixedParamPath('/api/admin/enrollments/', 'hubIdentityId'),
      handle: (req, res, { hubIdentityId }) => {
        const url = parseRequestUrl(req, '/api/admin/enrollments');
        const actor = url.searchParams.get('actor')?.trim() || undefined;
        enrollmentService.revoke(hubIdentityId, actor).then(
          (result) => {
            if (!result.revoked) {
              sendJson(res, 404, { error: 'No active enrollment to revoke', ...result }, ADMIN_DYNAMIC_JSON_HEADERS);
              return;
            }
            sendJson(res, 200, { ok: true, ...result }, ADMIN_DYNAMIC_JSON_HEADERS);
          },
          (error) => sendJson(res, 400, { error: toSanitizedMessage(error, 'Failed to revoke hub identity') }),
        );
      },
    },
  ];
}
