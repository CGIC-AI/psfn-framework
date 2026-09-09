// ── Cross-process Garden observability over two tenant scopes (bead
// psfn-framework-e5r0s) ──
//
// The fault this proves is gone: in a fleet, the gateway persists its
// observations into one pool scope and each companion's Garden reads another,
// so a Postgres pool storm the gateway saw, and the escalation it raised, were
// visible on no operator surface at all. The gateway now writes its
// system-owned rows into the shared schema, and both companions read them
// beside their own.
//
// Real Postgres and real schemas throughout: two companion schemas plus the
// shared one, three separately-pinned pools. A mock cannot fail the way the
// production bug failed, because the bug WAS the schema boundary.

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPostgresPool,
  quotePostgresSchemaName,
} from '../postgres.js';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { bootstrapSharedSchema } from './shared-schema.js';
import { PostgresHealthEventStore } from './health-event-store.js';
import { PostgresHumanEscalationStore } from './human-escalation-store.js';
import { AdminIncidentTimelineDataService } from '../../operator/garden/services/incident-timeline-service.js';
import { AdminHumanEscalationDataService } from '../../operator/garden/services/human-escalation-service.js';
import {
  DEFAULT_HEALTH_DETECTORS_CONFIG,
} from '../../system/config/scheduler-config/health-detectors.js';
import {
  DEFAULT_HUMAN_ESCALATION_CONFIG,
} from '../../system/config/scheduler-config/human-escalation.js';
import {
  createHealthEvent,
  processObserverId,
  stableHealthConditionCorrelationId,
  type HealthEventInput,
} from '../../shared/contracts/health-event.js';
import type { HumanEscalationFacts } from '../../shared/escalation/contracts.js';

const INTEGRATION_TIMEOUT_MS = 120_000;
const NOW_MS = 1_800_000_000_000;
const MAX_ROWS = 500;
const COMPANION_A = '11111111-1111-4111-8111-111111111111';
const COMPANION_B = '22222222-2222-4222-8222-222222222222';
const SCHEMA_A = 'companion_a';
const SCHEMA_B = 'companion_b';

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  if (harness) await harness.stop();
  harness = null;
}, INTEGRATION_TIMEOUT_MS);

function tenantPool(databaseUrl: string, schema: string): Pool {
  return createPostgresPool(databaseUrl, {
    applicationName: `fleet-observability-${schema}`,
    allowExitOnIdle: true,
    schema,
    max: 2,
  });
}

function healthEvent(overrides: Partial<HealthEventInput>) {
  return createHealthEvent({
    owner: { kind: 'system' },
    severity: 'degraded',
    code: 'postgres_pool_pressure_opened',
    provenance: {
      process: 'gateway',
      component: 'persistence',
      observerId: processObserverId(),
    },
    observedAtMs: NOW_MS,
    evidence: { saturationPercent: 97 },
    ...overrides,
  });
}

function escalationFacts(overrides: Partial<HumanEscalationFacts> = {}): HumanEscalationFacts {
  return {
    kind: 'runtime_incident',
    severity: 'critical',
    owner: { kind: 'system' },
    dedupeKey: 'gateway-incident',
    sourceRef: 'gateway-incident',
    labels: ['postgres_pool_pressure_opened'],
    evidence: { saturationPercent: 97 },
    detailPath: '/subsystem-health',
    raisedAtMs: NOW_MS,
    ...overrides,
  };
}

interface FleetFixture {
  databaseUrl: string;
  pools: Pool[];
}

async function fleet(): Promise<FleetFixture> {
  if (!harness) throw new Error('postgres harness not started');
  const { databaseUrl } = await harness.createDatabase();
  const bootstrap = createPostgresPool(databaseUrl, {
    applicationName: 'fleet-observability-bootstrap',
    allowExitOnIdle: true,
    max: 1,
  });
  try {
    for (const schema of [SCHEMA_A, SCHEMA_B]) {
      await bootstrap.query(`CREATE SCHEMA ${quotePostgresSchemaName(schema)}`);
    }
  } finally {
    await bootstrap.end();
  }
  // The gateway's shared-schema migration authority, exactly as production runs
  // it: version 21 installs the fleet's system-owned tables.
  await bootstrapSharedSchema(databaseUrl);
  return { databaseUrl, pools: [] };
}

async function closeAll(fixture: FleetFixture): Promise<void> {
  await Promise.all(fixture.pools.map(pool => pool.end().catch(() => undefined)));
}

describe('fleet system observability across two tenant pool scopes', () => {
  it('shows one gateway incident in both companions, under the id the alert carried', async () => {
    const fixture = await fleet();
    try {
      // The gateway, writing where a fleet can read it — under the write
      // contract, so the readiness proof covers the statements it runs.
      const gatewayStream = await PostgresHealthEventStore.connectShared(
        fixture.databaseUrl,
        MAX_ROWS,
        { access: 'write' },
      );
      const correlationId = stableHealthConditionCorrelationId(
        'operator_alert_sinks_unconfigured',
        { kind: 'system' },
      );
      await gatewayStream.record(healthEvent({ correlationId }));
      await gatewayStream.close();

      for (const [schema, companionId] of [
        [SCHEMA_A, COMPANION_A],
        [SCHEMA_B, COMPANION_B],
      ] as const) {
        const tenant = tenantPool(fixture.databaseUrl, schema);
        fixture.pools.push(tenant);
        const companionStream = await PostgresHealthEventStore.fromPool(tenant, MAX_ROWS);
        const fleetStream = await PostgresHealthEventStore.connectShared(
          fixture.databaseUrl,
          MAX_ROWS,
        );
        fixture.pools.push({ end: () => fleetStream.close() } as unknown as Pool);
        const timeline = new AdminIncidentTimelineDataService({
          readStream: query => companionStream.listRecent(query),
          fleetSystemReadStream: query => fleetStream.listRecent(query),
          config: () => DEFAULT_HEALTH_DETECTORS_CONFIG,
          companionId,
          now: () => NOW_MS,
        });

        const snapshot = await timeline.getSnapshot();

        expect(snapshot.scope.streams).toEqual(['companion', 'fleet_system']);
        // Same correlation id the alert carried — not a re-derived one.
        expect(snapshot.incidents.map(incident => incident.incidentId))
          .toEqual([correlationId]);
      }
    } finally {
      await closeAll(fixture);
    }
  });

  it('never carries one companion\'s incidents onto another companion\'s page', async () => {
    const fixture = await fleet();
    try {
      const tenantA = tenantPool(fixture.databaseUrl, SCHEMA_A);
      const tenantB = tenantPool(fixture.databaseUrl, SCHEMA_B);
      fixture.pools.push(tenantA, tenantB);
      const streamA = await PostgresHealthEventStore.fromPool(tenantA, MAX_ROWS);
      const streamB = await PostgresHealthEventStore.fromPool(tenantB, MAX_ROWS);
      await streamA.record(healthEvent({
        owner: { kind: 'companion', companionId: COMPANION_A as never },
        provenance: {
          process: 'agent',
          component: 'persistence',
          observerId: processObserverId(),
        },
      }));

      const fleetStream = await PostgresHealthEventStore.connectShared(
        fixture.databaseUrl,
        MAX_ROWS,
      );
      const timelineB = new AdminIncidentTimelineDataService({
        readStream: query => streamB.listRecent(query),
        fleetSystemReadStream: query => fleetStream.listRecent(query),
        config: () => DEFAULT_HEALTH_DETECTORS_CONFIG,
        companionId: COMPANION_B,
        now: () => NOW_MS,
      });

      const snapshot = await timelineB.getSnapshot();

      expect(snapshot.incidents).toEqual([]);
      await fleetStream.close();
    } finally {
      await closeAll(fixture);
    }
  });

  it('lets each companion answer the gateway\'s escalation on its own Garden', async () => {
    const fixture = await fleet();
    try {
      const gatewayLedger = await PostgresHumanEscalationStore.connectShared(
        fixture.databaseUrl,
        { access: 'raise', bounds: DEFAULT_HUMAN_ESCALATION_CONFIG.retention },
      );
      const raised = await gatewayLedger.openOrReopen(escalationFacts());
      await gatewayLedger.close();

      const tenantA = tenantPool(fixture.databaseUrl, SCHEMA_A);
      const tenantB = tenantPool(fixture.databaseUrl, SCHEMA_B);
      fixture.pools.push(tenantA, tenantB);
      const companionLedgerA = await PostgresHumanEscalationStore.fromPool(tenantA, {
        bounds: DEFAULT_HUMAN_ESCALATION_CONFIG.retention,
      });
      const companionLedgerB = await PostgresHumanEscalationStore.fromPool(tenantB, {
        bounds: DEFAULT_HUMAN_ESCALATION_CONFIG.retention,
      });
      // Each companion also has an escalation of its own, so the merged view is
      // proved to be a merge rather than a substitution.
      await companionLedgerA.openOrReopen(escalationFacts({
        kind: 'cogsec_quarantine',
        owner: { kind: 'companion', companionId: COMPANION_A as never },
        dedupeKey: 'quarantine-a',
        sourceRef: 'quarantine-a',
        labels: ['quarantine'],
        detailPath: '/cognitive-security',
      }));

      const fleetLedgerA = await PostgresHumanEscalationStore.connectShared(
        fixture.databaseUrl,
        { bounds: DEFAULT_HUMAN_ESCALATION_CONFIG.retention },
      );
      const fleetLedgerB = await PostgresHumanEscalationStore.connectShared(
        fixture.databaseUrl,
        { bounds: DEFAULT_HUMAN_ESCALATION_CONFIG.retention },
      );
      const gardenA = new AdminHumanEscalationDataService({
        ledger: companionLedgerA,
        fleetSystemLedger: fleetLedgerA,
        config: () => DEFAULT_HUMAN_ESCALATION_CONFIG,
        companionId: COMPANION_A,
        now: () => NOW_MS,
      });
      const gardenB = new AdminHumanEscalationDataService({
        ledger: companionLedgerB,
        fleetSystemLedger: fleetLedgerB,
        config: () => DEFAULT_HUMAN_ESCALATION_CONFIG,
        companionId: COMPANION_B,
        now: () => NOW_MS,
      });

      const beforeA = await gardenA.getSnapshot(['open']);
      const beforeB = await gardenB.getSnapshot(['open']);
      expect(beforeA.scope.ledgers).toEqual(['companion', 'fleet_system']);
      expect(beforeA.escalations.map(row => row.dedupeKey).sort())
        .toEqual(['gateway-incident', 'quarantine-a']);
      // B sees the gateway's escalation and NOT A's quarantine.
      expect(beforeB.escalations.map(row => row.dedupeKey)).toEqual(['gateway-incident']);
      expect(beforeA.counts.open).toBe(2);

      // The point of the whole seam: a companion's operator answers a fault the
      // gateway saw, and the answer lands in the shared ledger.
      const resolved = await gardenB.resolve({
        escalationId: raised.escalationId,
        state: 'resolved',
        reason: 'handled',
        actor: 'operator',
      });

      expect(resolved).toMatchObject({ ok: true, record: { state: 'resolved' } });
      const afterA = await gardenA.getSnapshot(['open']);
      expect(afterA.escalations.map(row => row.dedupeKey)).toEqual(['quarantine-a']);

      await Promise.all([fleetLedgerA.close(), fleetLedgerB.close()]);
    } finally {
      await closeAll(fixture);
    }
  });
});

// ── The shared readiness proof covers the writes each path makes
// (bead psfn-framework-2xt9c) ──
//
// `connectShared` could only ever ask for SELECT and UPDATE, so a credential
// with read-only DML on the shared schema opened both stores cleanly and then
// lost every observation the gateway made — a fire-and-forget write, a logged
// catch, and no operator surface any the wiser. It was masked because the sole
// provisioning path grants all four privileges; that is what kept it invisible,
// not what made it safe. Real roles and real GRANTs here: a mock cannot fail
// the way a narrowed grant fails.
async function grantSharedAccess(
  databaseUrl: string,
  role: string,
  grants: ReadonlyArray<{ relation: string; privileges: string }>,
): Promise<void> {
  const admin = createPostgresPool(databaseUrl, {
    applicationName: 'fleet-observability-grants',
    allowExitOnIdle: true,
    max: 1,
  });
  try {
    await admin.query(`CREATE ROLE ${role} NOLOGIN`);
    await admin.query(`GRANT USAGE ON SCHEMA shared TO ${role}`);
    // Every shared store proves the migration chain before its own relations,
    // so the ledger read is table stakes for any credential here.
    await admin.query(`GRANT SELECT ON shared.shared_schema_migrations TO ${role}`);
    for (const grant of grants) {
      await admin.query(`GRANT ${grant.privileges} ON shared.${grant.relation} TO ${role}`);
    }
  } finally {
    await admin.end();
  }
}

describe('shared observability readiness proves the privileges each path uses', () => {
  it('refuses the health-stream write path a credential that can only read', async () => {
    const fixture = await fleet();
    const role = 'fleet_health_reader';
    try {
      await grantSharedAccess(fixture.databaseUrl, role, [
        { relation: 'runtime_health_events', privileges: 'SELECT' },
      ]);

      // The read path is genuinely satisfied by this grant...
      const reader = await PostgresHealthEventStore.connectShared(
        fixture.databaseUrl,
        MAX_ROWS,
        { role, access: 'read' },
      );
      await expect(reader.listRecent({ limit: 1 })).resolves.toEqual([]);
      await reader.close();

      // ...and the write path is not, because `record` inserts and its ring
      // deletes. This used to open, and fail later, once, into a log line.
      await expect(PostgresHealthEventStore.connectShared(
        fixture.databaseUrl,
        MAX_ROWS,
        { role, access: 'write' },
      )).rejects.toThrow(/missing required role privileges: INSERT, DELETE/u);
    } finally {
      await closeAll(fixture);
    }
  }, INTEGRATION_TIMEOUT_MS);

  it('requires the answer path the DELETE its own retention ring runs', async () => {
    const fixture = await fleet();
    const role = 'fleet_escalation_answerer';
    try {
      // Exactly the privileges the shared ledger used to demand of a Garden.
      await grantSharedAccess(fixture.databaseUrl, role, [
        { relation: 'human_escalations', privileges: 'SELECT, UPDATE' },
        { relation: 'human_escalation_attempts', privileges: 'SELECT' },
      ]);

      await expect(PostgresHumanEscalationStore.connectShared(fixture.databaseUrl, {
        role,
        access: 'answer',
        bounds: DEFAULT_HUMAN_ESCALATION_CONFIG.retention,
      })).rejects.toThrow(/missing required role privileges: DELETE/u);

      const admin = createPostgresPool(fixture.databaseUrl, {
        applicationName: 'fleet-observability-grants',
        allowExitOnIdle: true,
        max: 1,
      });
      try {
        await admin.query(`GRANT DELETE ON shared.human_escalations TO ${role}`);
      } finally {
        await admin.end();
      }

      const answerer = await PostgresHumanEscalationStore.connectShared(fixture.databaseUrl, {
        role,
        access: 'answer',
        bounds: DEFAULT_HUMAN_ESCALATION_CONFIG.retention,
      });
      await expect(answerer.list({ limit: 1 })).resolves.toEqual([]);
      await answerer.close();

      // The raise path still is not satisfied: a Garden answers, it does not
      // file the fleet's questions.
      await expect(PostgresHumanEscalationStore.connectShared(fixture.databaseUrl, {
        role,
        access: 'raise',
        bounds: DEFAULT_HUMAN_ESCALATION_CONFIG.retention,
      })).rejects.toThrow(/missing required role privileges: INSERT/u);
    } finally {
      await closeAll(fixture);
    }
  }, INTEGRATION_TIMEOUT_MS);

  it('admits the fully granted fleet credential on every shared contract', async () => {
    const fixture = await fleet();
    const role = 'fleet_full_runtime';
    try {
      await grantSharedAccess(fixture.databaseUrl, role, [
        { relation: 'runtime_health_events', privileges: 'SELECT, INSERT, UPDATE, DELETE' },
        { relation: 'human_escalations', privileges: 'SELECT, INSERT, UPDATE, DELETE' },
        { relation: 'human_escalation_attempts', privileges: 'SELECT, INSERT, UPDATE, DELETE' },
      ]);

      const stream = await PostgresHealthEventStore.connectShared(
        fixture.databaseUrl,
        MAX_ROWS,
        { role, access: 'write' },
      );
      await stream.record(healthEvent({}));
      expect(await stream.listRecent({ limit: 5 })).toHaveLength(1);
      await stream.close();

      const ledger = await PostgresHumanEscalationStore.connectShared(fixture.databaseUrl, {
        role,
        access: 'raise',
        bounds: DEFAULT_HUMAN_ESCALATION_CONFIG.retention,
      });
      const raised = await ledger.openOrReopen(escalationFacts());
      expect(raised.state).toBe('open');
      await ledger.close();
    } finally {
      await closeAll(fixture);
    }
  }, INTEGRATION_TIMEOUT_MS);

  it('accepts companion-owned escalations on the fleet-wide ledger', async () => {
    const fixture = await fleet();
    try {
      const gatewayLedger = await PostgresHumanEscalationStore.connectShared(
        fixture.databaseUrl,
        { access: 'raise', bounds: DEFAULT_HUMAN_ESCALATION_CONFIG.retention },
      );
      try {
        // The fleet gateway files companion-owned questions here too — a
        // pending confirmation or a quarantine hold names the companion it
        // concerns — and the Garden fence (system rows plus the reader's own
        // companion) is what keeps them off the wrong operator surface. A
        // store-level refusal broke that producer on kube-test
        // (psfn-framework-2xt9c follow-up), so the ledger accepts both owners.
        await expect(gatewayLedger.openOrReopen(escalationFacts({
          owner: { kind: 'companion', companionId: COMPANION_A as never },
          dedupeKey: 'companion-owned',
        }))).resolves.toMatchObject({
          owner: { kind: 'companion', companionId: COMPANION_A },
        });
        await expect(gatewayLedger.openOrReopen(escalationFacts({
          dedupeKey: 'system-owned',
        }))).resolves.toMatchObject({ owner: { kind: 'system' } });
      } finally {
        await gatewayLedger.close();
      }

      // A companion's own tenant ledger is unaffected: it is exactly where a
      // companion-owned escalation belongs.
      const tenant = tenantPool(fixture.databaseUrl, SCHEMA_A);
      fixture.pools.push(tenant);
      const companionLedger = await PostgresHumanEscalationStore.fromPool(tenant, {
        bounds: DEFAULT_HUMAN_ESCALATION_CONFIG.retention,
      });
      await expect(companionLedger.openOrReopen(escalationFacts({
        owner: { kind: 'companion', companionId: COMPANION_A as never },
        dedupeKey: 'companion-owned',
      }))).resolves.toMatchObject({ owner: { kind: 'companion' } });
    } finally {
      await closeAll(fixture);
    }
  }, INTEGRATION_TIMEOUT_MS);
});
