import type { EventBus } from '../../shared/event-bus.js';
import type { RuntimeToolCatalogSnapshot } from '../../core/agent/tool-catalog.js';
import type { AdaptiveToolRuntimeState } from '../../core/agent/adaptive-tools-telemetry.js';
import type {
  ConfirmationListResult,
  ConfirmationResolveParams,
} from '../../boundary/gateway/protocol.js';
import type { ConfirmationResolveResult } from '../../system/capabilities/confirmation-queue.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { ReflectionTemplate } from '../../core/scheduler/heartbeat-policy.js';
import type { RecurringCadence, ScheduledTask, TaskType } from '../../core/scheduler/types.js';
import type { SkillSnapshot } from '../../faculties/skills/types.js';
import type { ValuesJournalEntry } from '../../faculties/values/store.js';
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
  AdminChargeLedgerService,
  AdminContactsService,
  AdminDashboardService,
  AdminEpisodicMemoryService,
  AdminGroupMemoryService,
  AdminImagesService,
  AdminIdentityService,
  AdminMemoryService,
  AdminModelUsageService,
  AdminPromptsService,
  AdminShardFoldReviewService,
  AdminSessionService,
  AdminSettingsService,
  AdminWikiService,
} from './services/types.js';
import type { AdminObserverEvalSidecarService } from './services/observer-eval-sidecar-service.js';

export interface ConfirmationQueueAdminApi {
  listConfirmationQueue(): Promise<ConfirmationListResult>;
  resolveConfirmationQueue(params: ConfirmationResolveParams): Promise<ConfirmationResolveResult>;
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
}

export interface ManagedSkillRecord {
  name: string;
  description: string;
  category: string;
  version: number;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface AdminSkillsApi {
  getSnapshot(): SkillSnapshot;
  listManaged(): ManagedSkillRecord[];
  createSkill(input: { name: string; category: string; content: string; description?: string }): ManagedSkillRecord;
  updateSkill(input: { name: string; content: string; description?: string }): ManagedSkillRecord;
  deleteSkill(name: string): void;
  toggleSkill(name: string): boolean;
  getDisabledSkills(): string[];
  invalidate(): void;
}

export interface AdminValuesJournalApi {
  list(options?: { limit?: number }): ValuesJournalEntry[];
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
  dashboard: AdminDashboardService;
  images: AdminImagesService;
  auditHistory: AdminAuditHistoryService;
  charges?: AdminChargeLedgerService | null;
  modelUsage?: AdminModelUsageService | null;
  observerEvalSidecar?: AdminObserverEvalSidecarService | null;
  actionPipe?: AdminActionPipeService | null;
  shards: AdminShardFoldReviewService;
  adaptiveTools?: AdminAdaptiveToolsService | null;
  wiki?: AdminWikiService | null;
  episodicMemory?: AdminEpisodicMemoryService | null;
  groupMemory?: AdminGroupMemoryService | null;
  memory: AdminMemoryService;
  sessions: AdminSessionService;
  contacts: AdminContactsService;
  settings: AdminSettingsService;
  identity: AdminIdentityService;
  prompts: AdminPromptsService;
  scheduler: AdminSchedulerApi;
  skills?: AdminSkillsApi | null;
  confirmations?: ConfirmationQueueAdminApi | null;
  values: AdminValuesJournalApi;
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
