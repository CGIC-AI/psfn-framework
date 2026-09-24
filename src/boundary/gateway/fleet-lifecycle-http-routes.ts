import type { IncomingMessage, ServerResponse } from 'node:http';

import { isRecord, isRfc4122Uuid } from '../../shared/utils/types.js';
import {
  FleetLifecycleError,
  type FleetLifecycleErrorCode,
} from '../../system/fleet-lifecycle/contracts.js';
import type { FleetLifecycleCommandPort } from '../../system/fleet-lifecycle/service.js';

export const FLEET_LIFECYCLE_API_PATH = '/v1/fleet/lifecycle/plans';

const FLEET_LIFECYCLE_HTTP_PROTOCOL = Object.freeze({
  schemaVersion: 1 as const,
  maxBodyBytes: 16_384,
  jsonCsp: "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
});

const STATUS_BY_CODE: Partial<Record<FleetLifecycleErrorCode, number>> = {
  invalid_request: 400,
  confirmation_mismatch: 400,
  unauthorized: 403,
  plan_not_found: 404,
};

/** Who reached the lifecycle door. Only the fleet operator credential may command it. */
export type FleetLifecycleRequester =
  | Readonly<{ kind: 'operator'; actor: string }>
  | Readonly<{ kind: 'session' }>;

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Length': String(body.byteLength),
    'Content-Security-Policy': FLEET_LIFECYCLE_HTTP_PROTOCOL.jsonCsp,
    'Content-Type': 'application/json; charset=utf-8',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  response.end(body);
}

function sendError(response: ServerResponse, code: FleetLifecycleErrorCode, stageId?: string): void {
  sendJson(response, STATUS_BY_CODE[code] ?? 409, {
    error: { type: code, ...(stageId ? { stageId } : {}) },
  });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim();
  if (contentType !== 'application/json' || request.headers['transfer-encoding'] !== undefined) {
    throw new FleetLifecycleError('invalid_request', 'Lifecycle commands require a JSON body');
  }
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    received += bytes.byteLength;
    if (received > FLEET_LIFECYCLE_HTTP_PROTOCOL.maxBodyBytes) {
      throw new FleetLifecycleError('invalid_request', 'Lifecycle command body is too large');
    }
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, received).toString('utf8')) as unknown;
  } catch {
    throw new FleetLifecycleError('invalid_request', 'Lifecycle command body is not JSON');
  }
}

function parseApplyBody(value: unknown): { planDigest: string; resume: boolean; confirmCompanionId: string } {
  if (!isRecord(value)
    || Object.keys(value).some(key => !['planDigest', 'resume', 'confirmCompanionId'].includes(key))
    || typeof value.planDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(value.planDigest)
    || typeof value.resume !== 'boolean'
    || !isRfc4122Uuid(value.confirmCompanionId)) {
    throw new FleetLifecycleError('invalid_request', 'Apply requires planDigest, resume, and confirmCompanionId');
  }
  return { planDigest: value.planDigest, resume: value.resume, confirmCompanionId: value.confirmCompanionId };
}

/**
 * Fleet lifecycle door (h248l.6): a thin, authorized client of the shared
 * reconciler. Only the fleet operator credential may plan or apply; SSO
 * sessions and anonymous callers are refused before any command runs. State
 * changes additionally require the exact canonical Origin and a JSON body.
 */
export class GatewayFleetLifecycleHttpRoutes {
  constructor(private readonly options: {
    readonly commands: FleetLifecycleCommandPort;
    readonly canonicalOrigin: string;
    readonly reportError: (error: unknown) => void;
  }) {}

  matches(rawPath: string): boolean {
    return rawPath === FLEET_LIFECYCLE_API_PATH || rawPath.startsWith(`${FLEET_LIFECYCLE_API_PATH}/`);
  }

  async handle(input: {
    readonly request: IncomingMessage;
    readonly response: ServerResponse;
    readonly rawPath: string;
    readonly rawQuery: string;
    readonly requester: FleetLifecycleRequester;
  }): Promise<void> {
    const { request, response } = input;
    try {
      if (input.requester.kind !== 'operator') {
        throw new FleetLifecycleError('unauthorized', 'Fleet lifecycle requires the fleet operator credential');
      }
      if (input.rawQuery) throw new FleetLifecycleError('invalid_request', 'Query strings are not accepted');
      const method = request.method ?? 'GET';
      if (method === 'POST' && request.headers.origin !== this.options.canonicalOrigin) {
        throw new FleetLifecycleError('unauthorized', 'Lifecycle commands require the canonical origin');
      }
      const tail = input.rawPath.slice(FLEET_LIFECYCLE_API_PATH.length);
      const commands = this.options.commands;
      if (tail === '' && method === 'GET') {
        sendJson(response, 200, {
          schemaVersion: FLEET_LIFECYCLE_HTTP_PROTOCOL.schemaVersion,
          applyMode: commands.applyMode,
          plans: await commands.list(),
        });
        return;
      }
      if (tail === '' && method === 'POST') {
        const plan = await commands.plan({ request: await readJsonBody(request), actor: input.requester.actor });
        sendJson(response, 201, plan);
        return;
      }
      const match = /^\/([0-9a-f-]{36})(\/apply)?$/u.exec(tail);
      if (!match || !isRfc4122Uuid(match[1])) {
        throw new FleetLifecycleError('plan_not_found', 'No such lifecycle resource');
      }
      const planId = match[1];
      if (!match[2] && method === 'GET') {
        sendJson(response, 200, await commands.progress(planId));
        return;
      }
      if (match[2] && method === 'POST') {
        const body = parseApplyBody(await readJsonBody(request));
        const current = await commands.progress(planId);
        if (body.confirmCompanionId !== current.plan.companionId) {
          throw new FleetLifecycleError('confirmation_mismatch', 'Confirmation must echo the plan companion');
        }
        sendJson(response, 200, await commands.apply({
          planId,
          planDigest: body.planDigest,
          resume: body.resume,
          actor: input.requester.actor,
        }));
        return;
      }
      throw new FleetLifecycleError('plan_not_found', 'No such lifecycle resource');
    } catch (error) {
      if (error instanceof FleetLifecycleError) {
        sendError(response, error.code, error.stageId);
        return;
      }
      this.options.reportError(error);
      sendJson(response, 503, { error: { type: 'fleet_lifecycle_unavailable' } });
    }
  }
}
