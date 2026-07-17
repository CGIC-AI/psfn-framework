#!/usr/bin/env tsx

import '../../shared/utils/load-dotenv.js';
import { loadConfig } from '../../system/config/load-config.js';
import { hydrateSecretBearingConfig } from '../startup/support/bootstrap-helpers.js';
import { resolveStartupPreflightBundle } from '../startup/support/startup-preflight.js';
import { RUNTIME_MODE } from '../../system/lifecycle/runtime-mode.js';
import { createComponentLogger } from '../../shared/logger.js';
import { initializeGatewayFleetAuthPersistence } from '../../persistence/postgres/fleet-auth/gateway-persistence.js';
import type { TrustedHostPasskeyCeremonyKind } from '../../boundary/fleet-auth/trusted-host-passkey-ceremony.js';
import { toErrorMessage } from '../../shared/utils/errors.js';

interface CliOptions {
  kind: TrustedHostPasskeyCeremonyKind;
  providerSubjectId: string;
  companionId?: string;
  contactId?: string;
  priorCredentialIdHash?: string;
}

function usage(): void {
  console.log('Usage: npm run fleet-auth:passkey-ceremony -- --kind <kind> --provider-subject <discord-id> [scope]');
  console.log('Kinds: first_owner, passkey_enrollment, passkey_recovery');
  console.log('first_owner requires --companion-id and --contact-id.');
  console.log('passkey_recovery requires --prior-credential-hash.');
  console.log('The command prints the single-use browser nonce once; it never accepts ADMIN_TOKEN/psfn_token.');
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    process.exit(0);
  }
  const values = new Map<string, string>();
  const allowed = new Set([
    '--kind',
    '--provider-subject',
    '--companion-id',
    '--contact-id',
    '--prior-credential-hash',
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name || !allowed.has(name) || !value || value.startsWith('--') || values.has(name)) {
      throw new Error('Arguments must be unique exact --name value pairs');
    }
    values.set(name, value);
  }
  const kind = values.get('--kind');
  const providerSubjectId = values.get('--provider-subject');
  if ((kind !== 'first_owner' && kind !== 'passkey_enrollment' && kind !== 'passkey_recovery')
    || !providerSubjectId) {
    throw new Error('--kind and --provider-subject are required');
  }
  return {
    kind,
    providerSubjectId,
    ...(values.get('--companion-id') ? { companionId: values.get('--companion-id')! } : {}),
    ...(values.get('--contact-id') ? { contactId: values.get('--contact-id')! } : {}),
    ...(values.get('--prior-credential-hash')
      ? { priorCredentialIdHash: values.get('--prior-credential-hash')! }
      : {}),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const env = process.env;
  const config = loadConfig(env);
  await hydrateSecretBearingConfig(config, { env });
  const logger = createComponentLogger('PasskeyCeremony');
  const { startupHydration } = resolveStartupPreflightBundle(config, {
    entrypoint: RUNTIME_MODE.GATEWAY_AGENT,
    env,
    logger,
  });
  if (!config.fleetAuth || !config.companionFleet || !config.credentialVault) {
    throw new Error('Fleet auth, companion fleet, and gateway credential vault are required');
  }
  const protectedRestoreRoots = [
    startupHydration.pathSnapshot.systemDataDir,
    startupHydration.pathSnapshot.companionDataDir,
    startupHydration.pathSnapshot.workspacePath,
    startupHydration.pathSnapshot.runtimePathLayout.backupsDir,
  ];
  const persistence = await initializeGatewayFleetAuthPersistence({
    config: config.fleetAuth,
    credentialVault: config.credentialVault,
    knownCompanionIds: config.companionFleet.companions.map(companion => companion.companionId),
    protectedRestoreRoots,
    lifecycleWitnessRoot: startupHydration.pathSnapshot.systemDataDir,
    ...(config.postgresDatabaseUrl ? { companionDatabaseUrl: config.postgresDatabaseUrl } : {}),
    discordEvidenceObserver: { observe: async () => ({ status: 'bot_absent' }) },
  });
  if (!persistence) throw new Error('Fleet auth persistence is unavailable');
  try {
    const created = await persistence.passkeyCeremonies.create({
      kind: options.kind,
      expectedProviderSubjectId: options.providerSubjectId,
      ...(options.companionId ? { expectedCompanionId: options.companionId } : {}),
      ...(options.contactId ? { expectedContactId: options.contactId } : {}),
      ...(options.priorCredentialIdHash
        ? { priorCredentialIdHash: options.priorCredentialIdHash }
        : {}),
    });
    console.log(JSON.stringify({
      schemaVersion: 1,
      ceremonyId: created.ceremonyId,
      kind: created.kind,
      nonce: created.nonce,
      expiresAt: created.expiresAt.toISOString(),
      browserStartPath: '/v1/fleet-auth/passkeys/registration/start',
    }, null, 2));
  } finally {
    await persistence.close();
  }
}

main().catch((error: unknown) => {
  console.error(`Passkey ceremony creation failed: ${toErrorMessage(error)}`);
  process.exitCode = 1;
});
