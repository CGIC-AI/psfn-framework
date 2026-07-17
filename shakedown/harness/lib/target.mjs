// Deployment-target abstraction for the shakedown harness.
//
// The harness runs against either a locally bootstrapped split runtime
// (`PSFN_TARGET=local`, the 65rk.1 default) or Artie's live kube deployment
// (`PSFN_TARGET=kube`). This module is the single place that resolves the
// transport contract — {chat base URL, admin/Garden base URL, gateway API key,
// Garden admin token, Postgres connection} — from the fail-closed env for both
// targets. There are no hardcoded cluster literals: the kube target reaches the
// gateway (:10053) and Garden (:10054) through operator-provided port-forward
// URLs in PSFN_API_BASE / PSFN_ADMIN_BASE exactly the way the local target does,
// so nothing here ever names a namespace, service, or /mnt path.
//
// It also owns the kube tier-flip: on kube the capability tier must be changed
// LIVE through the Garden settings API (PATCH /api/admin/settings
// {capabilityTier}) — never by editing capability-tier.json on the PVC — and the
// hot-reload must be confirmed by re-reading the setting before the tier's cases
// run. The tier sweep script (run-live-shakedown-matrix.sh) drives these through
// the CLI at the bottom of this file so its signal-safe revert can call them.

import {
  requireEnv,
  requireEnvOneOf,
  optionalEnv,
  optionalIntEnv,
  InvalidEnvError,
  MissingEnvError,
  failClosedOnEnv,
} from './env.mjs';
import { probeGatewayReady } from './probe.mjs';
import { assertPostgresReachable, closePool } from './postgres.mjs';

export const TARGET_LOCAL = 'local';
export const TARGET_KUBE = 'kube';
const KNOWN_TARGETS = new Set([TARGET_LOCAL, TARGET_KUBE]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resolve the deployment target from PSFN_TARGET. Defaults to `local` to keep
 * the 65rk.1 behavior byte-identical when the variable is unset; any value other
 * than `local`/`kube` is a named, fail-closed error.
 */
export function resolveTargetName(env = process.env) {
  const raw = (optionalEnv('PSFN_TARGET', TARGET_LOCAL) ?? TARGET_LOCAL).toLowerCase();
  if (!KNOWN_TARGETS.has(raw)) {
    throw new InvalidEnvError('PSFN_TARGET', `expected 'local' or 'kube', got ${JSON.stringify(raw)}`);
  }
  return raw;
}

/**
 * Resolve the full transport contract for the active target. Every required
 * value is read fail-closed — a missing one throws a MissingEnvError naming it,
 * so an unset variable exits non-zero at the entrypoint that resolves it. The
 * kube hints spell out the port-forward the operator must stand up.
 */
export function resolveTarget(env = process.env) {
  const target = resolveTargetName(env);
  const isKube = target === TARGET_KUBE;
  const chatHint = isKube
    ? 'kube gateway API base — port-forward svc <gateway>:10053 to this URL'
    : 'gateway API base URL';
  const adminHint = isKube
    ? 'kube Garden admin base — port-forward svc <garden>:10054 to this URL'
    : 'Garden admin base URL';
  return {
    target,
    isKube,
    chatBaseUrl: requireEnv('PSFN_API_BASE', chatHint),
    adminBaseUrl: requireEnv('PSFN_ADMIN_BASE', adminHint),
    apiKey: requireEnvOneOf(['API_KEY', 'PSFN_API_KEY'], 'gateway API key'),
    adminToken: requireEnvOneOf(['ADMIN_TOKEN', 'PSFN_ADMIN_TOKEN'], 'Garden admin token'),
    postgresUrl: requireEnv('POSTGRES_DATABASE_URL', 'the round Postgres database'),
    tierFlipConfirmTimeoutMs: optionalIntEnv('PSFN_TIER_FLIP_CONFIRM_TIMEOUT_MS', 30000),
    tierFlipPollMs: optionalIntEnv('PSFN_TIER_FLIP_POLL_MS', 1500),
  };
}

function adminAuthHeaders(adminToken) {
  return { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' };
}

/**
 * Read the live capability tier from the Garden settings API. The tier is a
 * non-runtime settings key, so it is exposed under `editors.capabilities.tier`
 * (settings-service.getSettingsData → loadSettingsConfigEditors), which reads
 * the persisted capability-tier.json fresh — the exact file the runtime
 * hot-reloads on mtime change. Throws loudly on any transport/shape failure so
 * an unconfirmable flip never runs cases against an unknown tier.
 */
export async function fetchCurrentTier({ adminBaseUrl, adminToken }, timeoutMs = 15000) {
  const url = `${adminBaseUrl}/api/admin/settings`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let rawText;
  try {
    response = await fetch(url, { headers: adminAuthHeaders(adminToken), signal: controller.signal });
    rawText = await response.text();
  } catch (error) {
    throw new Error(`GET ${url} failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`GET ${url} returned HTTP ${response.status}: ${rawText.slice(0, 400)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error(`GET ${url} returned non-JSON body: ${rawText.slice(0, 400)}`);
  }
  const tier = parsed?.editors?.capabilities?.tier;
  if (typeof tier !== 'string' || tier.trim().length === 0) {
    throw new Error(`GET ${url} response is missing editors.capabilities.tier`);
  }
  return tier.trim();
}

/**
 * Flip the capability tier through the settings API (PATCH capabilityTier) and
 * confirm the persisted hot-reload took effect by polling the GET read-back
 * until it reports the requested tier. A PATCH that returns non-2xx, or a flip
 * the read-back never confirms within the timeout, is a hard error — the sweep
 * must never run a tier's cases against an unconfirmed flip.
 */
export async function setTierAndConfirm({
  adminBaseUrl,
  adminToken,
  tier,
  confirmTimeoutMs = 30000,
  pollMs = 1500,
}) {
  const requested = typeof tier === 'string' ? tier.trim() : '';
  if (requested.length === 0) {
    throw new Error('setTierAndConfirm requires a non-empty tier');
  }
  const url = `${adminBaseUrl}/api/admin/settings`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let response;
  let rawText;
  try {
    response = await fetch(url, {
      method: 'PATCH',
      headers: adminAuthHeaders(adminToken),
      body: JSON.stringify({ capabilityTier: requested }),
      signal: controller.signal,
    });
    rawText = await response.text();
  } catch (error) {
    throw new Error(`PATCH ${url} {capabilityTier:${requested}} failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`PATCH ${url} {capabilityTier:${requested}} returned HTTP ${response.status}: ${rawText.slice(0, 400)}`);
  }

  const deadline = Date.now() + confirmTimeoutMs;
  let observed = null;
  for (;;) {
    observed = await fetchCurrentTier({ adminBaseUrl, adminToken });
    if (observed === requested) return requested;
    if (Date.now() >= deadline) break;
    await sleep(pollMs);
  }
  throw new Error(
    `capability tier flip to '${requested}' not confirmed within ${confirmTimeoutMs}ms; `
    + `settings API still reports '${observed}'`,
  );
}

// ---------------------------------------------------------------------------
// CLI: the tier sweep script drives the kube tier-flip and its signal-safe
// revert through these subcommands. Each is fail-closed and single-purpose so
// the shell trap can call `set-tier <original>` on EXIT/INT/TERM and treat a
// non-zero exit as a hard failed-revert error.
// ---------------------------------------------------------------------------

async function cliMain(argv) {
  const [command, ...rest] = argv;
  switch (command) {
    case 'resolve': {
      const contract = resolveTarget();
      // Never print secrets — only the shape the operator needs to eyeball.
      process.stdout.write(`${JSON.stringify({
        target: contract.target,
        chatBaseUrl: contract.chatBaseUrl,
        adminBaseUrl: contract.adminBaseUrl,
        apiKeyPresent: contract.apiKey.length > 0,
        adminTokenPresent: contract.adminToken.length > 0,
        postgresUrlPresent: contract.postgresUrl.length > 0,
      })}\n`);
      return;
    }
    case 'get-tier': {
      const contract = resolveTarget();
      const tier = await fetchCurrentTier(contract);
      process.stdout.write(`${tier}\n`);
      return;
    }
    case 'set-tier': {
      const tier = rest[0];
      if (typeof tier !== 'string' || tier.trim().length === 0) {
        process.stderr.write('set-tier requires a tier argument (e.g. set-tier nursery)\n');
        process.exit(2);
      }
      const contract = resolveTarget();
      const confirmed = await setTierAndConfirm({
        adminBaseUrl: contract.adminBaseUrl,
        adminToken: contract.adminToken,
        tier,
        confirmTimeoutMs: contract.tierFlipConfirmTimeoutMs,
        pollMs: contract.tierFlipPollMs,
      });
      process.stdout.write(`${confirmed}\n`);
      return;
    }
    case 'check-gateway': {
      const contract = resolveTarget();
      const result = await probeGatewayReady({ base: contract.chatBaseUrl, apiKey: contract.apiKey });
      if (!result.ok) {
        throw new Error(
          `gateway not reachable at ${contract.chatBaseUrl} (${result.detail ?? `HTTP ${result.status}`}); `
          + 'is the :10053 port-forward up?',
        );
      }
      process.stdout.write('ok\n');
      return;
    }
    case 'check-postgres': {
      // Resolve the target first so a missing URL fails closed naming it.
      resolveTarget();
      try {
        await assertPostgresReachable();
      } finally {
        await closePool();
      }
      process.stdout.write('ok\n');
      return;
    }
    default:
      process.stderr.write(
        'usage: target.mjs <resolve|get-tier|set-tier <tier>|check-gateway|check-postgres>\n',
      );
      process.exit(2);
  }
}

// Only run the CLI when executed directly, never when imported as a library.
if (import.meta.url === `file://${process.argv[1]}`) {
  cliMain(process.argv.slice(2)).catch((error) => {
    if (error instanceof MissingEnvError || error instanceof InvalidEnvError) {
      failClosedOnEnv(error);
      return;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
