import type { ServerResponse } from 'node:http';
import type { LegacyAdminHandlers } from '../handlers-legacy.js';
import type { EventName, EventMap } from '../../../event-bus.js';
import * as tpl from '../templates.js';

export class AdminEventsHandlers {
  constructor(private readonly legacy: LegacyAdminHandlers) {}

  valuesTimelinePageHtml(): string {
    const legacy = this.legacy as any;
    const entries = legacy.valuesJournal.list({ limit: 250 });
    return tpl.layout('Values Timeline', tpl.valuesTimelinePage({ entries }), 'values');
  }

  eventsPageHtml(searchParams?: URLSearchParams): string {
    const legacy = this.legacy as any;
    const filters = legacy.auditTimeline.parseFilters(searchParams);
    const entries = legacy.auditTimeline.list(filters);
    return tpl.layout(
      'Audit Timeline',
      tpl.auditTimelinePage({ entries, filters }, legacy.resolveCompanionName()),
      'events',
    );
  }

  setupSSE(res: ServerResponse): () => void {
    const legacy = this.legacy as any;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(':ok\n\n');

    const sseEvents: EventName[] = [
      'agent.turn.end',
      'agent.turn.usage',
      'agent.tool.start',
      'agent.tool.end',
      'agent.tools.adaptive.decision',
      'agent.tools.adaptive.snapshot',
      'agent.compaction.start',
      'agent.compaction.end',
      'agent.retry.start',
      'agent.retry.end',
      'agent.think.trace',
      'agent.error',
      'memory.extraction.end',
      'memory.retrieval',
      'schedule.task.run',
      'schedule.heartbeat',
      'wyoming.session.start',
      'wyoming.session.end',
      'wyoming.connection.error',
      'wyoming.policy.violation',
      'wyoming.audit.summary',
      'system.error',
    ];

    const unsubscribers: Array<() => void> = [];

    for (const eventName of sseEvents) {
      const unsub = legacy.eventBus.on(eventName, (data: EventMap[typeof eventName]) => {
        const now = Date.now();
        const html = tpl.eventItem(eventName, now, data as Record<string, unknown>);
        res.write(`event: admin-event\ndata: ${html}\n\n`);
      });
      unsubscribers.push(unsub);
    }

    return () => {
      for (const unsub of unsubscribers) unsub();
    };
  }
}
