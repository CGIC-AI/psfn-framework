import type { LegacyAdminHandlers } from '../handlers-legacy.js';

export class AdminSettingsHandlers {
  constructor(private readonly legacy: LegacyAdminHandlers) {}

  async settingsPage(): Promise<string> {
    return this.legacy.settingsPage();
  }

  skillsPage(): string {
    return this.legacy.skillsPage();
  }

  updateSettings(body: string): string {
    return this.legacy.updateSettings(body);
  }

  modelsConfigJson(): string {
    return this.legacy.modelsConfigJson();
  }

  updateModelsConfig(body: string): string {
    return this.legacy.updateModelsConfig(body);
  }

  skillsConfigJson(): string {
    return this.legacy.skillsConfigJson();
  }

  updateSkillsConfig(body: string): string {
    return this.legacy.updateSkillsConfig(body);
  }

  schedulerConfigJson(): string {
    return this.legacy.schedulerConfigJson();
  }

  updateSchedulerConfig(body: string): string {
    return this.legacy.updateSchedulerConfig(body);
  }

  trustPolicyConfigJson(): string {
    return this.legacy.trustPolicyConfigJson();
  }

  updateTrustPolicyConfig(body: string): string {
    return this.legacy.updateTrustPolicyConfig(body);
  }

  capabilitiesConfigJson(): string {
    return this.legacy.capabilitiesConfigJson();
  }

  updateCapabilitiesConfig(body: string): string {
    return this.legacy.updateCapabilitiesConfig(body);
  }

  async modelListJson(): Promise<string> {
    return this.legacy.modelListJson();
  }

  async refreshModels(): Promise<string> {
    return this.legacy.refreshModels();
  }
}
