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
  schemaVersion: 2;
  revision: number;
  phase: 'enabled' | 'disabled';
  transitionId: string;
  authorityLineageId: string;
}

export interface FleetAuthLifecycleEnablePreparation {
  observedRevision: number | null;
  observedPhase: FleetAuthLifecycleWitness['phase'] | 'absent';
  observedTransitionId: string | null;
  observedAuthorityLineageId: string | null;
  lifecycleTransitionId?: string;
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
    ['schemaVersion', 'revision', 'phase', 'transitionId', 'authorityLineageId'],
    'root',
    { errorPrefix: 'Invalid fleet auth lifecycle witness' },
  );
  if (value.schemaVersion !== 2
    || !Number.isSafeInteger(value.revision)
    || Number(value.revision) < 1
    || (value.phase !== 'enabled' && value.phase !== 'disabled')
    || typeof value.transitionId !== 'string'
    || !HASH_PATTERN.test(value.transitionId)
    || typeof value.authorityLineageId !== 'string'
    || !HASH_PATTERN.test(value.authorityLineageId)) {
    throw new Error('Invalid fleet auth lifecycle witness: malformed fields');
  }
  return {
    schemaVersion: 2,
    revision: Number(value.revision),
    phase: value.phase,
    transitionId: value.transitionId,
    authorityLineageId: value.authorityLineageId,
  };
}

function preparationFor(
  witness: FleetAuthLifecycleWitness | undefined,
  lifecycleTransitionId?: string,
): FleetAuthLifecycleEnablePreparation {
  return {
    observedRevision: witness?.revision ?? null,
    observedPhase: witness?.phase ?? 'absent',
    observedTransitionId: witness?.transitionId ?? null,
    observedAuthorityLineageId: witness?.authorityLineageId ?? null,
    ...(lifecycleTransitionId ? { lifecycleTransitionId } : {}),
  };
}

function matchesPreparation(
  witness: FleetAuthLifecycleWitness | undefined,
  preparation: FleetAuthLifecycleEnablePreparation,
): boolean {
  return (witness?.revision ?? null) === preparation.observedRevision
    && (witness?.phase ?? 'absent') === preparation.observedPhase
    && (witness?.transitionId ?? null) === preparation.observedTransitionId
    && (witness?.authorityLineageId ?? null) === preparation.observedAuthorityLineageId;
}

function nextRevision(revision: number): number {
  if (revision >= Number.MAX_SAFE_INTEGER) {
    throw new Error('Fleet auth lifecycle witness revision is exhausted');
  }
  return revision + 1;
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
    if (!existsSync(this.path)) return;
    withCrossProcessWriteLock(this.lockPath, LOCK_OPTIONS, () => {
      const current = this.readIfPresent();
      if (!current || current.phase === 'disabled') return;
      this.write({
        ...current,
        revision: nextRevision(current.revision),
        phase: 'disabled',
        transitionId: nonce(),
      });
    });
  }

  prepareEnable(existingAuthorityLineageId?: string): FleetAuthLifecycleEnablePreparation {
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
      if (current?.phase === 'disabled') {
        return preparationFor(current, current.transitionId);
      }
      // Missing witness beside an existing floor is treated as a recovery
      // transition. This safely over-fences rather than guessing restart.
      if (!current && existingAuthorityLineageId) {
        return preparationFor(undefined, nonce());
      }
      return preparationFor(current);
    });
  }

  publishEnabled(
    preparation: FleetAuthLifecycleEnablePreparation,
    authorityLineageId: string,
    lastLifecycleTransitionId: string | null,
  ): void {
    if (!HASH_PATTERN.test(authorityLineageId)) {
      throw new Error('Fleet auth lifecycle witness authority lineage is invalid');
    }
    if (lastLifecycleTransitionId !== null
      && !HASH_PATTERN.test(lastLifecycleTransitionId)) {
      throw new Error('Fleet auth lifecycle transition id is invalid');
    }
    withCrossProcessWriteLock(this.lockPath, LOCK_OPTIONS, () => {
      const current = this.readIfPresent();
      if (current && current.authorityLineageId !== authorityLineageId) {
        throw new Error('Fleet auth lifecycle witness authority lineage does not match the floor');
      }

      if (matchesPreparation(current, preparation)) {
        if (!current) {
          this.write({
            schemaVersion: 2,
            revision: 1,
            phase: 'enabled',
            transitionId: lastLifecycleTransitionId ?? nonce(),
            authorityLineageId,
          });
          return;
        }
        if (current.phase === 'disabled') {
          if (lastLifecycleTransitionId !== current.transitionId) {
            throw new Error(
              'Fleet auth lifecycle disabled transition was not consumed by the authority floor',
            );
          }
          this.write({
            ...current,
            revision: nextRevision(current.revision),
            phase: 'enabled',
          });
          return;
        }
        if (lastLifecycleTransitionId !== null
          && current.transitionId !== lastLifecycleTransitionId) {
          throw new Error('Fleet auth lifecycle witness does not match the reconciled authority floor');
        }
        return;
      }

      // Concurrent enabled startups may race to publish the same already-fenced
      // floor transition. Treat that exact result as idempotent, but never let a
      // changed disabled witness be overwritten by stale startup state.
      if (current?.phase === 'enabled'
        && current.authorityLineageId === authorityLineageId
        && ((lastLifecycleTransitionId !== null
          && current.transitionId === lastLifecycleTransitionId)
          || (preparation.observedPhase === 'absent'
            && lastLifecycleTransitionId === null
            && current.revision === 1))) {
        return;
      }
      throw new Error('Fleet auth lifecycle witness changed during enabled startup');
    });
  }
}
