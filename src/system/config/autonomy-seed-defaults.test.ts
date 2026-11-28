// Fresh-install autonomy posture (psfn-framework-ik47b.1). Seeds a companion
// data directory from the real config/*.seed.json files through the startup
// seeder, then loads it through the real scheduler loader.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_BLIND_REVIEWER_CONFIG } from './scheduler-config/blind-review.js';
import { loadSchedulerConfig, SCHEDULER_FILE_NAME } from './scheduler-config.js';
import { seedCompanionStartupOwnerFiles } from './startup-owner-files.js';

const SEED_DIR = resolve('config');

describe('fresh-install autonomy seed defaults', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function companionDir(): string {
    const root = mkdtempSync(join(tmpdir(), 'psfn-autonomy-seed-'));
    roots.push(root);
    return root;
  }

  it('enables the autonomy surfaces whose prerequisites a fresh install satisfies', () => {
    const dir = companionDir();
    seedCompanionStartupOwnerFiles({ companionDataDir: dir, seedDir: SEED_DIR });
    const scheduler = loadSchedulerConfig(dir, { seedDir: SEED_DIR });

    expect(scheduler.socialAutonomy.egressLease.mode).toBe('on');
    expect(scheduler.socialAutonomy.roomParticipationLease.enabled).toBe(true);
    expect(scheduler.socialAutonomy.roomSignal.enabled).toBe(true);
    expect(scheduler.weightedThoughtOutreach?.enabled).toBe(true);
    expect(scheduler.blindReviewer?.enabled).toBe(true);

    // Not default-on until their prerequisites exist on a fresh install: the
    // classifier also needs an owner-declared decisionBackend room.ambiguity
    // site, and the introspection audit needs a companion consent ledger that
    // no runtime surface can currently write.
    expect(scheduler.socialAutonomy.roomSignal.classifier.enabled).toBe(false);
    expect(scheduler.introspectionAudit?.enabled).toBe(false);
  });

  it('never overwrites an existing owner that chose a different posture', () => {
    const dir = companionDir();
    seedCompanionStartupOwnerFiles({ companionDataDir: dir, seedDir: SEED_DIR });
    const ownerPath = join(dir, SCHEDULER_FILE_NAME);
    const owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as { blindReviewer: { enabled: boolean } };
    owner.blindReviewer.enabled = false;
    writeFileSync(ownerPath, `${JSON.stringify(owner, null, 2)}\n`);
    const before = readFileSync(ownerPath, 'utf8');

    expect(() => seedCompanionStartupOwnerFiles({ companionDataDir: dir, seedDir: SEED_DIR }))
      .toThrow();
    expect(readFileSync(ownerPath, 'utf8')).toBe(before);
    expect(loadSchedulerConfig(dir, { seedDir: SEED_DIR }).blindReviewer?.enabled).toBe(false);
  });

  it('keeps an existing owner without a blindReviewer block on the disabled code default', () => {
    const dir = companionDir();
    seedCompanionStartupOwnerFiles({ companionDataDir: dir, seedDir: SEED_DIR });
    const ownerPath = join(dir, SCHEDULER_FILE_NAME);
    const owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as Record<string, unknown>;
    delete owner.blindReviewer;
    writeFileSync(ownerPath, `${JSON.stringify(owner, null, 2)}\n`);

    const scheduler = loadSchedulerConfig(dir, { seedDir: SEED_DIR });
    expect(scheduler.blindReviewer?.enabled ?? DEFAULT_BLIND_REVIEWER_CONFIG.enabled).toBe(false);
  });
});
