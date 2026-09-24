import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFileFleetTopologyPort, createLocalFleetWorkloadPort } from '../../system/fleet-lifecycle/local-adapter.js';
import { FleetLifecyclePlanStore } from '../../system/fleet-lifecycle/plan-store.js';
import {
  createFleetLifecycleService,
  type FleetLifecycleApplyMode,
  type FleetLifecycleCommandPort,
} from '../../system/fleet-lifecycle/service.js';
import { FLEET_LIFECYCLE_API_PATH, GatewayFleetLifecycleHttpRoutes } from './fleet-lifecycle-http-routes.js';

const ORIGIN = 'https://fleet.example.test';
const PRIMARY = '11111111-1111-4111-8111-111111111111';
const NOVA = '33333333-3333-4333-8333-333333333333';
const OPERATOR = { kind: 'operator', actor: 'operator:admin-token' } as const;

function entry(companionId: string, name: string) {
  return {
    companionId,
    companionDataDir: `companions/${name}`,
    characterCardPath: `companions/${name}/character-card.json`,
    postgresSchema: `companion_${name}`,
    postgresRole: `companion_${name}_runtime`,
    postgresDatabaseUrlRef: { kind: 'env', envName: `COMPANION_${name.toUpperCase()}_DATABASE_URL` },
  };
}

const MANIFEST = {
  postgres: {
    sharedMigrationRole: 'shared_schema_migration',
    sharedMigrationDatabaseUrlRef: { kind: 'env', envName: 'SHARED_SCHEMA_MIGRATION_DATABASE_URL' },
  },
  companions: [entry(PRIMARY, 'flagship')],
};

function request(method: string, body?: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const incoming = Readable.from(payload) as unknown as IncomingMessage;
  incoming.method = method;
  incoming.headers = {
    ...(body === undefined ? {} : { 'content-type': 'application/json', origin: ORIGIN }),
    ...headers,
  };
  return incoming;
}

function response(): ServerResponse & { status?: number; json?: () => unknown } {
  let status: number | undefined;
  let body = Buffer.alloc(0);
  const res = {
    writeHead: vi.fn((code: number) => { status = code; return res; }),
    end: vi.fn((chunk?: Buffer) => { if (chunk) body = chunk; }),
    get status() { return status; },
    json: () => JSON.parse(body.toString('utf8')) as unknown,
  };
  return res as unknown as ServerResponse & { status?: number; json?: () => unknown };
}

let dir: string;
let manifestPath: string;
let tenantChecks: number;

function service(applyMode: FleetLifecycleApplyMode = 'local'): FleetLifecycleCommandPort {
  return createFleetLifecycleService({
    applyMode,
    openRuntime: () => ({
      store: new FleetLifecyclePlanStore(dir),
      ports: {
        topology: createFileFleetTopologyPort(dir),
        prerequisites: {
          verifyTenant: async () => { tenantChecks += 1; },
          verifySecretRefs: async () => undefined,
          verifyOwnerRoots: async () => undefined,
          verifyWorkspace: async () => undefined,
        },
        workload: createLocalFleetWorkloadPort(),
        icpFence: {
          isFenced: async () => false,
          fence: async () => ({ transitioned: true }),
          clear: async () => ({ transitioned: true }),
        },
        fleetAuth: { disabled: true },
      },
      close: async () => undefined,
    }),
  });
}

function routes(commands = service()) {
  return new GatewayFleetLifecycleHttpRoutes({ commands, canonicalOrigin: ORIGIN, reportError: vi.fn() });
}

async function call(
  target: GatewayFleetLifecycleHttpRoutes,
  method: string,
  path: string,
  body?: unknown,
  options: { requester?: Parameters<GatewayFleetLifecycleHttpRoutes['handle']>[0]['requester']; headers?: Record<string, string> } = {},
) {
  const res = response();
  await target.handle({
    request: request(method, body, options.headers),
    response: res,
    rawPath: path,
    rawQuery: '',
    requester: options.requester ?? OPERATOR,
  });
  return { status: res.status, body: res.json?.() as Record<string, unknown> };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-lifecycle-routes-'));
  manifestPath = join(dir, 'companions.json');
  writeFileSync(manifestPath, `${JSON.stringify(MANIFEST, null, 2)}\n`);
  tenantChecks = 0;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('Fleet lifecycle HTTP routes', () => {
  it('lets the operator plan, review, and apply through the shared reconciler with audit', async () => {
    const target = routes();
    const planned = await call(target, 'POST', FLEET_LIFECYCLE_API_PATH, {
      operation: 'add', companion: entry(NOVA, 'nova'),
    });
    expect(planned.status).toBe(201);
    const planId = planned.body.planId as string;
    const reviewed = await call(target, 'GET', `${FLEET_LIFECYCLE_API_PATH}/${planId}`);
    expect(reviewed.body).toMatchObject({ status: 'planned', plan: { planId, companionId: NOVA } });
    const listed = await call(target, 'GET', FLEET_LIFECYCLE_API_PATH);
    expect(listed.body).toMatchObject({ schemaVersion: 1, applyMode: 'local', plans: [{ plan: { planId } }] });

    const wrongConfirm = await call(target, 'POST', `${FLEET_LIFECYCLE_API_PATH}/${planId}/apply`, {
      planDigest: planned.body.digest, resume: false, confirmCompanionId: PRIMARY,
    });
    expect(wrongConfirm).toMatchObject({ status: 400, body: { error: { type: 'confirmation_mismatch' } } });
    expect(tenantChecks).toBe(0);

    const applied = await call(target, 'POST', `${FLEET_LIFECYCLE_API_PATH}/${planId}/apply`, {
      planDigest: planned.body.digest, resume: false, confirmCompanionId: NOVA,
    });
    expect(applied).toMatchObject({ status: 200, body: { status: 'applied' } });
    expect(readFileSync(manifestPath, 'utf8')).toContain(NOVA);

    const audit = readFileSync(join(dir, 'fleet-lifecycle', 'audit.jsonl'), 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>);
    expect(audit.map(line => [line.action, line.outcome, line.actor])).toEqual([
      ['plan', 'ok', 'operator:admin-token'],
      ['apply', 'ok', 'operator:admin-token'],
    ]);
    expect(JSON.stringify(audit)).not.toContain('DATABASE_URL');
  });

  it('refuses SSO sessions, foreign origins, and stale digests without side effects', async () => {
    const target = routes();
    const before = readFileSync(manifestPath, 'utf8');
    const denied = await call(target, 'POST', FLEET_LIFECYCLE_API_PATH, {
      operation: 'add', companion: entry(NOVA, 'nova'),
    }, { requester: { kind: 'session' } });
    expect(denied).toMatchObject({ status: 403, body: { error: { type: 'unauthorized' } } });
    const deniedRead = await call(target, 'GET', FLEET_LIFECYCLE_API_PATH, undefined, { requester: { kind: 'session' } });
    expect(deniedRead.status).toBe(403);
    const crossOrigin = await call(target, 'POST', FLEET_LIFECYCLE_API_PATH, {
      operation: 'add', companion: entry(NOVA, 'nova'),
    }, { headers: { origin: 'https://evil.example.test' } });
    expect(crossOrigin).toMatchObject({ status: 403, body: { error: { type: 'unauthorized' } } });
    expect(new FleetLifecyclePlanStore(dir).listPlanIds()).toEqual([]);

    const planned = await call(target, 'POST', FLEET_LIFECYCLE_API_PATH, {
      operation: 'add', companion: entry(NOVA, 'nova'),
    });
    writeFileSync(manifestPath, before.replace('"companion_flagship"', '"companion_flagship_v2"'));
    const stale = await call(target, 'POST', `${FLEET_LIFECYCLE_API_PATH}/${planned.body.planId as string}/apply`, {
      planDigest: planned.body.digest, resume: false, confirmCompanionId: NOVA,
    });
    expect(stale).toMatchObject({ status: 409, body: { error: { type: 'stale_topology' } } });
    expect(tenantChecks).toBe(0);
  });

  it('serves progress but refuses apply where only the CLI may apply', async () => {
    const target = routes(service('cli_only'));
    const planned = await call(target, 'POST', FLEET_LIFECYCLE_API_PATH, {
      operation: 'add', companion: entry(NOVA, 'nova'),
    });
    const refused = await call(target, 'POST', `${FLEET_LIFECYCLE_API_PATH}/${planned.body.planId as string}/apply`, {
      planDigest: planned.body.digest, resume: false, confirmCompanionId: NOVA,
    });
    expect(refused).toMatchObject({ status: 409, body: { error: { type: 'apply_requires_cli' } } });
    expect(readFileSync(manifestPath, 'utf8')).not.toContain(NOVA);
  });

  it('rejects secret-shaped and malformed bodies', async () => {
    const target = routes();
    const secretValued = await call(target, 'POST', FLEET_LIFECYCLE_API_PATH, {
      operation: 'add', companion: { ...entry(NOVA, 'nova'), postgresDatabaseUrlRef: 'postgres://u:p@h/d' },
    });
    expect(secretValued).toMatchObject({ status: 400, body: { error: { type: 'invalid_request' } } });
    const widened = await call(target, 'POST', `${FLEET_LIFECYCLE_API_PATH}/${NOVA}/apply`, {
      planDigest: 'a'.repeat(64), resume: false, confirmCompanionId: NOVA, force: true,
    });
    expect(widened.status).toBe(400);
    const unknown = await call(target, 'GET', `${FLEET_LIFECYCLE_API_PATH}/${NOVA}`);
    expect(unknown).toMatchObject({ status: 404, body: { error: { type: 'plan_not_found' } } });
  });
});
