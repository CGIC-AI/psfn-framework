/**
 * Supervisor launcher helper: resolve the validated multi-companion fleet and
 * emit a machine-parseable spawn plan for `scripts/start-gateway-agent.sh`.
 *
 * The launcher sources `.env` into this process's environment before invoking
 * this helper, so — like `src/app/agent/main.ts` — this script does NOT import
 * dotenv. It reflects the already-loaded launcher environment.
 *
 * Single source of truth: path resolution reuses `resolveRuntimePathLayout`
 * (identical to `load-config.ts`) and validation reuses the canonical
 * `resolveCompanionFleet`. There is deliberately NO duplicate path-resolution or
 * validation logic here or in the launcher shell script.
 *
 * Fail-closed contract (inherited verbatim from `resolveCompanionFleet`):
 *   - PSFN_MULTI_COMPANION on  + companions.json missing/invalid => throw (exit != 0)
 *   - PSFN_MULTI_COMPANION off + companions.json present         => throw (exit != 0)
 *
 * Output contract (stdout):
 *   - Single-companion topology (fleet resolves to undefined): print NOTHING.
 *     The launcher reads empty stdout as "stay in single-agent mode".
 *   - Multi-companion topology: one line per companion, fields tab-separated in
 *     the order companionId, companionDataDir, characterCardPath, postgresSchema,
 *     companionAuthToken, sessionIntegrityAuthToken, adminTransportSocket,
 *     gardenPort. gardenPort is "-" when the companion has
 *     no Garden operator surface configured (companions.json gardenPort absent).
 *     Tabs/newlines inside any field are rejected (fail closed) so the launcher
 *     can parse the plan with a plain `IFS=$'\t' read`.
 *
 * Per-companion Garden support (sprint-10 W4): each companion's admin transport
 * socket is derived here via `resolveCompanionAdminTransportSocketPath` — the
 * launcher never derives socket names itself. Network admin transport mode is
 * rejected fail-closed: per-companion Gardens currently support socket mode only.
 */
import { resolveRuntimePathLayout } from '../src/persistence/layout.js';
import {
  isMultiCompanionEnabled,
  resolveCompanionFleet,
  resolveCompanionFleetPaths,
  type ResolvedCompanionFleetEntry,
} from '../src/system/config/companions-config.js';
import {
  resolveAdminTransportMode,
  resolveCompanionAdminTransportSocketPath,
} from '../src/operator/garden/transport-paths.js';
import { requireGatewaySessionHmacKeyring } from '../src/boundary/gateway/session-hmac-env.js';
import { deriveCompanionAuthToken } from '../src/boundary/gateway/companion-auth.js';

const FIELD_SEPARATOR = '\t';
const NO_GARDEN_PORT_SENTINEL = '-';

function assertPlanSafe(value: string, field: string, companionId: string): void {
  if (value.includes(FIELD_SEPARATOR) || value.includes('\n') || value.includes('\r')) {
    throw new Error(
      `Companion ${companionId}: ${field} must not contain tab or newline characters `
      + '(the supervisor spawn plan is tab-delimited, one companion per line).',
    );
  }
}

function formatPlanLine(
  entry: ResolvedCompanionFleetEntry,
  companionAuthToken: string,
  sessionIntegrityAuthToken: string,
  env: NodeJS.ProcessEnv,
): string {
  const adminTransportSocket = resolveCompanionAdminTransportSocketPath(entry.companionId, env);
  const fields: Array<[string, string]> = [
    ['companionId', entry.companionId],
    ['companionDataDir', entry.companionDataDir],
    ['characterCardPath', entry.characterCardPath],
    ['postgresSchema', entry.postgresSchema],
    ['companionAuthToken', companionAuthToken],
    ['sessionIntegrityAuthToken', sessionIntegrityAuthToken],
    ['adminTransportSocket', adminTransportSocket],
    [
      'gardenPort',
      entry.gardenPort !== undefined ? String(entry.gardenPort) : NO_GARDEN_PORT_SENTINEL,
    ],
  ];
  for (const [field, value] of fields) {
    assertPlanSafe(value, field, entry.companionId);
  }
  return fields.map(([, value]) => value).join(FIELD_SEPARATOR);
}

function main(): void {
  const env = process.env;

  // Mirror load-config.ts exactly so the fleet manifest is read from the same
  // resolved system-data root the runtime itself uses.
  const runtimePathLayout = resolveRuntimePathLayout({
    mode: env.PSFN_RUNTIME_LAYOUT_MODE,
    nodeEnv: env.NODE_ENV,
    runtimeRootDir: env.PSFN_RUNTIME_ROOT,
    systemDataDir: env.SYSTEM_DATA_DIR,
    companionDataDir: env.COMPANION_DATA_DIR,
    legacyDataDir: env.DATA_DIR,
    workspacePath: env.WORKSPACE_PATH,
    logsDir: env.PSFN_LOGS_DIR,
    tempDir: env.PSFN_TEMP_DIR,
    backupsDir: env.BACKUP_ROOT_DIR,
  });

  const multiCompanion = isMultiCompanionEnabled(env);
  const rawFleet = resolveCompanionFleet({
    dataDir: runtimePathLayout.systemDataDir,
    multiCompanion,
    seedDir: env.CONFIG_DIR?.trim() ? env.CONFIG_DIR : undefined,
  });

  if (!rawFleet) {
    // Single-companion topology: emit nothing; the launcher keeps its existing
    // single-agent behavior byte-identically.
    return;
  }
  const fleet = resolveCompanionFleetPaths(rawFleet, runtimePathLayout.runtimeRootDir);

  // Per-companion Gardens bind one admin transport socket per agent process;
  // a single shared network admin transport cannot serve N agents. Fail closed
  // rather than letting every agent race to bind the same listener.
  if (resolveAdminTransportMode(env) !== 'socket') {
    throw new Error(
      'Multi-companion mode requires ADMIN_TRANSPORT_MODE=socket: per-companion Garden '
      + 'admin transports are socket-scoped (one garden-admin-<companionId>.sock per agent).',
    );
  }

  const keyring = requireGatewaySessionHmacKeyring(env);
  const plan = fleet.companions.map((entry) => formatPlanLine(
    entry,
    deriveCompanionAuthToken(entry.companionId, 'agent', keyring),
    deriveCompanionAuthToken(entry.companionId, 'internal_session_integrity', keyring),
    env,
  )).join('\n');
  process.stdout.write(`${plan}\n`);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[resolve-companion-fleet] ${message}\n`);
  process.exit(1);
}
