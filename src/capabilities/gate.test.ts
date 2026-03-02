import { describe, expect, it, vi } from 'vitest';
import { Type } from '@sinclair/typebox';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { CapabilityTier } from '../types.js';
import type { CapabilityToken } from './tokens.js';
import { gateToolWithCapabilities, type CapabilityAccess } from './gate.js';
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

  it('gates scratchpad tools using static capability requirements', async () => {
    const scratchpadRead = createTool('scratchpad_read');
    const readGated = gateToolWithCapabilities(
      scratchpadRead.tool,
      () => accessForTier('custom', ['memory.write']),
    );
    const readDenied = await readGated.execute('call-read', {});
    expect(scratchpadRead.executeSpy).not.toHaveBeenCalled();
    expect((readDenied.content[0] as any).text).toContain('identity.read');

    const scratchpadWrite = createTool('scratchpad_write');
    const writeGated = gateToolWithCapabilities(
      scratchpadWrite.tool,
      () => accessForTier('custom', ['identity.read']),
    );
    const writeDenied = await writeGated.execute('call-write', {});
    expect(scratchpadWrite.executeSpy).not.toHaveBeenCalled();
    expect((writeDenied.content[0] as any).text).toContain('memory.write');
  });

  it('gates session_new using static capability requirements', async () => {
    const sessionNew = createTool('session_new');
    const deniedGated = gateToolWithCapabilities(
      sessionNew.tool,
      () => accessForTier('custom', ['identity.read']),
    );
    const denied = await deniedGated.execute('call-denied', {});
    expect(sessionNew.executeSpy).not.toHaveBeenCalled();
    expect((denied.content[0] as any).text).toContain('identity.write.runtime');

    const allowedGated = gateToolWithCapabilities(
      sessionNew.tool,
      () => accessForTier('nursery'),
    );
    await allowedGated.execute('call-allowed', {});
    expect(sessionNew.executeSpy).toHaveBeenCalledTimes(1);
  });
});
