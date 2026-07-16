// ── k3d end-to-end: self-update -> validate -> auto/manual rollback (x5rt.9) ──
//
// Drives the composed operator-job flow (runKubeSelfUpdateJob) against a REAL,
// disposable k3d cluster using real helm + kubectl + docker. It proves the
// x5rt.6/.7/.8 seams are wired live, not dead code:
//
//   1. deploy a known-good rollout       -> validation passes, no rollback
//   2. deploy a deliberately-broken one  -> validation FAILS
//                                        -> auto-rollback fires EXACTLY ONCE
//                                        -> the release recovers
//                                        -> a second evaluation is already_acted (no loop)
//   3. manual operator-approved rollback through the x5rt.4 approval boundary
//
// GATING: this suite requires a k3d cluster + docker daemon and is therefore
// skipped unless PSFN_K3D_E2E is set. Normal `npm test` / CI unit runs collect it
// but never execute it, so they need no cluster. The deterministic composition
// wiring is unit-tested with fakes in
// src/system/lifecycle/kube-self-update-job.test.ts (the mandatory gate); this is
// the live proof. Run it with:
//
//   PSFN_K3D_E2E=1 ./node_modules/.bin/vitest run src/app/e2e/kube-self-update-e2e.test.ts
//
// It provisions and tears down its own `psfn-x5rt9-e2e-<pid>` cluster and never
// touches an operator-managed cluster, live namespaces, or any real PVC.

import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfirmationQueue } from '../../system/capabilities/confirmation-queue.js';
import { KubeSelfManagementController } from '../../system/lifecycle/kube-self-management.js';
import { createKubeHelmRollbackExecutor } from '../../system/lifecycle/kube-helm-rollback.js';
import {
  runKubeSelfUpdateJob,
  type KubeSelfUpdateJobOptions,
} from '../../system/lifecycle/kube-self-update-job.js';
import { executeAutoRollback } from '../../system/lifecycle/kube-auto-rollback.js';
import type { DeployPipelineRunner } from '../../system/lifecycle/kube-deploy-pipeline.js';
import type { PostRolloutValidationRunner, RawCheckResult } from '../../system/lifecycle/kube-post-rollout-validation.js';
import {
  createLiveHelmRollbackApi,
  createLiveRollbackTargetResolver,
  readHelmHistory,
  type CommandRunner,
} from '../operator/kube-self-update-transport.js';
import { readKubeRollbackHistory } from '../../system/lifecycle/kube-rollback-store.js';
import { isDeploymentRolloutComplete } from '../../system/lifecycle/kube-rollout-restart.js';

const E2E_ENABLED = Boolean(process.env.PSFN_K3D_E2E?.trim());
const COMMIT = 'a'.repeat(40);
const NAMESPACE = 'psfn';
const RELEASE = 'psfn';
const RESOURCE_PREFIX = 'psfn'; // chart names the workload `${RESOURCE_PREFIX}-agent`
const CLUSTER = `psfn-x5rt9-e2e-${process.pid}`;
const IMAGE = 'localhost/psfn-x5rt9-e2e:app';

const run: CommandRunner = (file, args, options = {}) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        cwd: options.cwd,
        env: options.env ?? process.env,
        timeout: options.timeoutMs ?? 300_000,
        maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error && typeof (error as { code?: unknown }).code !== 'number') { reject(error); return; }
        resolve({ code: error ? Number((error as { code: number }).code) : 0, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

async function sh(command: string, cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return run('sh', ['-c', command], cwd ? { cwd } : undefined);
}
async function shOk(command: string, cwd?: string): Promise<string> {
  const r = await sh(command, cwd);
  if (r.code !== 0) throw new Error(`command failed (${command}): ${r.stderr || r.stdout}`);
  return r.stdout;
}

const helm = { run } as const;

async function currentRevision(): Promise<number> {
  const history = await readHelmHistory(helm, NAMESPACE, RELEASE);
  return Math.max(...history.map(h => h.revision));
}

async function agentReady(): Promise<boolean> {
  const r = await run('kubectl', ['get', 'deployment', `${RESOURCE_PREFIX}-agent`, '-n', NAMESPACE, '-o', 'json']);
  if (r.code !== 0) return false;
  const json = JSON.parse(r.stdout) as {
    metadata?: { generation?: number };
    spec?: { replicas?: number };
    status?: { observedGeneration?: number; readyReplicas?: number; updatedReplicas?: number; availableReplicas?: number };
  };
  return isDeploymentRolloutComplete({
    name: `${RESOURCE_PREFIX}-agent`,
    generation: json.metadata?.generation ?? 0,
    observedGeneration: json.status?.observedGeneration ?? 0,
    desiredReplicas: json.spec?.replicas ?? 0,
    readyReplicas: json.status?.readyReplicas ?? 0,
    updatedReplicas: json.status?.updatedReplicas ?? 0,
    availableReplicas: json.status?.availableReplicas ?? 0,
  });
}

async function pollAgentReady(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await agentReady()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(r => setTimeout(r, 2_000));
  }
}

let workDir: string;
let systemDataDir: string;
let chartDir: string;

// A test deploy runner that performs the REAL helm upgrade of the test chart (no
// --wait, so a broken command still records a revision the post-rollout gate then
// catches). The good/broken selection is carried by the command override.
function testDeployRunner(command: string[]): DeployPipelineRunner {
  return {
    verifyPreconditions: async () => ({ workingTreeClean: true, backupVerified: true }),
    archiveSource: async () => ({ sha256: 'b'.repeat(64) }),
    runGate: async () => ({ passed: true }),
    buildImage: async () => ({}), // image built once in beforeAll
    importImage: async () => undefined, // imported once in beforeAll
    validateOnK3d: async () => ({ passed: true }),
    captureLiveValues: async () => {
      const r = await run('helm', ['get', 'values', RELEASE, '-n', NAMESPACE, '-o', 'json']);
      const parsed: unknown = r.code === 0 ? JSON.parse(r.stdout.trim() || 'null') : null;
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    },
    helmUpgrade: async () => {
      const commandJson = JSON.stringify(command);
      const r = await run('helm', [
        'upgrade', '--install', RELEASE, chartDir, '-n', NAMESPACE, '--create-namespace',
        '--set', `image=${IMAGE}`,
        '--set-json', `command=${commandJson}`,
      ]);
      if (r.code !== 0) throw new Error(`helm upgrade failed: ${r.stderr || r.stdout}`);
      return { helmRevision: await currentRevision() };
    },
  };
}

// Test validation runner: the required rollout/readiness checks reflect the REAL
// deployment state (bounded poll); the app-internal probes pass so the flow hinges
// on the deliberately-broken workload actually failing to become ready.
function testValidationRunner(readinessTimeoutMs: number): PostRolloutValidationRunner {
  const PASS: RawCheckResult = { verdict: 'pass' };
  const rollout = async (): Promise<RawCheckResult> =>
    (await pollAgentReady(readinessTimeoutMs))
      ? { verdict: 'pass' }
      : { verdict: 'fail', detail: 'agent deployment did not become ready' };
  return {
    checkRolloutStatus: rollout,
    checkAgentReadiness: rollout,
    checkGardenHealth: async () => PASS,
    checkModelRoute: async () => PASS,
    checkPgVector: async () => PASS,
    checkRedis: async () => PASS,
    checkChatTurnProbe: async () => PASS,
    fetchToolConformance: async () => ({ skippedReason: 'conformance out of scope for the k3d control-flow e2e' }),
    fetchDiagnostics: async () => ({
      schemaVersion: 1,
      generatedAt: Date.now(),
      window: { sinceMs: 0, untilMs: Date.now(), windowMs: 1000, limit: 20, includeFileLogs: false, logsDir: '/app/logs' },
      sources: [],
      agentLog: { status: 'available', counts: { warn: 0, error: 0, total: 0 }, records: [] },
      fileLogs: { status: 'unavailable', reason: 'e2e' },
      toolValidationFailures: { status: 'available', total: 0, byTool: [] },
      lifecycle: { status: 'available', events: [] },
      rollout: { status: 'unavailable', reason: 'e2e' },
      pods: { status: 'unavailable', reason: 'e2e' },
      backup: { status: 'available', counts: { success: 0, failure: 0, total: 0 }, lastSuccess: null, lastFailure: null, recent: [] },
    }),
  };
}

function jobOptions(command: string[], readinessTimeoutMs: number): KubeSelfUpdateJobOptions {
  return {
    plan: {
      action: 'deploy',
      namespace: NAMESPACE,
      release: RELEASE,
      sourceBranch: 'e2e',
      sourceCommit: COMMIT,
      imageRepository: 'localhost/psfn-x5rt9-e2e',
      imageTag: 'app',
      k3dValidation: { mode: 'skip', reason: 'imported once in setup' },
    },
    systemDataDir,
    resourcePrefix: RESOURCE_PREFIX,
    deployRunner: testDeployRunner(command),
    postRolloutValidationRunner: testValidationRunner(readinessTimeoutMs),
    autoRollback: {
      api: createLiveHelmRollbackApi(helm),
      resolveRollbackTarget: createLiveRollbackTargetResolver({ ...helm, namespace: NAMESPACE, release: RELEASE }),
      waitTimeoutMs: 180_000,
      pollIntervalMs: 3_000,
    },
  };
}

describe.skipIf(!E2E_ENABLED)('kube self-update e2e (k3d)', () => {
  beforeAll(async () => {
    for (const bin of ['k3d', 'kubectl', 'helm', 'docker']) {
      const which = await sh(`command -v ${bin}`);
      if (which.code !== 0) throw new Error(`PSFN_K3D_E2E is set but required binary '${bin}' is missing`);
    }
    workDir = mkdtempSync(join(tmpdir(), 'psfn-x5rt9-e2e-'));
    systemDataDir = join(workDir, 'system-data');
    mkdirSync(systemDataDir, { recursive: true });

    // A trivial image whose behaviour is chosen at runtime by the container command.
    writeFileSync(join(workDir, 'Dockerfile'), 'FROM alpine:3.20\nCMD ["sleep", "3600"]\n');
    await shOk(`docker build -t ${IMAGE} ${workDir}`);

    await shOk(`k3d cluster create ${CLUSTER} --wait --timeout 180s`);
    await shOk(`k3d image import ${IMAGE} -c ${CLUSTER}`);

    // Minimal chart: one Deployment named `${RESOURCE_PREFIX}-agent` with a
    // configurable image + command. A bad command yields CrashLoopBackOff.
    chartDir = join(workDir, 'chart');
    mkdirSync(join(chartDir, 'templates'), { recursive: true });
    writeFileSync(join(chartDir, 'Chart.yaml'), 'apiVersion: v2\nname: psfn-e2e\nversion: 0.1.0\n');
    writeFileSync(join(chartDir, 'values.yaml'), `image: ${IMAGE}\ncommand: ["sleep", "3600"]\n`);
    writeFileSync(join(chartDir, 'templates', 'deployment.yaml'), [
      'apiVersion: apps/v1',
      'kind: Deployment',
      'metadata:',
      `  name: ${RESOURCE_PREFIX}-agent`,
      'spec:',
      '  replicas: 1',
      '  selector:',
      '    matchLabels: { app.kubernetes.io/component: agent }',
      '  template:',
      '    metadata:',
      '      labels: { app.kubernetes.io/component: agent }',
      '    spec:',
      '      containers:',
      '        - name: app',
      '          image: {{ .Values.image }}',
      '          imagePullPolicy: IfNotPresent',
      '          command: {{ toJson .Values.command }}',
      '',
    ].join('\n'));
  }, 300_000);

  afterAll(async () => {
    if (CLUSTER) await sh(`k3d cluster delete ${CLUSTER}`);
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  }, 120_000);

  it('deploys a known-good rollout that validates healthy with no rollback', async () => {
    const result = await runKubeSelfUpdateJob(jobOptions(['sleep', '3600'], 120_000));
    expect(result.pipeline.outcome).toBe('succeeded');
    expect(result.autoRollback.status).toBe('healthy');
    expect(readKubeRollbackHistory(systemDataDir)).toEqual([]);
    expect(await agentReady()).toBe(true);
  }, 300_000);

  it('rolls back a broken rollout exactly once, recovers, and does not loop', async () => {
    const goodRevision = await currentRevision();

    const broken = await runKubeSelfUpdateJob(jobOptions(['sh', '-c', 'exit 1'], 30_000));
    expect(broken.pipeline.outcome).toBe('failed');
    expect(broken.pipeline.failedStage).toBe('post_rollout_validation');
    expect(broken.autoRollback.status).toBe('rolled_back');
    const failedRevision = broken.pipeline.helmRevision as number;

    const ledger = readKubeRollbackHistory(systemDataDir);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ trigger: 'automatic', outcome: 'succeeded', fromHelmRevision: failedRevision });

    // The release recovered to the known-good workload.
    expect(await pollAgentReady(120_000)).toBe(true);
    const history = await readHelmHistory(helm, NAMESPACE, RELEASE);
    expect(Math.max(...history.map(h => h.revision))).toBeGreaterThan(goodRevision);

    // A second evaluation over the SAME failed rollout must be already_acted: the
    // persisted failed verdict still binds to it, but the act-once ledger blocks a
    // second rollback (no loop). This is the direct safety-net re-evaluation.
    const secondEval = await executeAutoRollback({
      namespace: NAMESPACE,
      release: RELEASE,
      resourcePrefix: RESOURCE_PREFIX,
      systemDataDir,
      currentRollout: { release: RELEASE, helmRevision: failedRevision, sourceCommit: COMMIT },
      api: createLiveHelmRollbackApi(helm),
      resolveRollbackTarget: createLiveRollbackTargetResolver({ ...helm, namespace: NAMESPACE, release: RELEASE }),
    });
    expect(secondEval.status).toBe('surfaced');
    expect(secondEval).toMatchObject({ reasonCode: 'already_acted' });
    expect(readKubeRollbackHistory(systemDataDir)).toHaveLength(1);
  }, 600_000);

  it('performs a manual operator-approved rollback through the x5rt.4 boundary', async () => {
    // Ensure at least two good revisions exist to roll between.
    await runKubeSelfUpdateJob(jobOptions(['sleep', '3600'], 120_000));
    const history = await readHelmHistory(helm, NAMESPACE, RELEASE);
    const target = Math.max(...history.filter(h => h.status === 'superseded').map(h => h.revision));

    const queue = new ConfirmationQueue();
    const controller = new KubeSelfManagementController({
      namespace: NAMESPACE,
      release: RELEASE,
      executor: createKubeHelmRollbackExecutor({
        namespace: NAMESPACE,
        release: RELEASE,
        resourcePrefix: RESOURCE_PREFIX,
        api: createLiveHelmRollbackApi(helm),
        waitTimeoutMs: 180_000,
        pollIntervalMs: 3_000,
      }),
      audit: async () => undefined,
    });

    const response = await controller.invoke({
      actor: 'companion',
      params: {
        action: 'rollback', namespace: NAMESPACE, release: RELEASE,
        sourceRevision: COMMIT, targetImage: IMAGE,
        helmRevision: target, reason: 'e2e manual rollback',
      },
      approvals: { enqueue: async (request, runOnApprove) => queue.enqueue(request, runOnApprove) },
    });
    expect(response).toMatchObject({ status: 'approval_required' });

    // Operator approves; the executor enacts the live helm rollback.
    const resolution = await queue.resolve(
      { id: (response as { approvalId: string }).approvalId, decision: 'approve' },
      { kind: 'operator', id: 'garden-admin' },
    );
    expect(resolution).toMatchObject({ executed: true });
    expect(await pollAgentReady(120_000)).toBe(true);
  }, 600_000);
});
