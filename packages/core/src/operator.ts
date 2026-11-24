/**
 * `@psfn/core/operator` entrypoint: Light Garden route builders, request
 * authorization & HTTP primitives, admin data services, companion stores, and
 * owner-file config loaders/savers.
 */
export type {
  CompanionGardenHandles,
  CompanionRuntime,
} from '../../../src/app/companion/runtime.js';

// Route builders
export { buildAdminAutomataRoutes } from '../../../src/operator/garden/routes/automata-routes.js';
export { buildAdminMemoryRoutes } from '../../../src/operator/garden/api-routes-memory.js';
export { buildAdminBiographicalReviewRoutes } from '../../../src/operator/garden/api-routes-biographical-review.js';
export { buildAdminSessionRoutes } from '../../../src/operator/garden/routes/session-routes.js';
export { buildAdminContactRoutes } from '../../../src/operator/garden/routes/contact-routes.js';
export { buildAdminGraphProposalRoutes } from '../../../src/operator/garden/api-routes-graph-proposals.js';
export { buildAdminConcernRoutes } from '../../../src/operator/garden/routes/concern-routes.js';
export {
  buildAdminIdentityRoutes,
  type IdentityCardUploadPort,
} from '../../../src/operator/garden/routes/identity-routes.js';
export { buildAdminPromptRoutes } from '../../../src/operator/garden/routes/prompt-routes.js';
export { buildAdminSchedulerRoutes } from '../../../src/operator/garden/routes/scheduler-routes.js';
export type {
  AdminApiRoute,
  AdminBodyReader,
  AdminSubjectVisibleAuditPort,
  ProtectedConcernAction,
} from '../../../src/operator/garden/routes/types.js';

// Request handling & HTTP primitives
export {
  assertGardenRouteDeclarationsCovered,
  compileGardenRouteDeclarations,
  type AuthorizedGardenRoute,
} from '../../../src/boundary/fleet-auth/garden-route-capabilities.js';
export {
  createStandaloneGardenRequestContext,
  type GardenRequestContext,
} from '../../../src/operator/garden/garden-request-context.js';
export { gardenRequestCompanionScopeDenial } from '../../../src/operator/garden/garden-companion-scope.js';
export {
  bindRequestForResponse,
  readBodyWithLimit,
  sendJson,
} from '../../../src/channels/backplane/http/primitives.js';
export type {
  AdminAuditActionType,
  AdminAuditActor,
  AdminAuditDecision,
  AdminAuditHistoryEntry,
  AdminAuditRequestAttribution,
} from '../../../src/operator/garden/types.js';

// Garden data services
export { AdminMemoryDataService } from '../../../src/operator/garden/services/memory-service.js';
export { AdminSessionDataService } from '../../../src/operator/garden/services/session-service.js';
export { AdminContactsDataService } from '../../../src/operator/garden/services/contacts-service.js';
export { createAdminGraphProposalsService } from '../../../src/operator/garden/services/graph-proposals-service.js';
export { AdminConcernDataService } from '../../../src/operator/garden/services/concern-service.js';
export { AdminIdentityDataService } from '../../../src/operator/garden/services/identity-service.js';
export { AdminPromptsDataService } from '../../../src/operator/garden/services/prompts-service.js';
export { AdminSchedulerService } from '../../../src/operator/garden/services/scheduler-service.js';
export { AdminAutomataDataService } from '../../../src/operator/garden/services/automata-service.js';
export { PostgresAdminAutomataBusReadAdapter } from '../../../src/operator/garden/services/automata-bus-read-adapter.js';
export { AdminBiographicalReviewService } from '../../../src/operator/garden/services/biographical-review-service.js';

// Companion stores & utilities
export { createSubjectAuthorizedMemoryStore } from '../../../src/faculties/memory/subject-authorized-store.js';
export { createCompanionRoomMembershipAuthority } from '../../../src/faculties/memory/companion-provenance.js';
export { createContactRelationshipScoreReader } from '../../../src/core/contacts/trust-drift-signals.js';
export { ValuesJournalStore } from '../../../src/faculties/values/store.js';
export { NorthStarStore } from '../../../src/faculties/north-star/store.js';
export { ReflectionJournalStore } from '../../../src/persistence/journals/reflection-journal.js';
export {
  resolveConcernResolutionArcJournalPath,
  resolveLegacyValuesJournalPath,
  resolveNorthStarPath,
  resolveValuesJournalPath,
} from '../../../src/persistence/layout.js';
export {
  PromptRuntimeLayoutStore,
  resolvePromptRuntimeLayoutPath,
} from '../../../src/core/identity/prompt-runtime.js';
export { invalidateCachedPromptRuntimeLayoutStore } from '../../../src/core/identity/prompt-runtime-store-cache.js';
export { resolveCompanionNameFromConfig } from '../../../src/core/identity/companion-runtime.js';
export {
  sanitizeCoreSubstrateConfig,
  type SubstrateConfig,
} from '../../../src/system/config/runtime-config-contracts.js';
export { resolveMorningWakeSnapshot } from '../../../src/core/scheduler/temporal-wakeup.js';
export { appendJsonLine } from '../../../src/shared/utils/jsonl.js';
export type { MemoryDeletionProposal } from '../../../src/faculties/memory/deletion-proposals.js';
export {
  loadCapabilityTierConfig,
  saveCapabilityTierConfig,
} from '../../../src/system/config/capability-tier-config.js';
export {
  loadSchedulerConfig,
  saveSchedulerConfig,
} from '../../../src/system/config/scheduler-config.js';
export {
  normalizeImportedCard,
  type ImportedCharacterCardInput,
} from '../../../src/core/identity/card-normalizer.js';
