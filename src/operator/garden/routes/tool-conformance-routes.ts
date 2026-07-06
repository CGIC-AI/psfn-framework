import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../../../channels/backplane/http/primitives.js';
import { ToolConformanceHarnessError } from '../../../core/agent/tool-conformance/types.js';
import type { ToolConformanceTrigger } from '../../../core/agent/tool-conformance/types.js';
import type { AdminToolConformanceService } from '../services/tool-conformance-service.js';
import { exactPath } from '../route-matchers.js';
import type { AdminApiRoute, AdminBodyReader } from './types.js';

const VALID_TRIGGERS: ReadonlySet<ToolConformanceTrigger> = new Set(['manual', 'post_rollout', 'scheduled']);

function parseTrigger(body: string): ToolConformanceTrigger | { error: string } {
  const trimmed = body.trim();
  if (!trimmed) return 'manual';
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { error: 'request body must be valid JSON' };
  }
  if (parsed === null || typeof parsed !== 'object') return 'manual';
  const trigger = (parsed as { trigger?: unknown }).trigger;
  if (trigger === undefined) return 'manual';
  if (typeof trigger !== 'string' || !VALID_TRIGGERS.has(trigger as ToolConformanceTrigger)) {
    return { error: 'trigger must be one of: manual, post_rollout, scheduled' };
  }
  return trigger as ToolConformanceTrigger;
}

/**
 * Tool-surface conformance routes. POST runs the LLM-free sweep and returns the
 * aggregated result; GET returns the latest persisted run. A harness-level fault
 * (unclassified live tool, unreachable catalog, write failure) is surfaced as a
 * 500 distinct from a run that merely contains failing tool probes.
 */
export function buildAdminToolConformanceRoutes(options: {
  toolConformance?: AdminToolConformanceService | null;
  withBody: AdminBodyReader;
}): AdminApiRoute[] {
  const { toolConformance, withBody } = options;

  return [
    {
      method: 'GET',
      match: exactPath('/api/admin/tool-conformance/latest'),
      handle: (_req: IncomingMessage, res: ServerResponse) => {
        if (!toolConformance) {
          sendJson(res, 503, { error: 'Tool conformance backend unavailable' });
          return;
        }
        const latest = toolConformance.getLatest();
        if (!latest) {
          sendJson(res, 404, { error: 'No tool conformance run has been recorded yet' });
          return;
        }
        sendJson(res, 200, latest);
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/admin/tool-conformance/run'),
      handle: (req: IncomingMessage, res: ServerResponse) => {
        if (!toolConformance) {
          sendJson(res, 503, { error: 'Tool conformance backend unavailable' });
          return;
        }
        withBody(req, res, (body) => {
          const trigger = parseTrigger(body);
          if (typeof trigger !== 'string') {
            sendJson(res, 400, { error: trigger.error });
            return;
          }
          toolConformance.run(trigger).then(
            (result) => sendJson(res, 200, result),
            (error: unknown) => {
              if (error instanceof ToolConformanceHarnessError) {
                sendJson(res, 500, { error: 'Tool conformance harness fault', detail: error.message });
                return;
              }
              const detail = error instanceof Error ? error.message : String(error);
              sendJson(res, 500, { error: 'Tool conformance run failed', detail });
            },
          );
        });
      },
    },
  ];
}
