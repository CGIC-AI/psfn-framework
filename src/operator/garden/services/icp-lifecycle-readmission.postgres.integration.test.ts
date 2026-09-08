import type { IncomingMessage, ServerResponse } from 'node:http';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  IcpAutonomyInvalidationConflictError,
  type IcpSharedAutonomyStorePort,
} from '../../../core/icp/autonomy-store-ports.js';
import { createIcpAutonomyRuntimeEnablement } from '../../../core/icp/runtime-enablement.js';
import { createPostgresPool } from '../../../persistence/postgres.js';
import { PostgresIcpSharedAutonomyStore } from '../../../persistence/postgres/icp-shared-autonomy-store.js';
import { bootstrapSharedSchema } from '../../../persistence/postgres/shared-schema.js';
import type { IcpAdminProjectionStore } from '../../../persistence/postgres/icp-admin-projection-store.js';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import type { GardenRequestContext } from '../garden-request-context.js';
import { buildAdminIcpAutonomyRoutes } from '../routes/icp-autonomy-routes.js';
import type {
  AdminApiRoute,
  AdminAuditTimelineAppender,
  AdminBodyReader,
} from '../routes/types.js';
import { AdminIcpAutonomyDataService } from './icp-autonomy-service.js';
import type { AdminSettingsService } from './types/settings.js';

const TIMEOUT_MS = 120_000;
const READMIT_PATH = '/api/admin/icp-autonomy/lifecycle/readmit';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
// The shared control plane is a fleet primitive: it refuses to open against
// fewer than two companions. C keeps the shrunken manifest a real fleet, so the
// departure this test exercises is B leaving — not the fleet collapsing.
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CHANNEL = `companion-dm:${A}:${B}`;
const CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';
const CANDIDATE_ID = '11111111-1111-4111-8111-111111111111';
const PERMIT_ID = '44444444-4444-4444-8444-444444444444';
const SECOND_CONVERSATION_ID = '55555555-5555-4555-8555-555555555555';
const SECOND_CANDIDATE_ID = '77777777-7777-4777-8777-777777777777';
const SECOND_PERMIT_ID = '66666666-6666-4666-8666-666666666666';

/**
 * The authenticated caller the Garden dispatcher hands the route. Readmission
 * is a fence-clearing act, so its durable audit row has to name this principal
 * rather than the generic 'operator' actor class.
 */
const OPERATOR_CONTEXT = {
  kind: 'fleet_principal',
  actor: {
    kind: 'fleet_principal',
    principalId: 'operator-mira',
    role: 'admin',
    sessionRecordId: 'session-readmit-1',
  },
  action: 'autonomy.manage',
  requestId: 'request-readmit-1',
  decisionId: 'decision-readmit-1',
  resource: {
    routeId: `POST ${READMIT_PATH}`,
    scope: 'system',
    area: 'autonomy',
    companionId: null,
    pathParams: {},
    query: {},
  },
} as unknown as GardenRequestContext;

let harness: PostgresTestHarness | null = null;
/** Request body the shared `withBody` reader replays into the route handler. */
let pendingBody = '{}';

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
}, TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
  harness = null;
}, TIMEOUT_MS);

async function freshDatabaseUrl(): Promise<string> {
  if (!harness) throw new Error('Postgres integration harness is unavailable');
  const databaseUrl = (await harness.createDatabase()).databaseUrl;
  await bootstrapSharedSchema(databaseUrl);
  return databaseUrl;
}

function episodeAndPermit(input: {
  conversationId: string;
  candidateId: string;
  permitId: string;
  issuedAtMs: number;
}) {
  return {
    episode: {
      conversationId: input.conversationId,
      channelId: CHANNEL,
      participantCompanionIds: [A, B],
      rootInitiationId: input.candidateId,
      initiatedByCompanionId: A,
      initiationSource: 'foreground' as const,
      provenanceRef: `icp-prov:${input.candidateId}`,
      openedAtMs: input.issuedAtMs,
      lastActivityAtMs: input.issuedAtMs,
      status: 'invited' as const,
      revision: 1,
    },
    permit: {
      permitId: input.permitId,
      candidateId: input.candidateId,
      conversationId: input.conversationId,
      senderCompanionId: A,
      recipientCompanionId: B,
      channelId: CHANNEL,
      provenanceRef: `icp-prov:${input.candidateId}`,
      issuedAtMs: input.issuedAtMs,
      expiresAtMs: 900_000,
      status: 'issued' as const,
      revision: 1,
    },
  };
}

/**
 * The readmission surface touches only the shared control plane, so the Garden
 * projection wrapper carries the REAL Postgres shared store and an empty bounded
 * projection. Nothing here stubs the fence: every admission read and write in
 * this file goes to the live database.
 */
function projectionStore(shared: IcpSharedAutonomyStorePort): IcpAdminProjectionStore {
  return {
    localCompanionId: A,
    shared,
    readProjection: async () => ({
      availability: [],
      dyads: [],
      episodes: [],
      permits: [],
      fatigue: [],
      costs: [],
      costProjection: { available: true, unavailableReason: null },
    }),
    close: async () => { /* the test owns the shared store lifecycle */ },
  };
}

function settingsService(): AdminSettingsService {
  const value = {
    enabled: true,
    candidate: { defaultTtlMs: 1, retryCadenceMs: 1, maxRetryAttempts: 1 },
    permit: { ttlMs: 1 },
    availability: { operatorLeaseTtlMs: 1_000 },
  };
  return {
    getSettingsData: vi.fn(async () => ({
      effectiveIcpAutonomy: {
        scheduler: {
          ownerFile: 'scheduler.json',
          effectiveValue: value,
          onDiskValue: value,
          restartRequired: false,
        },
        chargePolicy: {
          ownerFile: 'charge-policy.json',
          effectiveValue: null,
          onDiskValue: {} as never,
          restartRequired: false,
        },
      },
    })) as never,
  } as unknown as AdminSettingsService;
}

class CapturingResponse {
  statusCode = 0;
  body = '';
  readonly done: Promise<void>;
  private resolveDone: () => void = () => undefined;

  constructor() {
    this.done = new Promise(resolve => { this.resolveDone = resolve; });
  }

  writeHead(statusCode: number): this {
    this.statusCode = statusCode;
    return this;
  }

  setHeader(): void { /* headers are not asserted here */ }

  end(chunk?: string): void {
    this.body = chunk ?? '';
    this.resolveDone();
  }
}

/**
 * The operator's Garden as one fleet manifest sees it: the real route stack over
 * the real service over the real Postgres shared store. `manifestCompanionIds`
 * is exactly what the process resolved from companions.json at boot.
 */
function operatorGarden(
  shared: IcpSharedAutonomyStorePort,
  manifestCompanionIds: readonly string[],
): {
  routes: AdminApiRoute[];
  service: AdminIcpAutonomyDataService;
  auditCalls: Parameters<AdminAuditTimelineAppender>[];
} {
  const service = new AdminIcpAutonomyDataService({
    localCompanionId: A,
    projectionStore: projectionStore(shared),
    runtimeEnablement: createIcpAutonomyRuntimeEnablement(true),
    settingsService: settingsService(),
    operatorLeaseTtlMs: 1_000,
    fleetCompanionIds: manifestCompanionIds,
    now: () => 100_000,
  });
  const withBody: AdminBodyReader = (_req, _res, callback) => {
    callback(pendingBody);
  };
  const auditCalls: Parameters<AdminAuditTimelineAppender>[] = [];
  const appendAuditTimelineEntry: AdminAuditTimelineAppender = (...call) => {
    auditCalls.push(call);
  };
  return {
    service,
    auditCalls,
    routes: buildAdminIcpAutonomyRoutes({ service, withBody, appendAuditTimelineEntry }),
  };
}

async function postReadmit(
  routes: readonly AdminApiRoute[],
  body: unknown,
  context: GardenRequestContext | null = OPERATOR_CONTEXT,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  pendingBody = JSON.stringify(body);
  const route = routes.find(candidate => candidate.method === 'POST'
    && candidate.match(READMIT_PATH));
  if (!route) throw new Error(`readmission route not found: POST ${READMIT_PATH}`);
  const res = new CapturingResponse();
  route.handle(
    { headers: {} } as IncomingMessage,
    res as unknown as ServerResponse,
    route.match(READMIT_PATH) ?? {},
    context ?? undefined,
  );
  await res.done;
  return {
    status: res.statusCode,
    payload: JSON.parse(res.body) as Record<string, unknown>,
  };
}

async function readPermitReasonCodes(databaseUrl: string): Promise<string[]> {
  const pool = createPostgresPool(databaseUrl, { max: 1, allowExitOnIdle: true });
  try {
    const result = await pool.query<{ reason_code: string | null }>(`
      SELECT reason_code FROM shared.icp_initiation_permits
      WHERE status = 'revoked' ORDER BY permit_id
    `);
    return result.rows.map(row => row.reason_code ?? 'null');
  } finally {
    await pool.end();
  }
}

describe('explicit operator readmission of a lifecycle-fenced companion (psfn-framework-2vd7s)', () => {
  it('refuses permits until the operator readmits an on-manifest companion', async () => {
    const databaseUrl = await freshDatabaseUrl();

    // 1. The full fleet: A and B are on companions.json and permits issue.
    const full = await PostgresIcpSharedAutonomyStore.connect(databaseUrl, {
      knownCompanionIds: [A, B, C],
    });
    try {
      await expect(full.createEpisodeAndIssuePermit({
        ...episodeAndPermit({
          conversationId: CONVERSATION_ID,
          candidateId: CANDIDATE_ID,
          permitId: PERMIT_ID,
          issuedAtMs: 1_000,
        }),
        expectedInvalidationFence: await full.captureInvalidationFence(A, B),
      })).resolves.toMatchObject({ permit: { permitId: PERMIT_ID, status: 'issued' } });
    } finally {
      await full.close();
    }

    // 2. B is removed from companions.json. The next gateway start sweeps it
    //    outside the fleet and fences its admission durably.
    const shrunk = await PostgresIcpSharedAutonomyStore.connect(databaseUrl, {
      knownCompanionIds: [A, C],
    });
    try {
      await expect(shrunk.isLifecycleAdmissionFenced(B)).resolves.toBe(true);
    } finally {
      await shrunk.close();
    }

    // 3. B is added back to companions.json and the gateway restarts. Booting
    //    readmits nothing: permits for B still refuse against a fence captured
    //    a microsecond ago.
    const readded = await PostgresIcpSharedAutonomyStore.connect(databaseUrl, {
      knownCompanionIds: [A, B, C],
    });
    try {
      await expect(readded.isLifecycleAdmissionFenced(B)).resolves.toBe(true);
      await expect(readded.createEpisodeAndIssuePermit({
        ...episodeAndPermit({
          conversationId: SECOND_CONVERSATION_ID,
          candidateId: SECOND_CANDIDATE_ID,
          permitId: SECOND_PERMIT_ID,
          issuedAtMs: 2_000,
        }),
        expectedInvalidationFence: await readded.captureInvalidationFence(A, B),
      })).rejects.toBeInstanceOf(IcpAutonomyInvalidationConflictError);

      // 4. A Garden still running the SHRUNK manifest refuses the readmission
      //    with a legible reason, and the durable fence is untouched.
      const offManifest = operatorGarden(readded, [A, C]);
      const refused = await postReadmit(offManifest.routes, {
        companionId: B,
        confirmCompanionId: B,
      });
      expect(refused.status).toBe(409);
      expect(refused.payload).toMatchObject({ refusal: 'companion_not_on_manifest' });
      await expect(readded.isLifecycleAdmissionFenced(B)).resolves.toBe(true);

      // 5. On the CURRENT manifest, a body without the explicit echoed
      //    confirmation is still refused, and still changes nothing.
      const garden = operatorGarden(readded, [A, B, C]);
      const blind = await postReadmit(garden.routes, { companionId: B });
      expect(blind.status).toBe(400);
      const mismatched = await postReadmit(garden.routes, {
        companionId: B,
        confirmCompanionId: A,
      });
      expect(mismatched.status).toBe(400);
      await expect(readded.isLifecycleAdmissionFenced(B)).resolves.toBe(true);

      // The Garden shows the operator exactly which manifest companion is
      // fenced before they act.
      await expect(garden.service.getData()).resolves.toMatchObject({
        lifecycleAdmission: [
          { companionId: A, local: true, fenced: false },
          { companionId: B, local: false, fenced: true },
          { companionId: C, local: false, fenced: false },
        ],
      });

      // 6. The explicit, audited readmission clears the durable fence exactly
      //    once and revokes nothing that was not already revoked.
      const readmitted = await postReadmit(garden.routes, {
        companionId: B,
        confirmCompanionId: B,
      });
      expect(readmitted.status).toBe(200);
      expect(readmitted.payload).toMatchObject({
        ok: true,
        companionId: B,
        transitioned: true,
      });
      await expect(readded.isLifecycleAdmissionFenced(B)).resolves.toBe(false);

      // Idempotent: a second readmission transitions nothing.
      const repeated = await postReadmit(garden.routes, {
        companionId: B,
        confirmCompanionId: B,
      });
      expect(repeated.status).toBe(200);
      expect(repeated.payload).toMatchObject({ transitioned: false });

      // The durable audit names the principal and session that cleared the
      // fence, not just that "an operator" did.
      const readmitAudit = garden.auditCalls.find(([actionType, decision, narrative]) => (
        actionType === 'autonomy_control'
        && decision === 'allowed'
        && narrative.includes('readmitted a lifecycle-fenced companion')
      ));
      expect(readmitAudit?.[4]).toBe('operator');
      expect(readmitAudit?.[5]).toMatchObject({
        kind: 'fleet_principal',
        actor: { principalId: 'operator-mira', sessionRecordId: 'session-readmit-1' },
      });

      // An unattributable call is refused before it can touch the fence, and
      // never lands in the timeline as a generic operator act.
      const auditsBefore = garden.auditCalls.length;
      const unattributed = await postReadmit(garden.routes, {
        companionId: B,
        confirmCompanionId: B,
      }, null);
      expect(unattributed.status).toBe(403);
      expect(garden.auditCalls.length).toBe(auditsBefore);

      // 7. Permits issue again for the readmitted companion.
      await expect(readded.createEpisodeAndIssuePermit({
        ...episodeAndPermit({
          conversationId: SECOND_CONVERSATION_ID,
          candidateId: SECOND_CANDIDATE_ID,
          permitId: SECOND_PERMIT_ID,
          issuedAtMs: 3_000,
        }),
        expectedInvalidationFence: await readded.captureInvalidationFence(A, B),
      })).resolves.toMatchObject({ permit: { permitId: SECOND_PERMIT_ID, status: 'issued' } });

      await expect(garden.service.getData()).resolves.toMatchObject({
        lifecycleAdmission: [
          { companionId: A, local: true, fenced: false },
          { companionId: B, local: false, fenced: false },
          { companionId: C, local: false, fenced: false },
        ],
      });
    } finally {
      await readded.close();
    }

    // The permit the removal revoked carries the departure reason; readmission
    // never relabels it as an operator cancellation.
    await expect(readPermitReasonCodes(databaseUrl)).resolves.toEqual(['unknown_participant']);
  }, TIMEOUT_MS);
});
