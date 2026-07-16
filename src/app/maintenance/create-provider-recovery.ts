#!/usr/bin/env tsx

import '../../shared/utils/load-dotenv.js';
import { loadConfig } from '../../system/config/load-config.js';
import { hydrateSecretBearingConfig } from '../startup/support/bootstrap-helpers.js';
import { resolveStartupPreflightBundle } from '../startup/support/startup-preflight.js';
import { RUNTIME_MODE } from '../../system/lifecycle/runtime-mode.js';
import { createComponentLogger } from '../../shared/logger.js';
import { initializeGatewayFleetAuthPersistence } from '../../persistence/postgres/fleet-auth/gateway-persistence.js';
import { isCanonicalIsoTimestamp } from '../../shared/utils/types.js';
import { toErrorMessage } from '../../shared/utils/errors.js';

interface CliOptions {
  companionId: string;
  principalId: string;
  currentProviderSubjectId: string;
  currentProviderAuthorityGeneration: number;
  expectedNewProviderSubjectId: string;
  reason: string;
  expiresAt: Date;
}

function usage(): void {
  process.stdout.write([
    'Usage: npm run fleet-auth:provider-recovery -- --companion-id <uuid> --principal-id <uuid> --current-provider-subject <discord-id> --current-provider-version <integer> --new-provider-subject <discord-id> --reason <text> --expires-at <ISO>',
    'Creates one exact, short-lived provider.recover grant on the trusted host.',
    'The command emits its one-time result only on success; legacy authorization arguments are rejected.',
    '',
  ].join('\n'));
}

export function parseProviderRecoveryArgs(argv: string[]): CliOptions {
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    process.exit(0);
  }
  const allowed = new Set([
    '--companion-id',
    '--principal-id',
    '--current-provider-subject',
    '--current-provider-version',
    '--new-provider-subject',
    '--reason',
    '--expires-at',
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name || !allowed.has(name) || !value || value.startsWith('--') || values.has(name)) {
      throw new Error('Arguments must be unique exact --name value pairs');
    }
    values.set(name, value);
  }
  if (values.size !== allowed.size) throw new Error('All provider recovery arguments are required');
  const version = Number(values.get('--current-provider-version'));
  const expiresAtValue = values.get('--expires-at');
  if (!Number.isSafeInteger(version) || version < 1
    || !expiresAtValue || !isCanonicalIsoTimestamp(expiresAtValue)) {
    throw new Error('Provider version and expiry are invalid');
  }
  return {
    companionId: values.get('--companion-id')!,
    principalId: values.get('--principal-id')!,
    currentProviderSubjectId: values.get('--current-provider-subject')!,
    currentProviderAuthorityGeneration: version,
    expectedNewProviderSubjectId: values.get('--new-provider-subject')!,
    reason: values.get('--reason')!,
    expiresAt: new Date(expiresAtValue),
  };
}

async function main(): Promise<void> {
  const options = parseProviderRecoveryArgs(process.argv.slice(2));
  const env = process.env;
  const config = loadConfig(env);
  await hydrateSecretBearingConfig(config, { env });
  const logger = createComponentLogger('ProviderRecovery');
  const { startupHydration } = resolveStartupPreflightBundle(config, {
    entrypoint: RUNTIME_MODE.GATEWAY_AGENT,
    env,
    logger,
  });
  if (!config.fleetAuth || !config.companionFleet || !config.credentialVault) {
    throw new Error('Fleet auth, companion fleet, and gateway credential vault are required');
  }
  const persistence = await initializeGatewayFleetAuthPersistence({
    config: config.fleetAuth,
    credentialVault: config.credentialVault,
    knownCompanionIds: config.companionFleet.companions.map(companion => companion.companionId),
    protectedRestoreRoots: [
      startupHydration.pathSnapshot.systemDataDir,
      startupHydration.pathSnapshot.companionDataDir,
      startupHydration.pathSnapshot.workspacePath,
      startupHydration.pathSnapshot.runtimePathLayout.backupsDir,
    ],
    lifecycleWitnessRoot: startupHydration.pathSnapshot.systemDataDir,
    ...(config.postgresDatabaseUrl ? { companionDatabaseUrl: config.postgresDatabaseUrl } : {}),
    discordEvidenceObserver: { observe: async () => ({ status: 'bot_absent' }) },
  });
  if (!persistence) throw new Error('Fleet auth persistence is unavailable');
  try {
    const created = await persistence.providerRecovery.create(options);
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      action: 'provider.recover',
      ceremonyId: created.ceremonyId,
      oneTimeCredential: created.oneTimeCredential,
      expiresAt: created.expiresAt.toISOString(),
      oauthStartPath: '/v1/fleet-auth/lifecycle/oauth',
      webAuthnStartPath: '/v1/fleet-auth/provider-recovery/webauthn/start',
    }, null, 2)}\n`);
  } finally {
    await persistence.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    process.stderr.write(`Provider recovery creation failed: ${toErrorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
