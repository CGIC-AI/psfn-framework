import type { ServerResponse } from 'node:http';
import { LegacyAdminHandlers } from '../handlers-legacy.js';
import { AdminDashboardHandlers } from './dashboard.js';
import { AdminMemoryHandlers } from './memory.js';
import { AdminSessionsHandlers } from './sessions.js';
import { AdminIdentityHandlers } from './identity.js';
import { AdminSettingsHandlers } from './settings.js';
import { AdminContactsHandlers } from './contacts.js';
import { AdminPromptsHandlers } from './prompts.js';
import { AdminChatHandlers } from './chat.js';
import { AdminConfirmationsHandlers } from './confirmations.js';
import { AdminEventsHandlers } from './events.js';
import type { AdminChatBootstrapResponse } from '../chat/index.js';
import type { AdminModelRoomBootstrapResponse } from '../chat/index.js';
import type {
  AdminAuditActionType,
  AdminAuditActor,
  AdminAuditDecision,
} from '../types.js';
import type { AdminChatDebugStreamOptions } from '../types.js';

export type AdminHandlersDeps = ConstructorParameters<typeof LegacyAdminHandlers>[0];
export interface AdminHandlersDomains {
  dashboard: AdminDashboardHandlers;
  memory: AdminMemoryHandlers;
  sessions: AdminSessionsHandlers;
  identity: AdminIdentityHandlers;
  settings: AdminSettingsHandlers;
  contacts: AdminContactsHandlers;
  prompts: AdminPromptsHandlers;
  chat: AdminChatHandlers;
  confirmations: AdminConfirmationsHandlers;
  events: AdminEventsHandlers;
}

export class AdminHandlers {
  private readonly legacy: LegacyAdminHandlers;
  readonly domains: AdminHandlersDomains;

  constructor(deps: AdminHandlersDeps) {
    this.legacy = new LegacyAdminHandlers(deps);
    this.domains = {
      dashboard: new AdminDashboardHandlers(this.legacy),
      memory: new AdminMemoryHandlers(this.legacy),
      sessions: new AdminSessionsHandlers(this.legacy),
      identity: new AdminIdentityHandlers(this.legacy),
      settings: new AdminSettingsHandlers(this.legacy),
      contacts: new AdminContactsHandlers(this.legacy),
      prompts: new AdminPromptsHandlers(this.legacy),
      chat: new AdminChatHandlers({
        config: deps.config,
        sessionStore: deps.sessionStore,
        eventBus: deps.eventBus,
        contactStore: deps.contactStore,
        apiBaseUrl: deps.apiBaseUrl,
        apiHost: deps.apiHost,
        apiPort: deps.apiPort,
      }),
      confirmations: new AdminConfirmationsHandlers(this.legacy),
      events: new AdminEventsHandlers(this.legacy),
    };
  }

  loginPage(error?: string): string {
    return this.legacy.loginPage(error);
  }

  dashboard(): string {
    return this.domains.dashboard.dashboard();
  }

  memoryList(params?: URLSearchParams): string {
    return this.domains.memory.memoryList(params);
  }

  memoryDetail(id: string): string | null {
    return this.domains.memory.memoryDetail(id);
  }

  memoryListFragment(params?: URLSearchParams): string {
    return this.domains.memory.memoryListFragment(params);
  }

  async memorySearch(query: string): Promise<string> {
    return this.domains.memory.memorySearch(query);
  }

  memorySupersede(id: string): string {
    return this.domains.memory.memorySupersede(id);
  }

  sessionList(): string {
    return this.domains.sessions.sessionList();
  }

  sessionMessages(channelId: string): string {
    return this.domains.sessions.sessionMessages(channelId);
  }

  sessionMessagesFragment(channelId: string): string {
    return this.domains.sessions.sessionMessagesFragment(channelId);
  }

  schedulerPage(): string {
    return this.legacy.schedulerPage();
  }

  shardsPage(): string {
    return this.legacy.shardsPage();
  }

  identityPage(): string {
    return this.domains.identity.identityPage();
  }

  stageIdentityIntake(body: string): string {
    return this.domains.identity.stageIdentityIntake(body);
  }

  async commitIdentityIntake(body: string): Promise<string> {
    return this.domains.identity.commitIdentityIntake(body);
  }

  async importIdentityCard(body: string): Promise<string> {
    return this.domains.identity.importIdentityCard(body);
  }

  rollbackIdentityCard(body: string): string {
    return this.domains.identity.rollbackIdentityCard(body);
  }

  previewIdentityCardDiff(body: string): string {
    return this.domains.identity.previewIdentityCardDiff(body);
  }

  async settingsPage(): Promise<string> {
    return this.domains.settings.settingsPage();
  }

  skillsPage(): string {
    return this.domains.settings.skillsPage();
  }

  updateSettings(body: string): string {
    return this.domains.settings.updateSettings(body);
  }

  modelsConfigJson(): string {
    return this.domains.settings.modelsConfigJson();
  }

  updateModelsConfig(body: string): string {
    return this.domains.settings.updateModelsConfig(body);
  }

  skillsConfigJson(): string {
    return this.domains.settings.skillsConfigJson();
  }

  updateSkillsConfig(body: string): string {
    return this.domains.settings.updateSkillsConfig(body);
  }

  schedulerConfigJson(): string {
    return this.domains.settings.schedulerConfigJson();
  }

  updateSchedulerConfig(body: string): string {
    return this.domains.settings.updateSchedulerConfig(body);
  }

  trustPolicyConfigJson(): string {
    return this.domains.settings.trustPolicyConfigJson();
  }

  updateTrustPolicyConfig(body: string): string {
    return this.domains.settings.updateTrustPolicyConfig(body);
  }

  capabilitiesConfigJson(): string {
    return this.domains.settings.capabilitiesConfigJson();
  }

  updateCapabilitiesConfig(body: string): string {
    return this.domains.settings.updateCapabilitiesConfig(body);
  }

  primerPage(): string {
    return this.legacy.primerPage();
  }

  chatPage(): string {
    return this.domains.chat.chatPage();
  }

  async confirmationsPage(): Promise<string> {
    return this.domains.confirmations.confirmationsPage();
  }

  async confirmationsListFragment(): Promise<string> {
    return this.domains.confirmations.confirmationsListFragment();
  }

  async resolveConfirmation(body: string): Promise<string> {
    return this.domains.confirmations.resolveConfirmation(body);
  }

  chatBootstrap(requestOrigin?: string): AdminChatBootstrapResponse {
    return this.domains.chat.chatBootstrap(requestOrigin);
  }

  chatModelRoomBootstrap(requestOrigin?: string): AdminModelRoomBootstrapResponse {
    return this.domains.chat.chatModelRoomBootstrap(requestOrigin);
  }

  setupChatDebugSSE(
    res: ServerResponse,
    options: AdminChatDebugStreamOptions = {},
  ): () => void {
    return this.domains.chat.setupChatDebugSSE(res, options);
  }

  updateChatBootstrap(
    body: string,
    contentTypeHeader: string | string[] | undefined,
    requestOrigin?: string,
  ): AdminChatBootstrapResponse {
    return this.domains.chat.updateChatBootstrap(body, contentTypeHeader, requestOrigin);
  }

  async modelListJson(): Promise<string> {
    return this.domains.settings.modelListJson();
  }

  async refreshModels(): Promise<string> {
    return this.domains.settings.refreshModels();
  }

  contactsPage(): string {
    return this.domains.contacts.contactsPage();
  }

  contactMutationAuditFragment(params?: URLSearchParams): string {
    return this.domains.contacts.contactMutationAuditFragment(params);
  }

  contactsListFragment(): string {
    return this.domains.contacts.contactsListFragment();
  }

  contactEditFormFragment(contactId: string): string {
    return this.domains.contacts.contactEditFormFragment(contactId);
  }

  handleContactUpdate(contactId: string, body: string): string {
    return this.domains.contacts.handleContactUpdate(contactId, body);
  }

  promptsPage(): string {
    return this.domains.prompts.promptsPage();
  }

  promptDetail(layerId: string): string | null {
    return this.domains.prompts.promptDetail(layerId);
  }

  promptRegistryDetail(key: string): string | null {
    return this.domains.prompts.promptRegistryDetail(key);
  }

  updatePromptLayer(body: string): string {
    return this.domains.prompts.updatePromptLayer(body);
  }

  updatePromptRegistry(body: string): string {
    return this.domains.prompts.updatePromptRegistry(body);
  }

  togglePromptLayer(body: string): string {
    return this.domains.prompts.togglePromptLayer(body);
  }

  rollbackPromptLayer(body: string): string {
    return this.domains.prompts.rollbackPromptLayer(body);
  }

  rollbackPromptRegistry(body: string): string {
    return this.domains.prompts.rollbackPromptRegistry(body);
  }

  previewPromptLayerDiff(body: string): string {
    return this.domains.prompts.previewPromptLayerDiff(body);
  }

  valuesTimelinePageHtml(): string {
    return this.domains.events.valuesTimelinePageHtml();
  }

  eventsPageHtml(searchParams?: URLSearchParams): string {
    return this.domains.events.eventsPageHtml(searchParams);
  }

  setupSSE(res: ServerResponse): () => void {
    return this.domains.events.setupSSE(res);
  }

  appendAuditTimelineEntry(
    actionType: AdminAuditActionType,
    decision: AdminAuditDecision,
    narrative: string,
    details: Array<string | null | undefined> = [],
    actor?: AdminAuditActor,
  ): void {
    this.legacy.appendAuditTimelineEntry(actionType, decision, narrative, details, actor);
  }
}
