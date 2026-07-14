import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { isRecord } from '../../shared/utils/types.js';
import type { ToolSchema, TurnRecord } from '../../shared/contracts/runtime.js';

/**
 * Content-addressed sidecar store for cross-turn static turn-record payloads
 * (bead hgw3.3). Tool-definition sets barely change across turns (a handful of
 * distinct sets per hundreds of turns), so the set is stored ONCE under
 * `<turnRecordsDir>/_shared/tooldefs/<sha256>.json` and each persisted record
 * carries only `plan.toolDefinitionsRef: <hash>`.
 *
 * Semantics:
 * - write-once: if `<hash>.json` already exists it is never rewritten
 *   (content-addressing makes the payload immutable by construction);
 * - fail-closed reads: a dangling or corrupt ref is a loud error, never a
 *   silent empty tool list;
 * - kept in its own module (not woven through the JSONL append/read internals)
 *   so the turn-record segment/rotation work can evolve independently.
 */

const SHARED_DIR = '_shared';
const TOOLDEFS_DIR = 'tooldefs';

/** Persisted-record field carrying the content hash instead of inline defs. */
export const TOOL_DEFINITIONS_REF_FIELD = 'toolDefinitionsRef';

export interface TurnRecordSharedStore {
  /** Store the set once (write-once) and return its content hash. */
  internToolDefinitions(toolDefinitions: ToolSchema[]): string;
  /** Resolve a content hash back to the stored set. Throws on dangling/corrupt refs. */
  resolveToolDefinitions(hash: string): ToolSchema[];
}

function assertValidToolDefinitionsPayload(value: unknown, hash: string): asserts value is ToolSchema[] {
  if (!Array.isArray(value) || value.some(entry => !isRecord(entry) || typeof entry.name !== 'string')) {
    throw new Error(`TurnRecord shared tooldefs payload for ref "${hash}" is not a tool-definition array`);
  }
}

export function createTurnRecordSharedStore(turnRecordsDir: string): TurnRecordSharedStore {
  const tooldefsDir = join(turnRecordsDir, SHARED_DIR, TOOLDEFS_DIR);
  const resolvedByHash = new Map<string, string>();

  const pathForHash = (hash: string): string => join(tooldefsDir, `${hash}.json`);

  return {
    internToolDefinitions: (toolDefinitions) => {
      const serialized = JSON.stringify(toolDefinitions);
      const hash = createHash('sha256').update(serialized, 'utf-8').digest('hex');
      const path = pathForHash(hash);
      if (!existsSync(path)) {
        // Atomic publish: write a temp file, then rename into place so a
        // concurrent reader never observes a torn payload.
        mkdirSync(tooldefsDir, { recursive: true });
        const tempPath = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
        writeFileSync(tempPath, serialized, 'utf-8');
        try {
          renameSync(tempPath, path);
        } catch (error) {
          rmSync(tempPath, { force: true });
          throw error;
        }
      }
      resolvedByHash.set(hash, serialized);
      return hash;
    },
    resolveToolDefinitions: (hash) => {
      let serialized = resolvedByHash.get(hash);
      if (serialized === undefined) {
        const path = pathForHash(hash);
        if (!existsSync(path)) {
          throw new Error(
            `TurnRecord toolDefinitionsRef "${hash}" is dangling: expected shared payload at ${path}`,
          );
        }
        serialized = readFileSync(path, 'utf-8');
        const actualHash = createHash('sha256').update(serialized, 'utf-8').digest('hex');
        if (actualHash !== hash) {
          throw new Error(
            `TurnRecord shared tooldefs payload at ${path} is corrupt: content hash ${actualHash} does not match ref "${hash}"`,
          );
        }
        resolvedByHash.set(hash, serialized);
      }
      const parsed: unknown = JSON.parse(serialized);
      assertValidToolDefinitionsPayload(parsed, hash);
      return parsed;
    },
  };
}

function readSnapshotPlan(record: TurnRecord): Record<string, unknown> | undefined {
  const snapshot = record.observability?.snapshot;
  if (!snapshot || !isRecord(snapshot.plan)) return undefined;
  return snapshot.plan as unknown as Record<string, unknown>;
}

function withSnapshotPlan(record: TurnRecord, plan: Record<string, unknown>): TurnRecord {
  const observability = record.observability!;
  const snapshot = observability.snapshot!;
  return {
    ...record,
    observability: {
      ...observability,
      snapshot: {
        ...snapshot,
        plan: plan as unknown as NonNullable<typeof snapshot.plan>,
      },
    },
  };
}

/**
 * Persisted-record projection: replace non-empty inline `plan.toolDefinitions`
 * with a content-addressed `toolDefinitionsRef` (interning the set into the
 * sidecar store). Empty sets stay inline — there is nothing worth sharing.
 * Returns a restructured copy; the input record is not mutated.
 */
export function slimTurnRecordToolDefinitionsForAppend(
  record: TurnRecord,
  store: TurnRecordSharedStore,
): TurnRecord {
  const plan = readSnapshotPlan(record);
  const toolDefinitions = plan?.toolDefinitions;
  if (!plan || !Array.isArray(toolDefinitions) || toolDefinitions.length === 0) {
    return record;
  }
  const hash = store.internToolDefinitions(toolDefinitions as ToolSchema[]);
  const { toolDefinitions: _inline, ...planRest } = plan;
  return withSnapshotPlan(record, {
    ...planRest,
    [TOOL_DEFINITIONS_REF_FIELD]: hash,
  });
}

/**
 * Read-side inverse: a record whose snapshot plan carries `toolDefinitionsRef`
 * gets the inline `toolDefinitions` restored from the sidecar store, making
 * the ref fully transparent to every consumer above the persistence layer
 * (Garden reads records exclusively through this path). Fail closed: a
 * dangling ref, a corrupt payload, or an ambiguous ref+inline record is a loud
 * error. Records without a ref (old fat records, plan-less records) pass
 * through untouched.
 */
export function resolveTurnRecordToolDefinitions(
  record: TurnRecord,
  store: TurnRecordSharedStore,
): TurnRecord {
  const plan = readSnapshotPlan(record);
  const ref = plan?.[TOOL_DEFINITIONS_REF_FIELD];
  if (!plan || ref === undefined) return record;
  if (typeof ref !== 'string' || ref.trim().length === 0) {
    throw new Error(`TurnRecord field "observability.snapshot.plan.${TOOL_DEFINITIONS_REF_FIELD}" must be a non-empty string`);
  }
  if (plan.toolDefinitions !== undefined) {
    throw new Error(
      `TurnRecord snapshot plan carries both inline toolDefinitions and ${TOOL_DEFINITIONS_REF_FIELD} "${ref}"`,
    );
  }
  const toolDefinitions = store.resolveToolDefinitions(ref);
  const { [TOOL_DEFINITIONS_REF_FIELD]: _ref, ...planRest } = plan;
  return withSnapshotPlan(record, {
    ...planRest,
    toolDefinitions,
  });
}
