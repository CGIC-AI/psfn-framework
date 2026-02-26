import type { LegacyAdminHandlers } from '../handlers-legacy.js';

export class AdminMemoryHandlers {
  constructor(private readonly legacy: LegacyAdminHandlers) {}

  memoryList(params?: URLSearchParams): string {
    return this.legacy.memoryList(params);
  }

  memoryDetail(id: string): string | null {
    return this.legacy.memoryDetail(id);
  }

  memoryListFragment(params?: URLSearchParams): string {
    return this.legacy.memoryListFragment(params);
  }

  async memorySearch(query: string): Promise<string> {
    return this.legacy.memorySearch(query);
  }

  memorySupersede(id: string): string {
    return this.legacy.memorySupersede(id);
  }
}
