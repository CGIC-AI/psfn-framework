import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillsRuntime } from './runtime.js';
import { SKILL_USAGE_TELEMETRY_FILE_NAME } from './telemetry.js';

function writeSkill(path: string, description: string, body: string): void {
  writeFileSync(path, [
    '---',
    'name: memory-management',
    `description: ${description}`,
    'always: true',
    '---',
    body,
    '',
  ].join('\n'), 'utf-8');
}

function writeSkillsConfig(
  dataDir: string,
  seedDir: string,
  overrides?: {
    extraDirectories?: string[];
    maxLoadedSkills?: number;
    maxSkillChars?: number;
  },
): void {
  const payload = {
    enabled: true,
    directories: ['skills'],
    extraDirectories: overrides?.extraDirectories ?? [],
    maxLoadedSkills: overrides?.maxLoadedSkills ?? 32,
    maxSkillChars: overrides?.maxSkillChars ?? 100_000,
    disabledSkills: [],
  };

  writeFileSync(join(seedDir, 'skills.seed.json'), JSON.stringify(payload, null, 2));
  writeFileSync(join(dataDir, 'skills.json'), JSON.stringify(payload, null, 2));
}

describe('skills runtime', () => {
  it('uses explicit repoRoot even when process cwd drifts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-runtime-root-'));
    const launchCwd = mkdtempSync(join(tmpdir(), 'skills-runtime-cwd-'));
    const dataDir = join(root, 'data');
    const seedDir = join(root, 'config');
    const skillDir = join(root, 'skills', 'memory-management');

    mkdirSync(dataDir, { recursive: true });
    mkdirSync(seedDir, { recursive: true });
    mkdirSync(skillDir, { recursive: true });

    writeSkillsConfig(dataDir, seedDir);
    writeSkill(join(skillDir, 'SKILL.md'), 'cwd proof', '# Memory cwd-proof');

    const previousCwd = process.cwd();
    try {
      process.chdir(launchCwd);
      const runtime = new SkillsRuntime({
        dataDir,
        seedDir,
        repoRoot: root,
        isBinaryAvailable: () => true,
      });

      const snapshot = await runtime.getSnapshot();
      expect(snapshot.includedSkills[0]?.description).toBe('cwd proof');
      expect(snapshot.includedSkills[0]?.relativePath).toContain('skills/memory-management/SKILL.md');
    } finally {
      process.chdir(previousCwd);
      rmSync(launchCwd, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('caches snapshots and invalidates when skill files change', async () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-runtime-'));
    const dataDir = join(root, 'data');
    const seedDir = join(root, 'config');
    const skillDir = join(root, 'skills', 'memory-management');

    mkdirSync(dataDir, { recursive: true });
    mkdirSync(seedDir, { recursive: true });
    mkdirSync(skillDir, { recursive: true });

    writeSkillsConfig(dataDir, seedDir);

    const skillPath = join(skillDir, 'SKILL.md');
    writeSkill(skillPath, 'first description', '# Memory v1');

    try {
      const runtime = new SkillsRuntime({
        dataDir,
        seedDir,
        repoRoot: root,
        isBinaryAvailable: () => true,
      });

      const snapshotOne = await runtime.getSnapshot();
      const snapshotTwo = await runtime.getSnapshot();
      expect(snapshotTwo).toBe(snapshotOne);
      expect(snapshotOne.includedSkills[0]?.description).toBe('first description');

      writeSkill(skillPath, 'second description', '# Memory v2');

      const snapshotThree = await runtime.getSnapshot();
      expect(snapshotThree).not.toBe(snapshotOne);
      expect(snapshotThree.signature).not.toBe(snapshotOne.signature);
      expect(snapshotThree.includedSkills[0]?.description).toBe('second description');
      expect(snapshotThree.promptXml).toContain('<skills_index>');
      expect(snapshotThree.promptXml).toContain('second description');
      expect(snapshotThree.promptXml).not.toContain('Memory v2');

      const staleBuild = runtime.getSnapshot();
      await new Promise<void>(resolveTurn => setImmediate(resolveTurn));
      writeSkill(skillPath, 'third description', '# Memory v3');
      runtime.invalidate();
      const currentBuild = runtime.getSnapshot();
      const [staleCaller, currentCaller] = await Promise.all([staleBuild, currentBuild]);
      expect(staleCaller.includedSkills[0]?.description).toBe('third description');
      expect(currentCaller.includedSkills[0]?.description).toBe('third description');
      expect(await runtime.getSnapshot()).toBe(currentCaller);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports managed skill ownership under the personal files root when configured', () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-runtime-managed-root-'));
    const companionDataDir = join(root, 'companion-data');
    const personalFilesDir = join(root, 'purrsephone');
    const seedDir = join(root, 'config');

    mkdirSync(companionDataDir, { recursive: true });
    mkdirSync(personalFilesDir, { recursive: true });
    mkdirSync(seedDir, { recursive: true });

    writeSkillsConfig(companionDataDir, seedDir);

    try {
      const runtime = new SkillsRuntime({
        dataDir: companionDataDir,
        seedDir,
        repoRoot: root,
        managedRootDir: join(personalFilesDir, 'skills'),
        isBinaryAvailable: () => true,
      });

      expect(runtime.getManagedOwnership()).toEqual({
        owner: 'personal',
        managedRoot: 'purrsephone/skills',
        configPath: 'companion-data/skills.json',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exposes scan provenance for every skills root in the snapshot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-runtime-provenance-'));
    const dataDir = join(root, 'data');
    const seedDir = join(root, 'config');
    const skillDir = join(root, 'skills', 'memory-management');

    mkdirSync(dataDir, { recursive: true });
    mkdirSync(seedDir, { recursive: true });
    mkdirSync(skillDir, { recursive: true });

    writeSkillsConfig(dataDir, seedDir, { extraDirectories: ['vendor/skills'] });
    writeSkill(join(skillDir, 'SKILL.md'), 'provenance proof', '# Memory provenance');

    try {
      const runtime = new SkillsRuntime({
        dataDir,
        seedDir,
        repoRoot: root,
        isBinaryAvailable: () => true,
      });

      const snapshot = await runtime.getSnapshot();

      // managed (custom) root + configured 'skills' + missing 'vendor/skills'
      expect(snapshot.roots).toHaveLength(3);

      const managedRoot = snapshot.roots.find(r => r.source === 'custom');
      expect(managedRoot).toBeDefined();
      expect(managedRoot?.exists).toBe(false);
      expect(managedRoot?.skillCount).toBe(0);

      const bundledRoot = snapshot.roots.find(r => r.path === 'skills');
      expect(bundledRoot).toMatchObject({
        exists: true,
        skillCount: 1,
        source: 'bundled',
        absolutePath: join(root, 'skills'),
      });

      const vendorRoot = snapshot.roots.find(r => r.path === 'vendor/skills');
      expect(vendorRoot).toMatchObject({
        exists: false,
        skillCount: 0,
        source: 'extra',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('records content-free skill invocation success and failure metrics', async () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-runtime-telemetry-'));
    const dataDir = join(root, 'data');
    const seedDir = join(root, 'config');
    const skillDir = join(root, 'skills', 'memory-management');

    mkdirSync(dataDir, { recursive: true });
    mkdirSync(seedDir, { recursive: true });
    mkdirSync(skillDir, { recursive: true });

    writeSkillsConfig(dataDir, seedDir);
    writeSkill(join(skillDir, 'SKILL.md'), 'telemetry proof', '# Sensitive workflow body');

    try {
      const runtime = new SkillsRuntime({
        dataDir,
        seedDir,
        repoRoot: root,
        isBinaryAvailable: () => true,
      });

      expect(await runtime.recordSkillInvocation('missing-skill', {
        outcome: 'success',
        durationMs: 10,
        occurredAt: '2026-06-29T10:00:00.000Z',
      })).toBeNull();

      await runtime.recordSkillInvocation('memory-management', {
        outcome: 'success',
        durationMs: 100,
        occurredAt: '2026-06-29T10:00:00.000Z',
      });
      const stats = await runtime.recordSkillInvocation('MEMORY-MANAGEMENT', {
        outcome: 'failure',
        durationMs: 300,
        occurredAt: '2026-06-29T10:01:00.000Z',
      });

      expect(stats).toMatchObject({
        name: 'memory-management',
        invocationCount: 2,
        successCount: 1,
        failureCount: 1,
        durationSampleCount: 2,
        averageDurationMs: 200,
        lastDurationMs: 300,
        lastOutcome: 'failure',
        successRate: 0.5,
        firstUsedAt: '2026-06-29T10:00:00.000Z',
        lastUsedAt: '2026-06-29T10:01:00.000Z',
      });
      expect(runtime.getSkillUsageStats('memory-management')).toEqual(stats);
      expect(runtime.listSkillUsageStats()).toHaveLength(1);

      runtime.flushSkillUsageTelemetry();
      const persisted = readFileSync(join(dataDir, SKILL_USAGE_TELEMETRY_FILE_NAME), 'utf-8');
      expect(persisted).toContain('"invocationCount": 2');
      expect(persisted).not.toContain('Sensitive workflow body');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps prompt assembly cooperative across a large skill collection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-runtime-cooperative-'));
    const dataDir = join(root, 'data');
    const seedDir = join(root, 'config');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(seedDir, { recursive: true });
    writeSkillsConfig(dataDir, seedDir, { maxLoadedSkills: 3 });

    for (let index = 0; index < 160; index += 1) {
      const name = `skill-${String(index).padStart(3, '0')}`;
      const directory = join(root, 'skills', name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'SKILL.md'), [
        '---',
        `name: ${name}`,
        `description: Description for ${name}`,
        '---',
        '# Instructions',
        'bounded body '.repeat(500),
      ].join('\n'));
    }

    try {
      const runtime = new SkillsRuntime({
        dataDir,
        seedDir,
        repoRoot: root,
        isBinaryAvailable: () => true,
        collectionLimits: {
          maxMetadataBytes: 400_000,
          maxRetainedBytes: 500_000,
          yieldEvery: 2,
        },
      });
      let timerTicks = 0;
      const timer = setInterval(() => { timerTicks += 1; }, 0);
      const snapshot = await runtime.getSnapshot().finally(() => clearInterval(timer));

      expect(timerTicks).toBeGreaterThan(2);
      expect(snapshot.loadedSkills).toBe(0);
      expect(snapshot.includedSkills).toEqual([]);
      expect(snapshot.promptXml).toBe('');
      expect(snapshot.collection).toMatchObject({
        candidatesSeen: 160,
        metadataBytesRead: 0,
        metadataBytesRetained: 0,
        limited: true,
      });
      expect(snapshot.collection.candidateBytesRetained).toBeGreaterThan(0);
      expect(snapshot.collection.candidateBytesRetained)
        .toBeLessThan(snapshot.collection.limits.maxRetainedBytes);
      expect(snapshot.skipped).toEqual([
        expect.objectContaining({
          kind: 'collection_limit',
          reason: expect.stringMatching(/aggregate read limit/i),
          details: expect.arrayContaining([
            expect.stringMatching(/no partial skill set was accepted/i),
          ]),
        }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('diagnoses an oversized SKILL.md and never injects a partial instruction', async () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-runtime-oversized-'));
    const dataDir = join(root, 'data');
    const seedDir = join(root, 'config');
    const skillDir = join(root, 'skills', 'oversized');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(seedDir, { recursive: true });
    mkdirSync(skillDir, { recursive: true });
    writeSkillsConfig(dataDir, seedDir);
    writeFileSync(join(skillDir, 'SKILL.md'), [
      '---',
      'name: oversized',
      'description: should be rejected',
      '---',
      '# Never inject this',
      'x'.repeat(1_000_000),
    ].join('\n'));

    try {
      const runtime = new SkillsRuntime({
        dataDir,
        seedDir,
        repoRoot: root,
        isBinaryAvailable: () => true,
      });
      const snapshot = await runtime.getSnapshot();
      expect(snapshot.loadedSkills).toBe(0);
      expect(snapshot.promptXml).toBe('');
      expect(snapshot.skipped).toEqual([
        expect.objectContaining({
          kind: 'oversized',
          name: 'skills/oversized/SKILL.md',
          reason: expect.stringMatching(/hard limit/i),
        }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('builds Garden managed records from bounded async content reads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-runtime-managed-bounded-'));
    const dataDir = join(root, 'data');
    const seedDir = join(root, 'config');
    const managedRoot = join(root, 'personal', 'skills');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(seedDir, { recursive: true });
    writeSkillsConfig(dataDir, seedDir);

    try {
      const runtime = new SkillsRuntime({
        dataDir,
        seedDir,
        repoRoot: root,
        managedRootDir: managedRoot,
        isBinaryAvailable: () => true,
        now: () => new Date('2026-07-28T12:00:00.000Z'),
      });
      runtime.createSkill({
        name: 'normal',
        category: 'operator',
        description: 'Normal managed skill',
        content: '# Exact managed body',
      });
      const oversizedDir = join(managedRoot, 'operator', 'oversized');
      mkdirSync(oversizedDir, { recursive: true });
      writeFileSync(join(oversizedDir, 'SKILL.md'), [
        '---',
        'name: oversized',
        'description: Never synchronously read this body',
        'category: operator',
        '---',
        'x'.repeat(2_000_000),
      ].join('\n'));

      const snapshot = await runtime.getSnapshot();
      const projection = await runtime.listManaged();
      expect(projection.managed).toEqual([{
        name: 'normal',
        description: 'Normal managed skill',
        category: 'operator',
        version: 1,
        content: '# Exact managed body',
        createdAt: '2026-07-28T12:00:00.000Z',
        updatedAt: '2026-07-28T12:00:00.000Z',
      }]);
      expect(projection.skipped).toEqual([]);
      expect(snapshot.skipped).toEqual([
        expect.objectContaining({
          kind: 'oversized',
          name: expect.stringContaining('operator/oversized/SKILL.md'),
        }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed before Garden reads an aggregate managed-body overflow', async () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-runtime-managed-collection-'));
    const dataDir = join(root, 'data');
    const seedDir = join(root, 'config');
    const managedRoot = join(root, 'personal', 'skills');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(seedDir, { recursive: true });
    writeSkillsConfig(dataDir, seedDir);
    for (let index = 0; index < 8; index += 1) {
      const name = `managed-${String(index).padStart(2, '0')}`;
      const directory = join(managedRoot, 'operator', name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'SKILL.md'), [
        '---',
        `name: ${name}`,
        `description: ${name}`,
        'category: operator',
        '---',
        'b'.repeat(12_000),
      ].join('\n'));
    }

    try {
      const runtime = new SkillsRuntime({
        dataDir,
        seedDir,
        repoRoot: root,
        managedRootDir: managedRoot,
        isBinaryAvailable: () => true,
        collectionLimits: {
          maxContentBytes: 50_000,
          yieldEvery: 2,
        },
      });
      const projection = await runtime.listManaged();
      expect(projection.managed).toEqual([]);
      expect(projection.skipped).toEqual([
        expect.objectContaining({
          kind: 'collection_limit',
          reason: expect.stringMatching(/aggregate read limit/i),
          details: expect.arrayContaining([
            expect.stringMatching(/no partial Garden list was returned/i),
          ]),
        }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
