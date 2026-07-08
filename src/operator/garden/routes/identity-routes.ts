import { sendJson } from '../../../channels/backplane/http/primitives.js';
import { handleMultipartUpload, validateAndParseCharacterCardFile } from '../multipart.js';
import { parseAdminJsonBody } from '../request-body.js';
import { exactPath } from '../route-matchers.js';
import type { AdminIdentityService } from '../services/types.js';
import type { AdminAuditDecision } from '../types.js';
import { toSanitizedMessage } from './shared.js';
import type { AdminApiRoute, AdminAuditTimelineAppender, AdminBodyReader } from './types.js';

export function buildAdminIdentityRoutes(options: {
  identityService: AdminIdentityService;
  appendAuditTimelineEntry?: AdminAuditTimelineAppender;
  withBody: AdminBodyReader;
}): AdminApiRoute[] {
  const { identityService, appendAuditTimelineEntry, withBody } = options;

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
      match: exactPath('/api/admin/identity'),
      handle: (_req, res) => {
        sendJson(res, 200, identityService.getIdentityData());
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/admin/identity/import'),
      handle: (req, res) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            appendIdentityMutationAudit(
              'denied',
              'Operator identity import via /api/admin/identity/import failed: invalid JSON payload.',
            );
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const payload = parsed.value as Record<string, unknown>;
          const rawPath = typeof payload.path === 'string' ? payload.path.trim() : '';
          identityService.importIdentityCard(JSON.stringify(parsed.value)).then(
            result => {
              const safeMessage = toSanitizedMessage(result.message, 'Identity import failed');
              if (!result.ok) {
                appendIdentityMutationAudit(
                  'denied',
                  `Operator identity import via /api/admin/identity/import failed: ${safeMessage}`,
                  [rawPath ? `path=${rawPath}` : null],
                );
                sendJson(res, 400, { error: safeMessage });
                return;
              }
              appendIdentityMutationAudit(
                'allowed',
                'Operator imported identity card via /api/admin/identity/import.',
                [
                  rawPath ? `path=${rawPath}` : null,
                  safeMessage,
                ],
              );
              sendJson(res, 201, { ...result, message: safeMessage });
            },
            error => {
              const safeError = toSanitizedMessage(error, 'Identity import failed unexpectedly');
              appendIdentityMutationAudit(
                'denied',
                `Operator identity import via /api/admin/identity/import failed: ${safeError}`,
                [rawPath ? `path=${rawPath}` : null],
              );
              sendJson(res, 500, { error: safeError });
            },
          );
        });
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/admin/identity/upload'),
      handle: (req, res) => {
        handleMultipartUpload(req, res).then(
          (uploadResult) => {
            if (!uploadResult.ok) {
              const safeError = toSanitizedMessage(uploadResult.error, 'Identity upload failed');
              appendIdentityMutationAudit(
                'denied',
                `Operator identity upload via /api/admin/identity/upload failed: ${safeError}`,
              );
              sendJson(res, uploadResult.status, { error: safeError });
              return;
            }
            const cardResult = validateAndParseCharacterCardFile(uploadResult.file);
            if (!cardResult.ok) {
              const safeError = toSanitizedMessage(cardResult.error, 'Identity upload failed');
              appendIdentityMutationAudit(
                'denied',
                `Operator identity upload via /api/admin/identity/upload failed: ${safeError}`,
                [`filename=${uploadResult.file.filename}`],
              );
              sendJson(res, 400, { error: safeError });
              return;
            }
            // Pass the parsed card data as a JSON string to the import service
            identityService.importIdentityCard(JSON.stringify({ cardData: cardResult.cardData })).then(
              result => {
                const safeMessage = toSanitizedMessage(result.message, 'Identity upload import failed');
                if (!result.ok) {
                  appendIdentityMutationAudit(
                    'denied',
                    `Operator identity upload via /api/admin/identity/upload failed: ${safeMessage}`,
                    [`filename=${cardResult.filename}`],
                  );
                  sendJson(res, 400, { error: safeMessage });
                  return;
                }
                appendIdentityMutationAudit(
                  'allowed',
                  'Operator imported identity card via /api/admin/identity/upload.',
                  [
                    `filename=${cardResult.filename}`,
                    `container=${cardResult.containerFormat}`,
                    `source=${cardResult.sourceFormat}`,
                    `spec=${cardResult.spec}`,
                    safeMessage,
                  ],
                );
                sendJson(res, 201, {
                  ...result,
                  message: safeMessage,
                  filename: cardResult.filename,
                  containerFormat: cardResult.containerFormat,
                  sourceFormat: cardResult.sourceFormat,
                  spec: cardResult.spec,
                  warnings: cardResult.warnings,
                });
              },
              error => {
                const safeError = toSanitizedMessage(error, 'Identity upload import failed unexpectedly');
                appendIdentityMutationAudit(
                  'denied',
                  `Operator identity upload via /api/admin/identity/upload failed: ${safeError}`,
                  [`filename=${cardResult.filename}`],
                );
                sendJson(res, 500, { error: safeError });
              },
            );
          },
          (error) => {
            const safeError = toSanitizedMessage(error, 'Identity upload failed unexpectedly');
            appendIdentityMutationAudit(
              'denied',
              `Operator identity upload via /api/admin/identity/upload failed: ${safeError}`,
            );
            sendJson(res, 500, { error: safeError });
          },
        );
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/admin/identity/rollback'),
      handle: (req, res) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            appendIdentityMutationAudit(
              'denied',
              'Operator identity rollback via /api/admin/identity/rollback failed: invalid JSON payload.',
            );
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const payload = parsed.value as Record<string, unknown>;
          const rawVersion = typeof payload.version === 'number' || typeof payload.version === 'string'
            ? String(payload.version)
            : '';
          const result = identityService.rollbackIdentityCard(JSON.stringify(parsed.value));
          if (!result.ok) {
            appendIdentityMutationAudit(
              'denied',
              `Operator identity rollback via /api/admin/identity/rollback failed: ${result.message}`,
              [rawVersion ? `version=${rawVersion}` : null],
            );
            sendJson(res, 400, { error: result.message });
            return;
          }
          appendIdentityMutationAudit(
            'allowed',
            'Operator rolled identity card back via /api/admin/identity/rollback.',
            [
              rawVersion ? `targetVersion=${rawVersion}` : null,
              result.snapshot ? `currentVersion=${result.snapshot.version}` : null,
            ],
          );
          sendJson(res, 200, result);
        });
      },
    },
    {
      method: 'PATCH',
      match: exactPath('/api/admin/identity/fields'),
      handle: (req, res) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            appendIdentityMutationAudit(
              'denied',
              'Operator identity field update via /api/admin/identity/fields failed: invalid JSON payload.',
            );
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const payload = parsed.value as Record<string, unknown>;
          const field = typeof payload.field === 'string' ? payload.field.trim() : '';
          const result = identityService.updateIdentityField(JSON.stringify(parsed.value));
          if (!result.ok) {
            appendIdentityMutationAudit(
              'denied',
              `Operator identity field update via /api/admin/identity/fields failed: ${result.message}`,
              [field ? `field=${field}` : null],
            );
            sendJson(res, 400, { error: result.message });
            return;
          }
          appendIdentityMutationAudit(
            'allowed',
            'Operator updated identity field via /api/admin/identity/fields.',
            [
              field ? `field=${field}` : null,
              result.message || null,
            ],
          );
          sendJson(res, 200, result);
        });
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/admin/identity/onboarding'),
      handle: (req, res) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            appendIdentityMutationAudit(
              'denied',
              'Operator onboarding setup via /api/admin/identity/onboarding failed: invalid JSON payload.',
            );
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const payload = parsed.value as Record<string, unknown>;
          const action = typeof payload.action === 'string' ? payload.action.trim() : '';
          identityService.applyOnboardingAction(JSON.stringify(parsed.value)).then(
            result => {
              const safeMessage = toSanitizedMessage(result.message, 'Identity onboarding action failed');
              if (!result.ok) {
                appendIdentityMutationAudit(
                  'denied',
                  `Operator onboarding setup via /api/admin/identity/onboarding failed: ${safeMessage}`,
                  [action ? `action=${action}` : null],
                );
                sendJson(res, 400, { error: safeMessage, onboardingRequired: result.onboardingRequired });
                return;
              }
              appendIdentityMutationAudit(
                'allowed',
                'Operator completed identity onboarding action via /api/admin/identity/onboarding.',
                [
                  action ? `action=${action}` : null,
                  safeMessage,
                ],
              );
              sendJson(res, 200, { ...result, message: safeMessage });
            },
            error => {
              const safeError = toSanitizedMessage(error, 'Identity onboarding action failed unexpectedly');
              appendIdentityMutationAudit(
                'denied',
                `Operator onboarding setup via /api/admin/identity/onboarding failed: ${safeError}`,
                [action ? `action=${action}` : null],
              );
              sendJson(res, 500, { error: safeError });
            },
          );
        });
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/admin/identity/diff'),
      handle: (req, res) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const result = identityService.previewIdentityCardDiff(JSON.stringify(parsed.value));
          sendJson(res, 200, result);
        });
      },
    },
  ];
}
