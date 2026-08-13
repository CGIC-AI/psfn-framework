import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { resolveCompanionFleetPaths, type CompanionsFleetConfig } from '../../system/config/companions-config.js';
import {
  COMPANION_LIBRARY_MANIFEST_FILE,
  COMPANION_LIBRARY_SEED_VERSION,
  provisionFleetWorkspaces,
} from './provisioning.js';
import { createHash } from 'node:crypto';
import { SharedCompanionWorkspaceStore } from './shared-workspace-store.js';
import type { DurableWriteStage } from '../../shared/utils/fs.js';

const FLEET: CompanionsFleetConfig = {
  postgres: {
    sharedMigrationRole: 'shared_migration',
    sharedMigrationDatabaseUrlRef: {
      kind: 'env',
      envName: 'SHARED_MIGRATION_DATABASE_URL',
    },
  },
  companions: [{
    companionId: '11111111-1111-4111-8111-111111111111',
    companionDataDir: 'companions/one',
    characterCardPath: 'companions/one/card.json',
    postgresSchema: 'companion_one',
    postgresRole: 'companion_one_runtime',
    postgresDatabaseUrlRef: {
      kind: 'env',
      envName: 'COMPANION_ONE_DATABASE_URL',
    },
  }],
};

describe('SharedCompanionWorkspaceStore', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function createStore(): { store: SharedCompanionWorkspaceStore; sharedWorkspacePath: string } {
    const root = mkdtempSync(join(tmpdir(), 'psfn-shared-workspace-'));
    const source = mkdtempSync(join(tmpdir(), 'psfn-shared-seed-'));
    roots.push(root, source);
    writeFileSync(join(source, 'welcome.md'), 'welcome');
    writeFileSync(join(source, 'privacy-boundary-reference.md'), 'privacy');
    writeFileSync(join(source, COMPANION_LIBRARY_MANIFEST_FILE), JSON.stringify({
      schemaVersion: 1,
      bundleVersion: COMPANION_LIBRARY_SEED_VERSION,
      files: [
        { path: 'welcome.md', sha256: createHash('sha256').update('welcome').digest('hex') },
        { path: 'privacy-boundary-reference.md', sha256: createHash('sha256').update('privacy').digest('hex') },
      ],
    }));
    const fleet = resolveCompanionFleetPaths(FLEET, root);
    provisionFleetWorkspaces(fleet, { companionLibrarySourceDir: source });
    return {
      store: new SharedCompanionWorkspaceStore(fleet.sharedWorkspacePath),
      sharedWorkspacePath: fleet.sharedWorkspacePath,
    };
  }

  it('publishes only after independent review and CogSec approval', () => {
    const { store } = createStore();
    const proposal = store.propose({
      artifactPath: 'world/guide.md',
      content: '# Guide\n',
      mediaType: 'text/markdown',
      actor: { id: 'operator-a', role: 'proposer' },
      provenance: 'operator-authored Garden submission',
    });

    expect(() => store.review({
      reviewId: proposal.reviewId,
      reviewer: { id: 'operator-a', role: 'reviewer' },
      decision: 'approve',
    })).toThrow(/independent reviewer/);
    expect(() => store.review({
      reviewId: proposal.reviewId,
      reviewer: { id: 'operator-b', role: 'reviewer' },
      decision: 'approve',
    })).toThrow(/authoritative CogSec decision artifact/);

    store.recordCogSecDecision({
      reviewId: proposal.reviewId,
      reviewer: { id: 'operator-c', role: 'cogsec' },
      decision: 'approved',
    });

    const approved = store.review({
      reviewId: proposal.reviewId,
      reviewer: { id: 'operator-b', role: 'reviewer' },
      decision: 'approve',
    });
    expect(approved.status).toBe('approved');
    expect(store.readArtifact('world/guide.md')).toMatchObject({ content: '# Guide\n' });
  });

  it('rejects traversal, hidden paths, and executable artifact formats', () => {
    const { store } = createStore();
    const base = {
      content: 'x',
      mediaType: 'text/plain' as const,
      actor: { id: 'operator-a', role: 'proposer' as const },
      provenance: 'test',
    };
    expect(() => store.propose({ ...base, artifactPath: '../private.txt' })).toThrow(/contained/);
    expect(() => store.propose({ ...base, artifactPath: '.psfn/private.txt' })).toThrow(/hidden/);
    expect(() => store.propose({ ...base, artifactPath: 'skills/tool.ts' })).toThrow(/executable formats/);
  });

  it('rejects artifact paths that escape through a symlink', () => {
    const { store, sharedWorkspacePath } = createStore();
    const outside = mkdtempSync(join(tmpdir(), 'psfn-shared-outside-'));
    roots.push(outside);
    symlinkSync(outside, join(sharedWorkspacePath, 'artifacts', 'escape'));

    expect(() => store.propose({
      artifactPath: 'escape/leak.txt',
      content: 'nope',
      mediaType: 'text/plain',
      actor: { id: 'operator-a', role: 'proposer' },
      provenance: 'test',
    })).toThrow(/symlink outside/);
  });

  it('records immutable provenance without exposing a skills or modules root', () => {
    const { store } = createStore();
    const proposal = store.propose({
      artifactPath: 'facts.txt',
      content: 'shared fact',
      mediaType: 'text/plain',
      actor: { id: 'operator-a', role: 'proposer' },
      provenance: 'reviewed source set 7',
    });
    store.recordCogSecDecision({
      reviewId: proposal.reviewId,
      reviewer: { id: 'operator-c', role: 'cogsec' },
      decision: 'rejected',
    });
    store.review({
      reviewId: proposal.reviewId,
      reviewer: { id: 'operator-b', role: 'reviewer' },
      decision: 'reject',
      note: 'untrusted provenance',
    });
    expect(store.listArtifacts()).toEqual([]);
    expect(store.listReviews()[0]).toMatchObject({ status: 'rejected', provenance: 'reviewed source set 7' });
  });

  it('recovers artifact, decision, and provenance after a publication fault', () => {
    const { store, sharedWorkspacePath } = createStore();
    const proposal = store.propose({
      artifactPath: 'recovery/guide.md',
      content: 'durable publication\n',
      mediaType: 'text/markdown',
      actor: { id: 'operator-a', role: 'proposer' },
      provenance: 'fault injection test',
    });
    store.recordCogSecDecision({
      reviewId: proposal.reviewId,
      reviewer: { id: 'operator-c', role: 'cogsec' },
      decision: 'approved',
    });
    const faultingStore = new SharedCompanionWorkspaceStore(sharedWorkspacePath, {
      faultInjection: (stage) => {
        if (stage === 'after_artifact') throw new Error('simulated crash after artifact');
      },
    });

    expect(() => faultingStore.review({
      reviewId: proposal.reviewId,
      reviewer: { id: 'operator-b', role: 'reviewer' },
      decision: 'approve',
    })).toThrow(/simulated crash/);
    expect(existsSync(join(sharedWorkspacePath, 'transactions', `${proposal.reviewId}.json`))).toBe(true);

    const recovered = new SharedCompanionWorkspaceStore(sharedWorkspacePath);
    expect(recovered.readArtifact('recovery/guide.md').content).toBe('durable publication\n');
    expect(recovered.listReviews()[0].status).toBe('approved');
    expect(existsSync(join(
      sharedWorkspacePath,
      'provenance/events',
      `${proposal.reviewId}.approved.json`,
    ))).toBe(true);
    expect(existsSync(join(sharedWorkspacePath, 'transactions', `${proposal.reviewId}.json`))).toBe(false);
  });

  it.each<DurableWriteStage>([
    'after_file_sync',
    'after_publish',
    'after_directory_sync',
  ])('recovers a complete provenance record after durable-write fault %s', (faultStage) => {
    const { store, sharedWorkspacePath } = createStore();
    const proposal = store.propose({
      artifactPath: `recovery/provenance-${faultStage}.md`,
      content: `durable ${faultStage}\n`,
      mediaType: 'text/markdown',
      actor: { id: 'operator-a', role: 'proposer' },
      provenance: 'durable provenance syscall ordering',
    });
    store.recordCogSecDecision({
      reviewId: proposal.reviewId,
      reviewer: { id: 'operator-c', role: 'cogsec' },
      decision: 'approved',
    });
    const provenancePath = join(
      sharedWorkspacePath,
      'provenance/events',
      `${proposal.reviewId}.approved.json`,
    );
    let injected = false;
    const faultingStore = new SharedCompanionWorkspaceStore(sharedWorkspacePath, {
      faultInjection: (stage, path) => {
        if (!injected && stage === faultStage && path === provenancePath) {
          injected = true;
          throw new Error(`durable fault ${faultStage}`);
        }
      },
    });

    expect(() => faultingStore.review({
      reviewId: proposal.reviewId,
      reviewer: { id: 'operator-b', role: 'reviewer' },
      decision: 'approve',
    })).toThrow(`durable fault ${faultStage}`);
    expect(existsSync(join(sharedWorkspacePath, 'transactions', `${proposal.reviewId}.json`))).toBe(true);
    if (faultStage === 'after_file_sync') expect(existsSync(provenancePath)).toBe(false);
    else expect(() => JSON.parse(readFileSync(provenancePath, 'utf8'))).not.toThrow();

    const recovered = new SharedCompanionWorkspaceStore(sharedWorkspacePath);
    expect(recovered.listReviews()[0].status).toBe('approved');
    expect(() => JSON.parse(readFileSync(provenancePath, 'utf8'))).not.toThrow();
    expect(existsSync(join(sharedWorkspacePath, 'transactions', `${proposal.reviewId}.json`))).toBe(false);
  });

  it('reclaims crashed publication leases and recovers a SIGKILL journal on restart', async () => {
    const { store, sharedWorkspacePath } = createStore();
    const proposal = store.propose({
      artifactPath: 'recovery/killed.md',
      content: 'survives process death\n',
      mediaType: 'text/markdown',
      actor: { id: 'operator-a', role: 'proposer' },
      provenance: 'SIGKILL recovery test',
    });
    store.recordCogSecDecision({
      reviewId: proposal.reviewId,
      reviewer: { id: 'operator-c', role: 'cogsec' },
      decision: 'approved',
    });

    const worker = fileURLToPath(new URL(
      './test-fixtures/shared-workspace-kill-worker.ts',
      import.meta.url,
    ));
    const child = spawn(process.execPath, [
      '--import',
      'tsx',
      worker,
      sharedWorkspacePath,
      proposal.reviewId,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
      child.once('exit', (code, signal) => resolveExit({ code, signal }));
    });
    expect(outcome).toEqual({ code: null, signal: 'SIGKILL' });
    expect(existsSync(join(sharedWorkspacePath, 'transactions', `${proposal.reviewId}.json`))).toBe(true);
    expect(existsSync(join(sharedWorkspacePath, '.locks', `review-${proposal.reviewId}.lock`))).toBe(true);

    // The lease is deliberately bounded. After process death and expiry, the
    // next store instance atomically reclaims it and replays the journal.
    // Allow for the filesystem mtime precision probe, which may round the
    // initial lease timestamp up to the next second.
    await delay(3_100);
    const recovered = new SharedCompanionWorkspaceStore(sharedWorkspacePath, { lockStaleMs: 2_000 });
    expect(recovered.readArtifact('recovery/killed.md').content).toBe('survives process death\n');
    expect(recovered.listReviews()[0].status).toBe('approved');
    expect(existsSync(join(sharedWorkspacePath, 'transactions', `${proposal.reviewId}.json`))).toBe(false);
  });

  it('never reclaims a live publication owner after the lease age threshold', async () => {
    const { store, sharedWorkspacePath } = createStore();
    const proposal = store.propose({
      artifactPath: 'recovery/live-owner.md',
      content: 'one live publisher\n',
      mediaType: 'text/markdown',
      actor: { id: 'operator-a', role: 'proposer' },
      provenance: 'live owner race test',
    });
    store.recordCogSecDecision({
      reviewId: proposal.reviewId,
      reviewer: { id: 'operator-c', role: 'cogsec' },
      decision: 'approved',
    });

    const worker = fileURLToPath(new URL(
      './test-fixtures/shared-workspace-kill-worker.ts',
      import.meta.url,
    ));
    const child = spawn(process.execPath, [
      '--import',
      'tsx',
      worker,
      sharedWorkspacePath,
      proposal.reviewId,
      'hold',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolveReady, rejectReady) => {
      child.once('error', rejectReady);
      child.stdout.on('data', (chunk: Buffer) => {
        if (chunk.toString('utf8').includes('holding-live-lock')) resolveReady();
      });
    });

    await delay(2_100);
    expect(() => new SharedCompanionWorkspaceStore(sharedWorkspacePath, { lockStaleMs: 2_000 }))
      .toThrow(/operation is busy/);
    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
      child.once('exit', (code, signal) => resolveExit({ code, signal }));
    });
    expect(outcome).toEqual({ code: 0, signal: null });

    const recovered = new SharedCompanionWorkspaceStore(sharedWorkspacePath, { lockStaleMs: 2_000 });
    expect(recovered.readArtifact('recovery/live-owner.md').content).toBe('one live publisher\n');
    expect(recovered.listReviews()[0].status).toBe('approved');
  });

  it('serializes concurrent publication and re-reads the decision under lock', () => {
    const { store, sharedWorkspacePath } = createStore();
    const proposal = store.propose({
      artifactPath: 'concurrency/guide.md',
      content: 'one winner\n',
      mediaType: 'text/markdown',
      actor: { id: 'operator-a', role: 'proposer' },
      provenance: 'concurrency test',
    });
    store.recordCogSecDecision({
      reviewId: proposal.reviewId,
      reviewer: { id: 'operator-c', role: 'cogsec' },
      decision: 'approved',
    });
    let concurrentError = '';
    const firstWriter = new SharedCompanionWorkspaceStore(sharedWorkspacePath, {
      faultInjection: (stage) => {
        if (stage !== 'after_artifact') return;
        try {
          new SharedCompanionWorkspaceStore(sharedWorkspacePath);
        } catch (error) {
          concurrentError = error instanceof Error ? error.message : String(error);
        }
      },
    });
    firstWriter.review({
      reviewId: proposal.reviewId,
      reviewer: { id: 'operator-b', role: 'reviewer' },
      decision: 'approve',
    });

    expect(concurrentError).toMatch(/operation is busy: review-/);
    expect(() => store.review({
      reviewId: proposal.reviewId,
      reviewer: { id: 'operator-d', role: 'reviewer' },
      decision: 'approve',
    })).toThrow(/already resolved/);
    expect(readFileSync(join(sharedWorkspacePath, 'artifacts/concurrency/guide.md'), 'utf8'))
      .toBe('one winner\n');
  });
});
