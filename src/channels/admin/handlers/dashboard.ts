import type { LegacyAdminHandlers } from '../handlers-legacy.js';

export class AdminDashboardHandlers {
  constructor(private readonly legacy: LegacyAdminHandlers) {}

  dashboard(): string {
    return this.legacy.dashboard();
  }
}
