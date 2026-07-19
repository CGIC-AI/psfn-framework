import { sendJson } from '../../../channels/backplane/http/primitives.js';
import {
  parsePrivacyBreakGlassConfirmRequest,
  parsePrivacyBreakGlassDecideRequest,
  privacyBreakGlassReasonDigest,
  privacyBreakGlassResourceSelectorDigest,
  type PrivacyBreakGlassConfirmRequest,
  type PrivacyBreakGlassDecideRequest,
  type PrivacyBreakGlassResourceKind,
} from '../../../shared/contracts/privacy-break-glass.js';
import { parseAdminJsonBody } from '../request-body.js';
import { paramWithSuffix } from '../route-matchers.js';
import type {
  AdminPrivacyBreakGlassService,
  PrivacyBreakGlassAuditEvidence,
} from '../services/privacy-break-glass-service.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import type { FleetGardenRequestContext, GardenRequestContext } from '../garden-request-context.js';
import type { AdminApiRoute, AdminAuditTimelineAppender, AdminBodyReader } from './types.js';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;
const log = createComponentLogger('PrivacyBreakGlassRoutes');

function fleetContext(context: GardenRequestContext | undefined): FleetGardenRequestContext | null {
  return context?.kind === 'fleet_principal' ? context : null;
}

function details(evidence: PrivacyBreakGlassAuditEvidence): string[] {
  return [
    `assurance=${evidence.assurance}`,
    `resourceKind=${evidence.resourceKind}`,
    `resourceSelectorDigest=${evidence.resourceSelectorDigest}`,
    `reasonCategory=${evidence.reasonCategory}`,
    `reasonDigest=${evidence.reasonDigest}`,
    `subjectScopeDigest=${evidence.subjectScopeDigest}`,
    `confirmationDecisionId=${evidence.confirmationDecisionId}`,
    `expiresAt=${evidence.expiresAt}`,
  ];
}

function routePair(input: {
  resourceKind: PrivacyBreakGlassResourceKind;
  service: AdminPrivacyBreakGlassService | null | undefined;
  appendAudit: AdminAuditTimelineAppender | undefined;
  withBody: AdminBodyReader;
}): AdminApiRoute[] {
  const prefix = `/api/admin/privacy-break-glass/${input.resourceKind}/`;
  const audit = (
    decision: 'allowed' | 'denied' | 'needs_approval',
    narrative: string,
    auditDetails: Array<string | null | undefined>,
    context: GardenRequestContext | undefined,
  ): boolean => {
    if (!input.appendAudit) return false;
    try {
      input.appendAudit('memory_access', decision, narrative, auditDetails, 'operator', context);
      return true;
    } catch (error) {
      log.error('Failed to append privacy break-glass audit decision', {
        decision,
        resourceKind: input.resourceKind,
        error: toErrorMessage(error),
      });
      return false;
    }
  };
  const unavailable = (
    res: Parameters<AdminApiRoute['handle']>[1],
  ): void => sendJson(res, 503, { error: 'Privacy break-glass is unavailable' }, NO_STORE);
  return [
    {
      method: 'POST',
      match: paramWithSuffix(prefix, 'id', '/confirm'),
      handle: (req, res, { id }, context) => {
        if (!input.appendAudit) {
          unavailable(res);
          return;
        }
        if (!input.service) {
          audit('denied', 'Privacy break-glass confirmation request failed closed.', [
            'phase=confirm',
            `resourceKind=${input.resourceKind}`,
            `resourceSelectorDigest=${privacyBreakGlassResourceSelectorDigest(input.resourceKind, id)}`,
            'reasonCode=service_unavailable',
          ], context);
          unavailable(res);
          return;
        }
        input.withBody(req, res, body => {
          const parsed = parseAdminJsonBody(body);
          let request: PrivacyBreakGlassConfirmRequest;
          try {
            if (!parsed.ok) throw new Error(parsed.error);
            request = parsePrivacyBreakGlassConfirmRequest(parsed.value);
          } catch {
            if (!audit('denied', 'Privacy break-glass confirmation request was denied.', [
              'phase=confirm',
              `resourceKind=${input.resourceKind}`,
              `resourceSelectorDigest=${privacyBreakGlassResourceSelectorDigest(input.resourceKind, id)}`,
              'reasonCode=invalid_request',
            ], context)) {
              unavailable(res);
              return;
            }
            sendJson(res, 400, { error: 'Invalid privacy break-glass confirmation request' }, NO_STORE);
            return;
          }
          const principal = fleetContext(context);
          if (!principal) {
            if (!audit('denied', 'Privacy break-glass confirmation request was denied.', [
              'phase=confirm',
              `resourceKind=${input.resourceKind}`,
              `resourceSelectorDigest=${privacyBreakGlassResourceSelectorDigest(input.resourceKind, id)}`,
              `reasonCategory=${request.reasonCategory}`,
              `reasonDigest=${privacyBreakGlassReasonDigest(request)}`,
              'reasonCode=trusted_principal_required',
            ], context)) {
              unavailable(res);
              return;
            }
            sendJson(res, 403, { error: 'Privacy break-glass denied' }, NO_STORE);
            return;
          }
          void input.service.begin({
            resourceKind: input.resourceKind,
            resourceId: id,
            request,
            context: principal,
          }).then(result => {
            if (!result.ok) {
              if (!audit('denied', 'Privacy break-glass confirmation request was denied.', [
                'phase=confirm',
                `resourceKind=${input.resourceKind}`,
                `resourceSelectorDigest=${privacyBreakGlassResourceSelectorDigest(input.resourceKind, id)}`,
                `reasonCategory=${request.reasonCategory}`,
                `reasonDigest=${privacyBreakGlassReasonDigest(request)}`,
                `reasonCode=${result.code}`,
              ], context)) {
                unavailable(res);
                return;
              }
              sendJson(res, result.status, { error: 'Privacy break-glass denied' }, NO_STORE);
              return;
            }
            if (!audit(
              'needs_approval',
              'Privacy break-glass confirmation was issued (step 1 of 2).',
              ['phase=confirm', ...details(result.audit)],
              context,
            )) {
              unavailable(res);
              return;
            }
            sendJson(res, 200, {
              ok: true,
              confirmToken: result.confirmToken,
              expiresAt: result.expiresAt,
            }, NO_STORE);
          }, () => {
            audit('denied', 'Privacy break-glass confirmation request failed closed.', [
              'phase=confirm',
              `resourceKind=${input.resourceKind}`,
              `resourceSelectorDigest=${privacyBreakGlassResourceSelectorDigest(input.resourceKind, id)}`,
              'reasonCode=server_error',
            ], context);
            unavailable(res);
          }).catch(() => unavailable(res));
        });
      },
    },
    {
      method: 'POST',
      match: paramWithSuffix(prefix, 'id', '/decide'),
      handle: (req, res, { id }, context) => {
        if (!input.appendAudit) {
          unavailable(res);
          return;
        }
        if (!input.service) {
          audit('denied', 'Privacy break-glass decision failed closed.', [
            'phase=decide',
            `resourceKind=${input.resourceKind}`,
            `resourceSelectorDigest=${privacyBreakGlassResourceSelectorDigest(input.resourceKind, id)}`,
            'reasonCode=service_unavailable',
          ], context);
          unavailable(res);
          return;
        }
        input.withBody(req, res, body => {
          const parsed = parseAdminJsonBody(body);
          let request: PrivacyBreakGlassDecideRequest;
          try {
            if (!parsed.ok) throw new Error(parsed.error);
            request = parsePrivacyBreakGlassDecideRequest(parsed.value);
          } catch {
            if (!audit('denied', 'Privacy break-glass decision was denied.', [
              'phase=decide',
              `resourceKind=${input.resourceKind}`,
              `resourceSelectorDigest=${privacyBreakGlassResourceSelectorDigest(input.resourceKind, id)}`,
              'reasonCode=invalid_request',
            ], context)) {
              unavailable(res);
              return;
            }
            sendJson(res, 400, { error: 'Invalid privacy break-glass decision request' }, NO_STORE);
            return;
          }
          const principal = fleetContext(context);
          if (!principal) {
            if (!audit('denied', 'Privacy break-glass decision was denied.', [
              'phase=decide',
              `resourceKind=${input.resourceKind}`,
              `resourceSelectorDigest=${privacyBreakGlassResourceSelectorDigest(input.resourceKind, id)}`,
              `reasonCategory=${request.reasonCategory}`,
              `reasonDigest=${privacyBreakGlassReasonDigest(request)}`,
              'reasonCode=trusted_principal_required',
            ], context)) {
              unavailable(res);
              return;
            }
            sendJson(res, 403, { error: 'Privacy break-glass denied' }, NO_STORE);
            return;
          }
          void input.service.decide({
            resourceKind: input.resourceKind,
            resourceId: id,
            request,
            context: principal,
          }).then(result => {
            if (!result.ok) {
              if (!audit('denied', 'Privacy break-glass decision was denied.', [
                'phase=decide',
                `resourceKind=${input.resourceKind}`,
                `resourceSelectorDigest=${privacyBreakGlassResourceSelectorDigest(input.resourceKind, id)}`,
                `reasonCategory=${request.reasonCategory}`,
                `reasonDigest=${privacyBreakGlassReasonDigest(request)}`,
                `reasonCode=${result.code}`,
              ], context)) {
                unavailable(res);
                return;
              }
              sendJson(res, result.status, { error: 'Privacy break-glass denied' }, NO_STORE);
              return;
            }
            if (!audit(
              'allowed',
              'Privacy break-glass disclosed one exact resource (step 2 of 2).',
              ['phase=decide', ...details(result.audit)],
              context,
            )) {
              unavailable(res);
              return;
            }
            sendJson(res, 200, { ok: true, disclosure: result.disclosure }, NO_STORE);
          }, () => {
            audit('denied', 'Privacy break-glass decision failed closed.', [
              'phase=decide',
              `resourceKind=${input.resourceKind}`,
              `resourceSelectorDigest=${privacyBreakGlassResourceSelectorDigest(input.resourceKind, id)}`,
              'reasonCode=server_error',
            ], context);
            unavailable(res);
          }).catch(() => unavailable(res));
        });
      },
    },
  ];
}

export function buildAdminPrivacyBreakGlassRoutes(options: {
  service?: AdminPrivacyBreakGlassService | null;
  appendAuditTimelineEntry?: AdminAuditTimelineAppender;
  withBody: AdminBodyReader;
}): AdminApiRoute[] {
  return [
    ...routePair({
      resourceKind: 'memory',
      service: options.service,
      appendAudit: options.appendAuditTimelineEntry,
      withBody: options.withBody,
    }),
    ...routePair({
      resourceKind: 'profile',
      service: options.service,
      appendAudit: options.appendAuditTimelineEntry,
      withBody: options.withBody,
    }),
  ];
}
