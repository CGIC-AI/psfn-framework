import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillsRuntime } from './runtime.js';
import { createSkillTool, type SkillWriteGovernance } from './tools.js';
import type {
  ApprovalQueuePort,
  ConfirmationQueueEntry,
  ConfirmationQueueRequest,
  ConfirmationExecutionContext,
} from '../../system/capabilities/approval-queue-port.js';
import {
  gateToolWithCapabilities,
  type CapabilityAccess,
} from '../../system/capabilities/gate.js';

const AUTONOMOUS_GOVERNANCE: SkillWriteGovernance = {
  getCapabilityTier: () => 'autonomous',
};

type QueueExecutor = (
  params: Record<string, unknown>,
  entry: ConfirmationQueueEntry,
  context: ConfirmationExecutionContext,
) => Promise<unknown>;

function createCapturingQueue(): {
  queue: ApprovalQueuePort;
  requests: ConfirmationQueueRequest[];
  entries: ConfirmationQueueEntry[];
  executors: QueueExecutor[];
} {
  const requests: ConfirmationQueueRequest[] = [];
  const entries: ConfirmationQueueEntry[] = [];
  const executors: QueueExecutor[] = [];
  const queue: ApprovalQueuePort = {
    enqueue: (request, execute) => {
      requests.push(request);
      executors.push(execute);
      const entry: ConfirmationQueueEntry = {
        id: `proposal-${requests.length}`,
        method: request.method,
        action: request.action,
        scope: request.scope,
        params: request.params,
        companionReason: request.companionReason,
        requestedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      };
      entries.push(entry);
      return entry;
    },
    listPending: () => [...entries],
    listHistory: () => [],
    getPending: (id) => entries.find(entry => entry.id === id) ?? null,
    getApprovalOwner: () => null,
    resolve: async () => {
      throw new Error('resolve is unused in this fake');
    },
  };
  return { queue, requests, entries, executors };
}

interface SkillToolHarness {
  root: string;
  runtime: SkillsRuntime;
}

function setupSkillRuntime(prefix: string): SkillToolHarness {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const companionDataDir = join(root, 'companion-data');
  const personalFilesDir = join(root, 'purrsephone');
  const seedDir = join(root, 'config');
  mkdirSync(companionDataDir, { recursive: true });
  mkdirSync(personalFilesDir, { recursive: true });
  writeSkillsConfig(companionDataDir, seedDir);
  const runtime = new SkillsRuntime({
    dataDir: companionDataDir,
    seedDir,
    repoRoot: root,
    managedRootDir: join(personalFilesDir, 'skills'),
    isBinaryAvailable: () => true,
  });
  return { root, runtime };
}

const LONG_SKILL_BODY = '# Long Skill\n\n'
  + 'A load-bearing instruction line that matters a great deal.\n'.repeat(12);

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
      const skillTool = createSkillTool(runtime, undefined, AUTONOMOUS_GOVERNANCE);

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
      const skillTool = createSkillTool(runtime, undefined, AUTONOMOUS_GOVERNANCE);

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
      const skillTool = createSkillTool(runtime, undefined, AUTONOMOUS_GOVERNANCE);

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

describe('skill write governance (charter 9.5 category-2)', () => {
  it('refuses every write action when governance is not wired (fail closed)', async () => {
    const { root, runtime } = setupSkillRuntime('skills-gov-unwired-');
    try {
      const ungoverned = createSkillTool(runtime);
      const createResult = await ungoverned.execute('call-1', {
        action: 'create',
        name: 'blocked-skill',
        category: 'ops',
        content: 'Body text for a blocked create.',
      });
      expect(readText(createResult)).toContain('governance');
      expect(readText(createResult)).toContain('fail closed');
      expect(createResult.details.isError).toBe(true);
      expect(runtime.getStore().getByName('blocked-skill')).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('applies non-destructive updates directly at autonomous tier with journaled history', async () => {
    const { root, runtime } = setupSkillRuntime('skills-gov-append-');
    try {
      const tool = createSkillTool(runtime, undefined, AUTONOMOUS_GOVERNANCE);
      await tool.execute('call-1', {
        action: 'create',
        name: 'append-skill',
        category: 'ops',
        description: 'Append test skill.',
        content: LONG_SKILL_BODY,
      });
      const appendResult = await tool.execute('call-2', {
        action: 'update',
        name: 'append-skill',
        content: `${LONG_SKILL_BODY}\nOne appended line.`,
        reason: 'small append',
      });
      const payload = JSON.parse(readText(appendResult)) as { action: string; version: number };
      expect(payload.action).toBe('updated');
      expect(payload.version).toBe(2);

      const history = runtime.getStore().getHistory('append-skill');
      expect(history).toHaveLength(2);
      expect(history[1]).toMatchObject({
        action: 'update',
        updatedBy: 'agent',
        reason: 'small append',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('queues a destructive update at autonomous tier and applies it only on approval', async () => {
    const { root, runtime } = setupSkillRuntime('skills-gov-destructive-');
    try {
      const { queue, requests, entries, executors } = createCapturingQueue();
      const tool = createSkillTool(runtime, undefined, {
        getCapabilityTier: () => 'autonomous',
        confirmationQueue: queue,
      });
      await tool.execute('call-1', {
        action: 'create',
        name: 'guarded-skill',
        category: 'ops',
        description: 'Destructive test skill.',
        content: LONG_SKILL_BODY,
      });

      const destructiveResult = await tool.execute('call-2', {
        action: 'update',
        name: 'guarded-skill',
        content: 'Tiny replacement.',
      });
      const queuedPayload = JSON.parse(readText(destructiveResult)) as {
        action: string;
        cause: string;
        proposalId: string;
      };
      expect(queuedPayload.action).toBe('queued');
      expect(queuedPayload.cause).toBe('destructive');
      expect(requests).toHaveLength(1);
      expect(requests[0]?.method).toBe('skills.skill.update');
      expect(requests[0]?.params.baseVersion).toBe(1);

      // NOT silently live: the file still has the original body.
      const beforeApproval = runtime.getStore().getByName('guarded-skill');
      expect(beforeApproval?.version).toBe(1);
      expect(beforeApproval?.content).toContain('load-bearing instruction line');

      // Operator approves: the queued executor applies with admin provenance.
      await executors[0]!(requests[0]!.params, entries[0]!, {});
      const afterApproval = runtime.getStore().getByName('guarded-skill');
      expect(afterApproval?.version).toBe(2);
      expect(afterApproval?.content).toBe('Tiny replacement.');
      const history = runtime.getStore().getHistory('guarded-skill');
      expect(history[1]).toMatchObject({ action: 'update', updatedBy: 'admin:confirmation' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a destructive update at autonomous tier when no queue is configured', async () => {
    const { root, runtime } = setupSkillRuntime('skills-gov-noqueue-');
    try {
      const tool = createSkillTool(runtime, undefined, AUTONOMOUS_GOVERNANCE);
      await tool.execute('call-1', {
        action: 'create',
        name: 'stuck-skill',
        category: 'ops',
        description: 'No queue test skill.',
        content: LONG_SKILL_BODY,
      });
      const refused = await tool.execute('call-2', {
        action: 'update',
        name: 'stuck-skill',
        content: 'Tiny replacement.',
      });
      expect(readText(refused)).toContain('Destructive skill update blocked');
      expect(refused.details.isError).toBe(true);
      expect(runtime.getStore().getByName('stuck-skill')?.content).toContain('load-bearing');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('queues every write below autonomous tier, including creates', async () => {
    const { root, runtime } = setupSkillRuntime('skills-gov-tier-');
    try {
      const { queue, requests, entries, executors } = createCapturingQueue();
      const tool = createSkillTool(runtime, undefined, {
        getCapabilityTier: () => 'apprentice',
        confirmationQueue: queue,
      });
      const createResult = await tool.execute('call-1', {
        action: 'create',
        name: 'tiered-skill',
        category: 'ops',
        content: 'A skill body proposed from a supervised tier.',
      });
      const payload = JSON.parse(readText(createResult)) as { action: string; cause: string };
      expect(payload.action).toBe('queued');
      expect(payload.cause).toBe('tier');
      expect(requests[0]?.method).toBe('skills.skill.create');
      expect(runtime.getStore().getByName('tiered-skill')).toBeNull();

      await executors[0]!(requests[0]!.params, entries[0]!, {});
      const applied = runtime.getStore().getByName('tiered-skill');
      expect(applied?.version).toBe(1);
      expect(runtime.getStore().getHistory('tiered-skill')[0]).toMatchObject({
        action: 'create',
        updatedBy: 'admin:confirmation',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails an approved update whose base version drifted (no silent clobber)', async () => {
    const { root, runtime } = setupSkillRuntime('skills-gov-drift-');
    try {
      const { queue, requests, entries, executors } = createCapturingQueue();
      const tool = createSkillTool(runtime, undefined, {
        getCapabilityTier: () => 'autonomous',
        confirmationQueue: queue,
      });
      await tool.execute('call-1', {
        action: 'create',
        name: 'drift-skill',
        category: 'ops',
        description: 'Drift test skill.',
        content: LONG_SKILL_BODY,
      });
      await tool.execute('call-2', {
        action: 'update',
        name: 'drift-skill',
        content: 'Tiny replacement.',
      });
      // Skill changes between proposal and approval.
      runtime.getStore().update(
        { name: 'drift-skill', content: `${LONG_SKILL_BODY}\nIntervening edit.` },
        { updatedBy: 'agent' },
      );
      await expect(executors[0]!(requests[0]!.params, entries[0]!, {}))
        .rejects.toThrow(/changed since this proposal/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('restores a journaled version byte-exactly through action=rollback and lists history', async () => {
    const { root, runtime } = setupSkillRuntime('skills-gov-rollback-');
    try {
      const tool = createSkillTool(runtime, undefined, AUTONOMOUS_GOVERNANCE);
      const originalContent = '# Rollback Skill\n\n- Original step one\n- Original step two';
      await tool.execute('call-1', {
        action: 'create',
        name: 'rollback-skill',
        category: 'ops',
        description: 'Rollback test skill.',
        content: originalContent,
      });
      await tool.execute('call-2', {
        action: 'update',
        name: 'rollback-skill',
        content: '# Rollback Skill\n\n- Original step one\n- Original step two\n- Third step',
      });

      const historyResult = await tool.execute('call-3', {
        action: 'history',
        name: 'rollback-skill',
      });
      const historyPayload = JSON.parse(readText(historyResult)) as {
        entries: Array<{ action: string; version: number; updatedBy: string }>;
      };
      expect(historyPayload.entries).toHaveLength(2);
      expect(historyPayload.entries[0]).toMatchObject({ action: 'create', version: 1 });
      expect(historyPayload.entries[1]).toMatchObject({ action: 'update', version: 2 });

      const rollbackResult = await tool.execute('call-4', {
        action: 'rollback',
        name: 'rollback-skill',
        version: 1,
      });
      const rollbackPayload = JSON.parse(readText(rollbackResult)) as {
        action: string;
        restoredFromVersion: number;
        version: number;
      };
      expect(rollbackPayload.action).toBe('rolled_back');
      expect(rollbackPayload.restoredFromVersion).toBe(1);
      expect(rollbackPayload.version).toBe(3);

      const restored = runtime.getStore().getByName('rollback-skill');
      expect(restored?.content).toBe(originalContent);
      expect(runtime.getStore().getHistory('rollback-skill')[2]).toMatchObject({
        action: 'rollback',
        updatedBy: 'agent:rollback',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is refused by the capability gate for writes without identity.write.runtime', async () => {
    const { root, runtime } = setupSkillRuntime('skills-gov-gate-');
    try {
      const tool = createSkillTool(runtime, undefined, AUTONOMOUS_GOVERNANCE);
      const readOnlyAccess: CapabilityAccess = {
        getTier: () => 'nursery',
        getGrantedTokens: () => new Set(['identity.read']),
        has: (token) => token === 'identity.read',
      };
      const gated = gateToolWithCapabilities(tool, () => readOnlyAccess);

      const denied = await gated.execute('call-1', {
        action: 'create',
        name: 'gated-skill',
        category: 'ops',
        content: 'Body that must not land.',
      });
      expect(readText(denied)).toContain('Capability denied');
      expect(runtime.getStore().getByName('gated-skill')).toBeNull();

      const deniedRollback = await gated.execute('call-2', {
        action: 'rollback',
        name: 'gated-skill',
        version: 1,
      });
      expect(readText(deniedRollback)).toContain('Capability denied');

      const allowedList = await gated.execute('call-3', { action: 'list' });
      expect(readText(allowedList)).toContain('managedOwnership');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
