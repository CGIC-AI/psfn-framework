import type { EventBus } from '../../shared/event-bus.js';
import type { RuntimeToolCatalogSnapshot } from '../../core/agent/tool-catalog.js';
import type { AdaptiveToolRuntimeState } from '../../core/agent/adaptive-tools-telemetry.js';
import type {
  ConfirmationListResult,
  ConfirmationResolveParams,
} from '../../boundary/gateway/protocol.js';
import type { ConfirmationResolveResult } from '../../system/capabilities/confirmation-queue.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { ReflectionTemplate } from '../../core/scheduler/reflection-policy.js';
import type { RecurringCadence, ScheduledTask, TaskType } from '../../core/scheduler/types.js';
import type { WakeWindowSnapshot } from '../../core/scheduler/temporal-wakeup.js';
import type {
  SkillSkipRecord,
  SkillSnapshot,
} from '../../faculties/skills/types.js';
import type { ManagedSkillRecord as RuntimeManagedSkillRecord } from '../../faculties/skills/store.js';
import type { ValuesJournalEntry } from '../../faculties/values/store.js';
import type { ReflectionJournalEntry } from '../../persistence/journals/reflection-journal.js';
import type { ReflectionMetacognitionJournalEntry } from '../../persistence/journals/reflection-metacognition-journal.js';
import type { ReflectionDailyJournalEntry } from '../../persistence/journals/reflection-substrate.js';
import type { ModelDiscoveryBackend } from '../../primitives/llm/discovery.js';
import type {
  AdminChatBootstrapResponse,
  AdminChatBootstrapUpdateInput,
  AdminModelRoomBootstrapResponse,
} from './chat/types.js';
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
import type { AdminObserverEvalSidecarService } from './services/observer-eval-sidecar-service.js';
import type { AdminIntakeQuarantineService } from './services/intake-quarantine-service.js';
import type { AdminDriftReviewService } from './services/drift-review-service.js';
import type { AdminPendingContactsService } from './services/pending-contacts-service.js';
import type { AdminRoomsService } from './services/rooms-service.js';
import type { AdminPlacesService } from './services/places-service.js';
import type { AdminEnrollmentService } from './services/enrollment-service.js';
import type { AdminGraphProposalsService } from './services/graph-proposals-service.js';
import type { AdminSubsystemHealthService } from './services/subsystem-health-service.js';
import type { AdminPartnerAffectShadowService } from './services/partner-affect-shadow-service.js';
import type { AdminToolConformanceService } from './services/tool-conformance-service.js';
import type { AdminSharedWorkspaceService } from './services/shared-workspace-service.js';
import type { AdminPrivacyBreakGlassService } from './services/privacy-break-glass-service.js';
import type { AdminSubjectVisibleAuditService } from './services/subject-visible-audit-service.js';
import type { AdminBiographicalReviewService } from './services/biographical-review-service.js';
import type { OwnerFileReloadWatcher } from './services/owner-file-reload-watcher.js';
import type { GardenRequestContext } from './garden-request-context.js';

export interface ConfirmationQueueAdminApi {
  listConfirmationQueue(context?: GardenRequestContext): Promise<ConfirmationListResult>;
  /**
   * Resolves an agent-local confirmation (e.g. a card proposal). Operator-only
   * gateway confirmations are never resolved through this agent-hosted surface;
   * the operator credential required for them must not traverse the agent
   * (x5rt.10). Agent-local resolution therefore takes no auth context.
   */
  resolveConfirmationQueue(
    params: ConfirmationResolveParams,
    context?: GardenRequestContext,
  ): Promise<ConfirmationResolveResult>;
}

/**
 * Operator ADMIN_TOKEN material presented to the gateway operator confirmation
 * endpoint. Only the independently authenticated Garden operator process ever
 * holds this; it never crosses into the agent process (x5rt.10).
 */
export interface ConfirmationOperatorAuthContext {
  authorization?: string;
  cookie?: string;
}

export interface AdaptiveToolsStateProvider {
  getAdaptiveToolRuntimeState(): AdaptiveToolRuntimeState;
  getToolCatalogSnapshot(): RuntimeToolCatalogSnapshot;
}

export type AdminModelDiscoveryApi = ModelDiscoveryBackend;

export type AdminTaskCadence = RecurringCadence;

export interface AdminScheduledTaskView {
  id: string;
  name: string;
  type: TaskType;
  intervalMs: number;
  runAt?: number;
  state: string;
  cadence?: AdminTaskCadence;
  lastRunAt?: number;
  lastFinishedAt?: number;
  lastOutcome?: string;
  lastError?: string;
  lastErrorAt?: number;
  lastDeniedReason?: string;
}

export interface AdminSchedulerApi {
  listTasks(): ScheduledTask[];
  getFullData?(): {
    tasks: AdminScheduledTaskView[];
    reflections: ReflectionTemplate[];
  };
  updateTask?(id: string, updates: {
    intervalMs?: number;
    enabled?: boolean;
    name?: string;
    cadence?: unknown;
  }): { ok: boolean; message: string };
  createTask?(input: {
    id: string;
    name: string;
    type: TaskType;
    intervalMs?: number;
    runAt?: number;
    cadence?: unknown;
  }): { ok: boolean; message: string };
  removeTask?(id: string): { ok: boolean; message: string };
  updateReflection?(id: string, updates: Partial<ReflectionTemplate>): { ok: boolean; message: string };
  /** Current habit wake-window estimate + data sufficiency (E7.2). */
  getWakeWindow?(): WakeWindowSnapshot | null;
}

export type AdminManagedSkillRecord = Omit<
  RuntimeManagedSkillRecord,
  'absolutePath' | 'relativePath'
>;

export interface AdminSkillsApi {
  getSnapshot(): SkillSnapshot | Promise<SkillSnapshot>;
  listManaged(): Promise<{ managed: AdminManagedSkillRecord[]; skipped: SkillSkipRecord[] }>;
  createSkill(input: { name: string; category: string; content: string; description?: string }): AdminManagedSkillRecord;
  updateSkill(input: { name: string; content: string; description?: string }): AdminManagedSkillRecord;
  deleteSkill(name: string): void;
  toggleSkill(name: string): boolean;
  getDisabledSkills(): string[];
  invalidate(): void;
}

export interface AdminValuesJournalApi {
  list(options?: { limit?: number }): ValuesJournalEntry[];
}

export interface AdminReflectionMetacognitionJournalApi {
  listRecent(options?: { limit?: number }): ReflectionMetacognitionJournalEntry[];
}

export interface AdminReflectionDailyJournalApi {
  listRecent(options?: { limit?: number }): ReflectionDailyJournalEntry[];
}

export interface AdminReflectionJournalApi {
  listRecent(options?: { limit?: number }): ReflectionJournalEntry[];
}

export interface AdminChatBootstrapApi {
  buildBootstrap(options?: { requestOrigin?: string; settingsApiBaseUrl?: string }): Promise<AdminChatBootstrapResponse>;
  updateSelection(
    input: AdminChatBootstrapUpdateInput,
    options?: { requestOrigin?: string; settingsApiBaseUrl?: string },
  ): Promise<AdminChatBootstrapResponse>;
  buildModelRoomBootstrap(
    config: SubstrateConfig,
    options?: { requestOrigin?: string; settingsApiBaseUrl?: string },
  ): Promise<AdminModelRoomBootstrapResponse>;
}

export interface GardenAdminDomainServices {
  automata?: import('./services/automata-service.js').AdminAutomataService | null;
  dashboard: AdminDashboardService;
  diagnostics: AdminDiagnosticsService;
  images: AdminImagesService;
  auditHistory: AdminAuditHistoryService;
  /** Companion-facing, content-free records for protected operator actions. */
  subjectAudit?: AdminSubjectVisibleAuditService;
  charges?: AdminChargeLedgerService | null;
  chargeCosts?: AdminChargeCostReconciliationService | null;
  modelUsage?: AdminModelUsageService | null;
  observerEvalSidecar?: AdminObserverEvalSidecarService | null;
  actionPipe?: AdminActionPipeService | null;
  shards: AdminShardFoldReviewService;
  adaptiveTools?: AdminAdaptiveToolsService | null;
  wiki?: AdminWikiService | null;
  wishlist?: AdminWishlistService | null;
  episodicMemory?: AdminEpisodicMemoryService | null;
  groupMemory?: AdminGroupMemoryService | null;
  memory: AdminMemoryService;
  biographicalReview?: AdminBiographicalReviewService | null;
  privacyBreakGlass?: AdminPrivacyBreakGlassService | null;
  sessions: AdminSessionService;
  contacts: AdminContactsService;
  pendingContacts?: AdminPendingContactsService | null;
  rooms?: AdminRoomsService | null;
  places?: AdminPlacesService | null;
  enrollment?: AdminEnrollmentService | null;
  graphProposals?: AdminGraphProposalsService | null;
  concerns?: AdminConcernService | null;
  subsystemHealth?: AdminSubsystemHealthService | null;
  /** Shadow-only Partner Affect inspection surface (docs/partner-affect.md slice 1). */
  partnerAffectShadow?: AdminPartnerAffectShadowService | null;
  toolConformance?: AdminToolConformanceService | null;
  icpAutonomy?: AdminIcpAutonomyService | null;
  /** Fleet Command room-state and arbitration telemetry (jp36.8.1). */
  roomArbiter?: AdminRoomArbiterService | null;
  settings: AdminSettingsService;
  /**
   * Owner-file hot-reload watcher (bead nudf). Present only for the in-process
   * agent Garden; the transport server closes it on shutdown.
   */
  ownerFileReloadWatcher?: OwnerFileReloadWatcher | null;
  sharedWorkspace?: AdminSharedWorkspaceService | null;
  /** Intake quarantine approval queue (htm9.11 Cognitive Security tab). */
  intakeQuarantine: AdminIntakeQuarantineService;
  /** Slow-poisoning drift review cards (htm9.14 Cognitive Security tab). */
  driftReviews: AdminDriftReviewService;
  identity: AdminIdentityService;
  prompts: AdminPromptsService;
  scheduler: AdminSchedulerApi;
  skills?: AdminSkillsApi | null;
  confirmations?: ConfirmationQueueAdminApi | null;
  values: AdminValuesJournalApi;
  reflectionMetacognitionJournal: AdminReflectionMetacognitionJournalApi;
  reflectionDailyJournal: AdminReflectionDailyJournalApi;
  reflectionJournal: AdminReflectionJournalApi;
  modelDiscovery?: AdminModelDiscoveryApi | null;
  chatBootstrap: AdminChatBootstrapApi;
}

export interface AdminServerConfig {
  port: number;
  host?: string;
  token?: string;
  allowInsecureWithoutToken?: boolean;
  eventBus: EventBus;
  config: SubstrateConfig;
  services: GardenAdminDomainServices;
}
