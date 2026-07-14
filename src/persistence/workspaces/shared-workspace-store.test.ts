import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveCompanionFleetPaths, type CompanionsFleetConfig } from '../../system/config/companions-config.js';
import {
  COMPANION_LIBRARY_MANIFEST_FILE,
  COMPANION_LIBRARY_SEED_VERSION,
  provisionFleetWorkspaces,
} from './provisioning.js';
import { createHash } from 'node:crypto';
import { SharedCompanionWorkspaceStore } from './shared-workspace-store.js';

const FLEET: CompanionsFleetConfig = {
  companions: [{
    companionId: '11111111-1111-4111-8111-111111111111',
    companionDataDir: 'companions/one',
    characterCardPath: 'companions/one/card.json',
    postgresSchema: 'companion_one',
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
