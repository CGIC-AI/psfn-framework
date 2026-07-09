import { describe, expect, it, vi } from 'vitest';
import { Type } from '@sinclair/typebox';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { CapabilityTier } from '../config/runtime-config-contracts.js';
import type { CapabilityToken } from './tokens.js';
import {
  evaluateToolCapabilityEligibility,
  gateToolWithCapabilities,
  type CapabilityAccess,
} from './gate.js';
import { resolveTierCapabilityTokens } from './tiers.js';
import {
  assertToolCapabilityRequirementDeclared,
  resolveToolCapabilityRequirement,
  resolveToolRequiredCapabilities,
  toolHasDeclaredCapabilityRequirement,
  withCapabilityRequirement,
} from './requirements.js';
import { MODEL_FACING_DRIFT_GUARD_RETIRED_TOOL_ALIASES } from '../../core/agent/tool-surface/registry.js';

function accessForTier(
  tier: CapabilityTier,
  customTokens: CapabilityToken[] = [],
): CapabilityAccess {
  const granted = new Set(resolveTierCapabilityTokens(tier, customTokens));
  return {
    getTier: () => tier,
    getGrantedTokens: () => granted,
    has: (token) => granted.has(token),
  };
}

function createTool(name: string): {
  tool: AgentTool<any>;
  executeSpy: ReturnType<typeof vi.fn>;
} {
  const executeSpy = vi.fn().mockResolvedValue({
    content: [{ type: 'text', text: 'ok' }],
    details: {},
  });
  return {
    tool: {
      name,
      label: name,
      description: `${name} test tool`,
      parameters: Type.Object({}),
      execute: executeSpy,
    },
    executeSpy,
  };
}

describe('capability tool gating', () => {
  it('enforces nursery grants and denials', async () => {
    const memoryWrite = createTool('memory');
    const memoryGated = gateToolWithCapabilities(
      memoryWrite.tool,
      () => accessForTier('nursery'),
    );

    await memoryGated.execute('call-1', { action: 'write' });
    expect(memoryWrite.executeSpy).toHaveBeenCalledTimes(1);

    const repoCommit = createTool('repo_commit');
    const commitGated = gateToolWithCapabilities(
      repoCommit.tool,
      () => accessForTier('nursery'),
    );
    const denied = await commitGated.execute('call-2', {});

    expect(repoCommit.executeSpy).not.toHaveBeenCalled();
    expect((denied.details as any).isError).toBe(true);
    expect((denied.content[0] as any).text).toContain('git.write');
  });

  it('enforces apprentice grants and denials', async () => {
    const repoStatus = createTool('repo_status');
    const statusGated = gateToolWithCapabilities(
      repoStatus.tool,
      () => accessForTier('apprentice'),
    );
    await statusGated.execute('call-1', {});
    expect(repoStatus.executeSpy).toHaveBeenCalledTimes(1);

    const restart = createTool('system');
    const restartGated = gateToolWithCapabilities(
      restart.tool,
      () => accessForTier('apprentice'),
    );
    const denied = await restartGated.execute('call-2', { action: 'restart', reason: 'apply config' });

    expect(restart.executeSpy).not.toHaveBeenCalled();
    expect((denied.details as any).capabilityDenied).toBe(true);
    expect((denied.content[0] as any).text).toContain('lifecycle.restart');
  });

  it('gates unified system read actions by internal.read', async () => {
    const system = createTool('system');
    const deniedGated = gateToolWithCapabilities(
      system.tool,
      () => accessForTier('custom', ['lifecycle.restart']),
    );
    const denied = await deniedGated.execute('call-system-read-denied', { action: 'read', list: true });

    expect(system.executeSpy).not.toHaveBeenCalled();
    expect((denied.content[0] as any).text).toContain('internal.read');

    const allowedGated = gateToolWithCapabilities(
      system.tool,
      () => accessForTier('custom', ['internal.read']),
    );
    await allowedGated.execute('call-system-read-allowed', { action: 'read', list: true });
    expect(system.executeSpy).toHaveBeenCalledTimes(1);
  });

  it('gates unified memory delete-like actions by memory.delete capability token', async () => {
    const memoryDelete = createTool('memory');
    const nurseryGated = gateToolWithCapabilities(
      memoryDelete.tool,
      () => accessForTier('nursery'),
    );
    const denied = await nurseryGated.execute('call-1', { action: 'delete' });
    expect(memoryDelete.executeSpy).not.toHaveBeenCalled();
    expect((denied.content[0] as any).text).toContain('memory.delete');

    const apprenticeGated = gateToolWithCapabilities(
      memoryDelete.tool,
      () => accessForTier('apprentice'),
    );
    const apprenticeDenied = await apprenticeGated.execute('call-2', { action: 'restore' });
    expect(memoryDelete.executeSpy).not.toHaveBeenCalled();
    expect((apprenticeDenied.content[0] as any).text).toContain('memory.delete');

    const autonomousGated = gateToolWithCapabilities(
      memoryDelete.tool,
      () => accessForTier('autonomous'),
    );
    await autonomousGated.execute('call-3', { action: 'restore' });
    expect(memoryDelete.executeSpy).toHaveBeenCalledTimes(1);
  });

  it('gates unified memory redact by memory.delete capability token', async () => {
    const memory = createTool('memory');
    const nurseryGated = gateToolWithCapabilities(
      memory.tool,
      () => accessForTier('nursery'),
    );
    const denied = await nurseryGated.execute('call-1b', { action: 'redact' });
    expect(memory.executeSpy).not.toHaveBeenCalled();
    expect((denied.content[0] as any).text).toContain('memory.delete');

    const apprenticeGated = gateToolWithCapabilities(
      memory.tool,
      () => accessForTier('apprentice'),
    );
    const apprenticeDenied = await apprenticeGated.execute('call-2b', { action: 'redact' });
    expect(memory.executeSpy).not.toHaveBeenCalled();
    expect((apprenticeDenied.content[0] as any).text).toContain('memory.delete');

    const autonomousGated = gateToolWithCapabilities(
      memory.tool,
      () => accessForTier('autonomous'),
    );
    await autonomousGated.execute('call-3b', { action: 'redact' });
    expect(memory.executeSpy).toHaveBeenCalledTimes(1);
  });

  it('gates unified memory read and write actions by their specific tokens', async () => {
    const memorySearch = createTool('memory');
    const searchGated = gateToolWithCapabilities(
      memorySearch.tool,
      () => accessForTier('custom', ['memory.write']),
    );
    const searchDenied = await searchGated.execute('call-search', { action: 'search' });
    expect(memorySearch.executeSpy).not.toHaveBeenCalled();
    expect((searchDenied.content[0] as any).text).toContain('identity.read');

    const memoryWrite = createTool('memory');
    const writeGated = gateToolWithCapabilities(
      memoryWrite.tool,
      () => accessForTier('custom', ['identity.read']),
    );
    const writeDenied = await writeGated.execute('call-write', { action: 'write' });
    expect(memoryWrite.executeSpy).not.toHaveBeenCalled();
    expect((writeDenied.content[0] as any).text).toContain('memory.write');

    const patchDenied = await writeGated.execute('call-patch', { action: 'patch' });
    expect(memoryWrite.executeSpy).not.toHaveBeenCalled();
    expect((patchDenied.content[0] as any).text).toContain('memory.write');

    const memoryTimeline = createTool('memory');
    const timelineGated = gateToolWithCapabilities(
      memoryTimeline.tool,
      () => accessForTier('custom', ['memory.write']),
    );
    const timelineDenied = await timelineGated.execute('call-timeline', { action: 'timeline' });
    expect(memoryTimeline.executeSpy).not.toHaveBeenCalled();
    expect((timelineDenied.content[0] as any).text).toContain('identity.read');

    const memoryCensus = createTool('memory');
    const censusGated = gateToolWithCapabilities(
      memoryCensus.tool,
      () => accessForTier('custom', ['memory.write']),
    );
    const censusDenied = await censusGated.execute('call-census', { action: 'census' });
    expect(memoryCensus.executeSpy).not.toHaveBeenCalled();
    expect((censusDenied.content[0] as any).text).toContain('identity.read');

    const memoryExists = createTool('memory');
    const existsGated = gateToolWithCapabilities(
      memoryExists.tool,
      () => accessForTier('custom', ['identity.read']),
    );
    await existsGated.execute('call-exists', { action: 'exists', query: 'topic' });
    expect(memoryExists.executeSpy).toHaveBeenCalledTimes(1);
  });

  it('resolves canonical action-aware requirements for consolidated tool domains', () => {
    expect(resolveToolRequiredCapabilities(createTool('contact').tool, { action: 'lookup', contactId: 'contact-1' })).toEqual(['identity.read']);
    expect(resolveToolRequiredCapabilities(createTool('memory').tool, { action: 'timeline' })).toEqual(['identity.read']);
    expect(resolveToolRequiredCapabilities(createTool('contact').tool, { action: 'note', contactId: 'contact-1' })).toEqual(['identity.write.runtime']);
    expect(resolveToolRequiredCapabilities(createTool('media').tool, { action: 'generate' })).toEqual([]);
    expect(resolveToolRequiredCapabilities(createTool('media').tool, { action: 'analyze' })).toEqual([]);
    expect(resolveToolRequiredCapabilities(createTool('selfie_create').tool, {})).toEqual([]);
    expect(resolveToolRequiredCapabilities(createTool('web').tool, { action: 'search' })).toEqual([]);
    expect(resolveToolRequiredCapabilities(createTool('web_fetch').tool, {})).toEqual([]);
    expect(resolveToolRequiredCapabilities(createTool('settings_get').tool, {})).toEqual(['internal.read']);
    expect(resolveToolRequiredCapabilities(createTool('self_status').tool, {})).toEqual(['internal.read']);
    expect(resolveToolRequiredCapabilities(createTool('response_control').tool, { action: 'no_reply' })).toEqual(['identity.read']);
    expect(resolveToolRequiredCapabilities(createTool('subagent').tool, { action: 'status' })).toEqual(['identity.read']);
    expect(resolveToolRequiredCapabilities(createTool('subagent').tool, { action: 'spawn' })).toEqual(['shard.spawn']);
    expect(resolveToolRequiredCapabilities(createTool('skill').tool, { action: 'stats' })).toEqual(['identity.read']);
    expect(resolveToolRequiredCapabilities(createTool('skill').tool, { action: 'skill_view' })).toEqual(['identity.read']);
    expect(resolveToolRequiredCapabilities(createTool('skill').tool, { action: 'update' })).toEqual(['identity.write.runtime']);
  });

  it('gates unified skill stats as read-oriented and mutations as runtime writes', async () => {
    const skillStats = createTool('skill');
    const statsDeniedGated = gateToolWithCapabilities(
      skillStats.tool,
      () => accessForTier('custom', ['identity.write.runtime']),
    );
    const statsDenied = await statsDeniedGated.execute('call-skill-stats-denied', { action: 'stats' });
    expect(skillStats.executeSpy).not.toHaveBeenCalled();
    expect((statsDenied.content[0] as any).text).toContain('identity.read');

    const statsAllowedGated = gateToolWithCapabilities(
      skillStats.tool,
      () => accessForTier('custom', ['identity.read']),
    );
    await statsAllowedGated.execute('call-skill-stats-allowed', { action: 'stats' });
    expect(skillStats.executeSpy).toHaveBeenCalledTimes(1);

    const skillUpdate = createTool('skill');
    const updateDeniedGated = gateToolWithCapabilities(
      skillUpdate.tool,
      () => accessForTier('custom', ['identity.read']),
    );
    const updateDenied = await updateDeniedGated.execute('call-skill-update-denied', { action: 'update' });
    expect(skillUpdate.executeSpy).not.toHaveBeenCalled();
    expect((updateDenied.content[0] as any).text).toContain('identity.write.runtime');
  });

  it('does not grant static capability metadata to retired model-facing split aliases', () => {
    const retiredMetadataAliases = [
      ...MODEL_FACING_DRIFT_GUARD_RETIRED_TOOL_ALIASES,
      'promoted_tools_list',
      'promoted_tools_add',
      'promoted_tools_remove',
      'promoted_tools_swap',
    ];

    for (const alias of retiredMetadataAliases) {
      expect(resolveToolRequiredCapabilities(createTool(alias).tool, {}), alias).toEqual([]);
    }
  });

  it('gates unified north_star actions by read versus runtime-write capability tokens', async () => {
    const northStarList = createTool('north_star');
    const listGated = gateToolWithCapabilities(
      northStarList.tool,
      () => accessForTier('custom', ['identity.write.runtime']),
    );
    const listDenied = await listGated.execute('call-north-star-list', { action: 'list' });
    expect(northStarList.executeSpy).not.toHaveBeenCalled();
    expect((listDenied.content[0] as any).text).toContain('identity.read');

    const northStarUpdate = createTool('north_star');
    const updateGated = gateToolWithCapabilities(
      northStarUpdate.tool,
      () => accessForTier('custom', ['identity.read']),
    );
    const updateDenied = await updateGated.execute('call-north-star-update', { action: 'update' });
    expect(northStarUpdate.executeSpy).not.toHaveBeenCalled();
    expect((updateDenied.content[0] as any).text).toContain('identity.write.runtime');
  });

  it('gates shell by repl.execute capability token', async () => {
    const shell = createTool('shell');
    const deniedGated = gateToolWithCapabilities(
      shell.tool,
      () => accessForTier('custom', ['git.read']),
    );
    const denied = await deniedGated.execute('call-shell-denied', { action: 'exec', command: 'node' });

    expect(shell.executeSpy).not.toHaveBeenCalled();
    expect((denied.content[0] as any).text).toContain('repl.execute');

    const allowedGated = gateToolWithCapabilities(
      shell.tool,
      () => accessForTier('custom', ['repl.execute']),
    );
    await allowedGated.execute('call-shell-allowed', { action: 'exec', command: 'node' });
    expect(shell.executeSpy).toHaveBeenCalledTimes(1);
  });

  it('grants autonomous tier access for locked tools', async () => {
    const restart = createTool('system');
    const restartGated = gateToolWithCapabilities(
      restart.tool,
      () => accessForTier('autonomous'),
    );
    await restartGated.execute('call-1', { action: 'restart', reason: 'apply config' });
    expect(restart.executeSpy).toHaveBeenCalledTimes(1);

    const repoCommit = createTool('repo_commit');
    const commitGated = gateToolWithCapabilities(
      repoCommit.tool,
      () => accessForTier('autonomous'),
    );
    await commitGated.execute('call-2', {});
    expect(repoCommit.executeSpy).toHaveBeenCalledTimes(1);
  });

  it('leaves benign media and web tools ungated across tiers', async () => {
    // `generate_image` is the canonical media surface; the old `media` alias is
    // retired and now correctly fails closed as undeclared (02-M2).
    for (const toolName of ['generate_image', 'selfie_create', 'web', 'web_fetch']) {
      const tool = createTool(toolName);
      const gated = gateToolWithCapabilities(
        tool.tool,
        () => accessForTier('custom', []),
      );
      await gated.execute(`call-${toolName}`, { action: 'generate' });
      expect(tool.executeSpy, toolName).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps read-only internal state at apprentice tier', async () => {
    const settings = createTool('settings_get');
    const nurserySettings = gateToolWithCapabilities(
      settings.tool,
      () => accessForTier('nursery'),
    );
    const settingsDenied = await nurserySettings.execute('settings-nursery', {});
    expect(settings.executeSpy).not.toHaveBeenCalled();
    expect((settingsDenied.content[0] as any).text).toContain('internal.read');

    const apprenticeSettings = gateToolWithCapabilities(
      settings.tool,
      () => accessForTier('apprentice'),
    );
    await apprenticeSettings.execute('settings-apprentice', {});
    expect(settings.executeSpy).toHaveBeenCalledTimes(1);

    const selfStatus = createTool('self_status');
    const nurseryStatus = gateToolWithCapabilities(
      selfStatus.tool,
      () => accessForTier('nursery'),
    );
    const statusDenied = await nurseryStatus.execute('status-nursery', {});
    expect(selfStatus.executeSpy).not.toHaveBeenCalled();
    expect((statusDenied.content[0] as any).text).toContain('internal.read');
  });

  it('enforces custom tier cherry-picked tokens', async () => {
    const promptList = createTool('prompt_layer_list');
    const promptGated = gateToolWithCapabilities(
      promptList.tool,
      () => accessForTier('custom', ['identity.read']),
    );
    await promptGated.execute('call-1', {});
    expect(promptList.executeSpy).toHaveBeenCalledTimes(1);

    const memoryWrite = createTool('memory');
    const memoryGated = gateToolWithCapabilities(
      memoryWrite.tool,
      () => accessForTier('custom', ['identity.read']),
    );
    const denied = await memoryGated.execute('call-2', { action: 'write' });
    expect(memoryWrite.executeSpy).not.toHaveBeenCalled();
    expect((denied.content[0] as any).text).toContain('memory.write');
  });

  it('supports dynamic per-tool requirements', async () => {
    const dynamic = createTool('dynamic_prompt_write');
    const annotated = withCapabilityRequirement(dynamic.tool, (params) => (
      params.layer === 'base' ? 'identity.write.base' : 'identity.write.runtime'
    ));

    const nursery = gateToolWithCapabilities(
      annotated,
      () => accessForTier('nursery'),
    );
    await nursery.execute('call-1', { layer: 'runtime' });
    expect(dynamic.executeSpy).toHaveBeenCalledTimes(1);

    const denied = await nursery.execute('call-2', { layer: 'base' });
    expect((denied.details as any).capabilityDenied).toBe(true);
    expect((denied.content[0] as any).text).toContain('identity.write.base');

    const apprentice = gateToolWithCapabilities(
      annotated,
      () => accessForTier('apprentice'),
    );
    const apprenticeDenied = await apprentice.execute('call-3', { layer: 'base' });
    expect((apprenticeDenied.content[0] as any).text).toContain('identity.write.base');
    expect(dynamic.executeSpy).toHaveBeenCalledTimes(1);

    const autonomous = gateToolWithCapabilities(
      annotated,
      () => accessForTier('autonomous'),
    );
    await autonomous.execute('call-4', { layer: 'base' });
    expect(dynamic.executeSpy).toHaveBeenCalledTimes(2);
  });

  it('gates scratchpad actions using dynamic capability requirements', async () => {
    const scratchpad = createTool('scratchpad');
    const readGated = gateToolWithCapabilities(
      scratchpad.tool,
      () => accessForTier('custom', ['memory.write']),
    );
    const readDenied = await readGated.execute('call-read', { action: 'list' });
    expect(scratchpad.executeSpy).not.toHaveBeenCalled();
    expect((readDenied.content[0] as any).text).toContain('identity.read');

    const writeGated = gateToolWithCapabilities(
      scratchpad.tool,
      () => accessForTier('custom', ['identity.read']),
    );
    const writeDenied = await writeGated.execute('call-write', { action: 'add' });
    expect(scratchpad.executeSpy).not.toHaveBeenCalled();
    expect((writeDenied.content[0] as any).text).toContain('memory.write');

    const replaceDenied = await writeGated.execute('call-replace', { action: 'replace' });
    expect(scratchpad.executeSpy).not.toHaveBeenCalled();
    expect((replaceDenied.content[0] as any).text).toContain('memory.write');
  });

  it('gates orient values actions by read versus runtime-write capability tokens', async () => {
    const orient = createTool('orient');
    const readGated = gateToolWithCapabilities(
      orient.tool,
      () => accessForTier('custom', ['identity.write.runtime']),
    );
    const listDenied = await readGated.execute('orient-values-list', { action: 'values_list' });
    expect(orient.executeSpy).not.toHaveBeenCalled();
    expect((listDenied.content[0] as any).text).toContain('identity.read');

    const writeGated = gateToolWithCapabilities(
      orient.tool,
      () => accessForTier('custom', ['identity.read']),
    );
    const addDenied = await writeGated.execute('orient-values-add', {
      action: 'values_add',
      value: 'Protect trust continuity.',
    });
    expect(orient.executeSpy).not.toHaveBeenCalled();
    expect((addDenied.content[0] as any).text).toContain('identity.write.runtime');

    const updateDenied = await writeGated.execute('orient-values-update', {
      action: 'values_update',
      version: 1,
      value: 'Protect trust continuity explicitly.',
    });
    expect(orient.executeSpy).not.toHaveBeenCalled();
    expect((updateDenied.content[0] as any).text).toContain('identity.write.runtime');

    const allowedGated = gateToolWithCapabilities(
      orient.tool,
      () => accessForTier('custom', ['identity.write.runtime']),
    );
    await allowedGated.execute('orient-values-add-allowed', {
      action: 'values_add',
      value: 'Protect trust continuity.',
    });
    expect(orient.executeSpy).toHaveBeenCalledTimes(1);
  });

  it('gates unified session actions by read versus runtime-write capability tokens', async () => {
    const session = createTool('session');
    const readGated = gateToolWithCapabilities(
      session.tool,
      () => accessForTier('custom', ['memory.write']),
    );
    const listDenied = await readGated.execute('session-list', { action: 'list' });
    expect(session.executeSpy).not.toHaveBeenCalled();
    expect((listDenied.content[0] as any).text).toContain('identity.read');

    const searchDenied = await readGated.execute('session-search', { action: 'search', query: 'orion' });
    expect(session.executeSpy).not.toHaveBeenCalled();
    expect((searchDenied.content[0] as any).text).toContain('identity.read');

    const grepDenied = await readGated.execute('session-grep', { action: 'grep', pattern: 'orion' });
    expect(session.executeSpy).not.toHaveBeenCalled();
    expect((grepDenied.content[0] as any).text).toContain('identity.read');

    const writeGated = gateToolWithCapabilities(
      session.tool,
      () => accessForTier('custom', ['identity.read']),
    );
    const newDenied = await writeGated.execute('session-new', { action: 'new' });
    expect(session.executeSpy).not.toHaveBeenCalled();
    expect((newDenied.content[0] as any).text).toContain('identity.write.runtime');

    const resumeDenied = await writeGated.execute('session-resume', {
      action: 'resume',
      sessionId: 'api:resume-me',
    });
    expect(session.executeSpy).not.toHaveBeenCalled();
    expect((resumeDenied.content[0] as any).text).toContain('identity.write.runtime');

    const focusDenied = await writeGated.execute('session-focus', {
      action: 'start_focus',
      scope: 'Investigate continuity',
    });
    expect(session.executeSpy).not.toHaveBeenCalled();
    expect((focusDenied.content[0] as any).text).toContain('identity.write.runtime');

    const wakeReturnDenied = await writeGated.execute('session-wake-return', {
      action: 'wake_return',
      sessionId: 'api:resume-me',
      summary: 'Resume the visibility audit.',
    });
    expect(session.executeSpy).not.toHaveBeenCalled();
    expect((wakeReturnDenied.content[0] as any).text).toContain('identity.write.runtime');

    const allowedGated = gateToolWithCapabilities(
      session.tool,
      () => accessForTier('nursery'),
    );
    await allowedGated.execute('session-allowed', { action: 'complete_focus' });
    expect(session.executeSpy).toHaveBeenCalledTimes(1);
  });

  it('gates unified vault actions by read versus runtime-write capability tokens', async () => {
    const vault = createTool('vault');
    const readGated = gateToolWithCapabilities(
      vault.tool,
      () => accessForTier('custom', ['memory.write']),
    );
    const readDenied = await readGated.execute('vault-read', { action: 'read', name: 'Inbox' });
    expect(vault.executeSpy).not.toHaveBeenCalled();
    expect((readDenied.content[0] as any).text).toContain('identity.read');

    const searchDenied = await readGated.execute('vault-search', { action: 'vault_search', query: 'focus' });
    expect(vault.executeSpy).not.toHaveBeenCalled();
    expect((searchDenied.content[0] as any).text).toContain('identity.read');

    const writeGated = gateToolWithCapabilities(
      vault.tool,
      () => accessForTier('custom', ['identity.read']),
    );
    const writeDenied = await writeGated.execute('vault-write', {
      action: 'write',
      name: 'Inbox',
      content: 'entry',
    });
    expect(vault.executeSpy).not.toHaveBeenCalled();
    expect((writeDenied.content[0] as any).text).toContain('identity.write.runtime');

    const dailyDenied = await writeGated.execute('vault-daily', { action: 'daily', content: 'journal' });
    expect(vault.executeSpy).not.toHaveBeenCalled();
    expect((dailyDenied.content[0] as any).text).toContain('identity.write.runtime');

    const ambiguousDenied = await writeGated.execute('vault-ambiguous', { name: 'Inbox', query: 'focus' });
    expect(vault.executeSpy).not.toHaveBeenCalled();
    expect((ambiguousDenied.content[0] as any).text).toContain('identity.read');
    expect((ambiguousDenied.content[0] as any).text).toContain('identity.write.runtime');
  });

  it('gates unified fs actions using git read/write capability requirements', async () => {
    const fsTool = createTool('fs');
    const readGated = gateToolWithCapabilities(
      fsTool.tool,
      () => accessForTier('custom', ['memory.write']),
    );
    const readDenied = await readGated.execute('fs-read', { action: 'read', path: 'src/agent-main.ts' });
    expect(fsTool.executeSpy).not.toHaveBeenCalled();
    expect((readDenied.content[0] as any).text).toContain('git.read');

    const writeGated = gateToolWithCapabilities(
      fsTool.tool,
      () => accessForTier('apprentice'),
    );
    const writeDenied = await writeGated.execute('fs-write', {
      action: 'write',
      path: 'notes.txt',
      content: 'hello',
    });
    expect(fsTool.executeSpy).not.toHaveBeenCalled();
    expect((writeDenied.content[0] as any).text).toContain('git.write');

    const allowedRead = gateToolWithCapabilities(
      fsTool.tool,
      () => accessForTier('nursery'),
    );
    await allowedRead.execute('fs-list', {});
    expect(fsTool.executeSpy).toHaveBeenCalledTimes(1);
  });

  it('gates unified repo actions using git read/write capability requirements', async () => {
    const repoTool = createTool('repo');
    const readGated = gateToolWithCapabilities(
      repoTool.tool,
      () => accessForTier('custom', ['memory.write']),
    );
    const inspectDenied = await readGated.execute('repo-inspect', { action: 'inspect', target: 'status' });
    expect(repoTool.executeSpy).not.toHaveBeenCalled();
    expect((inspectDenied.content[0] as any).text).toContain('git.read');

    const writeGated = gateToolWithCapabilities(
      repoTool.tool,
      () => accessForTier('apprentice'),
    );
    const patchDenied = await writeGated.execute('repo-patch', {
      action: 'patch',
      file_path: 'src/agent-main.ts',
      content: 'patched',
    });
    expect(repoTool.executeSpy).not.toHaveBeenCalled();
    expect((patchDenied.content[0] as any).text).toContain('git.write');

    const allowedRead = gateToolWithCapabilities(
      repoTool.tool,
      () => accessForTier('nursery'),
    );
    await allowedRead.execute('repo-allowed', {});
    expect(repoTool.executeSpy).toHaveBeenCalledTimes(1);
  });

  it('gates unified beads actions by issue.* capability tokens', async () => {
    const beads = createTool('beads');
    const readyGated = gateToolWithCapabilities(
      beads.tool,
      () => accessForTier('custom', ['identity.read']),
    );
    const readyDenied = await readyGated.execute('beads-ready', { action: 'ready' });
    expect(beads.executeSpy).not.toHaveBeenCalled();
    expect((readyDenied.content[0] as any).text).toContain('issue.read');

    const implicitReadyGated = gateToolWithCapabilities(
      beads.tool,
      () => accessForTier('custom', ['issue.read']),
    );
    await implicitReadyGated.execute('beads-implicit-ready', {});
    expect(beads.executeSpy).toHaveBeenCalledTimes(1);

    const createGated = gateToolWithCapabilities(
      beads.tool,
      () => accessForTier('custom', ['issue.read']),
    );
    const createDenied = await createGated.execute('beads-create', { action: 'create', title: 'Tracked work' });
    expect(beads.executeSpy).toHaveBeenCalledTimes(1);
    expect((createDenied.content[0] as any).text).toContain('issue.write');

    const updateGated = gateToolWithCapabilities(
      beads.tool,
      () => accessForTier('apprentice'),
    );
    await updateGated.execute('beads-update', { action: 'issue_update', id: 'PSFN-1', status: 'in_progress' });
    expect(beads.executeSpy).toHaveBeenCalledTimes(2);

    const closeGated = gateToolWithCapabilities(
      beads.tool,
      () => accessForTier('autonomous'),
    );
    await closeGated.execute('beads-close', { action: 'close', id: 'PSFN-1', reason: 'done' });
    expect(beads.executeSpy).toHaveBeenCalledTimes(3);
  });

  it('evaluates toolset capability requirements by action', async () => {
    const toolsetModule = await import('../../core/agent/substrate-agent/adaptive-tools-runtime.js');
    const toolset = toolsetModule.createToolsetTool({
      getExtendedTools: () => [],
      getExtendedToolAutoloadPolicy: () => null,
      getAdaptiveToolRuntimeState: () => ({
        generatedAt: 1,
        coreTools: ['tool_search', 'toolset'],
        extendedTools: [],
        promotedToolsConfigured: [],
        promotedToolsActive: [],
        promotedToolsSkipped: [],
        loadedExtendedTools: [],
        activeTools: [
          { toolName: 'tool_search', source: 'core' },
          { toolName: 'toolset', source: 'core' },
        ],
        lastSnapshot: null,
      }),
      resolveCapabilityAccess: () => accessForTier('custom', ['identity.read']),
      getActiveTurnCorrelation: () => null,
      getActiveTurnTaskKind: () => null,
      getActiveTurnIntent: () => null,
      getPromotedExtendedToolsLimit: () => 4,
      getPromotedExtendedTools: () => [],
      setPromotedExtendedTools: (next: readonly string[]) => [...next],
      persistPromotedExtendedTools: () => null,
      addPromotedExtendedTool: () => ({
        ok: true,
        changed: false,
        promotedTools: [],
        message: 'ok',
      }),
      removePromotedExtendedTool: () => ({
        ok: true,
        changed: false,
        promotedTools: [],
        message: 'ok',
      }),
      applyActiveToolsToAgent: () => {},
      activateExtendedTools: () => ({
        requestedTools: [],
        activatedTools: [],
        alreadyActiveTools: [],
        missingTools: [],
      }),
      resolveSessionChannelId: (channelId: string) => channelId,
      withAdaptiveCorrelation: () => ({}),
      emitAdaptiveToolDecision: () => {},
      emitTelemetry: () => {},
    });

    const deniedPinEligibility = evaluateToolCapabilityEligibility(
      toolset,
      { action: 'pin', tool: 'repo_status' },
      accessForTier('custom', ['identity.read']),
    );
    expect(deniedPinEligibility.allowed).toBe(false);
    expect(deniedPinEligibility.requiredTokens).toEqual(['identity.write.runtime']);
    expect(deniedPinEligibility.missingTokens).toEqual(['identity.write.runtime']);

    const allowedListEligibility = evaluateToolCapabilityEligibility(
      toolset,
      { action: 'list' },
      accessForTier('custom', ['identity.read']),
    );
    expect(allowedListEligibility.allowed).toBe(true);
    expect(allowedListEligibility.missingTokens).toEqual([]);
  });
});

describe('undeclared capability fail-closed (02-M2)', () => {
  it('refuses a tool that declares no capability requirement at all', async () => {
    const rogue = createTool('tool_with_no_requirement_path');
    // Autonomous is the most-privileged default tier; even it must not run an
    // undeclared tool (an empty requirement set is otherwise allowed everywhere).
    const gated = gateToolWithCapabilities(rogue.tool, () => accessForTier('autonomous'));
    const denied = await gated.execute('call-rogue', { action: 'anything' });

    expect(rogue.executeSpy).not.toHaveBeenCalled();
    expect((denied.details as any).isError).toBe(true);
    expect((denied.details as any).capabilityDenied).toBe(true);
    expect((denied.details as any).capabilityUndeclared).toBe(true);
    expect((denied.content[0] as any).text).toContain('declares no capability requirement');
  });

  it('resolveToolCapabilityRequirement marks unknown tools undeclared and known tools declared', () => {
    expect(resolveToolCapabilityRequirement(createTool('tool_with_no_requirement_path').tool, {}).declared)
      .toBe(false);
    expect(toolHasDeclaredCapabilityRequirement(createTool('tool_with_no_requirement_path').tool))
      .toBe(false);

    // Static explicit "no requirement" entry => declared, empty tokens.
    expect(resolveToolCapabilityRequirement(createTool('tool_search').tool, {}))
      .toEqual({ declared: true, tokens: [] });
    // Unified resolver => declared.
    expect(resolveToolCapabilityRequirement(createTool('memory').tool, { action: 'write' }).declared)
      .toBe(true);
  });

  it('allows a tool with an explicit empty ("none") declaration', async () => {
    // tool_search declares NO_CAPABILITY_REQUIREMENT via the static map.
    const toolSearch = createTool('tool_search');
    const gated = gateToolWithCapabilities(toolSearch.tool, () => accessForTier('nursery'));
    await gated.execute('call-tool-search', { query: 'memory' });
    expect(toolSearch.executeSpy).toHaveBeenCalledTimes(1);

    // Explicit empty annotation is also a valid declaration.
    const annotatedNone = withCapabilityRequirement(createTool('annotated_none').tool, []);
    expect(resolveToolCapabilityRequirement(annotatedNone, {})).toEqual({ declared: true, tokens: [] });
    const annotatedGated = gateToolWithCapabilities(annotatedNone, () => accessForTier('nursery'));
    const annotatedResult = await annotatedGated.execute('call-annotated-none', {});
    expect((annotatedResult.details as any)?.capabilityUndeclared).toBeUndefined();
  });

  it('assertToolCapabilityRequirementDeclared throws for undeclared, passes for declared', () => {
    expect(() => assertToolCapabilityRequirementDeclared(createTool('tool_with_no_requirement_path').tool))
      .toThrow(/no declared capability requirement/);
    expect(() => assertToolCapabilityRequirementDeclared(createTool('tool_search').tool)).not.toThrow();
    expect(() => assertToolCapabilityRequirementDeclared(createTool('journal').tool)).not.toThrow();
  });

  it('gates the journal tool by read versus runtime-write capability tokens', async () => {
    expect(resolveToolRequiredCapabilities(createTool('journal').tool, { action: 'read' }))
      .toEqual(['identity.read']);
    expect(resolveToolRequiredCapabilities(createTool('journal').tool, { action: 'search' }))
      .toEqual(['identity.read']);
    expect(resolveToolRequiredCapabilities(createTool('journal').tool, { action: 'write' }))
      .toEqual(['identity.write.runtime']);
    expect(resolveToolRequiredCapabilities(createTool('journal').tool, { action: 'append' }))
      .toEqual(['identity.write.runtime']);

    const journal = createTool('journal');
    const writeDeniedGated = gateToolWithCapabilities(
      journal.tool,
      () => accessForTier('custom', ['identity.read']),
    );
    const writeDenied = await writeDeniedGated.execute('journal-write-denied', {
      action: 'write',
      title: 'A note',
      content: 'hello',
    });
    expect(journal.executeSpy).not.toHaveBeenCalled();
    expect((writeDenied.content[0] as any).text).toContain('identity.write.runtime');

    const readAllowedGated = gateToolWithCapabilities(
      journal.tool,
      () => accessForTier('custom', ['identity.read']),
    );
    await readAllowedGated.execute('journal-read-allowed', { action: 'read', path: 'a-note' });
    expect(journal.executeSpy).toHaveBeenCalledTimes(1);
  });
});

describe('world capability gating', () => {
  it('grants world.read from apprentice up and withholds world.control from every default tier', () => {
    expect(resolveTierCapabilityTokens('nursery')).not.toContain('world.read');
    expect(resolveTierCapabilityTokens('apprentice')).toContain('world.read');
    expect(resolveTierCapabilityTokens('autonomous')).toContain('world.read');

    for (const tier of ['nursery', 'apprentice', 'autonomous'] as const) {
      expect(resolveTierCapabilityTokens(tier)).not.toContain('world.control');
    }
  });

  it('resolves per-action world requirements: perceive/list/move -> world.read, control -> world.control', () => {
    const world = createTool('world');
    expect(resolveToolRequiredCapabilities(world.tool, { action: 'perceive' })).toEqual(['world.read']);
    expect(resolveToolRequiredCapabilities(world.tool, { action: 'list' })).toEqual(['world.read']);
    // `move` (vinz.26) is read-tier virtual navigation — requiring world.control
    // here would silently block move everywhere (control is withheld from all
    // default tiers).
    expect(resolveToolRequiredCapabilities(world.tool, { action: 'move' })).toEqual(['world.read']);
    expect(resolveToolRequiredCapabilities(world.tool, { action: 'control' })).toEqual(['world.control']);
  });

  it('hides control when world.control is absent while keeping perceive/list live', async () => {
    const world = createTool('world');
    // Autonomous grants world.read but never world.control.
    const gated = gateToolWithCapabilities(world.tool, () => accessForTier('autonomous'));

    await gated.execute('world-perceive', { action: 'perceive', placeId: 'place.living-room' });
    await gated.execute('world-list', { action: 'list' });
    expect(world.executeSpy).toHaveBeenCalledTimes(2);

    const denied = await gated.execute('world-control', { action: 'control', affordanceId: 'lr_lights', command: 'on' });
    expect(world.executeSpy).toHaveBeenCalledTimes(2);
    expect((denied.details as any).capabilityDenied).toBe(true);
    expect((denied.content[0] as any).text).toContain('world.control');
  });

  it('refuses world.read for nursery (no world.read token)', async () => {
    const world = createTool('world');
    const gated = gateToolWithCapabilities(world.tool, () => accessForTier('nursery'));
    const denied = await gated.execute('world-perceive-nursery', { action: 'perceive', placeId: 'place.living-room' });
    expect(world.executeSpy).not.toHaveBeenCalled();
    expect((denied.content[0] as any).text).toContain('world.read');
  });

  it('allows control only when world.control is granted via a custom tier', async () => {
    const world = createTool('world');
    const gated = gateToolWithCapabilities(
      world.tool,
      () => accessForTier('custom', ['world.read', 'world.control']),
    );
    await gated.execute('world-control-granted', { action: 'control', affordanceId: 'lr_lights', command: 'on' });
    expect(world.executeSpy).toHaveBeenCalledTimes(1);
  });
});
