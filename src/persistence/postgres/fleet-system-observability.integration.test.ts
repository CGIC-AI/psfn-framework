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
      // The gateway, writing where a fleet can read it.
      const gatewayStream = await PostgresHealthEventStore.connectShared(
        fixture.databaseUrl,
        MAX_ROWS,
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
        { bounds: DEFAULT_HUMAN_ESCALATION_CONFIG.retention },
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
