import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveCompanionFleetPaths, type CompanionsFleetConfig } from '../../system/config/companions-config.js';
import { provisionFleetWorkspaces } from './provisioning.js';
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
      actor: { id: 'operator-a', role: 'operator' },
      provenance: 'operator-authored Garden submission',
    });

    expect(() => store.review({
      reviewId: proposal.reviewId,
      reviewer: { id: 'operator-a', role: 'operator' },
      decision: 'approve',
      cogSecDecision: 'approved',
    })).toThrow(/independent reviewer/);
    expect(() => store.review({
      reviewId: proposal.reviewId,
      reviewer: { id: 'operator-b', role: 'operator' },
      decision: 'approve',
      cogSecDecision: 'rejected',
    })).toThrow(/CogSec approval/);

    const approved = store.review({
      reviewId: proposal.reviewId,
      reviewer: { id: 'operator-b', role: 'operator' },
      decision: 'approve',
      cogSecDecision: 'approved',
    });
    expect(approved.status).toBe('approved');
    expect(store.readArtifact('world/guide.md')).toMatchObject({ content: '# Guide\n' });
  });

  it('rejects traversal, hidden paths, and executable artifact formats', () => {
    const { store } = createStore();
    const base = {
      content: 'x',
      mediaType: 'text/plain' as const,
      actor: { id: 'operator-a', role: 'operator' as const },
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
      actor: { id: 'operator-a', role: 'operator' },
      provenance: 'test',
    })).toThrow(/symlink outside/);
  });

  it('records immutable provenance without exposing a skills or modules root', () => {
    const { store } = createStore();
    const proposal = store.propose({
      artifactPath: 'facts.txt',
      content: 'shared fact',
      mediaType: 'text/plain',
      actor: { id: 'operator-a', role: 'operator' },
      provenance: 'reviewed source set 7',
    });
    store.review({
      reviewId: proposal.reviewId,
      reviewer: { id: 'operator-b', role: 'operator' },
      decision: 'reject',
      cogSecDecision: 'rejected',
      note: 'untrusted provenance',
    });
    expect(store.listArtifacts()).toEqual([]);
    expect(store.listReviews()[0]).toMatchObject({ status: 'rejected', provenance: 'reviewed source set 7' });
  });
});
