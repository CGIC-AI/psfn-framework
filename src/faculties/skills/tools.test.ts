import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillsRuntime } from './runtime.js';
import { createSkillTool } from './tools.js';

function writeSkillsConfig(dataDir: string, seedDir: string): void {
  mkdirSync(seedDir, { recursive: true });
  const payload = {
    enabled: true,
    directories: ['skills'],
    extraDirectories: [],
    maxLoadedSkills: 32,
    maxSkillChars: 24_000,
    disabledSkills: [],
  };
  writeFileSync(join(seedDir, 'skills.seed.json'), JSON.stringify(payload, null, 2));
  writeFileSync(join(dataDir, 'skills.json'), JSON.stringify(payload, null, 2));
}

function readText(result: { content: Array<{ text?: string }> }): string {
  return result.content[0]?.text ?? '';
}

describe('skills tools', () => {
  it('supports create, view, update, and list through the unified skill tool', async () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-tools-'));
    const companionDataDir = join(root, 'companion-data');
    const personalFilesDir = join(root, 'purrsephone');
    const seedDir = join(root, 'config');
    mkdirSync(companionDataDir, { recursive: true });
    mkdirSync(personalFilesDir, { recursive: true });
    writeSkillsConfig(companionDataDir, seedDir);

    try {
      const runtime = new SkillsRuntime({
        dataDir: companionDataDir,
        seedDir,
        repoRoot: root,
        managedRootDir: join(personalFilesDir, 'skills'),
        isBinaryAvailable: () => true,
      });
      const skillTool = createSkillTool(runtime);

      expect(skillTool.name).toBe('skill');
      expect(skillTool.label).toBe('skill');

      const createResult = await skillTool.execute('call-1', {
        action: 'create',
        name: 'incident-runbook',
        category: 'ops',
        description: 'Incident response checklist.',
        content: '# Incident Runbook\n\n- Gather logs\n- Escalate if needed',
      });
      const createdPayload = JSON.parse(readText(createResult)) as {
        action: string;
        version: number;
        ownership: string;
        path: string;
      };
      expect(createdPayload.action).toBe('created');
      expect(createdPayload.version).toBe(1);
      expect(createdPayload.ownership).toBe('personal');
      expect(createdPayload.path).toContain('purrsephone/skills/ops/incident-runbook/SKILL.md');

      const viewCreated = await skillTool.execute('call-2', {
        action: 'skill_view',
        name: 'incident-runbook',
      });
      const createdViewPayload = JSON.parse(readText(viewCreated)) as {
        name: string;
        content: string;
        category: string;
        ownership: string;
      };
      expect(createdViewPayload.name).toBe('incident-runbook');
      expect(createdViewPayload.category).toBe('ops');
      expect(createdViewPayload.ownership).toBe('personal');
      expect(createdViewPayload.content).toContain('Gather logs');

      const updateResult = await skillTool.execute('call-3', {
        action: 'update',
        name: 'incident-runbook',
        content: '# Incident Runbook\n\n- Gather logs\n- Escalate if needed\n- Postmortem',
      });
      const updatedPayload = JSON.parse(readText(updateResult)) as {
        action: string;
        version: number;
      };
      expect(updatedPayload.action).toBe('updated');
      expect(updatedPayload.version).toBe(2);

      const listResult = await skillTool.execute('call-4', {
        includeSkipped: false,
      });
      const listPayload = JSON.parse(readText(listResult)) as {
        managedOwnership: { owner: string; managedRoot: string; configPath: string };
        categories: Array<{ category: string; total: number; included: number }>;
        includedInPrompt: Array<{ name: string; ownership: string }>;
        skills: Array<{ name: string; inPromptIndex: boolean; ownership: string }>;
      };
      expect(listPayload.managedOwnership).toEqual({
        owner: 'personal',
        managedRoot: 'purrsephone/skills',
        configPath: 'companion-data/skills.json',
      });
      expect(listPayload.categories).toContainEqual({
        category: 'ops',
        total: 1,
        included: 1,
      });
      expect(listPayload.includedInPrompt.some(skill => (
        skill.name === 'incident-runbook'
        && skill.ownership === 'personal'
      ))).toBe(true);
      const managedSkill = listPayload.skills.find(skill => skill.name === 'incident-runbook');
      expect(managedSkill?.inPromptIndex).toBe(true);
      expect(managedSkill?.ownership).toBe('personal');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns explicit errors for invalid actions, invalid names, and missing skills', async () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-tools-errors-'));
    const companionDataDir = join(root, 'companion-data');
    const personalFilesDir = join(root, 'purrsephone');
    const seedDir = join(root, 'config');
    mkdirSync(companionDataDir, { recursive: true });
    mkdirSync(personalFilesDir, { recursive: true });
    writeSkillsConfig(companionDataDir, seedDir);

    try {
      const runtime = new SkillsRuntime({
        dataDir: companionDataDir,
        seedDir,
        repoRoot: root,
        managedRootDir: join(personalFilesDir, 'skills'),
      });
      const skillTool = createSkillTool(runtime);

      const missingAction = await skillTool.execute('call-0', {
        name: 'needs-action',
      });
      expect(readText(missingAction)).toContain('action is required unless using the default list behavior');
      expect(missingAction.details.isError).toBe(true);

      const invalidCreate = await skillTool.execute('call-1', {
        action: 'skill_create',
        name: '../escape',
        category: 'ops',
        content: 'bad',
      });
      expect(readText(invalidCreate)).toContain('Unable to use skill tool');
      expect(invalidCreate.details.isError).toBe(true);

      const missingView = await skillTool.execute('call-2', {
        action: 'view',
        name: 'not-found',
      });
      expect(readText(missingView)).toContain('not found');
      expect(missingView.details.isError).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exposes named and list-level skill usage stats without skill content', async () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-tools-stats-'));
    const companionDataDir = join(root, 'companion-data');
    const personalFilesDir = join(root, 'purrsephone');
    const seedDir = join(root, 'config');
    mkdirSync(companionDataDir, { recursive: true });
    mkdirSync(personalFilesDir, { recursive: true });
    writeSkillsConfig(companionDataDir, seedDir);

    try {
      const runtime = new SkillsRuntime({
        dataDir: companionDataDir,
        seedDir,
        repoRoot: root,
        managedRootDir: join(personalFilesDir, 'skills'),
        isBinaryAvailable: () => true,
      });
      const skillTool = createSkillTool(runtime);

      await skillTool.execute('call-create-1', {
        action: 'create',
        name: 'incident-runbook',
        category: 'ops',
        description: 'Incident response checklist.',
        content: '# Incident Runbook\n\n- Secret escalation text',
      });
      await skillTool.execute('call-create-2', {
        action: 'create',
        name: 'quiet-review',
        category: 'reflection',
        description: 'Slow review checklist.',
        content: '# Quiet Review\n\n- Private review body',
      });

      await skillTool.execute('call-view-1', {
        action: 'view',
        name: 'incident-runbook',
      });
      runtime.recordSkillInvocation('incident-runbook', {
        outcome: 'failure',
        durationMs: 50,
        occurredAt: '2026-06-29T12:00:00.000Z',
      });

      const namedStatsResult = await skillTool.execute('call-stats-1', {
        action: 'stats',
        name: 'incident-runbook',
      });
      const namedStats = JSON.parse(readText(namedStatsResult)) as {
        status: string;
        skill: { name: string; path: string };
        stats: {
          invocationCount: number;
          successCount: number;
          failureCount: number;
          lastOutcome: string;
        };
      };
      expect(namedStats.status).toBe('ok');
      expect(namedStats.skill.name).toBe('incident-runbook');
      expect(namedStats.skill.path).toContain('purrsephone/skills/ops/incident-runbook/SKILL.md');
      expect(namedStats.stats.invocationCount).toBe(2);
      expect(namedStats.stats.successCount).toBe(1);
      expect(namedStats.stats.failureCount).toBe(1);
      expect(namedStats.stats.lastOutcome).toBe('failure');
      expect(readText(namedStatsResult)).not.toContain('Secret escalation text');

      const noStatsResult = await skillTool.execute('call-stats-2', {
        action: 'skill_stats',
        name: 'quiet-review',
      });
      const noStatsPayload = JSON.parse(readText(noStatsResult)) as {
        status: string;
        stats: null;
      };
      expect(noStatsPayload.status).toBe('no_stats');
      expect(noStatsPayload.stats).toBeNull();

      const missingStatsResult = await skillTool.execute('call-stats-3', {
        action: 'stats',
        name: 'not-found',
      });
      const missingStatsPayload = JSON.parse(readText(missingStatsResult)) as {
        status: string;
        stats: null;
        message: string;
      };
      expect(missingStatsResult.details.isError).toBeUndefined();
      expect(missingStatsPayload.status).toBe('not_found');
      expect(missingStatsPayload.stats).toBeNull();
      expect(missingStatsPayload.message).toContain('was not found');

      const listStatsResult = await skillTool.execute('call-stats-4', {
        action: 'stats',
      });
      const listStats = JSON.parse(readText(listStatsResult)) as {
        scope: string;
        totals: {
          recordedSkills: number;
          invocationCount: number;
          successCount: number;
          failureCount: number;
        };
        skills: Array<{
          name: string;
          stats: null | { invocationCount: number };
        }>;
      };
      expect(listStats.scope).toBe('list');
      expect(listStats.totals.recordedSkills).toBe(1);
      expect(listStats.totals.invocationCount).toBe(2);
      expect(listStats.totals.successCount).toBe(1);
      expect(listStats.totals.failureCount).toBe(1);
      expect(listStats.skills.find(skill => skill.name === 'incident-runbook')?.stats?.invocationCount).toBe(2);
      expect(listStats.skills.find(skill => skill.name === 'quiet-review')?.stats).toBeNull();
      expect(readText(listStatsResult)).not.toContain('Private review body');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
