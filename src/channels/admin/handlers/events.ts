import type { ServerResponse } from 'node:http';
import type { LegacyAdminHandlers } from '../handlers-legacy.js';

export class AdminEventsHandlers {
  constructor(private readonly legacy: LegacyAdminHandlers) {}

  valuesTimelinePageHtml(): string {
    return this.legacy.valuesTimelinePageHtml();
  }

  eventsPageHtml(searchParams?: URLSearchParams): string {
    return this.legacy.eventsPageHtml(searchParams);
  }

  setupSSE(res: ServerResponse): () => void {
    return this.legacy.setupSSE(res);
  }
}
