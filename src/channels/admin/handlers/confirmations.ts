import type { LegacyAdminHandlers } from '../handlers-legacy.js';

export class AdminConfirmationsHandlers {
  constructor(private readonly legacy: LegacyAdminHandlers) {}

  async confirmationsPage(): Promise<string> {
    return this.legacy.confirmationsPage();
  }

  async confirmationsListFragment(): Promise<string> {
    return this.legacy.confirmationsListFragment();
  }

  async resolveConfirmation(body: string): Promise<string> {
    return this.legacy.resolveConfirmation(body);
  }
}
