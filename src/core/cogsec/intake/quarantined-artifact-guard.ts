// ── Cognition Intake Firewall: quarantined-artifact access guard (hrmrq.54) ──
//
// Closes the containment bypass where a quarantined document's raw bytes were
// one fs.read away: the intake screening withholds the content from the
// prompt, but the parsed document and its sidecar still sit on disk, and a
// read seam that serves those paths hands the quarantined content straight
// back into the turn.
//
// The guard is the ONE decision point filesystem seams consult before serving
// or mutating file content. It resolves the requested path against the quarantine store's
// registered artifact paths (quarantine-store.ts, registered at hold time):
//
// - Released/discard-resolved-and-consumable entries do not block: once a
//   human decision put the envelope in a sink-consumable state the artifact
//   is operator-cleared.
// - Any other match records an attempted access on the entry (operator-visible
//   in the Garden Cognitive Security queue — a bypass attempt is never
//   invisible) and, in enforce mode, withholds the read: the caller must
//   return the fixed quarantine notice instead of content.
// - Shadow mode observes only after the attempt is durably recorded: the read
//   then proceeds (the content was delivered at intake anyway). Audit failure
//   aborts in either mode so the queue never silently loses an access attempt.
//
// A failed audit write is logged and thrown. The caller therefore fails the
// tool path closed instead of returning content without the required queue
// evidence.

import { realpathSync, statSync } from 'node:fs';
import { createComponentLogger } from '../../../shared/logger.js';
import { isIntakeSinkConsumableState } from '../../../shared/contracts/intake-envelope.js';
import { INTAKE_FIREWALL_NOTICE_TEMPLATES } from '../intake-firewall-notice-templates.js';
import {
  normalizeQuarantineArtifactPath,
  type IntakeQuarantineAccessAttemptInput,
  type IntakeQuarantineEntry,
} from './quarantine-store.js';

const log = createComponentLogger('QuarantinedArtifactGuard');

/** The store surface the guard needs (structural subset of IntakeQuarantineStore). */
export interface QuarantinedArtifactPathPort {
  findByArtifactPath(path: string): IntakeQuarantineEntry | undefined;
  recordAccessAttempt(input: IntakeQuarantineAccessAttemptInput): IntakeQuarantineEntry;
  findByArtifactPaths(paths: readonly string[]): Map<string, IntakeQuarantineEntry>;
  recordAccessAttempts(
    inputs: readonly IntakeQuarantineAccessAttemptInput[],
  ): IntakeQuarantineEntry[];
  checkArtifactAccesses(input: {
    requests: readonly {
      requestedPath: string;
      lookupPaths: readonly string[];
      lookupIdentities?: readonly string[];
    }[];
    via: string;
    atMs?: number;
  }): {
    entries: Array<IntakeQuarantineEntry | undefined>;
    revisionToken: string;
  };
  readRevisionToken(): string;
  /** Registered artifact paths of entries not in a sink-consumable state. */
  listActiveArtifactPaths(): string[];
  listActiveArtifactIdentities(): string[];
}

export type QuarantinedArtifactCheckResult =
  | { withheld: false }
  | {
    withheld: true;
    /** The envelope/entry id backing the withhold (Garden queue reference). */
    envelopeId: string;
    /** The fixed htm9.12 withheld-content notice to return instead of content. */
    noticeText: string;
  };

export interface QuarantinedArtifactBatchCheckResult {
  verdicts: QuarantinedArtifactCheckResult[];
  /** Exact gating-state revision captured with the batch verdicts. */
  revisionToken: string;
}

export interface QuarantinedArtifactPhysicalCheckOptions {
  /** Device/inode identity bound to each already-statted/opened path. */
  physicalIdentities: readonly (string | undefined)[];
}

export interface QuarantinedArtifactAccessGuard {
  /**
   * Check one access to `path`. `via` is the auditable access seam
   * (e.g. 'gateway:fs.read' or 'gateway:fs.write'). Throws when the queue
   * attempt cannot be persisted, so an unaudited access never proceeds.
   */
  check(path: string, context: { via: string }): QuarantinedArtifactCheckResult;
  /**
   * Batch check for bounded scans. All lookups share one store snapshot and
   * all matched access attempts share one durable audit transaction.
   */
  checkMany(
    paths: readonly string[],
    context: { via: string },
    options?: QuarantinedArtifactPhysicalCheckOptions,
  ): QuarantinedArtifactBatchCheckResult;
  /** Token for revalidating a bounded scan before its bytes are returned. */
  readRevisionToken(): string;
  /**
   * The physical deny set for sandbox launches (hrmrq.54 shell seam): every
   * registered artifact path of a not-operator-released entry. Enforce mode
   * THROWS when the store cannot enumerate — a sandbox that cannot know what
   * to mask must not launch (fail closed). Shadow mode always returns []
   * (observe-only: nothing is physically denied).
   */
  listEnforcedArtifactPaths(): string[];
  /** Physical identities whose aliases must also be masked in the sandbox. */
  listEnforcedArtifactIdentities(): string[];
}

export interface QuarantinedArtifactAccessGuardOptions {
  store: QuarantinedArtifactPathPort;
  /** Current firewall mode; 'shadow' observes and records but never withholds. */
  mode: 'shadow' | 'enforce';
  now?: () => number;
}

export interface UnionQuarantinedArtifactAccessGuardOptions {
  /** Every companion-owned quarantine store served by this gateway. */
  stores: readonly QuarantinedArtifactPathPort[];
  /** Shared system-owned firewall mode. */
  mode: 'shadow' | 'enforce';
  now?: () => number;
}

function lookupEntries(
  paths: readonly string[],
  physicalIdentities?: readonly (string | undefined)[],
): {
  requests: Array<{
    requestedPath: string;
    lookupPaths: string[];
    lookupIdentities: string[];
  }>;
  requestIndexes: number[];
  errors: Map<number, unknown>;
} {
  if (physicalIdentities && physicalIdentities.length !== paths.length) {
    throw new Error('Quarantined-artifact physical identity count must match path count');
  }
  const requests: Array<{
    requestedPath: string;
    lookupPaths: string[];
    lookupIdentities: string[];
  }> = [];
  const requestIndexes: number[] = [];
  const errors = new Map<number, unknown>();
  const aliases = paths.map((path, index) => {
    const normalized = normalizeQuarantineArtifactPath(path);
    const boundIdentity = physicalIdentities?.[index];
    if (boundIdentity !== undefined) {
      return { paths: [normalized], identities: [boundIdentity] };
    }
    try {
      const canonical = realpathSync(path);
      const stats = statSync(path, { bigint: true });
      return {
        paths: canonical === normalized ? [normalized] : [normalized, canonical],
        identities: [
          `${stats.dev.toString()}:${stats.ino.toString()}:${stats.birthtimeNs.toString()}`,
        ],
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === 'ENOENT' || code === 'ENOTDIR'
        ? { paths: [normalized], identities: [] }
        : { paths: [], identities: [], error };
    }
  });
  aliases.forEach((pathAliases, index) => {
    if (pathAliases.error) {
      errors.set(index, pathAliases.error);
      return;
    }
    requests.push({
      requestedPath: paths[index]!,
      lookupPaths: pathAliases.paths,
      lookupIdentities: pathAliases.identities,
    });
    requestIndexes.push(index);
  });
  return { requests, requestIndexes, errors };
}

export function createQuarantinedArtifactAccessGuard(
  options: QuarantinedArtifactAccessGuardOptions,
): QuarantinedArtifactAccessGuard {
  const { store, mode } = options;
  const now = options.now ?? Date.now;

  const checkMany = (
    paths: readonly string[],
    context: { via: string },
    checkOptions?: QuarantinedArtifactPhysicalCheckOptions,
  ): QuarantinedArtifactBatchCheckResult => {
    const prepared = lookupEntries(paths, checkOptions?.physicalIdentities);
    const lookups = paths.map<{ entry?: IntakeQuarantineEntry; error?: unknown }>(() => ({}));
    for (const [index, error] of prepared.errors) lookups[index] = { error };
    let revisionToken = 'unavailable';
    try {
      const checked = store.checkArtifactAccesses({
        requests: prepared.requests,
        via: context.via,
        atMs: now(),
      });
      revisionToken = checked.revisionToken;
      checked.entries.forEach((entry, resultIndex) => {
        const pathIndex = prepared.requestIndexes[resultIndex]!;
        lookups[pathIndex] = entry ? { entry } : {};
      });
    } catch (error) {
      for (const path of paths) {
        // A broken quarantine store cannot prove the path is safe: fail
        // closed in enforce mode rather than serving possibly-held content.
        log.error('Quarantined-artifact lookup failed; failing closed in enforce mode', {
          path,
          via: context.via,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to resolve or audit quarantined-artifact access batch: ${detail}`,
        { cause: error },
      );
    }

    const verdicts: QuarantinedArtifactCheckResult[] = lookups.map(({ entry, error }, index) => {
      const path = paths[index]!;
      if (error) {
        log.error('Quarantined-artifact path canonicalization failed; failing this path closed', {
          path,
          via: context.via,
          error: error instanceof Error ? error.message : String(error),
        });
        return mode === 'enforce'
          ? {
            withheld: true,
            envelopeId: 'unknown',
            noticeText: INTAKE_FIREWALL_NOTICE_TEMPLATES.withheldContent,
          }
          : { withheld: false };
      }
      if (!entry || isIntakeSinkConsumableState(entry.envelope.state)) {
        return { withheld: false };
      }
      if (mode !== 'enforce') {
        log.warn('Shadow mode: quarantined-artifact access observed (not withheld)', {
          entryId: entry.id,
          envelopeState: entry.envelope.state,
          path,
          via: context.via,
        });
        return { withheld: false };
      }

      log.warn('Quarantined-artifact access withheld', {
        entryId: entry.id,
        envelopeState: entry.envelope.state,
        path,
        via: context.via,
      });
      return {
        withheld: true,
        envelopeId: entry.id,
        noticeText: INTAKE_FIREWALL_NOTICE_TEMPLATES.withheldContent,
      };
    });
    return { verdicts, revisionToken };
  };

  return {
    listEnforcedArtifactPaths(): string[] {
      if (mode !== 'enforce') return [];
      // Throws propagate deliberately: an unenumerable deny set must fail the
      // sandbox launch, never silently launch with the artifacts readable.
      return store.listActiveArtifactPaths();
    },

    listEnforcedArtifactIdentities(): string[] {
      if (mode !== 'enforce') return [];
      return store.listActiveArtifactIdentities();
    },

    check(path: string, context: { via: string }): QuarantinedArtifactCheckResult {
      return checkMany([path], context).verdicts[0]!;
    },

    checkMany,

    readRevisionToken: () => store.readRevisionToken(),
  };
}

/**
 * Fleet-wide view over companion-owned quarantine stores.
 *
 * The guard deliberately has no caller-companion filter: a held artifact is a
 * physical gateway deny regardless of which authenticated companion invokes
 * fs.read, fs.search, or shell.exec. Each child store reloads from disk per
 * operation, so this union stays current without sharing mutable snapshots.
 */
export function createUnionQuarantinedArtifactAccessGuard(
  options: UnionQuarantinedArtifactAccessGuardOptions,
): QuarantinedArtifactAccessGuard {
  if (options.stores.length === 0) {
    throw new Error('Fleet quarantined-artifact access guard requires at least one store');
  }
  const guards = options.stores.map(store => createQuarantinedArtifactAccessGuard({
    store,
    mode: options.mode,
    ...(options.now ? { now: options.now } : {}),
  }));
  const checkMany = (
    paths: readonly string[],
    context: { via: string },
    checkOptions?: QuarantinedArtifactPhysicalCheckOptions,
  ): QuarantinedArtifactBatchCheckResult => {
    const aggregate = paths.map<QuarantinedArtifactCheckResult>(() => ({ withheld: false }));
    const revisions: string[] = [];
    for (const guard of guards) {
      const checked = guard.checkMany(paths, context, checkOptions);
      revisions.push(checked.revisionToken);
      checked.verdicts.forEach((verdict, index) => {
        if (verdict.withheld && !aggregate[index]!.withheld) aggregate[index] = verdict;
      });
    }
    return { verdicts: aggregate, revisionToken: revisions.join('|') };
  };
  const readRevisionToken = (): string => guards
    .map(guard => guard.readRevisionToken())
    .join('|');

  return {
    check(path, context) {
      return checkMany([path], context).verdicts[0]!;
    },

    checkMany,

    readRevisionToken,

    listEnforcedArtifactPaths() {
      if (options.mode !== 'enforce') return [];
      const paths = new Set<string>();
      // A failure from any store propagates: the gateway cannot launch a
      // sandbox while even one companion's physical deny set is unknown.
      for (const guard of guards) {
        for (const path of guard.listEnforcedArtifactPaths()) {
          paths.add(path);
        }
      }
      return [...paths];
    },

    listEnforcedArtifactIdentities() {
      if (options.mode !== 'enforce') return [];
      const identities = new Set<string>();
      for (const guard of guards) {
        for (const identity of guard.listEnforcedArtifactIdentities()) {
          identities.add(identity);
        }
      }
      return [...identities];
    },
  };
}
