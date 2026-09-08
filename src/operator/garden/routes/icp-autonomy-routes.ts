import { sendJson } from '../../../channels/backplane/http/primitives.js';
import { isRecord, isRfc4122Uuid } from '../../../shared/utils/types.js';
import { parseAdminJsonBody } from '../request-body.js';
import { exactPath, paramWithSuffix } from '../route-matchers.js';
import { AdminIcpReadmissionRefusedError } from '../services/icp-autonomy-service.js';
import type { AdminIcpAutonomyService } from '../services/types.js';
import { ADMIN_DYNAMIC_JSON_HEADERS, sendInternalError, toSanitizedMessage } from './shared.js';
import type { AdminApiRoute, AdminAuditTimelineAppender, AdminBodyReader } from './types.js';

const ICP_AUTONOMY_PATH = '/api/admin/icp-autonomy';
const ICP_TEST_INITIATIONS_PATH = `${ICP_AUTONOMY_PATH}/test-initiations`;
const ICP_CANDIDATE_PREFIX = `${ICP_AUTONOMY_PATH}/candidates/`;
const ICP_DND_PATH = `${ICP_AUTONOMY_PATH}/do-not-disturb`;
const ICP_EMERGENCY_DISABLE_PATH = `${ICP_AUTONOMY_PATH}/emergency-disable`;
const ICP_LIFECYCLE_READMIT_PATH = `${ICP_AUTONOMY_PATH}/lifecycle/readmit`;

function parseEmptyBody(value: unknown): string | null {
  if (!isRecord(value)) return 'Body must be a JSON object';
  const unknown = Object.keys(value);
  return unknown.length > 0 ? `Unknown fields: ${unknown.join(', ')}` : null;
}

function parseCancelBody(
  value: unknown,
): { ok: true; expectedRevision: number } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: 'Body must be a JSON object' };
  const unknown = Object.keys(value).filter(key => key !== 'expectedRevision');
  if (unknown.length > 0) {
    return { ok: false, error: `Unknown candidate cancellation fields: ${unknown.join(', ')}` };
  }
  if (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 1) {
    return { ok: false, error: 'expectedRevision must be a positive safe integer' };
  }
  return { ok: true, expectedRevision: value.expectedRevision as number };
}

function parseTestInitiationBody(value: unknown):
  | { ok: true; peerCompanionId: string; requestId: string }
  | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: 'Body must be a JSON object' };
  const unknown = Object.keys(value)
    .filter(key => key !== 'peerCompanionId' && key !== 'requestId');
  if (unknown.length > 0) {
    return { ok: false, error: `Unknown test initiation fields: ${unknown.join(', ')}` };
  }
  if (!isRfc4122Uuid(value.peerCompanionId)) {
    return { ok: false, error: 'peerCompanionId must be a lowercase RFC-4122 UUID' };
  }
  if (!isRfc4122Uuid(value.requestId)) {
    return { ok: false, error: 'requestId must be a lowercase RFC-4122 UUID' };
  }
  return {
    ok: true,
    peerCompanionId: value.peerCompanionId,
    requestId: value.requestId,
  };
}

function parseReadmitBody(
  value: unknown,
): { ok: true; companionId: string; confirmCompanionId: string } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: 'Body must be a JSON object' };
  const unknown = Object.keys(value)
    .filter(key => key !== 'companionId' && key !== 'confirmCompanionId');
  if (unknown.length > 0) {
    return { ok: false, error: `Unknown readmission fields: ${unknown.join(', ')}` };
  }
  if (!isRfc4122Uuid(value.companionId)) {
    return { ok: false, error: 'companionId must be a lowercase RFC-4122 UUID' };
  }
  // The explicit operator confirmation: the body must echo the exact target, so
  // a blind or replayed body can never clear a durable admission fence.
  if (!isRfc4122Uuid(value.confirmCompanionId)) {
    return {
      ok: false,
      error: 'confirmCompanionId must echo the companionId being readmitted',
    };
  }
  return {
    ok: true,
    companionId: value.companionId,
    confirmCompanionId: value.confirmCompanionId,
  };
}

function statusForMutationError(error: unknown): number {
  const message = error instanceof Error ? error.message : '';
  return /not found/u.test(message)
    ? 404
    : /(revision conflict|cannot be cancelled|no revocable)/u.test(message)
      ? 409
      : 500;
}

export function buildAdminIcpAutonomyRoutes(options: {
  service: AdminIcpAutonomyService;
  withBody: AdminBodyReader;
  appendAuditTimelineEntry?: AdminAuditTimelineAppender;
}): AdminApiRoute[] {
  const { service, withBody, appendAuditTimelineEntry } = options;
  const audit = (
    decision: 'allowed' | 'denied',
    narrative: string,
    details: Array<string | null | undefined> = [],
  ) => appendAuditTimelineEntry?.('autonomy_control', decision, narrative, details, 'operator');

  const withStrictBody = (
    req: Parameters<AdminBodyReader>[0],
    res: Parameters<AdminBodyReader>[1],
    action: string,
    handler: (value: unknown) => void,
  ): void => {
    withBody(req, res, body => {
      const parsed = parseAdminJsonBody(body);
      if (!parsed.ok) {
        audit('denied', `Operator ICP ${action} rejected invalid JSON.`);
        sendJson(res, 400, { error: parsed.error });
        return;
      }
      handler(parsed.value);
    });
  };

  return [
    {
      method: 'GET',
      match: exactPath(ICP_AUTONOMY_PATH),
      handle: (_req, res) => {
        service.getData().then(
          data => sendJson(res, 200, data, ADMIN_DYNAMIC_JSON_HEADERS),
          error => sendInternalError(res, error, 'Failed to load ICP autonomy state'),
        );
      },
    },
    {
      method: 'POST',
      match: exactPath(ICP_TEST_INITIATIONS_PATH),
      handle: (req, res) => {
        withStrictBody(req, res, 'test initiation', value => {
          const parsed = parseTestInitiationBody(value);
          if (!parsed.ok) {
            audit('denied', 'Operator ICP test initiation rejected invalid fields.');
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          service.triggerTestInitiation({
            peerCompanionId: parsed.peerCompanionId,
            requestId: parsed.requestId,
          }).then(result => {
            audit('allowed', result.outcome === 'accepted'
              ? 'Operator accepted an ICP test initiation for background delivery.'
              : 'Operator replayed an existing ICP test initiation.', [
              `peerCompanionId=${parsed.peerCompanionId}`,
              `requestId=${parsed.requestId}`,
              `candidateId=${result.candidateId}`,
              `outcome=${result.outcome}`,
              `status=${result.status}`,
              `deliveryDisposition=${result.deliveryDisposition}`,
            ]);
            sendJson(res, 200, result, ADMIN_DYNAMIC_JSON_HEADERS);
          }, error => {
            audit('denied', 'Operator ICP test initiation failed.', [
              `peerCompanionId=${parsed.peerCompanionId}`,
              `requestId=${parsed.requestId}`,
              `error=${toSanitizedMessage(error, 'initiation failed')}`,
            ]);
            sendInternalError(res, error, 'Failed to trigger ICP test initiation');
          });
        });
      },
    },
    {
      method: 'POST',
      match: paramWithSuffix(ICP_CANDIDATE_PREFIX, 'candidateId', '/cancel'),
      handle: (req, res, { candidateId }) => {
        withStrictBody(req, res, 'candidate cancellation', value => {
          if (!isRfc4122Uuid(candidateId)) {
            audit('denied', 'Operator ICP candidate cancellation rejected invalid identity.');
            sendJson(res, 400, { error: 'candidateId must be a lowercase RFC-4122 UUID' });
            return;
          }
          const parsed = parseCancelBody(value);
          if (!parsed.ok) {
            audit('denied', 'Operator ICP candidate cancellation rejected invalid fields.', [
              `candidateId=${candidateId}`,
            ]);
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          service.cancelCandidate({
            candidateId,
            expectedRevision: parsed.expectedRevision,
          }).then(result => {
            audit('allowed', 'Operator cancelled an ICP initiation candidate.', [
              `candidateId=${candidateId}`,
              `revokedPermits=${String(result.revokedPermitCount)}`,
            ]);
            sendJson(res, 200, result, ADMIN_DYNAMIC_JSON_HEADERS);
          }, error => {
            audit('denied', 'Operator ICP candidate cancellation failed.', [
              `candidateId=${candidateId}`,
              `error=${toSanitizedMessage(error, 'mutation failed')}`,
            ]);
            sendJson(res, statusForMutationError(error), {
              error: toSanitizedMessage(error, 'Failed to cancel ICP candidate'),
            });
          });
        });
      },
    },
    {
      method: 'POST',
      match: exactPath(ICP_LIFECYCLE_READMIT_PATH),
      handle: (req, res) => {
        withStrictBody(req, res, 'lifecycle readmission', value => {
          const parsed = parseReadmitBody(value);
          if (!parsed.ok) {
            audit('denied', 'Operator ICP lifecycle readmission rejected invalid fields.');
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          service.readmitCompanion({
            companionId: parsed.companionId,
            confirmCompanionId: parsed.confirmCompanionId,
          }).then(result => {
            audit('allowed', result.transitioned
              ? 'Operator readmitted a lifecycle-fenced companion to ICP.'
              : 'Operator readmission found the companion already admitted to ICP.', [
              `companionId=${result.companionId}`,
              `transitioned=${String(result.transitioned)}`,
              `revokedPermits=${String(result.revokedPermitCount)}`,
            ]);
            sendJson(res, 200, result, ADMIN_DYNAMIC_JSON_HEADERS);
          }, error => {
            const refused = error instanceof AdminIcpReadmissionRefusedError;
            audit('denied', 'Operator ICP lifecycle readmission was refused.', [
              `companionId=${parsed.companionId}`,
              ...(refused ? [`refusal=${error.refusal}`] : []),
              `error=${toSanitizedMessage(error, 'readmission refused')}`,
            ]);
            if (refused) {
              // A mismatched confirmation is a malformed request; an
              // off-manifest or unwired target is a legible state conflict.
              const status = error.refusal === 'confirmation_mismatch' ? 400 : 409;
              sendJson(res, status, { error: error.message, refusal: error.refusal });
              return;
            }
            sendInternalError(res, error, 'Failed to readmit ICP companion');
          });
        });
      },
    },
    {
      method: 'POST',
      match: exactPath(ICP_DND_PATH),
      handle: (req, res) => {
        withStrictBody(req, res, 'do-not-disturb', value => {
          const bodyError = parseEmptyBody(value);
          if (bodyError) {
            audit('denied', 'Operator ICP do-not-disturb rejected invalid fields.');
            sendJson(res, 400, { error: bodyError });
            return;
          }
          service.setDoNotDisturb().then(result => {
            audit('allowed', 'Operator published ICP do-not-disturb and invalidated permits.', [
              `revokedPermits=${String(result.revokedPermitCount)}`,
            ]);
            sendJson(res, 200, result, ADMIN_DYNAMIC_JSON_HEADERS);
          }, error => {
            audit('denied', 'Operator ICP do-not-disturb failed.', [
              `error=${toSanitizedMessage(error, 'mutation failed')}`,
            ]);
            sendInternalError(res, error, 'Failed to set ICP do-not-disturb');
          });
        });
      },
    },
    {
      method: 'POST',
      match: exactPath(ICP_EMERGENCY_DISABLE_PATH),
      handle: (req, res) => {
        withStrictBody(req, res, 'emergency disable', value => {
          const bodyError = parseEmptyBody(value);
          if (bodyError) {
            audit('denied', 'Operator ICP emergency disable rejected invalid fields.');
            sendJson(res, 400, { error: bodyError });
            return;
          }
          service.emergencyDisable().then(result => {
            audit('allowed', 'Operator emergency-disabled ICP autonomous initiation.', [
              `revokedPermits=${String(result.revokedPermitCount)}`,
            ]);
            sendJson(res, 200, result, ADMIN_DYNAMIC_JSON_HEADERS);
          }, error => {
            audit('denied', 'Operator ICP emergency disable failed.', [
              `error=${toSanitizedMessage(error, 'mutation failed')}`,
            ]);
            sendInternalError(res, error, 'Failed to emergency-disable ICP autonomy');
          });
        });
      },
    },
  ];
}
