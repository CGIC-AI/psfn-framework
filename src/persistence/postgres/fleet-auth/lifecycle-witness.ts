import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeFileDurableAtomicSync } from '../../../shared/utils/fs.js';
import { assertNoUnknownKeys, isRecord } from '../../../shared/utils/types.js';
import { withCrossProcessWriteLock } from '../../sessions/cross-process-write-lock.js';

export const FLEET_AUTH_LIFECYCLE_WITNESS_FILE_NAME = 'fleet-auth-lifecycle.json';
const LOCK_DIR_NAME = '.fleet-auth-lifecycle.lock';
const HASH_PATTERN = /^[0-9a-f]{64}$/u;

interface FleetAuthLifecycleWitness {
  schemaVersion: 1;
  phase: 'enabled' | 'disabled';
  transitionId: string;
  authorityLineageId: string;
}

const LOCK_OPTIONS = {
  pollMs: 10,
  staleMs: 30_000,
  timeoutMs: 10_000,
} as const;

function nonce(): string {
  return randomBytes(32).toString('hex');
}

function parseWitness(value: unknown): FleetAuthLifecycleWitness {
  if (!isRecord(value)) throw new Error('Invalid fleet auth lifecycle witness: root must be an object');
  assertNoUnknownKeys(
    value,
    ['schemaVersion', 'phase', 'transitionId', 'authorityLineageId'],
    'root',
    { errorPrefix: 'Invalid fleet auth lifecycle witness' },
  );
  if (value.schemaVersion !== 1
    || (value.phase !== 'enabled' && value.phase !== 'disabled')
    || typeof value.transitionId !== 'string'
    || !HASH_PATTERN.test(value.transitionId)
    || typeof value.authorityLineageId !== 'string'
    || !HASH_PATTERN.test(value.authorityLineageId)) {
    throw new Error('Invalid fleet auth lifecycle witness: malformed fields');
  }
  return {
    schemaVersion: 1,
    phase: value.phase,
    transitionId: value.transitionId,
    authorityLineageId: value.authorityLineageId,
  };
}

/**
 * A system-owned, non-secret witness that makes disable -> re-enable observable.
 * It is deliberately absent until fleet auth has completed its first enabled
 * startup, preserving never-enabled feature-off behavior.
 */
export class FleetAuthLifecycleWitnessStore {
  readonly path: string;
  private readonly lockPath: string;

  constructor(systemDataDir: string) {
    const root = resolve(systemDataDir);
    this.path = join(root, FLEET_AUTH_LIFECYCLE_WITNESS_FILE_NAME);
    this.lockPath = join(root, LOCK_DIR_NAME);
  }

  private readIfPresent(): FleetAuthLifecycleWitness | undefined {
    if (!existsSync(this.path)) return undefined;
    try {
      return parseWitness(JSON.parse(readFileSync(this.path, 'utf8')));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Fleet auth lifecycle witness is unreadable: ${error.message}`);
      }
      throw error;
    }
  }

  private write(value: FleetAuthLifecycleWitness): void {
    writeFileDurableAtomicSync(this.path, `${JSON.stringify(parseWitness(value), null, 2)}\n`);
  }

  /** Feature-off is byte-for-byte inert until an enabled startup created the witness. */
  recordDisabledIfPresent(): void {
    withCrossProcessWriteLock(this.lockPath, LOCK_OPTIONS, () => {
      const current = this.readIfPresent();
      if (!current || current.phase === 'disabled') return;
      this.write({ ...current, phase: 'disabled', transitionId: nonce() });
    });
  }

  prepareEnable(existingAuthorityLineageId?: string): string | undefined {
    return withCrossProcessWriteLock(this.lockPath, LOCK_OPTIONS, () => {
      const current = this.readIfPresent();
      if (current && !existingAuthorityLineageId) {
        throw new Error(
          'Fleet auth lifecycle witness exists but the non-restored authority floor is missing',
        );
      }
      if (current && current.authorityLineageId !== existingAuthorityLineageId) {
        throw new Error('Fleet auth lifecycle witness authority lineage does not match the floor');
      }
      if (current?.phase === 'disabled') return current.transitionId;
      // Missing witness beside an existing floor is treated as a recovery
      // transition. This safely over-fences rather than guessing restart.
      if (!current && existingAuthorityLineageId) return nonce();
      return undefined;
    });
  }

  recordEnabled(authorityLineageId: string, lastLifecycleTransitionId: string | null): void {
    if (!HASH_PATTERN.test(authorityLineageId)) {
      throw new Error('Fleet auth lifecycle witness authority lineage is invalid');
    }
    withCrossProcessWriteLock(this.lockPath, LOCK_OPTIONS, () => {
      this.write({
        schemaVersion: 1,
        phase: 'enabled',
        transitionId: lastLifecycleTransitionId ?? nonce(),
        authorityLineageId,
      });
    });
  }
}
