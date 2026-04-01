import { describe, expect, it, vi } from 'vitest';
import { Type } from '@sinclair/typebox';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { CapabilityTier } from '../types.js';
import type { CapabilityToken } from './tokens.js';
import {
  evaluateToolCapabilityEligibility,
  gateToolWithCapabilities,
  type CapabilityAccess,
} from './gate.js';
import { resolveTierCapabilityTokens } from './tiers.js';
import { withCapabilityRequirement } from './requirements.js';

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
    const memoryWrite = createTool('memory_write');
    const memoryGated = gateToolWithCapabilities(
      memoryWrite.tool,
      () => accessForTier('nursery'),
    );

    await memoryGated.execute('call-1', {});
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

    const restart = createTool('self_restart');
    const restartGated = gateToolWithCapabilities(
      restart.tool,
      () => accessForTier('apprentice'),
    );
    const denied = await restartGated.execute('call-2', {});

    expect(restart.executeSpy).not.toHaveBeenCalled();
    expect((denied.details as any).capabilityDenied).toBe(true);
    expect((denied.content[0] as any).text).toContain('lifecycle.restart');
  });

  it('gates memory_delete by memory.delete capability token', async () => {
    const memoryDelete = createTool('memory_delete');
    const nurseryGated = gateToolWithCapabilities(
      memoryDelete.tool,
      () => accessForTier('nursery'),
    );
    const denied = await nurseryGated.execute('call-1', {});
    expect(memoryDelete.executeSpy).not.toHaveBeenCalled();
    expect((denied.content[0] as any).text).toContain('memory.delete');

    const apprenticeGated = gateToolWithCapabilities(
      memoryDelete.tool,
      () => accessForTier('apprentice'),
    );
    await apprenticeGated.execute('call-2', {});
    expect(memoryDelete.executeSpy).toHaveBeenCalledTimes(1);
  });

  it('gates unified memory delete-like actions by memory.delete capability token', async () => {
    const memory = createTool('memory');
    const nurseryGated = gateToolWithCapabilities(
      memory.tool,
      () => accessForTier('nursery'),
    );
    const denied = await nurseryGated.execute('call-1b', { action: 'delete' });
    expect(memory.executeSpy).not.toHaveBeenCalled();
    expect((denied.content[0] as any).text).toContain('memory.delete');

    const apprenticeGated = gateToolWithCapabilities(
      memory.tool,
      () => accessForTier('apprentice'),
    );
    await apprenticeGated.execute('call-2b', { action: 'restore' });
    expect(memory.executeSpy).toHaveBeenCalledTimes(1);
  });

  it('gates memory_redact by memory.delete capability token', async () => {
    const memoryRedact = createTool('memory_redact');
    const nurseryGated = gateToolWithCapabilities(
      memoryRedact.tool,
      () => accessForTier('nursery'),
    );
    const denied = await nurseryGated.execute('call-1', {});
    expect(memoryRedact.executeSpy).not.toHaveBeenCalled();
    expect((denied.content[0] as any).text).toContain('memory.delete');

    const apprenticeGated = gateToolWithCapabilities(
      memoryRedact.tool,
      () => accessForTier('apprentice'),
    );
    await apprenticeGated.execute('call-2', {});
    expect(memoryRedact.executeSpy).toHaveBeenCalledTimes(1);
  });

  it('gates unified memory search and write actions by their specific tokens', async () => {
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

  it('grants autonomous tier access for locked tools', async () => {
    const restart = createTool('self_restart');
    const restartGated = gateToolWithCapabilities(
      restart.tool,
      () => accessForTier('autonomous'),
    );
    await restartGated.execute('call-1', {});
    expect(restart.executeSpy).toHaveBeenCalledTimes(1);

    const repoCommit = createTool('repo_commit');
    const commitGated = gateToolWithCapabilities(
      repoCommit.tool,
      () => accessForTier('autonomous'),
    );
    await commitGated.execute('call-2', {});
    expect(repoCommit.executeSpy).toHaveBeenCalledTimes(1);
  });

  it('enforces custom tier cherry-picked tokens', async () => {
    const promptList = createTool('prompt_layer_list');
    const promptGated = gateToolWithCapabilities(
      promptList.tool,
      () => accessForTier('custom', ['identity.read']),
    );
    await promptGated.execute('call-1', {});
    expect(promptList.executeSpy).toHaveBeenCalledTimes(1);

    const memoryWrite = createTool('memory_write');
    const memoryGated = gateToolWithCapabilities(
      memoryWrite.tool,
      () => accessForTier('custom', ['identity.read']),
    );
    const denied = await memoryGated.execute('call-2', {});
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
    await apprentice.execute('call-3', { layer: 'base' });
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

    const grepDenied = await readGated.execute('session-grep', { action: 'session_grep', pattern: 'orion' });
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
      action: 'session_resume',
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

    const allowedGated = gateToolWithCapabilities(
      session.tool,
      () => accessForTier('nursery'),
    );
    await allowedGated.execute('session-allowed', { action: 'complete_focus' });
    expect(session.executeSpy).toHaveBeenCalledTimes(1);
  });

  it('gates unified fs actions using git read/write capability requirements', async () => {
    const fsTool = createTool('fs');
    const readGated = gateToolWithCapabilities(
      fsTool.tool,
      () => accessForTier('custom', ['memory.write']),
    );
    const readDenied = await readGated.execute('fs-read', { action: 'read', path: 'src/runtime.ts' });
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

  it('gates issue tools by issue.* capability tokens', async () => {
    const issueReady = createTool('issue_ready');
    const readyGated = gateToolWithCapabilities(
      issueReady.tool,
      () => accessForTier('custom', ['identity.read']),
    );
    const readyDenied = await readyGated.execute('issue-ready', {});
    expect(issueReady.executeSpy).not.toHaveBeenCalled();
    expect((readyDenied.content[0] as any).text).toContain('issue.read');

    const issueCreate = createTool('issue_create');
    const createGated = gateToolWithCapabilities(
      issueCreate.tool,
      () => accessForTier('custom', ['issue.read']),
    );
    const createDenied = await createGated.execute('issue-create', {});
    expect(issueCreate.executeSpy).not.toHaveBeenCalled();
    expect((createDenied.content[0] as any).text).toContain('issue.write');

    const issueClose = createTool('issue_close');
    const closeGated = gateToolWithCapabilities(
      issueClose.tool,
      () => accessForTier('autonomous'),
    );
    await closeGated.execute('issue-close', {});
    expect(issueClose.executeSpy).toHaveBeenCalledTimes(1);
  });

  it('evaluates toolset capability requirements by action', async () => {
    const toolsetModule = await import('../agent/substrate-agent/adaptive-tools-runtime.js');
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
