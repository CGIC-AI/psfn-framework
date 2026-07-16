import { afterEach, describe, expect, it } from 'vitest';
import type { ContactLifecycleCertificationHarness } from './process-harness.js';
import {
  CERTIFICATION_COMPANION_A,
  CERTIFICATION_COMPANION_B,
  certificationDeleteRequest,
  startContactLifecycleCertificationHarness,
} from './process-harness.js';

const TIMEOUT_MS = 120_000;

describe.each(['unix', 'wss'] as const)(
  'contact lifecycle authenticated %s process certification',
  (transport) => {
    let harness: ContactLifecycleCertificationHarness | undefined;

    afterEach(async () => {
      await harness?.stop();
      harness = undefined;
    }, TIMEOUT_MS);

    it('isolates colliding contact ids and replays exact receipts across gateway/agent restart', async () => {
      harness = await startContactLifecycleCertificationHarness(transport);
      const requestA = certificationDeleteRequest('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      const requestB = certificationDeleteRequest('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
      const [resultA, resultB] = await Promise.all([
        harness.agents[0].execute(requestA),
        harness.agents[1].execute(requestB),
      ]);
      expect(resultA.intentId).toBe(requestA.intentId);
      expect(resultB.intentId).toBe(requestB.intentId);
      expect(harness.authority.calls.map(call => call.companionId).sort()).toEqual([
        CERTIFICATION_COMPANION_A,
        CERTIFICATION_COMPANION_B,
      ]);

      await expect(harness.agents[1].execute(requestA)).rejects.toThrow(
        /contact lifecycle authority operation was denied/i,
      );
      const restarted = await harness.restart();
      await expect(restarted[0].execute(requestA)).resolves.toEqual(resultA);
      await expect(restarted[1].execute(requestB)).resolves.toEqual(resultB);
    }, TIMEOUT_MS);
  },
);
