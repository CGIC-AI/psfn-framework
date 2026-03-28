import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillsRuntime } from './runtime.js';
import {
  createSkillCreateTool,
  createSkillListTool,
  createSkillUpdateTool,
  createSkillViewTool,
} from './tools.js';

function writeSeedConfig(seedDir: string): void {
  mkdirSync(seedDir, { recursive: true });
  writeFileSync(join(seedDir, 'skills.seed.json'), JSON.stringify({
    enabled: true,
    directories: ['skills'],
    extraDirectories: [],
    maxLoadedSkills: 32,
    maxSkillChars: 24_000,
    disabledSkills: [],
  }, null, 2));
}

function readText(result: { content: Array<{ text?: string }> }): string {
  return result.content[0]?.text ?? '';
}

describe('skills tools', () => {
  it('supports create, view, update, and list for managed skills', async () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-tools-'));
    const dataDir = join(root, 'data');
    const seedDir = join(root, 'config');
    mkdirSync(dataDir, { recursive: true });
    writeSeedConfig(seedDir);

    try {
      const runtime = new SkillsRuntime({
        dataDir,
        seedDir,
        repoRoot: root,
        isBinaryAvailable: () => true,
      });
      const createTool = createSkillCreateTool(runtime);
      const viewTool = createSkillViewTool(runtime);
      const updateTool = createSkillUpdateTool(runtime);
      const listTool = createSkillListTool(runtime);

      const createResult = await createTool.execute('call-1', {
        name: 'incident-runbook',
        category: 'ops',
        description: 'Incident response checklist.',
        content: '# Incident Runbook\n\n- Gather logs\n- Escalate if needed',
      });
      const createdPayload = JSON.parse(readText(createResult)) as {
        action: string;
        version: number;
        path: string;
      };
      expect(createdPayload.action).toBe('created');
      expect(createdPayload.version).toBe(1);
      expect(createdPayload.path).toContain('data/skills/ops/incident-runbook/SKILL.md');

      const viewCreated = await viewTool.execute('call-2', { name: 'incident-runbook' });
      const createdViewPayload = JSON.parse(readText(viewCreated)) as {
        name: string;
        content: string;
        category: string;
      };
      expect(createdViewPayload.name).toBe('incident-runbook');
      expect(createdViewPayload.category).toBe('ops');
      expect(createdViewPayload.content).toContain('Gather logs');

      const updateResult = await updateTool.execute('call-3', {
        name: 'incident-runbook',
        content: '# Incident Runbook\n\n- Gather logs\n- Escalate if needed\n- Postmortem',
      });
      const updatedPayload = JSON.parse(readText(updateResult)) as {
        action: string;
        version: number;
      };
      expect(updatedPayload.action).toBe('updated');
      expect(updatedPayload.version).toBe(2);

      const listResult = await listTool.execute('call-4', {
        includeSkipped: false,
      });
      const listPayload = JSON.parse(readText(listResult)) as {
        includedInPrompt: Array<{ name: string }>;
        skills: Array<{ name: string; inPromptIndex: boolean }>;
      };
      expect(listPayload.includedInPrompt.some(skill => skill.name === 'incident-runbook')).toBe(true);
      const managedSkill = listPayload.skills.find(skill => skill.name === 'incident-runbook');
      expect(managedSkill?.inPromptIndex).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns explicit errors for invalid names and missing skills', async () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-tools-errors-'));
    const dataDir = join(root, 'data');
    const seedDir = join(root, 'config');
    mkdirSync(dataDir, { recursive: true });
    writeSeedConfig(seedDir);

    try {
      const runtime = new SkillsRuntime({
        dataDir,
        seedDir,
        repoRoot: root,
      });
      const createTool = createSkillCreateTool(runtime);
      const viewTool = createSkillViewTool(runtime);

      const invalidCreate = await createTool.execute('call-1', {
        name: '../escape',
        category: 'ops',
        content: 'bad',
      });
      expect(readText(invalidCreate)).toContain('Unable to create skill');
      expect(invalidCreate.details.isError).toBe(true);

      const missingView = await viewTool.execute('call-2', { name: 'not-found' });
      expect(readText(missingView)).toContain('not found');
      expect(missingView.details.isError).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
