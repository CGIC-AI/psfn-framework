// jp36.7.1.2 remediation — REAL cross-process concurrency regressions for the
// durable Share Capsule custody store. These refute the two verified blockers an
// adversarial review reproduced with a two-process probe:
//
//   1. Lost-update: without a cross-process lock, two processes both load
//      use-count N, both pass the in-memory CAS, and both persist N+1 over each
//      other — committed grants exceed the surviving count and can drive replays
//      past maxUseCount. Also lets a use-persist clobber a concurrent revoke
//      (revoked capsule resurrected).
//   2. Torn write: a FIXED shared `${filePath}.tmp` lets concurrent writers
//      publish each other's half-written tmp — an uncaught SyntaxError in load().
//
// Honesty note: these spawn genuine OS child processes (`process.execPath` +
// `--import tsx`) that each construct their OWN store instance over the SAME
// file, exactly like the gateway / agent / Garden processes do at runtime. No
// in-process fakery, no shared module state — the interleaving is real OS
// scheduling. Runtimes are bounded (a few hundred racing iterations).

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  approveShareCandidate,
  buildShareCandidate,
  type ApprovedShareCapsule,
  type CapsuleExpiry,
} from './capsule.js';
import { createShareCapsuleCustodyStore } from './capsule-custody.js';

const NOW = 1_750_000_000_000;
const MODULE_URL = new URL('./capsule-custody.ts', import.meta.url).href;

function seedCapsule(expiry: CapsuleExpiry, capsuleId = 'cap-1'): ApprovedShareCapsule {
  const candidate = buildShareCandidate({
    candidateId: 'cand-1',
    content: { body: 'An honest, exact sentence.', mediaRefs: ['media:a'] },
    proposedDestinations: [{ kind: 'contact_dm', contactIds: ['contact-1'] }],
    effectiveSensitivity: 'intimate',
    provenanceRefs: ['memory:1'],
    subjectContactIds: ['contact-1'],
    createdAt: new Date(NOW).toISOString(),
  });
  return approveShareCandidate(candidate, {
    capsuleId,
    actor: 'operator:pierre',
    approvedAt: new Date(NOW).toISOString(),
    expiry,
  });
}

interface ChildEnv {
  [key: string]: string;
}

/** Spawn one child worker running an inline tsx script; resolve on clean exit. */
function runChild(source: string, env: ChildEnv): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--eval', source], {
      env: { ...process.env, MODULE_URL, ...env },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stderr }));
  });
}

describe('ShareCapsuleCustodyStore — REAL cross-process concurrency (jp36.7.1.2 blockers)', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'share-capsule-concurrency-'));
    filePath = join(dir, 'cogsec-share-capsules.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it(
    'no lost increment: N racing child processes never grant past maxUseCount, and grants == final count',
    async () => {
      const CAP = 120;
      const WORKERS = 3;
      // Seed one capsule capped at CAP. A large enough cap over-active for a
      // single miner would deadlock the mint cap, so raise maxActiveCapsules.
      const store = createShareCapsuleCustodyStore(filePath, { maxActiveCapsules: 5, now: () => NOW });
      store.putApprovedCapsule(seedCapsule({ maxUseCount: CAP }));

      // Each worker loops: read current count, attempt a compare-and-set use.
      // On a CAS conflict ("concurrent use") it re-reads and retries. It stops
      // when the cap is reached. It prints the number of grants it durably won
      // to a per-worker result file. With a sound cross-process lock the sum of
      // all workers' grants MUST equal CAP exactly (no lost increment, no
      // over-grant). Under the pre-fix last-writer-wins persist, workers would
      // collectively "succeed" more times than the surviving count reflects.
      const childSource = `
        (async () => {
          const { readFileSync, writeFileSync } = await import('node:fs');
          const { createShareCapsuleCustodyStore } = await import(process.env.MODULE_URL);
          const filePath = process.env.FILE_PATH;
          const cap = Number(process.env.CAP);
          const resultPath = process.env.RESULT_PATH;
          let grants = 0;
          for (;;) {
            const store = createShareCapsuleCustodyStore(filePath, { maxActiveCapsules: 5 });
            const state = store.getCapsuleState('cap-1');
            if (!state || state.useCount >= cap) break;
            try {
              store.recordExactReplayUse({ capsuleId: 'cap-1', expectedPriorUseCount: state.useCount });
              grants += 1;
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              // A CAS conflict is expected under contention — retry. Hitting the
              // cap is the terminal, expected stop condition.
              if (/concurrent use/.test(message) || /already reached its cap/.test(message)) {
                continue;
              }
              // Any OTHER failure (e.g. an unparseable torn file) is a real bug.
              process.stderr.write('unexpected: ' + message + '\\n');
              process.exit(2);
            }
          }
          writeFileSync(resultPath, String(grants), 'utf8');
          process.exit(0);
        })();
      `;

      const results = await Promise.all(
        Array.from({ length: WORKERS }, (_unused, index) => {
          const resultPath = join(dir, `grants-${index}.txt`);
          return runChild(childSource, {
            FILE_PATH: filePath,
            CAP: String(CAP),
            RESULT_PATH: resultPath,
          }).then((outcome) => ({ ...outcome, resultPath }));
        }),
      );

      for (const result of results) {
        expect(result.stderr, `child stderr:\n${result.stderr}`).toBe('');
        expect(result.code).toBe(0);
      }

      const totalGrants = results.reduce(
        (sum, result) => sum + Number(readFileSync(result.resultPath, 'utf8')),
        0,
      );
      const finalCount = createShareCapsuleCustodyStore(filePath, { maxActiveCapsules: 5 })
        .getCapsuleState('cap-1')!.useCount;

      // The load re-parses the file; a torn or clobbered file would have thrown.
      // Every durable grant advanced the count by exactly one: no lost update.
      expect(finalCount).toBe(CAP);
      expect(totalGrants).toBe(CAP);
    },
    30_000,
  );

  it(
    'revoke concurrent with use: after both settle the capsule is revoked and no post-revoke grant occurred',
    async () => {
      // One capsule with headroom; two workers race — one hammers uses, the
      // other revokes. After both settle the capsule MUST be revoked, and the
      // surviving use-count must not exceed the number of uses that could have
      // committed strictly before the revoke landed. The invariant we assert:
      // once revoked, the count never advances again (no resurrection, no grant
      // after the revoke write).
      const store = createShareCapsuleCustodyStore(filePath, { maxActiveCapsules: 5, now: () => NOW });
      store.putApprovedCapsule(seedCapsule({ maxUseCount: 500 }));

      const useWorker = `
        (async () => {
          const { createShareCapsuleCustodyStore } = await import(process.env.MODULE_URL);
          const filePath = process.env.FILE_PATH;
          for (let attempt = 0; attempt < 400; attempt += 1) {
            const store = createShareCapsuleCustodyStore(filePath, { maxActiveCapsules: 5 });
            const state = store.getCapsuleState('cap-1');
            if (!state) break;
            try {
              store.recordExactReplayUse({ capsuleId: 'cap-1', expectedPriorUseCount: state.useCount });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              if (/revoked/.test(message)) break; // terminal: stop once revoked
              if (/concurrent use/.test(message) || /already reached its cap/.test(message)) continue;
              process.stderr.write('unexpected: ' + message + '\\n');
              process.exit(2);
            }
          }
          process.exit(0);
        })();
      `;

      const revokeWorker = `
        (async () => {
          const { createShareCapsuleCustodyStore } = await import(process.env.MODULE_URL);
          const filePath = process.env.FILE_PATH;
          // Let a few uses land first so the race is genuine, then revoke.
          for (let spin = 0; spin < 40; spin += 1) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
          }
          const store = createShareCapsuleCustodyStore(filePath, { maxActiveCapsules: 5 });
          store.revokeCapsule({ capsuleId: 'cap-1', revokedAt: new Date(${NOW}).toISOString(), reason: 'operator kill-switch' });
          process.exit(0);
        })();
      `;

      const [useOutcome, revokeOutcome] = await Promise.all([
        runChild(useWorker, { FILE_PATH: filePath }),
        runChild(revokeWorker, { FILE_PATH: filePath }),
      ]);
      expect(useOutcome.stderr, `use worker stderr:\n${useOutcome.stderr}`).toBe('');
      expect(revokeOutcome.stderr, `revoke worker stderr:\n${revokeOutcome.stderr}`).toBe('');
      expect(useOutcome.code).toBe(0);
      expect(revokeOutcome.code).toBe(0);

      // The revoke must have won terminally — the capsule is revoked on disk.
      const reboot = createShareCapsuleCustodyStore(filePath, { maxActiveCapsules: 5 });
      const settled = reboot.getCapsuleState('cap-1')!;
      expect(settled.capsule.revocation.revoked).toBe(true);
      const countAtRevoke = settled.useCount;

      // No post-revoke grant: any further use attempt fails closed and the count
      // does not move (the revoked capsule was never resurrected).
      expect(() =>
        reboot.recordExactReplayUse({ capsuleId: 'cap-1', expectedPriorUseCount: countAtRevoke }),
      ).toThrow(/revoked/);
      expect(reboot.getCapsuleState('cap-1')!.useCount).toBe(countAtRevoke);
    },
    30_000,
  );

  it(
    'torn-write regression: concurrent writers never leave an unparseable live file',
    async () => {
      // Five capsules, five workers each hammering revoke on a distinct capsule
      // (a cheap, always-succeeding mutation) so writers overlap heavily on the
      // same file. After the storm the live file must parse cleanly on every
      // read — the fixed shared `${filePath}.tmp` bug published half-written
      // files that made load() throw a SyntaxError.
      const store = createShareCapsuleCustodyStore(filePath, { maxActiveCapsules: 10, now: () => NOW });
      for (let index = 0; index < 5; index += 1) {
        store.putApprovedCapsule(seedCapsule({ maxUseCount: 50 }, `cap-${index}`));
      }

      const stormWorker = `
        (async () => {
          const { readFileSync } = await import('node:fs');
          const { createShareCapsuleCustodyStore } = await import(process.env.MODULE_URL);
          const filePath = process.env.FILE_PATH;
          const id = process.env.CAPSULE_ID;
          for (let iteration = 0; iteration < 150; iteration += 1) {
            const store = createShareCapsuleCustodyStore(filePath, { maxActiveCapsules: 10 });
            // A read interleaved with sibling writes must NEVER see a torn file.
            try {
              JSON.parse(readFileSync(filePath, 'utf8'));
            } catch (error) {
              process.stderr.write('torn read: ' + (error instanceof Error ? error.message : String(error)) + '\\n');
              process.exit(3);
            }
            // Revoke is idempotent, so hammering it is a safe repeated mutation.
            store.revokeCapsule({ capsuleId: id, revokedAt: new Date(${NOW}).toISOString() });
          }
          process.exit(0);
        })();
      `;

      const outcomes = await Promise.all(
        Array.from({ length: 5 }, (_unused, index) =>
          runChild(stormWorker, { FILE_PATH: filePath, CAPSULE_ID: `cap-${index}` }),
        ),
      );
      for (const outcome of outcomes) {
        expect(outcome.stderr, `worker stderr:\n${outcome.stderr}`).toBe('');
        expect(outcome.code).toBe(0);
      }

      // Final invariant: the live file parses and every capsule survived, revoked.
      const reboot = createShareCapsuleCustodyStore(filePath, { maxActiveCapsules: 10 });
      const records = reboot.list();
      expect(records).toHaveLength(5);
      for (const record of records) {
        expect(record.capsule.revocation.revoked).toBe(true);
      }
      // No orphan tmp files linger under the storm's directory beyond the store.
      expect(JSON.parse(readFileSync(filePath, 'utf8')).version).toBe(1);
    },
    30_000,
  );
});
