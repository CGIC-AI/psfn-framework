#!/usr/bin/env tsx

import '../../shared/utils/load-dotenv.js';
import { loadConfig } from '../../system/config/load-config.js';
import { hydrateSecretBearingConfig } from '../startup/support/bootstrap-helpers.js';
import { resolveStartupPreflightBundle } from '../startup/support/startup-preflight.js';
import { RUNTIME_MODE } from '../../system/lifecycle/runtime-mode.js';
import { createComponentLogger } from '../../shared/logger.js';
import { initializeGatewayFleetAuthPersistence } from '../../persistence/postgres/fleet-auth/gateway-persistence.js';
import { toErrorMessage } from '../../shared/utils/errors.js';

interface CliOptions {
  providerSubjectId: string;
  principalId: string;
  companionId: string;
  contactId: string;
  bindingId: string;
  roleGrantId: string;
  reason: string;
}

const ARGUMENTS = new Set([
  '--provider-subject',
  '--principal-id',
  '--companion-id',
  '--contact-id',
  '--binding-id',
  '--role-grant-id',
  '--reason',
]);

function usage(): void {
  console.log('Usage: npm run fleet-auth:account-reapproval -- [exact restored authority]');
  console.log('Required: --provider-subject --principal-id --companion-id --contact-id');
  console.log('          --binding-id --role-grant-id --reason');
  console.log('The command prints one single-use nonce. It cannot enroll or recover a passkey.');
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    process.exit(0);
  }
  if (argv.length !== ARGUMENTS.size * 2) {
    throw new Error('Every account reapproval argument is required exactly once');
  }
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name || !ARGUMENTS.has(name) || !value || value.startsWith('--') || values.has(name)) {
      throw new Error('Arguments must be unique exact --name value pairs');
    }
    values.set(name, value);
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (!value) throw new Error(`Missing required ${name}`);
    return value;
  };
  return {
    providerSubjectId: required('--provider-subject'),
    principalId: required('--principal-id'),
    companionId: required('--companion-id'),
    contactId: required('--contact-id'),
    bindingId: required('--binding-id'),
    roleGrantId: required('--role-grant-id'),
    reason: required('--reason'),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const env = process.env;
  const config = loadConfig(env);
  await hydrateSecretBearingConfig(config, { env });
  const logger = createComponentLogger('AccountReapprovalCeremony');
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
    const created = await persistence.accountReapprovalCeremonies.create({
      expectedProviderSubjectId: options.providerSubjectId,
      expectedPrincipalId: options.principalId,
      expectedCompanionId: options.companionId,
      expectedContactId: options.contactId,
      expectedBindingId: options.bindingId,
      expectedRoleGrantId: options.roleGrantId,
      reason: options.reason,
    });
    console.log(JSON.stringify({
      schemaVersion: 1,
      ceremonyId: created.ceremonyId,
      kind: 'account_reapproval',
      nonce: created.nonce,
      expiresAt: created.expiresAt.toISOString(),
      providerProof: {
        startPath: '/v1/fleet-auth/lifecycle/oauth',
        action: 'provider.relink',
        proofRole: 'new',
        ceremonyId: created.ceremonyId,
      },
      webAuthnStartPath: '/v1/fleet-auth/account-reapproval/webauthn/start',
      webAuthnFinishPath: '/v1/fleet-auth/account-reapproval/webauthn/finish',
      reauthenticationRequiredAfterCompletion: true,
    }, null, 2));
  } finally {
    await persistence.close();
  }
}

main().catch((error: unknown) => {
  console.error(`Account reapproval ceremony creation failed: ${toErrorMessage(error)}`);
  process.exitCode = 1;
});
