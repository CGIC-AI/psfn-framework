import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { createPostgresPool } from '../postgres.js';
import { PostgresIcpInitiationCandidateStore } from './icp-initiation-candidate-store.js';
import { PostgresIcpFeltImpulseFunnelStore } from './icp-felt-impulse-funnel-store.js';

const TIMEOUT_MS = 120_000;
const SCHEMA = 'companion_funnel';
const LOCAL_ID = '11111111-1111-4111-8111-111111111111';
const PEER_ID = '22222222-2222-4222-8222-222222222222';
const CANDIDATE_ID = '33333333-3333-4333-8333-333333333333';
const PERMIT_ID = '44444444-4444-4444-8444-444444444444';
const T0 = Date.parse('2026-08-17T00:00:00.000Z');

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
}, TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
  harness = null;
}, TIMEOUT_MS);

describe('Postgres felt-impulse funnel outcomes', () => {
  it('preserves exactly-once content-free outcomes and candidate lifecycle across restart', async () => {
    if (!harness) throw new Error('Postgres integration harness is unavailable');
    const { databaseUrl } = await harness.createDatabase();
    const bootstrap = createPostgresPool(databaseUrl, {
      applicationName: 'icp-felt-impulse-funnel-bootstrap',
      allowExitOnIdle: true,
    });
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();

    const candidates = await PostgresIcpInitiationCandidateStore.connect(databaseUrl, {
      schema: SCHEMA,
    });
    let funnel = await PostgresIcpFeltImpulseFunnelStore.connect(databaseUrl, {
      schema: SCHEMA,
    });
    try {
      const noPeer = {
        correlationId: `felt-impulse:would_message:${T0}`,
        firedAtMs: T0,
        recordedAtMs: T0 + 10,
        outcome: 'no_eligible_peer' as const,
      };
      await expect(funnel.recordOutcome(noPeer)).resolves.toEqual(noPeer);
      await expect(funnel.recordOutcome({
        ...noPeer,
        correlationId: `felt-impulse:would_message:${T0 + 1}`,
      })).rejects.toThrow('must encode firedAtMs');
      await expect(funnel.recordOutcome({
        ...noPeer,
        recordedAtMs: T0 + 20,
        outcome: 'not_authorized',
      })).resolves.toEqual(noPeer);
      const notAuthorized = {
        correlationId: `felt-impulse:would_message:${T0 + 100}`,
        firedAtMs: T0 + 100,
        recordedAtMs: T0 + 110,
        outcome: 'not_authorized' as const,
      };
      const throttled = {
        correlationId: `felt-impulse:would_message:${T0 + 200}`,
        firedAtMs: T0 + 200,
        recordedAtMs: T0 + 210,
        outcome: 'throttled' as const,
        nextEligibleAtMs: T0 + 60_000,
      };
      await funnel.recordOutcome(notAuthorized);
      await funnel.recordOutcome(throttled);

      const pending = await candidates.createCandidate({
        candidateId: CANDIDATE_ID,
        rootInitiationId: CANDIDATE_ID,
        localCompanionId: LOCAL_ID,
        peerContactId: 'private-contact-id',
        peerCompanionId: PEER_ID,
        preferredChannel: 'dm',
        source: 'felt_impulse',
        provenanceRef: 'icp-prov:55555555-5555-4555-8555-555555555555',
        reasonSummary: 'private motivation must remain outside the funnel',
        createdAtMs: T0,
        expiresAtMs: T0 + 60_000,
        status: 'pending',
        revision: 1,
      });
      const permitted = await candidates.transitionCandidate({
        candidateId: pending.candidateId,
        expectedStatus: pending.status,
        expectedRevision: pending.revision,
        status: 'permitted',
        permitId: PERMIT_ID,
      });
      await candidates.transitionCandidate({
        candidateId: permitted.candidateId,
        expectedStatus: permitted.status,
        expectedRevision: permitted.revision,
        status: 'consumed',
        deliveryDisposition: 'delivered',
      });
      const linked = {
        correlationId: `felt-impulse:would_message:${T0 + 1_000}`,
        firedAtMs: T0 + 1_000,
        recordedAtMs: T0 + 1_010,
        outcome: 'candidate_linked' as const,
        candidateId: CANDIDATE_ID,
        candidateOutcome: 'submitted' as const,
      };
      await expect(funnel.recordOutcome(linked)).resolves.toEqual(linked);

      const atomicCandidateId = '66666666-6666-4666-8666-666666666666';
      const atomicFiredAtMs = T0 + 2_000;
      await candidates.createClaimedFeltImpulseCandidate({
        candidateId: atomicCandidateId,
        rootInitiationId: atomicCandidateId,
        localCompanionId: LOCAL_ID,
        peerContactId: 'private-atomic-contact',
        peerCompanionId: PEER_ID,
        preferredChannel: 'dm',
        source: 'felt_impulse',
        provenanceRef: `icp-prov:${atomicCandidateId}`,
        reasonSummary: 'private atomic motivation',
        createdAtMs: atomicFiredAtMs,
        expiresAtMs: atomicFiredAtMs + 60_000,
        status: 'pending',
        revision: 1,
      }, {
        claimToken: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        claimExpiresAtMs: Date.now() + 60_000,
      }, {
        correlationId: `felt-impulse:would_message:${atomicFiredAtMs}`,
        firedAtMs: atomicFiredAtMs,
        recordedAtMs: atomicFiredAtMs,
        outcome: 'candidate_linked',
        candidateId: atomicCandidateId,
        candidateOutcome: 'submitted',
      });
      await expect(funnel.getOutcome(
        `felt-impulse:would_message:${atomicFiredAtMs}`,
      )).resolves.toMatchObject({
        outcome: 'candidate_linked',
        candidateId: atomicCandidateId,
      });

      const rolledBackCandidateId = '55555555-5555-4555-8555-555555555555';
      await expect(candidates.createClaimedFeltImpulseCandidate({
        candidateId: rolledBackCandidateId,
        rootInitiationId: rolledBackCandidateId,
        localCompanionId: LOCAL_ID,
        peerContactId: 'private-losing-contact',
        peerCompanionId: PEER_ID,
        preferredChannel: 'dm',
        source: 'felt_impulse',
        provenanceRef: `icp-prov:${rolledBackCandidateId}`,
        reasonSummary: 'private losing motivation',
        createdAtMs: T0,
        expiresAtMs: T0 + 60_000,
        status: 'pending',
        revision: 1,
      }, {
        claimToken: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        claimExpiresAtMs: Date.now() + 60_000,
      }, {
        correlationId: noPeer.correlationId,
        firedAtMs: noPeer.firedAtMs,
        recordedAtMs: noPeer.recordedAtMs,
        outcome: 'candidate_linked',
        candidateId: rolledBackCandidateId,
        candidateOutcome: 'submitted',
      })).rejects.toThrow();
      await expect(candidates.getCandidate(rolledBackCandidateId)).resolves.toBeNull();

      const lifecycleFixtures = [
        { candidateId: '77777777-7777-4777-8777-777777777777', status: 'permitted' as const },
        { candidateId: '88888888-8888-4888-8888-888888888888', status: 'deferred' as const },
        { candidateId: '99999999-9999-4999-8999-999999999999', status: 'declined' as const },
        { candidateId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'rejected' as const },
        { candidateId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', status: 'suppressed' as const },
        { candidateId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', status: 'expired' as const },
        { candidateId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', status: 'cancelled' as const },
      ];
      for (const [index, fixture] of lifecycleFixtures.entries()) {
        let candidate = await candidates.createCandidate({
          candidateId: fixture.candidateId,
          rootInitiationId: fixture.candidateId,
          localCompanionId: LOCAL_ID,
          peerContactId: `private-contact-${index}`,
          peerCompanionId: PEER_ID,
          preferredChannel: 'dm',
          source: 'felt_impulse',
          provenanceRef: `icp-prov:${fixture.candidateId}`,
          reasonSummary: `private lifecycle motivation ${index}`,
          createdAtMs: T0 + 2_000 + index,
          expiresAtMs: T0 + 120_000 + index,
          status: 'pending',
          revision: 1,
        });
        if (fixture.status === 'permitted' || fixture.status === 'suppressed') {
          candidate = await candidates.transitionCandidate({
            candidateId: candidate.candidateId,
            expectedStatus: candidate.status,
            expectedRevision: candidate.revision,
            status: 'permitted',
            permitId: PERMIT_ID,
          });
        }
        if (fixture.status === 'suppressed') {
          candidate = await candidates.transitionCandidate({
            candidateId: candidate.candidateId,
            expectedStatus: candidate.status,
            expectedRevision: candidate.revision,
            status: 'consumed',
            deliveryDisposition: 'suppressed',
          });
        } else if (fixture.status !== 'pending' && fixture.status !== 'permitted') {
          candidate = await candidates.transitionCandidate({
            candidateId: candidate.candidateId,
            expectedStatus: candidate.status,
            expectedRevision: candidate.revision,
            status: fixture.status,
          });
        }
        const firedAtMs = T0 + 2_001 + index;
        await funnel.recordOutcome({
          correlationId: `felt-impulse:would_message:${firedAtMs}`,
          firedAtMs,
          recordedAtMs: firedAtMs + 10,
          outcome: 'candidate_linked',
          candidateId: candidate.candidateId,
          candidateOutcome: fixture.status === 'deferred' ? 'deduped' : 'submitted',
        });
      }

      await funnel.close();
      funnel = await PostgresIcpFeltImpulseFunnelStore.connect(databaseUrl, { schema: SCHEMA });

      await expect(funnel.getOutcome(noPeer.correlationId)).resolves.toEqual(noPeer);
      const projection = await funnel.readProjection(20);
      expect(projection).toMatchObject({
        totalQualified: 12,
        preCandidate: { noEligiblePeer: 1, notAuthorized: 1, throttled: 1 },
        candidateLinks: { total: 9, submitted: 8, deduped: 1 },
        candidateLifecycle: {
          pending: 1,
          permitted: 1,
          deferred: 1,
          declined: 1,
          rejected: 1,
          delivered: 1,
          suppressed: 1,
          expired: 1,
          cancelled: 1,
        },
      });
      expect(projection.recent).toHaveLength(12);
      expect(projection.recent).toContainEqual({
        correlationId: linked.correlationId,
        firedAtMs: linked.firedAtMs,
        recordedAtMs: linked.recordedAtMs,
        outcome: 'candidate_linked',
        candidateId: CANDIDATE_ID,
        candidateOutcome: 'submitted',
        lifecycleOutcome: 'delivered',
      });
      expect(JSON.stringify(projection)).not.toContain('private lifecycle motivation');
      expect(JSON.stringify(projection)).not.toContain('private-contact');

      const inspect = createPostgresPool(databaseUrl, {
        applicationName: 'icp-felt-impulse-funnel-inspect',
        allowExitOnIdle: true,
        schema: SCHEMA,
      });
      try {
        const columns = await inspect.query<{ column_name: string }>(`
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'icp_felt_impulse_funnel_outcomes'
          ORDER BY column_name
        `, [SCHEMA]);
        expect(columns.rows.map(row => row.column_name)).not.toContain('reason_summary');
        expect(columns.rows.map(row => row.column_name)).not.toContain('reason');
      } finally {
        await inspect.end();
      }
    } finally {
      await Promise.allSettled([funnel.close(), candidates.close()]);
    }
  }, TIMEOUT_MS);
});
