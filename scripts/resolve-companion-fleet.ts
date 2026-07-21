/**
 * Supervisor launcher helper: resolve the validated companion fleet and
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
 *   - companions.json missing or invalid => throw (exit != 0). The manifest is
 *     mandatory for every deployment (a single-companion install is a one-entry
 *     fleet); there is no flag-gated single mode.
 *
 * Output contract (stdout):
 *   - One line per companion, fields tab-separated in
 *     the order companionId, companionDataDir, characterCardPath, postgresSchema,
 *     personalWorkspacePath, companionAuthToken, sessionIntegrityAuthToken,
 *     databaseUrl, adminTransportSocket.
 *     Tabs/newlines inside any field are rejected (fail closed) so the launcher
 *     can parse the plan with a plain `IFS=$'\t' read`.
 *
 * The local fleet Garden target registry derives and validates every companion's
 * admin transport socket before the launcher starts. The launcher never derives
 * socket names itself and local network admin transport mode is rejected.
 */
import {
  type ResolvedCompanionFleetEntry,
} from '../src/system/config/companions-config.js';
import {
  type FleetGardenTargetIdentity,
} from '../src/operator/garden/fleet-garden-target-registry.js';
import { FleetGardenAdminTransportProxy } from '../src/operator/garden/fleet-transport-client.js';
import { requireGatewaySessionHmacKeyring } from '../src/boundary/gateway/session-hmac-env.js';
import { deriveCompanionAuthToken } from '../src/boundary/gateway/companion-auth.js';
import { resolveConfiguredLocalCompanionFleetRuntime } from './companion-fleet-runtime.js';
import { createCredentialVaultFromEnvironment } from '../src/boundary/custody/credential-vault.js';
import { resolveCompanionDatabaseTopology } from '../src/system/config/companion-database-config.js';

const FIELD_SEPARATOR = '\t';

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
  target: FleetGardenTargetIdentity,
  companionAuthToken: string,
  sessionIntegrityAuthToken: string,
  databaseUrl: string,
): string {
  if (target.companionId !== entry.companionId || target.endpoint.mode !== 'socket') {
    throw new Error(
      `Companion ${entry.companionId}: validated fleet Garden target identity is incomplete`,
    );
  }
  const fields: Array<[string, string]> = [
    ['companionId', entry.companionId],
    ['companionDataDir', entry.companionDataDir],
    ['characterCardPath', entry.characterCardPath],
    ['postgresSchema', entry.postgresSchema],
    ['personalWorkspacePath', entry.personalWorkspacePath],
    ['companionAuthToken', companionAuthToken],
    ['sessionIntegrityAuthToken', sessionIntegrityAuthToken],
    ['databaseUrl', databaseUrl],
    ['adminTransportSocket', target.endpoint.socketPath],
  ];
  for (const [field, value] of fields) {
    assertPlanSafe(value, field, entry.companionId);
  }
  return fields.map(([, value]) => value).join(FIELD_SEPARATOR);
}

async function probeFleetAdminTransports(
  runtime: NonNullable<ReturnType<typeof resolveConfiguredLocalCompanionFleetRuntime>>,
): Promise<void> {
  const transport = new FleetGardenAdminTransportProxy(runtime.targetRegistry);
  try {
    await transport.probeAll();
    const unavailable = runtime.targetRegistry.readiness()
      .filter(target => target.health.status !== 'ready');
    if (unavailable.length > 0) {
      throw new Error(
        `Fleet Garden agent admin transports are not ready: ${unavailable
          .map(target => `${target.companionId}(${target.health.status})`)
          .join(', ')}`,
      );
    }
  } finally {
    await new Promise<void>((resolve) => transport.close(resolve));
  }
}

async function main(): Promise<void> {
  const env = process.env;

  const runtime = resolveConfiguredLocalCompanionFleetRuntime(env);
  const mode = process.argv[2];
  if (mode === '--probe-ready') {
    await probeFleetAdminTransports(runtime);
    return;
  }
  if (mode !== undefined) {
    throw new Error(`Unknown argument ${JSON.stringify(mode)}`);
  }
  const keyring = requireGatewaySessionHmacKeyring(env);
  const gatewayDatabaseUrl = env.POSTGRES_DATABASE_URL?.trim();
  if (!gatewayDatabaseUrl) {
    throw new Error('Companion fleet launcher requires POSTGRES_DATABASE_URL for the gateway');
  }
  const databaseTopology = resolveCompanionDatabaseTopology({
    fleet: runtime.fleet,
    credentialVault: await createCredentialVaultFromEnvironment(env),
    gatewayDatabaseUrl,
  });
  const databaseByCompanionId = new Map(databaseTopology.companions.map(entry => (
    [entry.companion.companionId, entry.databaseUrl] as const
  )));
  const plan = runtime.fleet.companions.map((entry) => {
    const databaseUrl = databaseByCompanionId.get(entry.companionId);
    if (!databaseUrl) {
      throw new Error(`Companion ${entry.companionId} has no resolved database credential`);
    }
    return formatPlanLine(
      entry,
      runtime.targetRegistry.resolve(entry.companionId),
      deriveCompanionAuthToken(entry.companionId, 'agent', keyring),
      deriveCompanionAuthToken(entry.companionId, 'internal_session_integrity', keyring),
      databaseUrl,
    );
  }).join('\n');
  process.stdout.write(`${plan}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[resolve-companion-fleet] ${message}\n`);
  process.exit(1);
});
