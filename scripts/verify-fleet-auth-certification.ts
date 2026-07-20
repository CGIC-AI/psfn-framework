#!/usr/bin/env tsx

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

interface CertificationPhase {
  name: string;
  proves: string;
  files: readonly string[];
  vitestOptions?: readonly string[];
}

const phases: readonly CertificationPhase[] = [
  {
    name: 'gateway-and-multi-principal',
    proves: 'gateway-only OAuth/session authority, two companions and principals, request binding, replay, IDOR, logout, and revocation',
    files: [
      'src/app/e2e/fleet-sso-unified-origin.integration.test.ts',
      'src/app/e2e/multi-companion-e2e.test.ts',
      'src/app/gateway/api-surface.fleet-portal.test.ts',
      'src/app/gateway/fleet-auth-wiring.test.ts',
      'src/boundary/fleet-auth/request-capability.test.ts',
      'src/boundary/fleet-auth/request-capability-replay.test.ts',
      'src/boundary/fleet-auth/request-capability-target.test.ts',
      'src/boundary/gateway/fleet-auth-broker.test.ts',
      'src/boundary/gateway/fleet-auth-child-assertions.test.ts',
      'src/boundary/gateway/fleet-sso-router.test.ts',
      'src/channels/api/server/fleet-auth-child-assertion-route.test.ts',
      'src/channels/api/server/fleet-auth-routes.test.ts',
    ],
  },
  {
    name: 'discord-device-and-companion-ui',
    proves: 'Discord hard veto, authoritative device identity, Companion UI attachment, enabled legacy rejection, and feature-off parity',
    files: [
      'src/boundary/fleet-auth/companion-ui-action.test.ts',
      'src/boundary/fleet-auth/discord-evidence-lifecycle.test.ts',
      'src/boundary/fleet-auth/discord-evidence-runtime.test.ts',
      'src/boundary/fleet-auth/discord-evidence-terminal-authority.test.ts',
      'src/boundary/fleet-auth/hub-device-assertion.test.ts',
      'src/boundary/fleet-auth/hub-device-ingress.test.ts',
      'src/boundary/gateway/companion-ui-action-broker.test.ts',
      'src/boundary/gateway/companion-ui-primary-embodiment.test.ts',
      'src/channels/api/companion-ui-websocket.test.ts',
      'src/channels/api/server/fleet-auth-recovery-routes.e2e.test.ts',
      'src/app/e2e/fleet-garden-cutover-certification.integration.test.ts',
      'src/system/config/fleet-auth-legacy-surface-guard.test.ts',
    ],
  },
  {
    name: 'ceremonies-and-subject-privacy',
    proves: 'first owner, provider recovery, UV passkeys, self/co-subject JIT, non-subject break-glass, and stale privacy denial',
    files: [
      'src/boundary/fleet-auth/jit-step-up.test.ts',
      'src/boundary/fleet-auth/lifecycle-ceremony.test.ts',
      'src/boundary/fleet-auth/recovery-request-capability.test.ts',
      'src/boundary/fleet-auth/trusted-host-account-reapproval.test.ts',
      'src/boundary/fleet-auth/trusted-host-passkey-ceremony.test.ts',
      'src/boundary/fleet-auth/trusted-host-provider-recovery.test.ts',
      'src/channels/api/server/fleet-auth-account-reapproval-routes.test.ts',
      'src/channels/api/server/fleet-auth-jit-routes.test.ts',
      'src/channels/api/server/fleet-auth-lifecycle-ceremony-routes.test.ts',
      'src/channels/api/server/fleet-auth-passkey-routes.test.ts',
      'src/channels/api/server/fleet-auth-provider-recovery-routes.test.ts',
      'src/faculties/memory/postgres-store/subject-policy.test.ts',
      'src/faculties/memory/subject-authorized-store.test.ts',
      'src/operator/garden/api-routes-memory.test.ts',
      'src/operator/garden/garden-request-context.test.ts',
      'src/operator/garden/routes/privacy-break-glass-routes.test.ts',
      'src/operator/garden/services/privacy-break-glass-service.test.ts',
      'src/shared/contracts/memory-subject-jit.test.ts',
    ],
  },
  {
    name: 'durable-postgres-and-restore',
    proves: 'provider lifecycle races, account/passkey floors, restore quarantine, assertion replay, and privacy projection invalidation',
    files: [
      'src/faculties/memory/postgres-store.integration.test.ts',
      'src/persistence/backups/fleet-auth-family-restore.integration.test.ts',
      'src/persistence/backups/fleet-restore.integration.test.ts',
      'src/persistence/postgres/fleet-auth/authority-lifecycle-store.integration.test.ts',
      'src/persistence/postgres/fleet-auth/authorization-context-store.integration.test.ts',
      'src/persistence/postgres/fleet-auth/gateway-persistence.integration.test.ts',
      'src/persistence/postgres/fleet-auth/schema.integration.test.ts',
      'src/persistence/postgres/fleet-auth/trusted-host-provider-recovery-store.integration.test.ts',
    ],
    vitestOptions: ['--maxWorkers=1', '--no-file-parallelism'],
  },
];

function assertCertificationManifest(): void {
  const seen = new Set<string>();
  for (const phase of phases) {
    if (phase.files.length === 0) throw new Error(`Certification phase ${phase.name} is empty`);
    for (const file of phase.files) {
      if (seen.has(file)) throw new Error(`Certification suite is duplicated: ${file}`);
      seen.add(file);
      if (!existsSync(resolve(file))) throw new Error(`Certification suite is missing: ${file}`);
    }
  }
}

function runPhase(phase: CertificationPhase): void {
  process.stdout.write(`\n[fleet-auth-certification] ${phase.name}\n${phase.proves}\n`);
  const result = spawnSync(process.execPath, [
    resolve('node_modules/vitest/vitest.mjs'),
    'run',
    ...(phase.vitestOptions ?? []),
    ...phase.files,
  ], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Certification phase ${phase.name} ended on ${result.signal}`);
  if (result.status !== 0) {
    throw new Error(`Certification phase ${phase.name} failed with exit ${String(result.status)}`);
  }
}

assertCertificationManifest();
for (const phase of phases) runPhase(phase);
process.stdout.write('\n[fleet-auth-certification] all deterministic phases passed\n');
