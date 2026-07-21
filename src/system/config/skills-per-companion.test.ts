import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SKILLS_FILE_NAME,
  saveSkillsConfig,
} from './skills-config.js';
import { createOwnerFileConfigStore } from './config-store.js';
import { verifyStartupOwnerFiles } from './startup-owner-files.js';
import {
  PER_COMPANION_OWNER_FILES,
  buildSettingsContractData,
  ownerFileScope,
} from './settings-contract.js';
import { verifySettingsContractGuard } from './settings-contract-guard.js';
import { SYSTEM_CONFIG_OWNER_FILES } from '../../persistence/backups/system-config-tree.js';
import { executePersistenceCutover } from '../../persistence/cutover.js';
import { SkillsRuntime } from '../../faculties/skills/runtime.js';
import { SKILL_USAGE_TELEMETRY_FILE_NAME } from '../../faculties/skills/telemetry.js';

const roots: string[] = [];

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function writeSkillsOwner(
  dir: string,
  disabledSkills: string[],
  enabled = true,
): void {
  saveSkillsConfig(dir, {
    enabled,
    directories: ['skills'],
    extraDirectories: [],
    maxLoadedSkills: 32,
    maxSkillChars: 24_000,
    disabledSkills,
  });
}

function writeSkill(root: string, category: string, name: string): void {
  const directory = join(root, category, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${name} description`,
    'always: true',
    '---',
    `# ${name}`,
    '',
  ].join('\n'), 'utf8');
}

afterEach(() => {
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('skills per-companion rooting (dnll.9)', () => {
  it('reads and writes each selected companion skills owner file', () => {
    const systemDataDir = makeDir('psfn-skills-system-');
    const companionDataDir = makeDir('psfn-skills-companion-');
    writeSkillsOwner(systemDataDir, ['system-only']);
    writeSkillsOwner(companionDataDir, ['personal-only']);

    const store = createOwnerFileConfigStore({ dataDir: systemDataDir, companionDataDir });
    expect(store.loadSkills().disabledSkills).toEqual(['personal-only']);
    store.saveSkills({ ...store.loadSkills(), disabledSkills: ['edited-for-companion'] });
    expect(store.loadSkills().disabledSkills).toEqual(['edited-for-companion']);
    expect(createOwnerFileConfigStore({ dataDir: systemDataDir }).loadSkills().disabledSkills)
      .toEqual(['system-only']);
  });

  it('keeps enabled sets, personal skill roots, and telemetry isolated by companion', () => {
    const root = makeDir('psfn-skills-runtime-');
    const systemDataDir = join(root, 'system');
    const companionA = join(root, 'companion-a');
    const companionB = join(root, 'companion-b');
    const workspaceA = join(root, 'workspace-a');
    const workspaceB = join(root, 'workspace-b');
    mkdirSync(systemDataDir, { recursive: true });
    mkdirSync(companionA, { recursive: true });
    mkdirSync(companionB, { recursive: true });
    writeSkillsOwner(companionA, ['deployment-skill']);
    writeSkillsOwner(companionB, []);
    writeSkill(join(root, 'skills'), 'deployment', 'deployment-skill');
    writeSkill(join(workspaceA, 'skills'), 'personal', 'personal-a');
    writeSkill(join(workspaceB, 'skills'), 'personal', 'personal-b');

    const runtimeA = new SkillsRuntime({
      dataDir: companionA,
      repoRoot: root,
      managedRootDir: join(workspaceA, 'skills'),
      isBinaryAvailable: () => true,
    });
    const runtimeB = new SkillsRuntime({
      dataDir: companionB,
      repoRoot: root,
      managedRootDir: join(workspaceB, 'skills'),
      isBinaryAvailable: () => true,
    });

    const includedA = runtimeA.getSnapshot().includedSkills.map(skill => skill.name);
    const includedB = runtimeB.getSnapshot().includedSkills.map(skill => skill.name);
    expect(includedA).toContain('personal-a');
    expect(includedA).not.toContain('personal-b');
    expect(includedA).not.toContain('deployment-skill');
    expect(includedB).toContain('personal-b');
    expect(includedB).not.toContain('personal-a');
    expect(includedB).toContain('deployment-skill');

    runtimeA.recordSkillInvocation('personal-a', {
      outcome: 'success',
      durationMs: 1,
    });
    runtimeA.flushSkillUsageTelemetry();
    expect(existsSync(join(companionA, SKILL_USAGE_TELEMETRY_FILE_NAME))).toBe(true);
    expect(existsSync(join(companionB, SKILL_USAGE_TELEMETRY_FILE_NAME))).toBe(false);
    expect(existsSync(join(systemDataDir, SKILL_USAGE_TELEMETRY_FILE_NAME))).toBe(false);
    expect('toggleSkill' in runtimeA).toBe(false);
  });

  it('fails closed when the companion skills owner is missing despite a system decoy', () => {
    const systemDataDir = makeDir('psfn-skills-system-');
    const companionDataDir = makeDir('psfn-skills-companion-');
    writeSkillsOwner(systemDataDir, []);

    const store = createOwnerFileConfigStore({ dataDir: systemDataDir, companionDataDir });
    expect(() => store.loadSkills()).toThrow(/Missing required JSON owner file/);
  });

  it('validates skills at the companion root during startup', () => {
    const systemDataDir = makeDir('psfn-skills-system-');
    const companionDataDir = makeDir('psfn-skills-companion-');
    writeFileSync(join(systemDataDir, SKILLS_FILE_NAME), '{"enabled":"bad"}', 'utf8');
    writeSkillsOwner(companionDataDir, ['personal-only']);

    const result = verifyStartupOwnerFiles({
      dataDir: systemDataDir,
      companionDataDir,
      seedDir: './config',
      multiCompanion: true,
    });
    expect(result.errors.find(error => error.includes(SKILLS_FILE_NAME))).toBeUndefined();

    const emptyCompanion = makeDir('psfn-skills-companion-empty-');
    const missing = verifyStartupOwnerFiles({
      dataDir: systemDataDir,
      companionDataDir: emptyCompanion,
      seedDir: './config',
      multiCompanion: true,
    });
    expect(missing.errors.some(error => error.includes(SKILLS_FILE_NAME))).toBe(true);
  });

  it('marks skills per-companion and excludes it from the system backup slice', () => {
    expect(PER_COMPANION_OWNER_FILES.has(SKILLS_FILE_NAME)).toBe(true);
    expect(ownerFileScope(SKILLS_FILE_NAME)).toBe('perCompanion');
    expect(buildSettingsContractData().subsystems.skills.scope).toBe('perCompanion');
    expect(SYSTEM_CONFIG_OWNER_FILES).not.toContain(SKILLS_FILE_NAME);
    expect(verifySettingsContractGuard()).toEqual({ ok: true, errors: [] });
  });

  it('routes legacy skills config through the registry-driven cutover', () => {
    const root = makeDir('psfn-skills-cutover-');
    const legacySharedDataDir = join(root, 'legacy');
    const systemDataDir = join(root, 'system');
    const companionDataDir = join(root, 'companion');
    writeSkillsOwner(legacySharedDataDir, []);

    executePersistenceCutover({
      systemDataDir,
      companionDataDir,
      legacySharedDataDir,
      legacyCompanionDir: join(root, 'legacy-companion'),
    });

    expect(existsSync(join(companionDataDir, SKILLS_FILE_NAME))).toBe(true);
    expect(existsSync(join(systemDataDir, SKILLS_FILE_NAME))).toBe(false);
  });
});
