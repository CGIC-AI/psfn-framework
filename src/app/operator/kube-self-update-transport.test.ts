import { describe, expect, it, vi } from 'vitest';
import {
  createLiveDeployPipelineRunner,
  createLiveHelmRollbackApi,
  createLiveRollbackTargetResolver,
  readHelmHistory,
  type CommandResult,
  type CommandRunner,
} from './kube-self-update-transport.js';

function helmHistoryJson(entries: Array<{ revision: number; status: string }>): string {
  return JSON.stringify(entries.map(e => ({ revision: e.revision, status: e.status, updated: '2026-07-15' })));
}

function runner(handlers: Array<{ match: (file: string, args: readonly string[]) => boolean; result: CommandResult }>): {
  run: CommandRunner;
  calls: Array<{ file: string; args: string[] }>;
} {
  const calls: Array<{ file: string; args: string[] }> = [];
  const run: CommandRunner = async (file, args) => {
    calls.push({ file, args: [...args] });
    const handler = handlers.find(h => h.match(file, args));
    if (!handler) throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
    return handler.result;
  };
  return { run, calls };
}

const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: '' });
const err = (stderr: string): CommandResult => ({ code: 1, stdout: '', stderr });

describe('createLiveRollbackTargetResolver (helm history seam)', () => {
  it('picks the highest known-good revision strictly earlier than the failed one', async () => {
    const { run } = runner([{
      match: (f, a) => f === 'helm' && a.includes('history'),
      result: ok(helmHistoryJson([
        { revision: 5, status: 'superseded' },
        { revision: 6, status: 'superseded' },
        { revision: 7, status: 'failed' }, // a failed rollout is never a target
        { revision: 8, status: 'deployed' }, // the current (failed) revision under test
      ])),
    }]);
    const resolve = createLiveRollbackTargetResolver({ run, namespace: 'psfn', release: 'psfn' });
    await expect(resolve(8)).resolves.toEqual({ kind: 'target', targetRevision: 6 });
  });

  it('never selects a failed revision as the rollback target', async () => {
    const { run } = runner([{
      match: (f, a) => f === 'helm' && a.includes('history'),
      result: ok(helmHistoryJson([
        { revision: 6, status: 'failed' },
        { revision: 7, status: 'failed' },
      ])),
    }]);
    const resolve = createLiveRollbackTargetResolver({ run, namespace: 'psfn', release: 'psfn' });
    await expect(resolve(8)).resolves.toEqual({ kind: 'no_previous_revision' });
  });

  it('returns no_previous_revision when nothing is strictly earlier', async () => {
    const { run } = runner([{
      match: (f, a) => f === 'helm' && a.includes('history'),
      result: ok(helmHistoryJson([{ revision: 1, status: 'deployed' }])),
    }]);
    const resolve = createLiveRollbackTargetResolver({ run, namespace: 'psfn', release: 'psfn' });
    await expect(resolve(1)).resolves.toEqual({ kind: 'no_previous_revision' });
  });
});

describe('createLiveHelmRollbackApi', () => {
  it('runs helm rollback --wait and reads back the resulting revision', async () => {
    const { run, calls } = runner([
      { match: (f, a) => f === 'helm' && a.includes('rollback'), result: ok('Rollback was a success!') },
      {
        match: (f, a) => f === 'helm' && a.includes('history'),
        result: ok(helmHistoryJson([
          { revision: 8, status: 'superseded' },
          { revision: 9, status: 'deployed' },
        ])),
      },
    ]);
    const api = createLiveHelmRollbackApi({ run });
    await expect(api.rollback('psfn', 'psfn', 7)).resolves.toEqual({ helmRevision: 9 });
    const rollbackCall = calls.find(c => c.args.includes('rollback'));
    expect(rollbackCall?.args).toEqual(expect.arrayContaining(['rollback', 'psfn', '7', '-n', 'psfn', '--wait']));
  });

  it('fails closed when helm rollback exits non-zero', async () => {
    const { run } = runner([
      { match: (f, a) => f === 'helm' && a.includes('rollback'), result: err('release not found') },
    ]);
    const api = createLiveHelmRollbackApi({ run });
    await expect(api.rollback('psfn', 'psfn', 7)).rejects.toThrow(/helm rollback failed/);
  });

  it('maps a Deployment JSON to the readiness diagnostic', async () => {
    const { run } = runner([{
      match: (f, a) => f === 'kubectl' && a.includes('get'),
      result: ok(JSON.stringify({
        metadata: { generation: 3 },
        spec: { replicas: 2 },
        status: { observedGeneration: 3, readyReplicas: 2, updatedReplicas: 2, availableReplicas: 2 },
      })),
    }]);
    const api = createLiveHelmRollbackApi({ run });
    await expect(api.getDeployment('psfn', 'psfn-agent')).resolves.toEqual({
      name: 'psfn-agent',
      generation: 3,
      observedGeneration: 3,
      desiredReplicas: 2,
      readyReplicas: 2,
      updatedReplicas: 2,
      availableReplicas: 2,
    });
  });

  it('rejects an invalid namespace before shelling out', async () => {
    const run = vi.fn();
    const api = createLiveHelmRollbackApi({ run: run as unknown as CommandRunner });
    await expect(api.rollback('Bad_NS', 'psfn', 7)).rejects.toThrow(/must be a DNS label/);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('createLiveDeployPipelineRunner', () => {
  it('takes ownership of existing chart-declared resources during Helm upgrade', async () => {
    const { run, calls } = runner([
      { match: (f, a) => f === 'helm' && a.includes('upgrade'), result: ok('upgrade complete') },
      {
        match: (f, a) => f === 'helm' && a.includes('history'),
        result: ok(helmHistoryJson([{ revision: 12, status: 'deployed' }])),
      },
    ]);
    const deploy = createLiveDeployPipelineRunner({
      run,
      repoDir: '/repo',
      dockerfile: 'docker/Dockerfile.agent',
      buildContext: '.',
      chartPath: 'deploy/helm/psfn',
      importImage: async () => undefined,
      verifyBackup: async () => true,
    });

    await expect(deploy.helmUpgrade({
      action: 'deploy',
      namespace: 'psfn',
      release: 'psfn',
      sourceBranch: 'fix/chart-ownership',
      sourceCommit: 'a'.repeat(40),
      imageRepository: 'localhost/psfn-framework',
      imageTag: '0.1.0-kube-aaaaaaaa',
      imageRevisionLabel: 'a'.repeat(40),
    }, {})).resolves.toEqual({ helmRevision: 12 });

    const upgrade = calls.find(call => call.args.includes('upgrade'));
    expect(upgrade?.args).toContain('--take-ownership');
  });
});

describe('readHelmHistory', () => {
  it('parses only well-formed revision/status entries', async () => {
    const { run } = runner([{
      match: (f, a) => f === 'helm' && a.includes('history'),
      result: ok(JSON.stringify([
        { revision: 1, status: 'superseded' },
        { revision: 'x', status: 'deployed' },
        { status: 'deployed' },
        { revision: 2, status: 'deployed' },
      ])),
    }]);
    await expect(readHelmHistory({ run }, 'psfn', 'psfn')).resolves.toEqual([
      { revision: 1, status: 'superseded' },
      { revision: 2, status: 'deployed' },
    ]);
  });
});
