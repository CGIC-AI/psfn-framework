import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { certifyIdlePurity } from './certification.js';

describe('idle-purity certification', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })));
  });

  it('fails when the quiet window rewrites an unapproved durable file', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'psfn-idle-purity-'));
    roots.push(runtimeRoot);
    const companionDir = join(runtimeRoot, 'companions', 'certification');
    const statePath = join(companionDir, 'state.json');
    await mkdir(companionDir, { recursive: true });
    await writeFile(statePath, '{"revision":1}\n', 'utf8');

    await expect(certifyIdlePurity({
      runtimeRoot,
      idleWindowMs: 0,
      capturePostgresWrites: async () => ({}),
      wait: async () => {
        await writeFile(statePath, '{"revision":2}\n', 'utf8');
      },
    })).rejects.toThrow(/filesystem modified: companions\/certification\/state\.json/u);
  });

  it('reports explicitly allowed automata writes without treating them as violations', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'psfn-idle-purity-'));
    roots.push(runtimeRoot);
    const noteDir = join(runtimeRoot, 'companions', 'certification', 'automata-notes');
    const notePath = join(noteDir, 'ambient-presence.jsonl');
    await mkdir(noteDir, { recursive: true });
    await writeFile(notePath, '{"note":"before"}\n', 'utf8');

    const report = await certifyIdlePurity({
      runtimeRoot,
      idleWindowMs: 0,
      capturePostgresWrites: async () => ({}),
      allowlist: {
        filesystem: [{
          path: 'companions/certification/automata-notes/ambient-presence.jsonl',
          reason: 'Ambient-presence notes are an intentional automaton lane',
        }],
      },
      wait: async () => {
        await writeFile(notePath, '{"note":"after"}\n', 'utf8');
      },
    });

    expect(report.violations).toEqual([]);
    expect(report.allowedChanges).toEqual([
      'filesystem modified: companions/certification/automata-notes/ambient-presence.jsonl '
      + '(Ambient-presence notes are an intentional automaton lane)',
    ]);
  });

  it('detects a same-content rewrite from durable metadata', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'psfn-idle-purity-'));
    roots.push(runtimeRoot);
    const statePath = join(runtimeRoot, 'state.json');
    await writeFile(statePath, '{"stable":true}\n', 'utf8');

    await expect(certifyIdlePurity({
      runtimeRoot,
      idleWindowMs: 0,
      capturePostgresWrites: async () => ({}),
      wait: async () => {
        await utimes(statePath, new Date(2_000_000), new Date(2_000_000));
      },
    })).rejects.toThrow(/filesystem modified: state\.json/u);
  });

  it('detects a file created and deleted within the measured window', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'psfn-idle-purity-'));
    roots.push(runtimeRoot);
    const durableDir = join(runtimeRoot, 'durable-state');
    const transientPath = join(durableDir, 'transient.json');
    await mkdir(durableDir);

    await expect(certifyIdlePurity({
      runtimeRoot,
      idleWindowMs: 0,
      capturePostgresWrites: async () => ({}),
      wait: async () => {
        await writeFile(transientPath, '{}\n', 'utf8');
        await rm(transientPath);
      },
    })).rejects.toThrow(/filesystem modified: durable-state/u);
  });

  it('fails on unapproved PostgreSQL tuple writes', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'psfn-idle-purity-'));
    roots.push(runtimeRoot);
    let inserted = '12';

    await expect(certifyIdlePurity({
      runtimeRoot,
      idleWindowMs: 0,
      capturePostgresWrites: async () => ({
        'certification.sessions': { deleted: '2', inserted, updated: '4' },
      }),
      wait: async () => {
        inserted = '13';
      },
    })).rejects.toThrow(/postgres wrote: certification\.sessions \(inserted=1, updated=0, deleted=0\)/u);
  });

  it('starts the measured window only after delayed startup writes settle', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'psfn-idle-purity-'));
    roots.push(runtimeRoot);
    const statePath = join(runtimeRoot, 'startup-state.json');
    await writeFile(statePath, '{"phase":"starting"}\n', 'utf8');
    let waitCount = 0;

    const report = await certifyIdlePurity({
      runtimeRoot,
      idleWindowMs: 1,
      capturePostgresWrites: async () => ({}),
      stabilization: { sampleIntervalMs: 1, timeoutMs: 3 },
      wait: async () => {
        waitCount += 1;
        if (waitCount === 1) await writeFile(statePath, '{"phase":"ready"}\n', 'utf8');
      },
    });

    expect(waitCount).toBe(3);
    expect(report).toEqual({ allowedChanges: [], violations: [] });
  });

  it('fails closed when a tuple counter becomes visible after the baseline', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'psfn-idle-purity-'));
    roots.push(runtimeRoot);
    let inserted = '0';

    await expect(certifyIdlePurity({
      runtimeRoot,
      idleWindowMs: 0,
      capturePostgresWrites: async () => ({
        'certification.startup_checkpoint': {
          deleted: '0',
          inserted,
          rowCount: '1',
          rowFingerprint: 'stable-physical-state',
          updated: '0',
        },
      }),
      wait: async () => {
        inserted = '1';
      },
    })).rejects.toThrow(
      /postgres wrote: certification\.startup_checkpoint \(inserted=1, updated=0, deleted=0\)/u,
    );
  });

  it('accepts an unchanged PostgreSQL physical snapshot with unchanged counters', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'psfn-idle-purity-'));
    roots.push(runtimeRoot);

    await expect(certifyIdlePurity({
      runtimeRoot,
      idleWindowMs: 0,
      capturePostgresWrites: async () => ({
        'public.stable_relation': {
          deleted: '2',
          inserted: '12',
          rowCount: '10',
          rowFingerprint: 'stable-physical-state',
          updated: '4',
        },
      }),
      wait: async () => undefined,
    })).resolves.toEqual({ allowedChanges: [], violations: [] });
  });
});
