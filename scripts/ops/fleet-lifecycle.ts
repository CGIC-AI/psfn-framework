#!/usr/bin/env node
// Companion fleet lifecycle CLI (h248l.5): dry-run plan, digest-approved apply,
// explicit resume, and progress. A thin client of src/system/fleet-lifecycle;
// the Fleet UI drives the same reconciler and contracts.
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { parseArgs } from 'node:util';

import { resolveRuntimePathLayout } from '../../src/persistence/layout.js';
import { resolveFleetAuthOwnerFile } from '../../src/system/config/fleet-auth-config.js';
import { FleetLifecycleError } from '../../src/system/fleet-lifecycle/contracts.js';
import {
  openFleetLifecycleRuntime,
  type FleetLifecycleDeployment,
} from '../../src/system/fleet-lifecycle/composition.js';
import {
  createKubectlReadExecutor,
  parseKubernetesFleetWorkloadBinding,
} from '../../src/system/fleet-lifecycle/kubernetes-adapter.js';
import { planFleetLifecycle } from '../../src/system/fleet-lifecycle/plan.js';
import { applyFleetLifecyclePlan } from '../../src/system/fleet-lifecycle/reconciler.js';

const USAGE = `Usage: npm run ops:fleet-lifecycle -- <command> [options]

Commands:
  plan --request <file.json>              Dry run: compute and store a plan; prints it.
  apply --plan <id> --approve <digest>    Apply an approved plan (add --resume to continue).
  progress --plan <id>                    Show stored plan progress.
  list                                    List stored plan ids.

Deployment (default local):
  --deployment kubernetes --kube-context <ctx> --kube-namespace <ns>
    --chart-fullname <name> --app-secret <name> [--workload-binding <file.json>]

Requests carry companions.json entry metadata and credential references only.
Removal retains schema, data, workspace, and backups; purge is separate.`;

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function requireOption(values: Record<string, unknown>, name: string): string {
  const value = values[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new FleetLifecycleError('invalid_request', `--${name} is required`);
  }
  return value;
}

function deploymentFrom(values: Record<string, unknown>): FleetLifecycleDeployment {
  if (values.deployment === undefined || values.deployment === 'local') return { kind: 'local' };
  if (values.deployment !== 'kubernetes') {
    throw new FleetLifecycleError('invalid_request', '--deployment must be local or kubernetes');
  }
  return {
    kind: 'kubernetes',
    executor: createKubectlReadExecutor({
      context: requireOption(values, 'kube-context'),
      namespace: requireOption(values, 'kube-namespace'),
    }),
    chartFullname: requireOption(values, 'chart-fullname'),
    appSecretName: requireOption(values, 'app-secret'),
    ...(typeof values['workload-binding'] === 'string'
      ? { binding: parseKubernetesFleetWorkloadBinding(readJsonFile(values['workload-binding'])) }
      : {}),
  };
}

async function main(argv: readonly string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      request: { type: 'string' },
      plan: { type: 'string' },
      approve: { type: 'string' },
      resume: { type: 'boolean', default: false },
      deployment: { type: 'string' },
      'kube-context': { type: 'string' },
      'kube-namespace': { type: 'string' },
      'chart-fullname': { type: 'string' },
      'app-secret': { type: 'string' },
      'workload-binding': { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const env = process.env;
  const layout = resolveRuntimePathLayout({
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
  const fleetAuth = resolveFleetAuthOwnerFile({
    dataDir: layout.systemDataDir,
    processMode: 'gateway',
    env,
    ...(env.CONFIG_DIR?.trim() ? { seedDir: env.CONFIG_DIR } : {}),
  });
  const runtime = openFleetLifecycleRuntime({
    systemDataDir: layout.systemDataDir,
    persistenceRoot: layout.runtimeRootDir,
    env,
    ...(fleetAuth ? { fleetAuthConfig: fleetAuth.config } : {}),
    deployment: deploymentFrom(values),
  });
  try {
    let output: unknown;
    switch (command) {
      case 'plan': {
        const plan = await planFleetLifecycle({
          request: readJsonFile(requireOption(values, 'request')),
          topology: runtime.ports.topology,
          icpFence: runtime.ports.icpFence,
        });
        runtime.store.savePlan(plan);
        output = plan;
        break;
      }
      case 'apply':
        output = await applyFleetLifecyclePlan({
          planId: requireOption(values, 'plan'),
          approval: { planDigest: requireOption(values, 'approve') },
          resume: values.resume === true,
          store: runtime.store,
          ports: runtime.ports,
        });
        break;
      case 'progress':
        output = runtime.store.progress(requireOption(values, 'plan'));
        break;
      case 'list':
        output = runtime.store.listPlanIds();
        break;
      default:
        throw new FleetLifecycleError('invalid_request', `Unknown command ${command}`);
    }
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } finally {
    await runtime.close();
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const code = error instanceof FleetLifecycleError ? error.code : 'stage_error';
  const stage = error instanceof FleetLifecycleError && error.stageId ? ` at ${error.stageId}` : '';
  process.stderr.write(`[fleet-lifecycle] ${code}${stage}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
