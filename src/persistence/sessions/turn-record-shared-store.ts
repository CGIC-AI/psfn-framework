import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { isRecord, toRecordView } from '../../shared/utils/types.js';
import type { ToolSchema, TurnRecord } from '../../shared/contracts/runtime.js';
import { restoreSnapshotSection } from './turn-record-snapshot-view.js';

/**
 * Content-addressed sidecar store for cross-turn static turn-record payloads
 * (bead hgw3.3). Tool-definition sets barely change across turns (a handful of
 * distinct sets per hundreds of turns), so the set is stored ONCE under
 * `<turnRecordsDir>/_shared/tooldefs/<sha256>.json` and each persisted record
 * carries only `plan.toolDefinitionsRef: <hash>`.
 *
 * Semantics:
 * - write-once: if `<hash>.json` already exists it is never rewritten
 *   (content-addressing makes the payload immutable by construction); the
 *   first intern per process against an existing file re-verifies that its
 *   content hashes to the filename and fails closed on a mismatch;
 * - fail-closed reads: a dangling or corrupt ref is a loud error, never a
 *   silent empty tool list;
 * - kept in its own module (not woven through the JSONL append/read internals)
 *   so the turn-record segment/rotation work can evolve independently.
 */

const SHARED_DIR = '_shared';
const TOOLDEFS_DIR = 'tooldefs';
const WIREBODIES_DIR = 'wirebodies';
const STATICPROMPTS_DIR = 'staticprompts';

/** Persisted-record field carrying the content hash instead of inline defs. */
export const TOOL_DEFINITIONS_REF_FIELD = 'toolDefinitionsRef';

/**
 * Persisted-record field (bead auiu) carrying the content hash of the static
 * system-prompt prefix template instead of the inline string. The static
 * prefix is session-stable (it only changes when the prompt stack is edited),
 * so hundreds of turns in a session serialize byte-identical copies of the
 * same multi-KB template; content-addressing stores it once in the sidecar.
 */
export const STATIC_PROMPT_TEMPLATE_REF_FIELD = 'staticPrefixTemplateRef';

export interface TurnRecordSharedStore {
  /** Store the set once (write-once) and return its content hash. */
  internToolDefinitions(toolDefinitions: ToolSchema[]): string;
  /** Resolve a content hash back to the stored set. Throws on dangling/corrupt refs. */
  resolveToolDefinitions(hash: string): ToolSchema[];
  /** Store a captured provider wire body once (write-once) and return its content hash. */
  internWireBody(body: unknown): string;
  /** Resolve a content hash back to the stored wire body. Throws on dangling/corrupt refs. */
  resolveWireBody(hash: string): unknown;
  /** Store the static system-prompt prefix template once (write-once) and return its content hash. */
  internStaticPrompt(template: string): string;
  /** Resolve a content hash back to the stored static prefix template. Throws on dangling/corrupt refs. */
  resolveStaticPrompt(hash: string): string;
}

function assertValidToolDefinitionsPayload(value: unknown, hash: string): asserts value is ToolSchema[] {
  if (!Array.isArray(value) || value.some(entry => !isRecord(entry) || typeof entry.name !== 'string')) {
    throw new Error(`TurnRecord shared tooldefs payload for ref "${hash}" is not a tool-definition array`);
  }
}

/**
 * Content-addressed write-once intern for a serialized payload (bead hgw3.3
 * tooldefs, extended for hgw3-80f6 wire bodies). Atomic publish via temp+rename;
 * a re-sighted existing sidecar is re-verified to hash to its filename before
 * new records reference it — a mismatch fails closed rather than silently
 * rewriting immutable, content-addressed data.
 */
function internSerialized(
  dir: string,
  label: string,
  resolvedByHash: Map<string, string>,
  serialized: string,
): string {
  const hash = createHash('sha256').update(serialized, 'utf-8').digest('hex');
  const path = join(dir, `${hash}.json`);
  if (!existsSync(path)) {
    mkdirSync(dir, { recursive: true });
    const tempPath = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    writeFileSync(tempPath, serialized, 'utf-8');
    try {
      renameSync(tempPath, path);
    } catch (error) {
      rmSync(tempPath, { force: true });
      throw error;
    }
  } else if (!resolvedByHash.has(hash)) {
    const existing = readFileSync(path, 'utf-8');
    const actualHash = createHash('sha256').update(existing, 'utf-8').digest('hex');
    if (actualHash !== hash) {
      throw new Error(
        `TurnRecord shared ${label} payload at ${path} is corrupt: content hash ${actualHash} `
        + `does not match ref "${hash}"; refusing to intern against a rewritten sidecar`,
      );
    }
  }
  resolvedByHash.set(hash, serialized);
  return hash;
}

/** Fail-closed read of a content-addressed serialized payload. */
function resolveSerialized(
  dir: string,
  label: string,
  refField: string,
  resolvedByHash: Map<string, string>,
  hash: string,
): string {
  let serialized = resolvedByHash.get(hash);
  if (serialized === undefined) {
    const path = join(dir, `${hash}.json`);
    if (!existsSync(path)) {
      throw new Error(
        `TurnRecord ${refField} "${hash}" is dangling: expected shared payload at ${path}`,
      );
    }
    serialized = readFileSync(path, 'utf-8');
    const actualHash = createHash('sha256').update(serialized, 'utf-8').digest('hex');
    if (actualHash !== hash) {
      throw new Error(
        `TurnRecord shared ${label} payload at ${path} is corrupt: content hash ${actualHash} does not match ref "${hash}"`,
      );
    }
    resolvedByHash.set(hash, serialized);
  }
  return serialized;
}

export function createTurnRecordSharedStore(turnRecordsDir: string): TurnRecordSharedStore {
  const tooldefsDir = join(turnRecordsDir, SHARED_DIR, TOOLDEFS_DIR);
  const wirebodiesDir = join(turnRecordsDir, SHARED_DIR, WIREBODIES_DIR);
  const staticpromptsDir = join(turnRecordsDir, SHARED_DIR, STATICPROMPTS_DIR);
  const tooldefsByHash = new Map<string, string>();
  const wirebodiesByHash = new Map<string, string>();
  const staticpromptsByHash = new Map<string, string>();

  return {
    internToolDefinitions: (toolDefinitions) => internSerialized(
      tooldefsDir,
      'tooldefs',
      tooldefsByHash,
      JSON.stringify(toolDefinitions),
    ),
    resolveToolDefinitions: (hash) => {
      const serialized = resolveSerialized(
        tooldefsDir,
        'tooldefs',
        TOOL_DEFINITIONS_REF_FIELD,
        tooldefsByHash,
        hash,
      );
      const parsed: unknown = JSON.parse(serialized);
      assertValidToolDefinitionsPayload(parsed, hash);
      return parsed;
    },
    internWireBody: (body) => internSerialized(
      wirebodiesDir,
      'wire-body',
      wirebodiesByHash,
      JSON.stringify(body),
    ),
    resolveWireBody: (hash) => {
      const serialized = resolveSerialized(
        wirebodiesDir,
        'wire-body',
        'capturedWirePayload.bodyRef',
        wirebodiesByHash,
        hash,
      );
      return JSON.parse(serialized) as unknown;
    },
    internStaticPrompt: (template) => internSerialized(
      staticpromptsDir,
      'static-prompt',
      staticpromptsByHash,
      JSON.stringify(template),
    ),
    resolveStaticPrompt: (hash) => {
      const serialized = resolveSerialized(
        staticpromptsDir,
        'static-prompt',
        STATIC_PROMPT_TEMPLATE_REF_FIELD,
        staticpromptsByHash,
        hash,
      );
      const parsed: unknown = JSON.parse(serialized);
      if (typeof parsed !== 'string') {
        throw new Error(
          `TurnRecord shared static-prompt payload for ref "${hash}" is not a string`,
        );
      }
      return parsed;
    },
  };
}

function readSnapshotPlan(record: TurnRecord): Record<string, unknown> | undefined {
  const snapshot = record.observability?.snapshot;
  if (!snapshot || !isRecord(snapshot.plan)) return undefined;
  return snapshot.plan;
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
        plan: restoreSnapshotSection(plan),
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

/** Field on capturedWirePayload carrying the content hash instead of the inline body. */
export const CAPTURED_WIRE_BODY_REF_FIELD = 'bodyRef';

function readCapturedWirePayload(record: TurnRecord): Record<string, unknown> | undefined {
  const promptContext = record.observability?.snapshot?.promptContext;
  if (!isRecord(promptContext)) return undefined;
  const providerObservability = promptContext.providerObservability;
  if (!isRecord(providerObservability)) return undefined;
  const captured = providerObservability.capturedWirePayload;
  return isRecord(captured) ? captured : undefined;
}

function withCapturedWirePayload(record: TurnRecord, captured: Record<string, unknown>): TurnRecord {
  const observability = record.observability!;
  const snapshot = observability.snapshot!;
  const promptContext = toRecordView(snapshot.promptContext!);
  const providerObservability = promptContext.providerObservability as Record<string, unknown>;
  return {
    ...record,
    observability: {
      ...observability,
      snapshot: {
        ...snapshot,
        promptContext: restoreSnapshotSection({
          ...promptContext,
          providerObservability: {
            ...providerObservability,
            capturedWirePayload: captured,
          },
        }),
      },
    },
  };
}

/**
 * Persisted-record projection (bead hgw3-80f6): content-address the captured
 * provider wire `body` into the shared sidecar and replace the inline body with
 * `capturedWirePayload.bodyRef`. The small summary fields (api, model,
 * byteLength, toolCount) stay inline so every persisted record still attests
 * what shipped without carrying the multi-hundred-KB body in the hot JSONL that
 * readRecentTurnRecords scans. Records without an inline body pass through.
 */
export function slimTurnRecordWirePayloadForAppend(
  record: TurnRecord,
  store: TurnRecordSharedStore,
): TurnRecord {
  const captured = readCapturedWirePayload(record);
  if (!captured || captured.body === undefined) return record;
  const hash = store.internWireBody(captured.body);
  const { body: _body, ...capturedRest } = captured;
  return withCapturedWirePayload(record, {
    ...capturedRest,
    [CAPTURED_WIRE_BODY_REF_FIELD]: hash,
  });
}

/**
 * Read-side inverse (bead hgw3-80f6): restore the inline captured wire `body`
 * from the sidecar for a record carrying `capturedWirePayload.bodyRef`, making
 * the ref transparent to every consumer above persistence (the Garden Loom).
 * Fail closed: a dangling ref, corrupt payload, or ambiguous ref+inline body is
 * a loud error. Records without a ref pass through untouched.
 */
export function resolveTurnRecordWirePayload(
  record: TurnRecord,
  store: TurnRecordSharedStore,
): TurnRecord {
  const captured = readCapturedWirePayload(record);
  const ref = captured?.[CAPTURED_WIRE_BODY_REF_FIELD];
  if (!captured || ref === undefined) return record;
  if (typeof ref !== 'string' || ref.trim().length === 0) {
    throw new Error(
      `TurnRecord field "observability.snapshot.promptContext.providerObservability.capturedWirePayload.${CAPTURED_WIRE_BODY_REF_FIELD}" must be a non-empty string`,
    );
  }
  if (captured.body !== undefined) {
    throw new Error(
      `TurnRecord capturedWirePayload carries both an inline body and ${CAPTURED_WIRE_BODY_REF_FIELD} "${ref}"`,
    );
  }
  const body = store.resolveWireBody(ref);
  const { [CAPTURED_WIRE_BODY_REF_FIELD]: _ref, ...capturedRest } = captured;
  return withCapturedWirePayload(record, {
    ...capturedRest,
    body,
  });
}

function readSnapshotPrompt(record: TurnRecord): Record<string, unknown> | undefined {
  const snapshot = record.observability?.snapshot;
  if (!snapshot || !isRecord(snapshot.prompt)) return undefined;
  return snapshot.prompt;
}

function withSnapshotPrompt(record: TurnRecord, prompt: Record<string, unknown>): TurnRecord {
  const observability = record.observability!;
  const snapshot = observability.snapshot!;
  return {
    ...record,
    observability: {
      ...observability,
      snapshot: {
        ...snapshot,
        prompt: restoreSnapshotSection(prompt),
      },
    },
  };
}

/**
 * Persisted-record projection (bead auiu): replace the inline static system
 * prompt prefix template (`snapshot.prompt.staticPrefixTemplate`) with a
 * content-addressed `staticPrefixTemplateRef`, interning the template into the
 * sidecar store. The static prefix is session-stable, so every turn in a
 * session otherwise serializes a byte-identical multi-KB copy; the sidecar
 * stores each distinct template once. Only the static prefix is deduped — the
 * per-turn dynamic suffix template stays inline (it re-renders each turn).
 * Empty templates stay inline: there is nothing worth sharing. Returns a
 * restructured copy; the input record is not mutated.
 */
export function slimTurnRecordStaticPromptForAppend(
  record: TurnRecord,
  store: TurnRecordSharedStore,
): TurnRecord {
  const prompt = readSnapshotPrompt(record);
  const template = prompt?.staticPrefixTemplate;
  if (!prompt || typeof template !== 'string' || template.length === 0) {
    return record;
  }
  const hash = store.internStaticPrompt(template);
  const { staticPrefixTemplate: _inline, ...promptRest } = prompt;
  return withSnapshotPrompt(record, {
    ...promptRest,
    [STATIC_PROMPT_TEMPLATE_REF_FIELD]: hash,
  });
}

/**
 * Read-side inverse (bead auiu): restore the inline static prefix template from
 * the sidecar for a record carrying `staticPrefixTemplateRef`, making the ref
 * transparent to every consumer above persistence (the Garden Loom, session
 * turn observability). Fail closed: a dangling ref, a corrupt payload, or an
 * ambiguous ref+inline record is a loud error. Records without a ref (old fat
 * records, prompt-less snapshots) pass through untouched.
 */
export function resolveTurnRecordStaticPrompt(
  record: TurnRecord,
  store: TurnRecordSharedStore,
): TurnRecord {
  const prompt = readSnapshotPrompt(record);
  const ref = prompt?.[STATIC_PROMPT_TEMPLATE_REF_FIELD];
  if (!prompt || ref === undefined) return record;
  if (typeof ref !== 'string' || ref.trim().length === 0) {
    throw new Error(
      `TurnRecord field "observability.snapshot.prompt.${STATIC_PROMPT_TEMPLATE_REF_FIELD}" must be a non-empty string`,
    );
  }
  if (prompt.staticPrefixTemplate !== undefined) {
    throw new Error(
      `TurnRecord snapshot prompt carries both an inline staticPrefixTemplate and ${STATIC_PROMPT_TEMPLATE_REF_FIELD} "${ref}"`,
    );
  }
  const staticPrefixTemplate = store.resolveStaticPrompt(ref);
  const { [STATIC_PROMPT_TEMPLATE_REF_FIELD]: _ref, ...promptRest } = prompt;
  return withSnapshotPrompt(record, {
    ...promptRest,
    staticPrefixTemplate,
  });
}
