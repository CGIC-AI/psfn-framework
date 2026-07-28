import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../../channels/backplane/http/primitives.js';
import { buildAdminEpisodicMemoryRoutes } from './api-routes-episodic-memory.js';
import { buildAdminMemoryRoutes } from './api-routes-memory.js';
import { parseAdminJsonBody } from './request-body.js';
import { parseRequestUrl, resolveRequestOrigin } from './request-url.js';
import {
  exactPath,
  paramWithSuffix,
  prefixedParamPath,
} from './route-matchers.js';
import { buildAdminContactRoutes } from './routes/contact-routes.js';
import { buildAdminContactApprovalRoutes } from './api-routes-contact-approvals.js';
import type { AdminPendingContactsService } from './services/pending-contacts-service.js';
import { buildAdminRoomRoutes } from './api-routes-rooms.js';
import { buildAdminPlacesRoutes } from './api-routes-places.js';
import { buildAdminWikiScopeRoutes } from './api-routes-wiki-scopes.js';
import { buildAdminEnrollmentRoutes } from './api-routes-enrollment.js';
import { buildAdminGraphProposalRoutes } from './api-routes-graph-proposals.js';
import type { AdminRoomsService } from './services/rooms-service.js';
import type { AdminPlacesService } from './services/places-service.js';
import type { AdminEnrollmentService } from './services/enrollment-service.js';
import type { AdminGraphProposalsService } from './services/graph-proposals-service.js';
import { buildAdminConcernRoutes } from './routes/concern-routes.js';
import { buildAdminWishlistRoutes } from './routes/wishlist-routes.js';
import { buildAdminIdentityRoutes } from './routes/identity-routes.js';
import { buildAdminImageRoutes } from './routes/image-routes.js';
import { buildAdminOverviewRoutes } from './routes/overview-routes.js';
import { buildAdminPromptRoutes } from './routes/prompt-routes.js';
import { buildAdminSchedulerRoutes } from './routes/scheduler-routes.js';
import { buildAdminSubsystemHealthRoutes } from './routes/subsystem-health-routes.js';
import { buildAdminPartnerAffectShadowRoutes } from './routes/partner-affect-shadow-routes.js';
import type { AdminPartnerAffectShadowService } from './services/partner-affect-shadow-service.js';
import { buildAdminToolConformanceRoutes } from './routes/tool-conformance-routes.js';
import { buildAdminIcpAutonomyRoutes } from './routes/icp-autonomy-routes.js';
import { buildAdminRoomArbiterRoutes } from './routes/room-arbiter-routes.js';
import { buildAdminSessionRoutes } from './routes/session-routes.js';
import { ADMIN_DYNAMIC_JSON_HEADERS, ADMIN_POLLED_QUEUE_JSON_HEADERS, toSanitizedMessage } from './routes/shared.js';
import { buildAdminSettingsRoutes } from './routes/settings-routes.js';
import { buildAdminChannelEnvelopeRoutes } from './routes/channel-envelope-routes.js';
import { buildAdminBearerCompanionRoutes } from './routes/bearer-companion-routes.js';
import { buildAdminIntakeSourceListRoutes } from './routes/intake-source-list-routes.js';
import { buildAdminIntakeQuarantineRoutes } from './routes/intake-quarantine-routes.js';
import type { AdminIntakeQuarantineService } from './services/intake-quarantine-service.js';
import { buildAdminDriftReviewRoutes } from './routes/drift-review-routes.js';
import type { AdminDriftReviewService } from './services/drift-review-service.js';
import type { AdminApiRoute, AuthorizedAdminApiRoute } from './routes/types.js';
import { compileGardenRouteDeclarations } from '../../boundary/fleet-auth/garden-route-capabilities.js';
import type {
  AdminActionPipeService,
  AdminAdaptiveToolsService,
  AdminAuditHistoryService,
  AdminChargeCostReconciliationService,
  AdminChargeLedgerService,
  AdminContactsService,
  AdminConcernService,
  AdminDashboardService,
  AdminDiagnosticsService,
  AdminEpisodicMemoryService,
  AdminGroupMemoryService,
  AdminImagesService,
  AdminIdentityService,
  AdminIcpAutonomyService,
  AdminRoomArbiterService,
  AdminMemoryService,
  AdminModelUsageService,
  AdminPromptsService,
  AdminShardFoldReviewService,
  AdminSessionService,
  AdminSettingsService,
  AdminWikiService,
  AdminWishlistService,
} from './services/types.js';
import type { AdminSubsystemHealthService } from './services/subsystem-health-service.js';
import type { AdminToolConformanceService } from './services/tool-conformance-service.js';
import type {
  AdminChatBootstrapApi,
  AdminModelDiscoveryApi,
  AdminReflectionDailyJournalApi,
  AdminReflectionJournalApi,
  AdminReflectionMetacognitionJournalApi,
  AdminSchedulerApi,
  AdminSkillsApi,
  AdminValuesJournalApi,
  ConfirmationQueueAdminApi,
} from './admin-contract.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { ConfirmationQueueEntry } from '../../system/capabilities/confirmation-queue.js';
import {
  projectPublicationProvenance,
  type PublicationProvenanceView,
} from '../../core/cogsec/disclosure/index.js';
import type { RuntimeDiagnosticsQuery } from '../../shared/diagnostics/runtime-diagnostics.js';
import type {
  AdminAuditActionType,
  AdminAuditActor,
  AdminAuditDecision,
} from './types.js';
import type { AdminChatBootstrapUpdateInput } from './chat/types.js';
import { isShardFoldReviewUnavailableError } from './services/shard-fold-review-service.js';
import type { AdminObserverEvalSidecarService } from './services/observer-eval-sidecar-service.js';
import { isRecord } from '../../shared/utils/types.js';
import type { GroupMemoryBackfillInput } from '../../faculties/memory/extraction/group-backfill.js';
import type { AdminSharedWorkspaceService } from './services/shared-workspace-service.js';
import { buildAdminSharedWorkspaceRoutes } from './api-routes-shared-workspace.js';
import type { GardenRequestContext } from './garden-request-context.js';
import { privacyBreakGlassResourceSelectorDigest } from '../../shared/contracts/privacy-break-glass.js';
import { buildAdminPrivacyBreakGlassRoutes } from './routes/privacy-break-glass-routes.js';
import type { AdminPrivacyBreakGlassService } from './services/privacy-break-glass-service.js';

export type { AdminApiRoute, AuthorizedAdminApiRoute } from './routes/types.js';

const ADMIN_MODELS_API_PATH = '/api/admin/models';
const ADMIN_MODELS_REFRESH_API_PATH = '/api/admin/models/refresh';
const ADMIN_CHAT_BOOTSTRAP_API_PATH = '/api/admin/chat/bootstrap';
const ADMIN_CHAT_MODEL_ROOM_BOOTSTRAP_API_PATH = '/api/admin/chat/model-room/bootstrap';
const MODEL_DISCOVERY_UNAVAILABLE_ERROR = 'Model discovery backend unavailable';
const WIKI_UNAVAILABLE_ERROR = 'Wiki backend unavailable';
const GROUP_MEMORY_UNAVAILABLE_ERROR = 'Group memory diagnostics backend unavailable';

function toPositiveIntegerQueryNumber(
  value: string | null,
  fieldName: string,
): { ok: true; value?: number } | { ok: false; error: string } {
  if (value === null) return { ok: true };
  const trimmed = value.trim();
  if (!trimmed) return { ok: true };
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return { ok: false, error: `Invalid ${fieldName} query parameter. Expected a positive integer.` };
  }
  return { ok: true, value: parsed };
}

const GROUP_MEMORY_BACKFILL_KEYS = new Set<string>([
  'mode',
  'dryRun',
  'startMessageId',
  'endMessageId',
  'startTimestamp',
  'endTimestamp',
  'resume',
  'maxMessagesPerRun',
  'maxChunksPerRun',
  'maxLlmCallsPerRun',
]);

function parseGroupMemoryBackfillInput(
  value: unknown,
): { ok: true; value: GroupMemoryBackfillInput } | { ok: false; error: string } {
  if (!isRecord(value)) {
    return { ok: false, error: 'Expected JSON object body' };
  }
  for (const key of Object.keys(value)) {
    if (!GROUP_MEMORY_BACKFILL_KEYS.has(key)) {
      return { ok: false, error: `Unknown group-memory backfill field: ${key}` };
    }
  }

  const input: GroupMemoryBackfillInput = {};
  if (value.mode !== undefined) {
    if (value.mode !== 'dry_run' && value.mode !== 'live') {
      return { ok: false, error: 'mode must be dry_run or live' };
    }
    input.mode = value.mode;
  }
  if (value.dryRun !== undefined) {
    if (typeof value.dryRun !== 'boolean') {
      return { ok: false, error: 'dryRun must be boolean' };
    }
    input.dryRun = value.dryRun;
  }
  if (value.resume !== undefined) {
    if (typeof value.resume !== 'boolean') {
      return { ok: false, error: 'resume must be boolean' };
    }
    input.resume = value.resume;
  }

  const integerFields = [
    'startMessageId',
    'endMessageId',
    'maxMessagesPerRun',
    'maxChunksPerRun',
    'maxLlmCallsPerRun',
  ] as const;
  for (const field of integerFields) {
    const parsed = parseOptionalPositiveInteger(value[field], field);
    if (!parsed.ok) return parsed;
    if (parsed.value !== undefined) input[field] = parsed.value;
  }

  const timestampFields = ['startTimestamp', 'endTimestamp'] as const;
  for (const field of timestampFields) {
    const parsed = parseOptionalNonNegativeNumber(value[field], field);
    if (!parsed.ok) return parsed;
    if (parsed.value !== undefined) input[field] = parsed.value;
  }

  return { ok: true, value: input };
}

function parseOptionalPositiveInteger(
  value: unknown,
  field: string,
): { ok: true; value?: number } | { ok: false; error: string } {
  if (value === undefined) return { ok: true };
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return { ok: false, error: `${field} must be a positive integer` };
  }
  return { ok: true, value };
}

function parseOptionalNonNegativeNumber(
  value: unknown,
  field: string,
): { ok: true; value?: number } | { ok: false; error: string } {
  if (value === undefined) return { ok: true };
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return { ok: false, error: `${field} must be a non-negative number` };
  }
  return { ok: true, value };
}

function parseOptionalNonNegativeQueryNumber(
  value: string | null,
  field: string,
): { ok: true; value?: number } | { ok: false; error: string } {
  if (value === null) return { ok: true };
  const trimmed = value.trim();
  if (!trimmed) return { ok: true };
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return { ok: false, error: `Invalid ${field} query parameter. Expected a non-negative number.` };
  }
  return { ok: true, value: parsed };
}

function parseOptionalBooleanQuery(
  value: string | null,
  field: string,
): { ok: true; value?: boolean } | { ok: false; error: string } {
  if (value === null) return { ok: true };
  const normalized = value.trim().toLowerCase();
  if (!normalized) return { ok: true };
  if (normalized === 'true') return { ok: true, value: true };
  if (normalized === 'false') return { ok: true, value: false };
  return { ok: false, error: `Invalid ${field} query parameter. Expected true or false.` };
}

function parseDiagnosticsQuery(req: IncomingMessage): { ok: true; value: RuntimeDiagnosticsQuery } | { ok: false; error: string } {
  const url = parseRequestUrl(req, '/api/admin/diagnostics');
  const windowMs = parseOptionalNonNegativeQueryNumber(url.searchParams.get('windowMs'), 'windowMs');
  if (!windowMs.ok) return windowMs;
  const sinceMs = parseOptionalNonNegativeQueryNumber(url.searchParams.get('sinceMs'), 'sinceMs');
  if (!sinceMs.ok) return sinceMs;
  const limit = toPositiveIntegerQueryNumber(url.searchParams.get('limit'), 'limit');
  if (!limit.ok) return limit;
  const includeFileLogs = parseOptionalBooleanQuery(url.searchParams.get('includeFileLogs'), 'includeFileLogs');
  if (!includeFileLogs.ok) return includeFileLogs;

  return {
    ok: true,
    value: {
      ...(windowMs.value !== undefined ? { windowMs: windowMs.value } : {}),
      ...(sinceMs.value !== undefined ? { sinceMs: sinceMs.value } : {}),
      ...(limit.value !== undefined ? { limit: limit.value } : {}),
      ...(includeFileLogs.value !== undefined ? { includeFileLogs: includeFileLogs.value } : {}),
    },
  };
}

/**
 * A pending confirmation as surfaced on the Garden approvals page, additively
 * carrying a content-free disclosure-provenance view when the entry is a
 * publication/share candidate (jp36.7.2, bible §10.10). Ordinary confirmations
 * carry no `disclosureProvenance` and are byte-for-byte unchanged.
 */
export type ConfirmationQueueEntryView = ConfirmationQueueEntry & {
  disclosureProvenance?: PublicationProvenanceView;
};

/**
 * Attach the content-free publication-provenance view to a confirmation entry
 * when it is a publication/share candidate. Fail-closed: a detected candidate
 * with absent/malformed provenance still carries a `malformed`/`unknown` view so
 * the operator sees that provenance is missing rather than nothing at all;
 * non-candidate confirmations pass through untouched.
 */
function attachDisclosureProvenance(entry: ConfirmationQueueEntry): ConfirmationQueueEntryView {
  const disclosureProvenance = projectPublicationProvenance(entry.params);
  return disclosureProvenance ? { ...entry, disclosureProvenance } : entry;
}

export function buildAdminApiRoutes(options: {
  config: SubstrateConfig;
  dashboardService: AdminDashboardService;
  diagnosticsService?: AdminDiagnosticsService | null;
  imagesService: AdminImagesService;
  auditHistoryService?: AdminAuditHistoryService | null;
  chargeLedgerService?: AdminChargeLedgerService | null;
  chargeCostReconciliationService?: AdminChargeCostReconciliationService | null;
  modelUsageService?: AdminModelUsageService | null;
  observerEvalSidecarService?: AdminObserverEvalSidecarService | null;
  actionPipeService?: AdminActionPipeService | null;
  shardFoldReviewService: AdminShardFoldReviewService;
  adaptiveToolsService?: AdminAdaptiveToolsService | null;
  wikiService?: AdminWikiService | null;
  wishlistService?: AdminWishlistService | null;
  episodicMemoryService?: AdminEpisodicMemoryService | null;
  groupMemoryService?: AdminGroupMemoryService | null;
  memoryService: AdminMemoryService;
  privacyBreakGlassService?: AdminPrivacyBreakGlassService | null;
  sessionService: AdminSessionService;
  contactsService: AdminContactsService;
  pendingContactsService?: AdminPendingContactsService | null;
  roomsService?: AdminRoomsService | null;
  placesService?: AdminPlacesService | null;
  enrollmentService?: AdminEnrollmentService | null;
  graphProposalsService?: AdminGraphProposalsService | null;
  concernService?: AdminConcernService | null;
  subsystemHealthService?: AdminSubsystemHealthService | null;
  partnerAffectShadowService?: AdminPartnerAffectShadowService | null;
  toolConformanceService?: AdminToolConformanceService | null;
  icpAutonomyService?: AdminIcpAutonomyService | null;
  roomArbiterService?: AdminRoomArbiterService | null;
  settingsService: AdminSettingsService;
  sharedWorkspaceService?: AdminSharedWorkspaceService | null;
  /** Intake quarantine approval queue (htm9.11); always wired in production. */
  intakeQuarantineService?: AdminIntakeQuarantineService | null;
  /** Slow-poisoning drift review cards (htm9.14). */
  driftReviewService?: AdminDriftReviewService | null;
  identityService: AdminIdentityService;
  promptsService: AdminPromptsService;
  modelDiscovery?: AdminModelDiscoveryApi | null;
  chatBootstrapService: AdminChatBootstrapApi;
  scheduler?: AdminSchedulerApi | null;
  skillsRuntime?: AdminSkillsApi | null;
  confirmationQueueApi?: ConfirmationQueueAdminApi | null;
  valuesJournal?: AdminValuesJournalApi | null;
  reflectionMetacognitionJournal?: AdminReflectionMetacognitionJournalApi | null;
  reflectionDailyJournal?: AdminReflectionDailyJournalApi | null;
  reflectionJournal?: AdminReflectionJournalApi | null;
  appendAuditTimelineEntry?: (
    actionType: AdminAuditActionType,
    decision: AdminAuditDecision,
    narrative: string,
    details?: Array<string | null | undefined>,
    actor?: AdminAuditActor,
    context?: GardenRequestContext,
  ) => void;
  withBody: (req: IncomingMessage, res: ServerResponse, cb: (body: string) => void) => void;
}): AuthorizedAdminApiRoute[] {
  const {
    config,
    dashboardService,
    diagnosticsService,
    imagesService,
    auditHistoryService,
    chargeLedgerService,
    chargeCostReconciliationService,
    modelUsageService,
    observerEvalSidecarService,
    actionPipeService,
    shardFoldReviewService,
    adaptiveToolsService,
    wikiService,
    wishlistService,
    episodicMemoryService,
    groupMemoryService,
    memoryService,
    privacyBreakGlassService,
    sessionService,
    contactsService,
    pendingContactsService,
    roomsService,
    placesService,
    enrollmentService,
    graphProposalsService,
    concernService,
    subsystemHealthService,
    partnerAffectShadowService,
    toolConformanceService,
    icpAutonomyService,
    roomArbiterService,
    settingsService,
    sharedWorkspaceService,
    intakeQuarantineService,
    driftReviewService,
    identityService,
    promptsService,
    modelDiscovery,
    chatBootstrapService,
    scheduler,
    skillsRuntime,
    confirmationQueueApi,
    valuesJournal,
    reflectionMetacognitionJournal,
    reflectionDailyJournal,
    reflectionJournal,
    appendAuditTimelineEntry,
    withBody,
  } = options;

  const resolveValuesTimelineLimit = (
    req: IncomingMessage,
    path: string,
  ): { ok: true; value: number } | { ok: false; error: string } => {
    const url = parseRequestUrl(req, path);
    const parsed = toPositiveIntegerQueryNumber(url.searchParams.get('limit'), 'limit');
    if (!parsed.ok) return parsed;
    return { ok: true, value: Math.min(parsed.value ?? 250, 250) };
  };

  // Companion-private journals (reflection, metacognition, values timeline) are
  // welfare-sensitive substrates: the operator may not read them through an
  // ordinary admin GET. Reuse the privacy break-glass contract — default deny,
  // disclose only under an active `break_glass` assurance (the same assurance
  // AdminPrivacyBreakGlassService demands for memory/profile), and emit the same
  // `memory_access` audit evidence. Fail closed if the disclosure cannot be
  // audited so a read never happens without a durable record.
  const enforceJournalBreakGlass = (input: {
    res: ServerResponse;
    context: GardenRequestContext | undefined;
    resourceSelector: string;
  }): boolean => {
    const resourceSelectorDigest = privacyBreakGlassResourceSelectorDigest(
      'journal',
      input.resourceSelector,
    );
    const writeAudit = (
      decision: 'allowed' | 'denied',
      narrative: string,
      extraDetails: Array<string | null | undefined>,
    ): boolean => {
      if (!appendAuditTimelineEntry) return false;
      try {
        appendAuditTimelineEntry('memory_access', decision, narrative, [
          'resourceKind=journal',
          `resourceSelectorDigest=${resourceSelectorDigest}`,
          ...extraDetails,
        ], 'operator', input.context);
        return true;
      } catch {
        return false;
      }
    };
    const principal = input.context?.kind === 'fleet_principal' ? input.context : null;
    if (!principal || principal.actor.sessionAssurance !== 'break_glass') {
      writeAudit('denied', 'Companion journal read denied without privacy break-glass.', [
        `reasonCode=${principal ? 'break_glass_required' : 'trusted_principal_required'}`,
      ]);
      sendJson(
        input.res,
        403,
        { error: 'Companion journal read requires privacy break-glass' },
        { 'Cache-Control': 'no-store' },
      );
      return false;
    }
    if (!writeAudit('allowed', 'Companion journal read disclosed under privacy break-glass.', [
      'assurance=break_glass',
    ])) {
      sendJson(
        input.res,
        503,
        { error: 'Companion journal read is unavailable' },
        { 'Cache-Control': 'no-store' },
      );
      return false;
    }
    return true;
  };

  const handleDiscoveredModels = (res: ServerResponse, refresh: boolean): void => {
    if (!modelDiscovery) {
      sendJson(res, 503, { error: MODEL_DISCOVERY_UNAVAILABLE_ERROR });
      return;
    }

    if (refresh) {
      modelDiscovery.invalidateCache();
    }

    modelDiscovery.getAvailableModels().then(
      models => sendJson(res, 200, models),
      error => sendJson(res, 502, {
        error: toSanitizedMessage(error, 'Model discovery failed'),
      }),
    );
  };

  const handleChatBootstrapUpdate = (req: IncomingMessage, res: ServerResponse): void => {
    withBody(req, res, (body) => {
      const parsed = parseAdminJsonBody(body);
      if (!parsed.ok) {
        sendJson(res, 400, { error: parsed.error });
        return;
      }
      if (
        parsed.value !== null
        && (typeof parsed.value !== 'object' || Array.isArray(parsed.value))
      ) {
        sendJson(res, 400, { error: 'Chat bootstrap payload must be a JSON object' });
        return;
      }

      try {
        chatBootstrapService.updateSelection(
          (parsed.value ?? {}) as AdminChatBootstrapUpdateInput,
          { requestOrigin: resolveRequestOrigin(req) },
        ).then(
          (bootstrap) => {
            sendJson(res, 200, { ok: true, bootstrap });
          },
          (error) => {
            sendJson(res, 400, {
              error: toSanitizedMessage(error, 'Failed to update chat bootstrap'),
            });
          },
        );
      } catch (error) {
        sendJson(res, 400, {
          error: toSanitizedMessage(error, 'Failed to update chat bootstrap'),
        });
      }
    });
  };

  return compileGardenRouteDeclarations([
    ...buildAdminWishlistRoutes({
      wishlistService,
      withBody,
      ...(appendAuditTimelineEntry ? { appendAuditTimelineEntry } : {}),
    }),
    ...(sharedWorkspaceService
      ? buildAdminSharedWorkspaceRoutes({ service: sharedWorkspaceService, withBody })
      : []),
    ...buildAdminOverviewRoutes({
      config,
      dashboardService,
      auditHistoryService,
      chargeLedgerService,
      chargeCostReconciliationService,
      modelUsageService,
      observerEvalSidecarService,
      actionPipeService,
      withBody,
    }),
    ...buildAdminImageRoutes({
      imagesService,
      appendAuditTimelineEntry,
      withBody,
    }),
    {
      method: 'GET',
      match: exactPath('/api/admin/shards'),
      handle: (_req, res, _params, context) => {
        shardFoldReviewService.listShardFoldReviews(context).then(
          (payload) => {
            sendJson(res, 200, payload, ADMIN_DYNAMIC_JSON_HEADERS);
          },
          (error) => {
            const status = isShardFoldReviewUnavailableError(error) ? 503 : 500;
            sendJson(res, status, {
              error: toSanitizedMessage(error, 'Failed to list shard fold reviews'),
            });
          },
        );
      },
    },
    {
      method: 'POST',
      match: paramWithSuffix('/api/admin/shards/', 'shardId', '/review'),
      handle: (req, res, { shardId }, context) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          if (
            parsed.value === null
            || typeof parsed.value !== 'object'
            || Array.isArray(parsed.value)
          ) {
            sendJson(res, 400, { error: 'Shard fold review payload must be a JSON object' });
            return;
          }

          const payload = parsed.value as Record<string, unknown>;
          const decision = typeof payload.decision === 'string' ? payload.decision.trim().toLowerCase() : '';
          if (decision !== 'approve' && decision !== 'deny') {
            sendJson(res, 400, { error: 'decision must be approve or deny' });
            return;
          }

          const actor = typeof payload.actor === 'string' ? payload.actor.trim() : undefined;
          const note = typeof payload.note === 'string' ? payload.note.trim() : undefined;
          shardFoldReviewService.resolveShardFoldReview(
            {
              shardId,
              decision,
              actor,
              note,
            },
            context,
          ).then(
            (result) => {
              if (!result.ok) {
                const status = result.message === 'Shard fold review not found' ? 404 : 400;
                sendJson(res, status, { error: result.message ?? 'Failed to resolve shard fold review' });
                return;
              }
              sendJson(res, 200, result, ADMIN_DYNAMIC_JSON_HEADERS);
            },
            (error) => {
              const status = isShardFoldReviewUnavailableError(error) ? 503 : 500;
              sendJson(res, status, {
                error: toSanitizedMessage(error, 'Failed to resolve shard fold review'),
              });
            },
          );
        });
      },
    },
    {
      method: 'GET',
      match: paramWithSuffix('/api/admin/shards/', 'shardId', '/configuration'),
      handle: (_req, res, { shardId }, context) => {
        shardFoldReviewService.getShardConfiguration(shardId, context).then(
          (snapshot) => {
            if (!snapshot) {
              sendJson(res, 404, { error: 'Shard not found' });
              return;
            }
            sendJson(res, 200, snapshot, ADMIN_DYNAMIC_JSON_HEADERS);
          },
          (error) => {
            const status = isShardFoldReviewUnavailableError(error) ? 503 : 500;
            sendJson(res, status, {
              error: toSanitizedMessage(error, 'Failed to load shard configuration'),
            });
          },
        );
      },
    },
    {
      method: 'PATCH',
      match: paramWithSuffix('/api/admin/shards/', 'shardId', '/configuration'),
      handle: (req, res, { shardId }, context) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          shardFoldReviewService.updateShardConfiguration(
            shardId,
            parsed.value,
            context,
          ).then(
            (result) => {
              if (!result.ok) {
                sendJson(res, result.code === 'not_found' ? 404 : 400, {
                  error: result.message,
                });
                return;
              }
              sendJson(res, 200, result.snapshot, ADMIN_DYNAMIC_JSON_HEADERS);
            },
            (error) => {
              const status = isShardFoldReviewUnavailableError(error) ? 503 : 500;
              sendJson(res, status, {
                error: toSanitizedMessage(error, 'Failed to update shard configuration'),
              });
            },
          );
        });
      },
    },
    {
      method: 'GET',
      match: prefixedParamPath('/api/admin/shards/', 'shardId'),
      handle: (_req, res, { shardId }, context) => {
        shardFoldReviewService.getShardFoldReview(shardId, context).then(
          (review) => {
            if (!review) {
              sendJson(res, 404, { error: 'Shard fold review not found' });
              return;
            }
            sendJson(res, 200, review, ADMIN_DYNAMIC_JSON_HEADERS);
          },
          (error) => {
            const status = isShardFoldReviewUnavailableError(error) ? 503 : 500;
            sendJson(res, status, {
              error: toSanitizedMessage(error, 'Failed to load shard fold review'),
            });
          },
        );
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/admin/tools/adaptive'),
      handle: (_req, res) => {
        if (!adaptiveToolsService) {
          sendJson(res, 200, {
            state: null,
            catalog: null,
            serviceHealth: [],
            toolHealth: [],
            inventory: [],
            recentInvocations: [],
            recentFailures: [],
            recentTelemetry: [],
          });
          return;
        }
        adaptiveToolsService.getAdaptiveToolsData().then(
          (payload) => {
            sendJson(res, 200, payload);
          },
          (error) => {
            sendJson(res, 500, {
              error: `Failed to load adaptive tools data: ${toSanitizedMessage(error, 'unknown error')}`,
            });
          },
        );
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/admin/diagnostics'),
      handle: (req, res) => {
        if (!diagnosticsService) {
          sendJson(res, 503, { error: 'Diagnostics backend unavailable' });
          return;
        }
        const parsed = parseDiagnosticsQuery(req);
        if (!parsed.ok) {
          sendJson(res, 400, { error: parsed.error });
          return;
        }
        diagnosticsService.getDiagnostics(parsed.value).then(
          payload => sendJson(res, 200, payload, ADMIN_DYNAMIC_JSON_HEADERS),
          error => sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to load diagnostics') }),
        );
      },
    },
    {
      method: 'GET',
      match: exactPath(ADMIN_CHAT_BOOTSTRAP_API_PATH),
      handle: (req, res) => {
        chatBootstrapService.buildBootstrap({
          requestOrigin: resolveRequestOrigin(req),
        }).then(
          (payload) => sendJson(res, 200, payload),
          (error) => {
            sendJson(res, 500, {
              error: toSanitizedMessage(error, 'Failed to build chat bootstrap'),
            });
          },
        );
      },
    },
    {
      method: 'PATCH',
      match: exactPath(ADMIN_CHAT_BOOTSTRAP_API_PATH),
      handle: (req, res) => {
        handleChatBootstrapUpdate(req, res);
      },
    },
    {
      method: 'POST',
      match: exactPath(ADMIN_CHAT_BOOTSTRAP_API_PATH),
      handle: (req, res) => {
        handleChatBootstrapUpdate(req, res);
      },
    },
    {
      method: 'GET',
      match: exactPath(ADMIN_CHAT_MODEL_ROOM_BOOTSTRAP_API_PATH),
      handle: (req, res) => {
        chatBootstrapService.buildModelRoomBootstrap(config, {
          requestOrigin: resolveRequestOrigin(req),
        }).then(
          (payload) => sendJson(res, 200, payload),
          (error) => {
            sendJson(res, 500, {
              error: toSanitizedMessage(error, 'Failed to build model room bootstrap'),
            });
          },
        );
      },
    },
    {
      method: 'GET',
      match: exactPath(ADMIN_MODELS_API_PATH),
      handle: (_req, res) => {
        handleDiscoveredModels(res, false);
      },
    },
    {
      method: 'POST',
      match: exactPath(ADMIN_MODELS_REFRESH_API_PATH),
      handle: (_req, res) => {
        handleDiscoveredModels(res, true);
      },
    },
    ...buildAdminMemoryRoutes({ memoryService, withBody }),
    ...buildAdminEpisodicMemoryRoutes({ episodicMemoryService }),
    {
      method: 'GET',
      match: exactPath('/api/admin/group-memory'),
      handle: (_req, res, _params, context) => {
        if (!groupMemoryService) {
          sendJson(res, 503, { error: GROUP_MEMORY_UNAVAILABLE_ERROR });
          return;
        }
        groupMemoryService.listGroupMemoryDiagnostics(context).then(
          payload => sendJson(res, 200, payload, ADMIN_DYNAMIC_JSON_HEADERS),
          error => sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to load group memory diagnostics') }),
        );
      },
    },
    {
      method: 'POST',
      match: paramWithSuffix('/api/admin/group-memory/', 'channelId', '/backfill'),
      handle: (req, res, { channelId }) => {
        if (!groupMemoryService) {
          sendJson(res, 503, { error: GROUP_MEMORY_UNAVAILABLE_ERROR });
          return;
        }
        withBody(req, res, (body) => {
          const parsedBody = parseAdminJsonBody(body);
          if (!parsedBody.ok) {
            sendJson(res, 400, { error: parsedBody.error });
            return;
          }
          const parsedInput = parseGroupMemoryBackfillInput(parsedBody.value);
          if (!parsedInput.ok) {
            sendJson(res, 400, { error: parsedInput.error });
            return;
          }
          groupMemoryService.runGroupMemoryBackfill(channelId, parsedInput.value).then(
            payload => sendJson(res, 200, payload, ADMIN_DYNAMIC_JSON_HEADERS),
            error => sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to run group memory backfill') }),
          );
        });
      },
    },
    {
      method: 'GET',
      match: prefixedParamPath('/api/admin/group-memory/', 'channelId'),
      handle: (_req, res, { channelId }, context) => {
        if (!groupMemoryService) {
          sendJson(res, 503, { error: GROUP_MEMORY_UNAVAILABLE_ERROR });
          return;
        }
        groupMemoryService.getGroupMemoryChannelDiagnostics(channelId, context).then(
          (diagnostics) => {
            if (!diagnostics) {
              sendJson(res, 404, { error: 'Group memory channel diagnostics not found' });
              return;
            }
            sendJson(res, 200, diagnostics, ADMIN_DYNAMIC_JSON_HEADERS);
          },
          error => sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to load group memory channel diagnostics') }),
        );
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/admin/wiki'),
      handle: (req, res) => {
        if (!wikiService) {
          sendJson(res, 503, { error: WIKI_UNAVAILABLE_ERROR });
          return;
        }
        // vinz.28: ?scope=shared_world:<siteId> filters to that shared scope;
        // absent/personal keeps the byte-identical personal listing.
        const url = parseRequestUrl(req, '/api/admin/wiki');
        const scope = url.searchParams.get('scope')?.trim();
        if (scope && scope.startsWith('shared_world:')) {
          const siteId = scope.slice('shared_world:'.length);
          if (!siteId) { sendJson(res, 400, { error: 'shared_world scope requires a siteId' }); return; }
          wikiService.listSharedWorldWikiDocuments(siteId).then(
            payload => sendJson(res, 200, payload, ADMIN_DYNAMIC_JSON_HEADERS),
            error => sendJson(res, 400, { error: toSanitizedMessage(error, 'Failed to list shared-world wiki documents') }),
          );
          return;
        }
        wikiService.listWikiDocuments().then(
          payload => sendJson(res, 200, payload, ADMIN_DYNAMIC_JSON_HEADERS),
          error => sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to list wiki documents') }),
        );
      },
    },
    ...buildAdminWikiScopeRoutes({ wikiService, withBody }),
    {
      method: 'GET',
      match: exactPath('/api/admin/wiki/search'),
      handle: (req, res) => {
        if (!wikiService) {
          sendJson(res, 503, { error: WIKI_UNAVAILABLE_ERROR });
          return;
        }
        const url = parseRequestUrl(req, '/api/admin/wiki/search');
        const query = url.searchParams.get('query')?.trim() ?? '';
        if (!query) {
          sendJson(res, 400, { error: 'query is required' });
          return;
        }
        const limit = toPositiveIntegerQueryNumber(url.searchParams.get('limit'), 'limit');
        if (!limit.ok) {
          sendJson(res, 400, { error: limit.error });
          return;
        }
        wikiService.searchWikiDocuments({
          query,
          ...(limit.value !== undefined ? { limit: limit.value } : {}),
        }).then(
          payload => sendJson(res, 200, payload, ADMIN_DYNAMIC_JSON_HEADERS),
          error => sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to search wiki documents') }),
        );
      },
    },
    {
      method: 'GET',
      match: prefixedParamPath('/api/admin/wiki/', 'id'),
      handle: (_req, res, { id }) => {
        if (!wikiService) {
          sendJson(res, 503, { error: WIKI_UNAVAILABLE_ERROR });
          return;
        }
        wikiService.getWikiDocument(id).then(
          (document) => {
            if (!document) {
              sendJson(res, 404, { error: 'Wiki document not found' });
              return;
            }
            sendJson(res, 200, document, ADMIN_DYNAMIC_JSON_HEADERS);
          },
          error => sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to load wiki document') }),
        );
      },
    },
    ...buildAdminSessionRoutes({ sessionService, withBody }),
    ...buildAdminContactRoutes({ contactsService, withBody }),
    ...buildAdminPrivacyBreakGlassRoutes({
      service: privacyBreakGlassService,
      appendAuditTimelineEntry,
      withBody,
    }),
    ...(pendingContactsService
      ? buildAdminContactApprovalRoutes({ pendingContactsService })
      : []),
    ...(roomsService
      ? buildAdminRoomRoutes({ roomsService })
      : []),
    ...(placesService
      ? buildAdminPlacesRoutes({ placesService, withBody })
      : []),
    ...(enrollmentService
      ? buildAdminEnrollmentRoutes({ enrollmentService, withBody })
      : []),
    ...(graphProposalsService
      ? buildAdminGraphProposalRoutes({ graphProposalsService, withBody })
      : []),
    ...buildAdminConcernRoutes({ concernService, withBody }),
    ...buildAdminSettingsRoutes({ settingsService, appendAuditTimelineEntry, withBody }),
    ...buildAdminChannelEnvelopeRoutes({ settingsService, appendAuditTimelineEntry, withBody }),
    ...buildAdminBearerCompanionRoutes({ settingsService, appendAuditTimelineEntry, withBody }),
    ...buildAdminIntakeSourceListRoutes({ settingsService, appendAuditTimelineEntry, withBody }),
    ...(intakeQuarantineService
      ? buildAdminIntakeQuarantineRoutes({
        quarantineService: intakeQuarantineService,
        settingsService,
        appendAuditTimelineEntry,
        withBody,
      })
      : []),
    ...(driftReviewService
      ? buildAdminDriftReviewRoutes({
        driftReviewService,
        appendAuditTimelineEntry,
        withBody,
      })
      : []),
    ...buildAdminIdentityRoutes({ identityService, appendAuditTimelineEntry, withBody }),
    ...buildAdminPromptRoutes({ promptsService, withBody }),
    ...buildAdminSchedulerRoutes({ scheduler, withBody }),
    ...buildAdminSubsystemHealthRoutes({ subsystemHealth: subsystemHealthService }),
    ...buildAdminPartnerAffectShadowRoutes({ partnerAffectShadow: partnerAffectShadowService }),
    ...buildAdminToolConformanceRoutes({ toolConformance: toolConformanceService, withBody }),
    ...(icpAutonomyService
      ? buildAdminIcpAutonomyRoutes({
        service: icpAutonomyService,
        appendAuditTimelineEntry,
        withBody,
      })
      : []),
    ...(roomArbiterService
      ? buildAdminRoomArbiterRoutes({ service: roomArbiterService })
      : []),
    // ── Skills ──
    {
      method: 'GET',
      match: exactPath('/api/admin/skills'),
      handle: (_req, res) => {
        if (!skillsRuntime) {
          sendJson(res, 200, { snapshot: null, managed: [], disabledSkills: [] });
          return;
        }
        const snapshot = skillsRuntime.getSnapshot();
        const managed = skillsRuntime.listManaged();
        const disabledSkills = skillsRuntime.getDisabledSkills();
        sendJson(res, 200, { snapshot, managed, disabledSkills });
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/admin/skills'),
      handle: (req, res) => {
        if (!skillsRuntime) {
          sendJson(res, 400, { error: 'Skills runtime not available' });
          return;
        }
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          try {
            const input = parsed.value as { name: string; category: string; content: string; description?: string };
            const result = skillsRuntime!.createSkill(input);
            skillsRuntime!.invalidate();
            sendJson(res, 201, { ok: true, skill: result });
          } catch (e) {
            sendJson(res, 400, { error: String(e instanceof Error ? e.message : e) });
          }
        });
      },
    },
    {
      method: 'PATCH',
      match: exactPath('/api/admin/skills'),
      handle: (req, res) => {
        if (!skillsRuntime) {
          sendJson(res, 400, { error: 'Skills runtime not available' });
          return;
        }
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          try {
            const input = parsed.value as { name: string; content: string; description?: string };
            const result = skillsRuntime!.updateSkill(input);
            skillsRuntime!.invalidate();
            sendJson(res, 200, { ok: true, skill: result });
          } catch (e) {
            sendJson(res, 400, { error: String(e instanceof Error ? e.message : e) });
          }
        });
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/admin/skills/toggle'),
      handle: (req, res) => {
        if (!skillsRuntime) {
          sendJson(res, 400, { error: 'Skills runtime not available' });
          return;
        }
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          try {
            const { name } = parsed.value as { name: string };
            if (!name.trim()) {
              sendJson(res, 400, { error: 'Skill name is required' });
              return;
            }
            const nowEnabled = skillsRuntime!.toggleSkill(name);
            sendJson(res, 200, { ok: true, name: name.trim(), enabled: nowEnabled });
          } catch (e) {
            sendJson(res, 400, { error: String(e instanceof Error ? e.message : e) });
          }
        });
      },
    },
    {
      method: 'DELETE',
      match: prefixedParamPath('/api/admin/skills/', 'name'),
      handle: (_req, res, { name }) => {
        if (!skillsRuntime) {
          sendJson(res, 400, { error: 'Skills runtime not available' });
          return;
        }
        try {
          skillsRuntime.deleteSkill(name);
          sendJson(res, 200, { ok: true });
        } catch (e) {
          sendJson(res, 400, { error: String(e instanceof Error ? e.message : e) });
        }
      },
    },
    // ── Confirmations ──
    {
      method: 'GET',
      match: exactPath('/api/admin/confirmations'),
      handle: (_req, res, _params, context) => {
        if (!confirmationQueueApi) {
          sendJson(res, 200, {
            entries: [],
            available: false,
            message: 'Confirmation queue is unavailable (gateway integration not configured).',
          }, ADMIN_POLLED_QUEUE_JSON_HEADERS);
          return;
        }
        confirmationQueueApi.listConfirmationQueue(context).then(
          (result) => {
            sendJson(res, 200, {
              entries: result.entries.map(attachDisclosureProvenance),
              available: true,
            }, ADMIN_POLLED_QUEUE_JSON_HEADERS);
          },
          (error) => {
            sendJson(res, 200, {
              entries: [],
              available: true,
              message: `Unable to load confirmation queue: ${String(error)}`,
            }, ADMIN_POLLED_QUEUE_JSON_HEADERS);
          },
        );
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/admin/confirmations/resolve'),
      handle: (req, res, _params, context) => {
        if (!confirmationQueueApi) {
          appendAuditTimelineEntry?.(
            'confirmation',
            'denied',
            'Operator confirmation resolve failed: confirmation queue unavailable.',
            [],
            'operator',
            context,
          );
          sendJson(res, 400, { ok: false, message: 'Confirmation queue is unavailable' });
          return;
        }
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            appendAuditTimelineEntry?.(
              'confirmation',
              'denied',
              'Operator confirmation resolve failed: invalid JSON payload.',
              [],
              'operator',
              context,
            );
            sendJson(res, 400, { ok: false, message: parsed.error });
            return;
          }
          const payload = parsed.value as Record<string, unknown>;
          const id = (typeof payload.id === 'string' ? payload.id : '').trim();
          const decision = (typeof payload.decision === 'string' ? payload.decision : '').trim();

          if (!id) {
            appendAuditTimelineEntry?.(
              'confirmation',
              'denied',
              'Operator confirmation resolve failed: missing confirmation ID.',
              [],
              'operator',
              context,
            );
            sendJson(res, 400, { ok: false, message: 'Confirmation ID is required' });
            return;
          }
          if (decision !== 'approve' && decision !== 'deny' && decision !== 'modify') {
            appendAuditTimelineEntry?.(
              'confirmation',
              'denied',
              'Operator confirmation resolve failed: invalid decision.',
              [`id=${id}`, `decision=${decision || 'missing'}`],
              'operator',
              context,
            );
            sendJson(res, 400, { ok: false, message: 'Invalid decision (must be approve, deny, or modify)' });
            return;
          }

          const resolveParams: { id: string; decision: 'approve' | 'deny' | 'modify'; modifiedParams?: Record<string, unknown> } = { id, decision };
          if (decision === 'modify' && payload.modifiedParams && typeof payload.modifiedParams === 'object') {
            resolveParams.modifiedParams = payload.modifiedParams as Record<string, unknown>;
          }

          // This agent-hosted route resolves agent-local confirmations only.
          // Operator-only gateway confirmations are resolved by the Garden
          // operator process on a direct operator→gateway path, so no operator
          // ADMIN_TOKEN is read from or forwarded through this agent (x5rt.10).
          confirmationQueueApi!.resolveConfirmationQueue(resolveParams, context).then(
            (result) => {
              appendAuditTimelineEntry?.(
                'confirmation',
                result.status === 'approved' || result.status === 'modified'
                  ? 'allowed'
                  : 'denied',
                `Operator resolved confirmation ${id}: ${result.status}.`,
                [
                  `decision=${decision}`,
                  `executed=${result.executed}`,
                  result.message ? `message=${result.message}` : null,
                ],
                'operator',
                context,
              );
              sendJson(res, 200, {
                ok: result.status === 'approved' || result.status === 'modified',
                message: result.message,
                status: result.status,
                executed: result.executed,
              });
            },
            (error) => {
              appendAuditTimelineEntry?.(
                'confirmation',
                'denied',
                `Operator confirmation resolve failed for ${id}.`,
                [`decision=${decision}`, `error=${toSanitizedMessage(error, 'unknown error')}`],
                'operator',
                context,
              );
              sendJson(res, 500, { ok: false, message: `Confirmation resolve failed: ${String(error)}` });
            },
          );
        });
      },
    },
    // ── Values Timeline ──
    {
      method: 'GET',
      match: exactPath('/api/admin/values'),
      handle: (_req, res, _params, context) => {
        if (!enforceJournalBreakGlass({ res, context, resourceSelector: 'values-journal' })) {
          return;
        }
        if (!valuesJournal) {
          sendJson(res, 200, { entries: [] });
          return;
        }
        const entries = valuesJournal.list({ limit: 250 });
        sendJson(res, 200, { entries });
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/admin/values/reflections/metacognition'),
      handle: (req, res, _params, context) => {
        if (!enforceJournalBreakGlass({
          res,
          context,
          resourceSelector: 'reflection-metacognition',
        })) {
          return;
        }
        if (!reflectionMetacognitionJournal) {
          sendJson(res, 503, { error: 'Reflection metacognition journal unavailable' });
          return;
        }
        const limit = resolveValuesTimelineLimit(req, '/api/admin/values/reflections/metacognition');
        if (!limit.ok) {
          sendJson(res, 400, { error: limit.error });
          return;
        }
        sendJson(res, 200, {
          entries: reflectionMetacognitionJournal.listRecent({ limit: limit.value }),
        });
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/admin/values/reflections/daily'),
      handle: (req, res, _params, context) => {
        if (!enforceJournalBreakGlass({ res, context, resourceSelector: 'reflection-daily' })) {
          return;
        }
        if (!reflectionDailyJournal) {
          sendJson(res, 503, { error: 'Reflection daily journal unavailable' });
          return;
        }
        const limit = resolveValuesTimelineLimit(req, '/api/admin/values/reflections/daily');
        if (!limit.ok) {
          sendJson(res, 400, { error: limit.error });
          return;
        }
        sendJson(res, 200, {
          entries: reflectionDailyJournal.listRecent({ limit: limit.value }),
        });
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/admin/values/reflections/journal'),
      handle: (req, res, _params, context) => {
        if (!enforceJournalBreakGlass({ res, context, resourceSelector: 'reflection-journal' })) {
          return;
        }
        if (!reflectionJournal) {
          sendJson(res, 503, { error: 'Reflection journal unavailable' });
          return;
        }
        const limit = resolveValuesTimelineLimit(req, '/api/admin/values/reflections/journal');
        if (!limit.ok) {
          sendJson(res, 400, { error: limit.error });
          return;
        }
        sendJson(res, 200, {
          entries: reflectionJournal.listRecent({ limit: limit.value }),
        });
      },
    },
  ] satisfies AdminApiRoute[]);
}
