import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  buildSelfDiagnosisReport,
  redactDeep,
  redactSecretString,
  type DiagnosisExec,
  type DiagnosisFs,
  type SelfDiagnosisDeps,
} from './self-diagnosis.js';
import type { ModelUsageQueryPort, ModelUsageEvent } from '../../shared/telemetry/model-usage.js';

const REPO_ROOT = '/app';
const CHECKOUT = '/app/repository';
const SYSTEM_DATA = '/app/system-data';
const COMPANION_DATA = '/app/companion-data';
const WORKSPACE = '/app/workspace';
const LOGS = '/app/logs';
const TMP = '/app/tmp';
const BACKUPS = '/app/backups';
const CONFORMANCE_PATH = join(SYSTEM_DATA, 'state', 'tool-conformance-latest.json');

interface GitRepoState {
  commit: string;
  branch: string;
  committer: string;
  dirty: boolean;
}

interface FakeWorld {
  files: Map<string, string>;
  existing: Set<string>;
  writable: Set<string>;
  statfs: Map<string, { freeBytes: number; totalBytes: number }>;
  gitRepos: Map<string, GitRepoState>;
  gitLog: Map<string, string>; // `${dir}:${range}` -> stdout
  which: Map<string, string>;
}

function baseWorld(): FakeWorld {
  const existing = new Set<string>([
    join(REPO_ROOT, '.git'),
    join(CHECKOUT, '.git'),
    SYSTEM_DATA, COMPANION_DATA, WORKSPACE, LOGS, TMP, BACKUPS,
    join(WORKSPACE, '.beads'),
  ]);
  const writable = new Set<string>([SYSTEM_DATA, COMPANION_DATA, WORKSPACE, LOGS, TMP, BACKUPS]);
  const statfs = new Map<string, { freeBytes: number; totalBytes: number }>();
  for (const p of [SYSTEM_DATA, COMPANION_DATA, WORKSPACE, LOGS, TMP, BACKUPS]) {
    statfs.set(p, { freeBytes: 5_000_000_000, totalBytes: 20_000_000_000 });
  }
  return {
    files: new Map<string, string>(),
    existing,
    writable,
    statfs,
    gitRepos: new Map<string, GitRepoState>([
      [REPO_ROOT, { commit: 'image00000000', branch: 'HEAD', committer: 'PSFN Runtime Image', dirty: false }],
      [CHECKOUT, { commit: 'current1111', branch: 'foundation_e0_e2', committer: 'axAilotl', dirty: false }],
    ]),
    gitLog: new Map<string, string>([
      [`${CHECKOUT}:prev00000..current1111`, [
        'psfn-framework-ay73: stop continuation no_reply from clobbering the authored user reply',
        'psfn-framework-gexb: stop post-turn appraisal from seeing the last exchange twice',
        'docs: add chat turn lifecycle doc',
      ].join('\n')],
    ]),
    which: new Map<string, string>([
      ['bd', '/usr/local/bin/bd'],
      ['rg', '/usr/bin/rg'],
      ['psql', '/opt/postgresql-client/wrappers/psql'],
    ]),
  };
}

function makeFs(world: FakeWorld): DiagnosisFs {
  return {
    existsSync: (path) => world.existing.has(path) || world.files.has(path),
    readFileSync: (path) => {
      const content = world.files.get(path);
      if (content === undefined) throw new Error(`ENOENT ${path}`);
      return content;
    },
    isWritable: (path) => world.writable.has(path),
    statfs: (path) => {
      const stats = world.statfs.get(path);
      if (!stats) throw new Error(`statfs unavailable for ${path}`);
      return stats;
    },
  };
}

function makeExec(world: FakeWorld): DiagnosisExec {
  return (bin, args) => {
    if (bin !== 'git') return { ok: false, stdout: '', stderr: 'unknown bin' };
    const dir = args[1];
    const repo = world.gitRepos.get(dir);
    if (args[2] === 'rev-parse' && args[3] === 'HEAD') {
      return repo ? { ok: true, stdout: `${repo.commit}\n`, stderr: '' } : { ok: false, stdout: '', stderr: 'not a git repo' };
    }
    if (args[2] === 'rev-parse' && args[3] === '--abbrev-ref') {
      return repo ? { ok: true, stdout: `${repo.branch}\n`, stderr: '' } : { ok: false, stdout: '', stderr: 'no branch' };
    }
    if (args[2] === 'log' && args[3] === '-1') {
      return repo ? { ok: true, stdout: `${repo.committer}\n`, stderr: '' } : { ok: false, stdout: '', stderr: 'no log' };
    }
    if (args[2] === 'status') {
      return repo ? { ok: true, stdout: repo.dirty ? ' M file\n' : '', stderr: '' } : { ok: false, stdout: '', stderr: 'no status' };
    }
    if (args[2] === 'log' && args[3] === '--format=%s') {
      const range = args[4];
      const key = `${dir}:${range}`;
      const out = world.gitLog.get(key);
      return out !== undefined
        ? { ok: true, stdout: out, stderr: '' }
        : { ok: false, stdout: '', stderr: `bad revision ${range}` };
    }
    return { ok: false, stdout: '', stderr: 'unhandled git command' };
  };
}

function makeModelUsageQuery(events: Array<Partial<ModelUsageEvent>>): ModelUsageQueryPort {
  return {
    getUsageData: async () => ({
      query: {},
      totals: {
        calls: 0, successfulCalls: 0, failedCalls: 0, inputTokens: 0, outputTokens: 0,
        cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, providerCostUsd: 0,
        estimatedCostUsd: 0, totalCostUsd: 0, averageDurationMs: null, averageTtftMs: null,
      },
      byModel: [], byPurpose: [], byTool: [], byCallKind: [],
      recentEvents: events as ModelUsageEvent[],
      expensiveEvents: [],
    }),
  };
}

function makeDeps(world: FakeWorld, overrides: Partial<SelfDiagnosisDeps> = {}): SelfDiagnosisDeps {
  return {
    env: {
      PATH: '/usr/bin',
      PSFN_IMAGE_TAG: '0.1.0-kube',
      PSFN_HELM_REVISION: '7',
      PSFN_GIT_COMMIT: 'current1111',
      PSFN_PREVIOUS_GIT_COMMIT: 'prev00000',
      PSFN_REPOSITORY_DIR: CHECKOUT,
      BEADS_TOOLS_ENABLED: 'true',
      SHELL_EXEC_ENABLED: 'false',
      GIT_REPO_ROOT: '/app/repository',
    },
    paths: {
      systemDataDir: SYSTEM_DATA,
      companionDataDir: COMPANION_DATA,
      workspacePath: WORKSPACE,
      logsDir: LOGS,
      tempDir: TMP,
      backupsDir: BACKUPS,
    },
    repoRoot: REPO_ROOT,
    now: () => 1_700_000_000_000,
    fs: makeFs(world),
    exec: makeExec(world),
    which: (bin) => world.which.get(bin) ?? null,
    getModelUsageQuery: () => makeModelUsageQuery([
      {
        recordedAtMs: 1_699_999_000_000,
        status: 'success',
        provider: 'openrouter',
        model: 'anthropic/claude',
        requestedProvider: 'litellm',
        requestedModel: 'anthropic/claude',
      },
      {
        recordedAtMs: 1_699_999_500_000,
        status: 'success',
        provider: 'litellm',
        model: 'anthropic/claude',
        requestedProvider: 'litellm',
        requestedModel: 'anthropic/claude',
      },
    ]),
    ...overrides,
  };
}

describe('buildSelfDiagnosisReport', () => {
  it('assembles all sections when everything is available', async () => {
    const world = baseWorld();
    world.files.set(CONFORMANCE_PATH, JSON.stringify({
      schemaVersion: 1,
      ranAt: 1_699_990_000_000,
      results: [
        { toolName: 'self_status', action: 'snapshot', ok: true },
        { toolName: 'response_control', probeKind: 'schema_only', ok: true },
        { toolName: 'memory', action: 'search', ok: false, classification: 'policy_blocked', error: 'denied' },
      ],
    }));
    const report = await buildSelfDiagnosisReport(makeDeps(world));

    expect(report.schemaVersion).toBe(1);
    expect(report.action).toBe('diagnose');

    const deployment = report.deployment as any;
    expect(deployment.status).toBe('available');
    expect(deployment.imageTag).toBe('0.1.0-kube');
    expect(deployment.helmRevision).toBe('7');
    expect(deployment.gitCommit).toBe('current1111');
    expect(deployment.fixesShipped).toMatchObject({
      status: 'available',
      fromCommit: 'prev00000',
      toCommit: 'current1111',
    });
    expect(deployment.fixesShipped.beadIds).toEqual(
      expect.arrayContaining(['psfn-framework-ay73', 'psfn-framework-gexb']),
    );

    const repository = report.repository as any;
    expect(repository.imageSnapshot).toMatchObject({ status: 'available', isImageSnapshot: true });
    expect(repository.sourceCheckout).toMatchObject({
      status: 'available',
      path: CHECKOUT,
      commit: 'current1111',
      branch: 'foundation_e0_e2',
      dirty: false,
    });

    const tooling = report.tooling as any;
    expect(tooling.binaries).toEqual({
      bd: '/usr/local/bin/bd',
      rg: '/usr/bin/rg',
      psql: '/opt/postgresql-client/wrappers/psql',
    });
    expect(tooling.beads).toMatchObject({ enabled: true, markerPresent: true });

    const storage = report.storage as any;
    expect(storage.mounts.systemData).toMatchObject({
      status: 'available',
      writable: true,
      freeBytes: 5_000_000_000,
      totalBytes: 20_000_000_000,
    });

    const routing = report.modelRouting as any;
    expect(routing.status).toBe('available');
    expect(routing.inspectedCount).toBe(2);
    expect(routing.mismatchCount).toBe(1);
    expect(routing.flagged).toBe(true);
    expect(routing.calls[0]).toMatchObject({ providerMismatch: true, servedProvider: 'openrouter' });

    const policy = report.policy as any;
    expect(policy.beads).toEqual({ value: true, source: 'env' });
    expect(policy.shellExec).toEqual({ value: false, source: 'env' });

    const conformance = report.toolConformance as any;
    expect(conformance).toMatchObject({ status: 'available', recorded: true, total: 3, passCount: 2, failCount: 1 });
    expect(conformance.failing[0]).toMatchObject({ toolName: 'memory', action: 'search', classification: 'policy_blocked' });
  });

  it('reports fixesShipped and sourceCheckout unavailable without a real checkout', async () => {
    const world = baseWorld();
    world.existing.delete(join(CHECKOUT, '.git'));
    world.gitRepos.delete(CHECKOUT);
    const report = await buildSelfDiagnosisReport(makeDeps(world));

    const repository = report.repository as any;
    expect(repository.sourceCheckout.status).toBe('unavailable');
    expect(repository.sourceCheckout.reason).toContain('no authoritative source checkout');

    const deployment = report.deployment as any;
    expect(deployment.fixesShipped.status).toBe('unavailable');
    expect(deployment.fixesShipped.reason).toContain('no authoritative source checkout');
    // Image-snapshot commit still surfaces as the running build commit.
    expect(deployment.gitCommit).toBe('current1111');
  });

  it('reports fixesShipped unavailable when the previous commit is unknown', async () => {
    const world = baseWorld();
    const deps = makeDeps(world);
    delete (deps.env as Record<string, string | undefined>).PSFN_PREVIOUS_GIT_COMMIT;
    const report = await buildSelfDiagnosisReport(deps);
    expect((report.deployment as any).fixesShipped).toMatchObject({
      status: 'unavailable',
      reason: expect.stringContaining('PSFN_PREVIOUS_GIT_COMMIT'),
    });
  });

  it('reports missing deployment identity env explicitly', async () => {
    const world = baseWorld();
    const deps = makeDeps(world, { env: { PATH: '/usr/bin', PSFN_REPOSITORY_DIR: CHECKOUT } });
    const report = await buildSelfDiagnosisReport(deps);
    const deployment = report.deployment as any;
    expect(deployment.imageTag).toMatchObject({ status: 'unavailable' });
    expect(deployment.helmRevision).toMatchObject({ status: 'unavailable' });
    // Falls back to the image-snapshot commit even without PSFN_GIT_COMMIT.
    expect(deployment.gitCommit).toBe('image00000000');
    expect(deployment.gitCommitSource).toBe('image-snapshot');
  });

  it('reports missing binaries and beads-disabled reason', async () => {
    const world = baseWorld();
    world.which.clear();
    world.existing.delete(join(WORKSPACE, '.beads'));
    const deps = makeDeps(world, {
      env: { PATH: '/usr/bin', PSFN_REPOSITORY_DIR: CHECKOUT },
    });
    const report = await buildSelfDiagnosisReport(deps);
    const tooling = report.tooling as any;
    expect(tooling.binaries).toEqual({ bd: null, rg: null, psql: null });
    expect(tooling.beads).toMatchObject({ enabled: false, markerPresent: false });
    expect(tooling.beads.reason).toContain('no .beads marker');
  });

  it('reports storage mount unavailable when a path is missing', async () => {
    const world = baseWorld();
    world.existing.delete(LOGS);
    const report = await buildSelfDiagnosisReport(makeDeps(world));
    const storage = report.storage as any;
    expect(storage.mounts.logs).toMatchObject({ status: 'unavailable' });
    expect(storage.mounts.logs.reason).toContain('does not exist');
  });

  it('reports model routing unavailable when the query port is not wired', async () => {
    const world = baseWorld();
    const report = await buildSelfDiagnosisReport(makeDeps(world, { getModelUsageQuery: () => null }));
    expect(report.modelRouting).toMatchObject({
      status: 'unavailable',
      reason: expect.stringContaining('model-usage query port is not wired'),
    });
  });

  it('reports model routing error when the query throws', async () => {
    const world = baseWorld();
    const report = await buildSelfDiagnosisReport(makeDeps(world, {
      getModelUsageQuery: () => ({
        getUsageData: async () => { throw new Error('db down'); },
      }),
    }));
    expect(report.modelRouting).toMatchObject({ status: 'error' });
    expect((report.modelRouting as any).reason).toContain('model-usage query failed');
  });

  it('reports policy flags as unset when env is absent', async () => {
    const world = baseWorld();
    const report = await buildSelfDiagnosisReport(makeDeps(world, {
      env: { PATH: '/usr/bin', PSFN_REPOSITORY_DIR: CHECKOUT },
    }));
    const policy = report.policy as any;
    expect(policy.beads).toEqual({ value: null, source: 'unset' });
    expect(policy.web).toEqual({ value: null, source: 'gateway-enforced' });
  });

  it('reports no conformance run recorded when the file is absent', async () => {
    const world = baseWorld();
    const report = await buildSelfDiagnosisReport(makeDeps(world));
    expect(report.toolConformance).toEqual({
      status: 'available',
      recorded: false,
      note: 'no conformance run recorded',
    });
  });

  it('rejects an invalid conformance schema instead of trusting it', async () => {
    const world = baseWorld();
    world.files.set(CONFORMANCE_PATH, JSON.stringify({ schemaVersion: 2, ranAt: 1, results: [] }));
    const report = await buildSelfDiagnosisReport(makeDeps(world));
    expect(report.toolConformance).toMatchObject({ status: 'error' });
    expect((report.toolConformance as any).reason).toContain('schemaVersion');
  });

  it('rejects conformance results with malformed entries', async () => {
    const world = baseWorld();
    world.files.set(CONFORMANCE_PATH, JSON.stringify({
      schemaVersion: 1,
      ranAt: 1,
      results: [{ toolName: 'x', action: 'y' }],
    }));
    const report = await buildSelfDiagnosisReport(makeDeps(world));
    expect(report.toolConformance).toMatchObject({ status: 'error' });
    expect((report.toolConformance as any).reason).toContain('required');
  });

  it('rejects a conformance file that is not valid JSON', async () => {
    const world = baseWorld();
    world.files.set(CONFORMANCE_PATH, '{ not json');
    const report = await buildSelfDiagnosisReport(makeDeps(world));
    expect(report.toolConformance).toMatchObject({ status: 'error' });
    expect((report.toolConformance as any).reason).toContain('not valid JSON');
  });

  it('redacts secrets that leak into the assembled report', async () => {
    const world = baseWorld();
    const report = await buildSelfDiagnosisReport(makeDeps(world, {
      env: {
        PATH: '/usr/bin',
        PSFN_REPOSITORY_DIR: CHECKOUT,
        GIT_REPO_ROOT: 'postgres://admin:supersecretpassword@db:5432/psfn',
      },
    }));
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('supersecretpassword');
    expect((report.policy as any).gitRepoRoot.value).toContain('[REDACTED]');
  });
});

describe('redaction helpers', () => {
  it('redacts credentials embedded in connection strings', () => {
    expect(redactSecretString('postgres://u:p4ss@h/db')).toBe('postgres://u:[REDACTED]@h/db');
  });

  it('redacts bearer tokens and key=value secrets', () => {
    expect(redactSecretString('Authorization: Bearer abcdef123456')).toContain('[REDACTED]');
    expect(redactSecretString('api_key=abcdef123456')).toBe('api_key=[REDACTED]');
  });

  it('redacts provider key prefixes', () => {
    expect(redactSecretString('key sk-ABCDEFGH12345678 here')).toContain('[REDACTED]');
  });

  it('redacts values under secret-named keys', () => {
    const out = redactDeep({ token: 'abcd1234', nested: { password: 'hunter2', safe: 'value' } }) as any;
    expect(out.token).toBe('[REDACTED]');
    expect(out.nested.password).toBe('[REDACTED]');
    expect(out.nested.safe).toBe('value');
  });

  it('does not over-redact benign key-like field names', () => {
    const out = redactDeep({ slotKey: 'slot-a', dayKey: '2026-07-06' }) as any;
    expect(out.slotKey).toBe('slot-a');
    expect(out.dayKey).toBe('2026-07-06');
  });
});
