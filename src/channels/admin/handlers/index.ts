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
import type { AdminChatDebugStreamOptions } from '../types.js';

export type AdminHandlersDeps = ConstructorParameters<typeof LegacyAdminHandlers>[0];

export class AdminHandlers {
  private readonly legacy: LegacyAdminHandlers;
  private readonly dashboardHandlers: AdminDashboardHandlers;
  private readonly memoryHandlers: AdminMemoryHandlers;
  private readonly sessionsHandlers: AdminSessionsHandlers;
  private readonly identityHandlers: AdminIdentityHandlers;
  private readonly settingsHandlers: AdminSettingsHandlers;
  private readonly contactsHandlers: AdminContactsHandlers;
  private readonly promptsHandlers: AdminPromptsHandlers;
  private readonly chatHandlers: AdminChatHandlers;
  private readonly confirmationsHandlers: AdminConfirmationsHandlers;
  private readonly eventsHandlers: AdminEventsHandlers;

  constructor(deps: AdminHandlersDeps) {
    this.legacy = new LegacyAdminHandlers(deps);
    this.dashboardHandlers = new AdminDashboardHandlers(this.legacy);
    this.memoryHandlers = new AdminMemoryHandlers(this.legacy);
    this.sessionsHandlers = new AdminSessionsHandlers(this.legacy);
    this.identityHandlers = new AdminIdentityHandlers(this.legacy);
    this.settingsHandlers = new AdminSettingsHandlers(this.legacy);
    this.contactsHandlers = new AdminContactsHandlers(this.legacy);
    this.promptsHandlers = new AdminPromptsHandlers(this.legacy);
    this.chatHandlers = new AdminChatHandlers(this.legacy);
    this.confirmationsHandlers = new AdminConfirmationsHandlers(this.legacy);
    this.eventsHandlers = new AdminEventsHandlers(this.legacy);
  }

  loginPage(error?: string): string {
    return this.legacy.loginPage(error);
  }

  dashboard(): string {
    return this.dashboardHandlers.dashboard();
  }

  memoryList(params?: URLSearchParams): string {
    return this.memoryHandlers.memoryList(params);
  }

  memoryDetail(id: string): string | null {
    return this.memoryHandlers.memoryDetail(id);
  }

  memoryListFragment(params?: URLSearchParams): string {
    return this.memoryHandlers.memoryListFragment(params);
  }

  async memorySearch(query: string): Promise<string> {
    return this.memoryHandlers.memorySearch(query);
  }

  memorySupersede(id: string): string {
    return this.memoryHandlers.memorySupersede(id);
  }

  sessionList(): string {
    return this.sessionsHandlers.sessionList();
  }

  sessionMessages(channelId: string): string {
    return this.sessionsHandlers.sessionMessages(channelId);
  }

  sessionMessagesFragment(channelId: string): string {
    return this.sessionsHandlers.sessionMessagesFragment(channelId);
  }

  schedulerPage(): string {
    return this.legacy.schedulerPage();
  }

  shardsPage(): string {
    return this.legacy.shardsPage();
  }

  identityPage(): string {
    return this.identityHandlers.identityPage();
  }

  stageIdentityIntake(body: string): string {
    return this.identityHandlers.stageIdentityIntake(body);
  }

  async commitIdentityIntake(body: string): Promise<string> {
    return this.identityHandlers.commitIdentityIntake(body);
  }

  async importIdentityCard(body: string): Promise<string> {
    return this.identityHandlers.importIdentityCard(body);
  }

  rollbackIdentityCard(body: string): string {
    return this.identityHandlers.rollbackIdentityCard(body);
  }

  previewIdentityCardDiff(body: string): string {
    return this.identityHandlers.previewIdentityCardDiff(body);
  }

  async settingsPage(): Promise<string> {
    return this.settingsHandlers.settingsPage();
  }

  skillsPage(): string {
    return this.settingsHandlers.skillsPage();
  }

  updateSettings(body: string): string {
    return this.settingsHandlers.updateSettings(body);
  }

  modelsConfigJson(): string {
    return this.settingsHandlers.modelsConfigJson();
  }

  updateModelsConfig(body: string): string {
    return this.settingsHandlers.updateModelsConfig(body);
  }

  skillsConfigJson(): string {
    return this.settingsHandlers.skillsConfigJson();
  }

  updateSkillsConfig(body: string): string {
    return this.settingsHandlers.updateSkillsConfig(body);
  }

  schedulerConfigJson(): string {
    return this.settingsHandlers.schedulerConfigJson();
  }

  updateSchedulerConfig(body: string): string {
    return this.settingsHandlers.updateSchedulerConfig(body);
  }

  trustPolicyConfigJson(): string {
    return this.settingsHandlers.trustPolicyConfigJson();
  }

  updateTrustPolicyConfig(body: string): string {
    return this.settingsHandlers.updateTrustPolicyConfig(body);
  }

  capabilitiesConfigJson(): string {
    return this.settingsHandlers.capabilitiesConfigJson();
  }

  updateCapabilitiesConfig(body: string): string {
    return this.settingsHandlers.updateCapabilitiesConfig(body);
  }

  primerPage(): string {
    return this.legacy.primerPage();
  }

  chatPage(): string {
    return this.chatHandlers.chatPage();
  }

  async confirmationsPage(): Promise<string> {
    return this.confirmationsHandlers.confirmationsPage();
  }

  async confirmationsListFragment(): Promise<string> {
    return this.confirmationsHandlers.confirmationsListFragment();
  }

  async resolveConfirmation(body: string): Promise<string> {
    return this.confirmationsHandlers.resolveConfirmation(body);
  }

  chatBootstrap(requestOrigin?: string): AdminChatBootstrapResponse {
    return this.chatHandlers.chatBootstrap(requestOrigin);
  }

  chatModelRoomBootstrap(requestOrigin?: string): AdminModelRoomBootstrapResponse {
    return this.chatHandlers.chatModelRoomBootstrap(requestOrigin);
  }

  setupChatDebugSSE(
    res: ServerResponse,
    options: AdminChatDebugStreamOptions = {},
  ): () => void {
    return this.chatHandlers.setupChatDebugSSE(res, options);
  }

  updateChatBootstrap(
    body: string,
    contentTypeHeader: string | string[] | undefined,
    requestOrigin?: string,
  ): AdminChatBootstrapResponse {
    return this.chatHandlers.updateChatBootstrap(body, contentTypeHeader, requestOrigin);
  }

  async modelListJson(): Promise<string> {
    return this.settingsHandlers.modelListJson();
  }

  async refreshModels(): Promise<string> {
    return this.settingsHandlers.refreshModels();
  }

  contactsPage(): string {
    return this.contactsHandlers.contactsPage();
  }

  contactMutationAuditFragment(params?: URLSearchParams): string {
    return this.contactsHandlers.contactMutationAuditFragment(params);
  }

  contactsListFragment(): string {
    return this.contactsHandlers.contactsListFragment();
  }

  contactEditFormFragment(contactId: string): string {
    return this.contactsHandlers.contactEditFormFragment(contactId);
  }

  handleContactUpdate(contactId: string, body: string): string {
    return this.contactsHandlers.handleContactUpdate(contactId, body);
  }

  promptsPage(): string {
    return this.promptsHandlers.promptsPage();
  }

  promptDetail(layerId: string): string | null {
    return this.promptsHandlers.promptDetail(layerId);
  }

  promptRegistryDetail(key: string): string | null {
    return this.promptsHandlers.promptRegistryDetail(key);
  }

  updatePromptLayer(body: string): string {
    return this.promptsHandlers.updatePromptLayer(body);
  }

  updatePromptRegistry(body: string): string {
    return this.promptsHandlers.updatePromptRegistry(body);
  }

  togglePromptLayer(body: string): string {
    return this.promptsHandlers.togglePromptLayer(body);
  }

  rollbackPromptLayer(body: string): string {
    return this.promptsHandlers.rollbackPromptLayer(body);
  }

  rollbackPromptRegistry(body: string): string {
    return this.promptsHandlers.rollbackPromptRegistry(body);
  }

  previewPromptLayerDiff(body: string): string {
    return this.promptsHandlers.previewPromptLayerDiff(body);
  }

  valuesTimelinePageHtml(): string {
    return this.eventsHandlers.valuesTimelinePageHtml();
  }

  eventsPageHtml(searchParams?: URLSearchParams): string {
    return this.eventsHandlers.eventsPageHtml(searchParams);
  }

  setupSSE(res: ServerResponse): () => void {
    return this.eventsHandlers.setupSSE(res);
  }
}
