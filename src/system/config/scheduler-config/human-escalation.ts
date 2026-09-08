// ── Human escalation routing policy and ledger bounds (beads
// psfn-framework-bznbn, psfn-framework-yu03d) ──
//
// Which kinds of "a human is needed" reach a person how, how often, and how
// much of that history the runtime keeps. The control plane and its durable
// ledger own no routing or retention literal: they read this block, so an
// operator changes where an escalation goes, and how long an answered one is
// kept, without a release.
//
// It lives in `scheduler.json` beside `healthDetectors.incidentAlerts` because
// that is already where this runtime's alert cadence and delivery policy live.
// Splitting escalation cadence into a second owner file would mean an operator
// has to reconcile two clocks in two files to answer one question — how often
// does this runtime interrupt me.
//
// The block is validated as a whole because the routes are not independent of
// the rest of the file:
//
//   * `runtime_incident` must carry a zero cooldown. The incident alert path
//     owns a longer, evidence-aware clock (`healthDetectors.incidentAlerts.
//     realertCooldownMs`) that survives a restart by re-anchoring on the
//     persisted health stream. A second cooldown here could only ever fight it,
//     and the loser would be an operator who never hears that a fault is still
//     going. Rejecting the value is the only honest option.
//   * A `garden_only` route must carry a zero cooldown, because nothing is
//     sent: throttling a notice that does not exist would read as a policy the
//     runtime honours and is not.
//
// Quiet hours are deliberately absent. The runtime defines quiet hours for
// companion-initiated outreach (`scheduler.json` `episodicProcessing`), and
// only there; the operator-alert contracts define none. Inventing one for
// operator escalation would mean silently withholding a page during the hours a
// runtime is least watched, which is a policy nobody has asked for and no
// existing contract expresses.

import {
  HUMAN_ESCALATION_KINDS,
  HUMAN_ESCALATION_LIMITS,
  HUMAN_ESCALATION_SINKS,
  isHumanEscalationSinkId,
  type HumanEscalationKind,
  type HumanEscalationLedgerBounds,
  type HumanEscalationSinkId,
} from '../../../shared/escalation/contracts.js';
import { isRecord } from '../../../shared/utils/types.js';
import { assertNoUnknownKeys } from '../validators.js';
import { toNonNegativeInteger, toPositiveInteger } from './primitives.js';

interface HumanEscalationRouteConfig {
  /** Where a raised escalation of this kind goes. */
  sink: HumanEscalationSinkId;
  /**
   * Minimum gap between two notices about the SAME condition. Zero means the
   * raising domain owns deduplication for this kind.
   */
  cooldownMs: number;
}

export interface HumanEscalationConfig {
  /** Exactly one route per declared escalation kind; a missing kind rejects. */
  routes: Readonly<Record<HumanEscalationKind, HumanEscalationRouteConfig>>;
  /** Rows the Garden attention surface reads per refresh. */
  listLimit: number;
  /** Durable ledger bounds; required, with no built-in fallback. */
  retention: HumanEscalationLedgerBounds;
}

export const DEFAULT_HUMAN_ESCALATION_CONFIG: HumanEscalationConfig = {
  routes: {
    // The incident path already pages once per incident and re-anchors its own
    // cooldown on the persisted stream; the plane adds the durable ledger and
    // the operator surface, not a second clock.
    runtime_incident: { sink: 'operator_alert', cooldownMs: 0 },
    // The confirmation queue and CogSec quarantine have never paged an
    // operator. Routing them to the Garden surface is what makes adopting the
    // control plane a no-op for their current behaviour.
    operator_confirmation: { sink: 'garden_only', cooldownMs: 0 },
    cogsec_quarantine: { sink: 'garden_only', cooldownMs: 0 },
  },
  listLimit: 100,
  retention: {
    // A week is the window in which an operator reviewing what this runtime
    // asked about still has the surrounding context to judge it.
    resolvedRetentionMs: 604_800_000,
    maxResolvedRowsPerKind: 256,
    maxAttemptsPerEscalation: 64,
    maxOpenRowsPerKind: 128,
  },
};

function requireObject(raw: unknown, sourcePath: string, field: string): Record<string, unknown> {
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: ${field} must be an object`);
  }
  return raw;
}

function validateRoute(
  raw: unknown,
  sourcePath: string,
  kind: HumanEscalationKind,
): HumanEscalationRouteConfig {
  const field = `humanEscalation.routes.${kind}`;
  const route = requireObject(raw, sourcePath, field);
  assertNoUnknownKeys(route, ['sink', 'cooldownMs'], `${sourcePath}.${field}`, {
    errorPrefix: 'Invalid scheduler config',
  });
  if (!isHumanEscalationSinkId(route.sink)) {
    throw new Error(
      `Invalid scheduler config at ${sourcePath}: ${field}.sink must be one of `
      + `${HUMAN_ESCALATION_SINKS.join(', ')}`,
    );
  }
  const cooldownMs = toNonNegativeInteger(route.cooldownMs, `${field}.cooldownMs`);
  if (route.sink === 'garden_only' && cooldownMs !== 0) {
    throw new Error(
      `Invalid scheduler config at ${sourcePath}: ${field}.cooldownMs must be 0 when the route `
      + 'sink is garden_only; nothing is sent, so a cooldown would describe a throttle the '
      + 'runtime never applies',
    );
  }
  return { sink: route.sink, cooldownMs };
}

/**
 * Fail closed on every bound. There is no built-in fallback and no partial
 * block: a ledger that persists what a runtime asked a human must never come up
 * without a declared bound, and a half-declared block is an operator edit that
 * was interrupted, not a policy.
 */
function validateRetention(raw: unknown, sourcePath: string): HumanEscalationLedgerBounds {
  const field = 'humanEscalation.retention';
  const retention = requireObject(raw, sourcePath, field);
  assertNoUnknownKeys(
    retention,
    [
      'resolvedRetentionMs',
      'maxResolvedRowsPerKind',
      'maxAttemptsPerEscalation',
      'maxOpenRowsPerKind',
    ],
    `${sourcePath}.${field}`,
    { errorPrefix: 'Invalid scheduler config' },
  );
  const maxResolvedRowsPerKind = toPositiveInteger(
    retention.maxResolvedRowsPerKind,
    `${field}.maxResolvedRowsPerKind`,
    1,
  );
  const maxOpenRowsPerKind = toPositiveInteger(
    retention.maxOpenRowsPerKind,
    `${field}.maxOpenRowsPerKind`,
    1,
  );
  return {
    resolvedRetentionMs: toPositiveInteger(
      retention.resolvedRetentionMs,
      `${field}.resolvedRetentionMs`,
      1,
    ),
    maxResolvedRowsPerKind,
    maxAttemptsPerEscalation: toPositiveInteger(
      retention.maxAttemptsPerEscalation,
      `${field}.maxAttemptsPerEscalation`,
      1,
    ),
    maxOpenRowsPerKind,
  };
}

export function validateHumanEscalationConfig(
  raw: unknown,
  sourcePath: string,
  crossChecks: { incidentRealertCooldownMs: number },
): HumanEscalationConfig {
  const root = requireObject(raw, sourcePath, 'humanEscalation');
  assertNoUnknownKeys(
    root,
    ['routes', 'listLimit', 'retention'],
    `${sourcePath}.humanEscalation`,
    { errorPrefix: 'Invalid scheduler config' },
  );
  const routesRaw = requireObject(root.routes, sourcePath, 'humanEscalation.routes');
  assertNoUnknownKeys(
    routesRaw,
    [...HUMAN_ESCALATION_KINDS],
    `${sourcePath}.humanEscalation.routes`,
    { errorPrefix: 'Invalid scheduler config' },
  );

  const routes = {} as Record<HumanEscalationKind, HumanEscalationRouteConfig>;
  for (const kind of HUMAN_ESCALATION_KINDS) {
    if (routesRaw[kind] === undefined) {
      throw new Error(
        `Invalid scheduler config at ${sourcePath}: humanEscalation.routes.${kind} is required; `
        + 'every declared escalation kind must name a sink so an unrouted kind can never be '
        + 'raised into silence',
      );
    }
    routes[kind] = validateRoute(routesRaw[kind], sourcePath, kind);
  }

  if (routes.runtime_incident.sink !== 'operator_alert') {
    throw new Error(
      `Invalid scheduler config at ${sourcePath}: humanEscalation.routes.runtime_incident.sink `
      + `must be operator_alert (got ${routes.runtime_incident.sink}); a runtime incident that `
      + 'only lands on a page nobody is watching is the operator_alert_sinks_unconfigured fault '
      + 'under another name, and the Garden incident timeline already lists every incident under '
      + 'the id its alert carried',
    );
  }
  if (routes.runtime_incident.cooldownMs !== 0) {
    throw new Error(
      `Invalid scheduler config at ${sourcePath}: humanEscalation.routes.runtime_incident`
      + `.cooldownMs must be 0 (got ${routes.runtime_incident.cooldownMs}); runtime incidents `
      + 'are deduplicated by healthDetectors.incidentAlerts.realertCooldownMs '
      + `(${crossChecks.incidentRealertCooldownMs}), which re-anchors on the persisted health `
      + 'stream across a restart. A second cooldown here can only suppress the re-alert that '
      + 'tells an operator a fault is still going',
    );
  }

  const listLimit = toPositiveInteger(root.listLimit, 'humanEscalation.listLimit', 1);
  if (listLimit > HUMAN_ESCALATION_LIMITS.maxListLimit) {
    throw new Error(
      `Invalid scheduler config at ${sourcePath}: humanEscalation.listLimit (${listLimit}) `
      + `must not exceed the escalation ledger's structural read ceiling `
      + `(${HUMAN_ESCALATION_LIMITS.maxListLimit})`,
    );
  }

  return { routes, listLimit, retention: validateRetention(root.retention, sourcePath) };
}
