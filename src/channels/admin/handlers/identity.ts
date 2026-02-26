import type { LegacyAdminHandlers } from '../handlers-legacy.js';

export class AdminIdentityHandlers {
  constructor(private readonly legacy: LegacyAdminHandlers) {}

  identityPage(): string {
    return this.legacy.identityPage();
  }

  stageIdentityIntake(body: string): string {
    return this.legacy.stageIdentityIntake(body);
  }

  async commitIdentityIntake(body: string): Promise<string> {
    return this.legacy.commitIdentityIntake(body);
  }

  async importIdentityCard(body: string): Promise<string> {
    return this.legacy.importIdentityCard(body);
  }

  rollbackIdentityCard(body: string): string {
    return this.legacy.rollbackIdentityCard(body);
  }

  previewIdentityCardDiff(body: string): string {
    return this.legacy.previewIdentityCardDiff(body);
  }
}
