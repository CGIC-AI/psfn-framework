import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayServer, type GatewayServerOptions } from '../boundary/gateway/server.js';
import { GatewayClient } from '../boundary/gateway/client.js';
import { GatewayGitOps } from './gateway-ops.js';
import { GitOps } from './ops.js';

const TEST_WYOMING_SHARD_ROUTING = {
  enabled: false,
};

function createServerOptions(
  socketPath: string,
  gitOps: GatewayServerOptions['gitOps'],
): GatewayServerOptions {
  return {
    socketPath,
    llmProvider: {
      stream: vi.fn(),
      complete: vi.fn(),
    } as any,
    embeddingService: {
      embed: vi.fn(),
      embedBatch: vi.fn(),
      dims: 1024,
    } as any,
    discordAdapter: {
      id: 'discord',
      outbound: {
        textChunkLimit: 2000,
        sendText: vi.fn(),
      },
    } as any,
    gitOps,
    policyConfig: {
      workspacePath: process.cwd(),
    },
    sessionHmacKeyring: {
      activeVersion: 'v1',
      keys: {
        v1: 'test-gateway-rpc-secret',
      },
    },
    wyomingShardRouting: TEST_WYOMING_SHARD_ROUTING,
    capabilityTierProvider: () => 'autonomous',
  };
}

describe('Gateway git RPC path', () => {
  let server: GatewayServer | null = null;
  let client: GatewayClient | null = null;

  afterEach(async () => {
    client?.destroy();
    client = null;
    if (server) {
      await server.stop();
      server = null;
    }
  });

  it('routes GatewayGitOps through GatewayClient to gateway git methods', async () => {
    const socketPath = join(tmpdir(), `psfn-git-rpc-${randomUUID()}.sock`);
    const gitOps = {
      status: vi.fn().mockReturnValue({
        branch: 'main',
        ahead: 0,
        behind: 0,
        staged: [],
        modified: ['src/a.ts'],
        untracked: ['src/b.ts'],
      }),
      diff: vi.fn().mockReturnValue({
        staged: 'cached',
        unstaged: 'working',
      }),
      createBranch: vi.fn().mockResolvedValue('feature/demo'),
      applyPatch: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue({
        hash: 'abc123',
        message: 'message',
        filesChanged: 2,
      }),
      openPR: vi.fn().mockResolvedValue('https://example.test/pr/1'),
    };

    server = new GatewayServer(createServerOptions(socketPath, gitOps));
    server.start();
    client = await GatewayClient.connect(socketPath, 1024);
    const gatewayOps = new GatewayGitOps(client);

    await expect(gatewayOps.status()).resolves.toMatchObject({ branch: 'main' });
    await expect(gatewayOps.diff({ staged: false })).resolves.toEqual({
      staged: 'cached',
      unstaged: 'working',
    });
    await expect(gatewayOps.createBranch('feature/demo', 'main')).resolves.toBe('feature/demo');
    await expect(gatewayOps.applyPatch('src/feature.ts', 'export const x = 1;')).resolves.toBeUndefined();
    await expect(gatewayOps.commit('message', 'intent', 'scope')).resolves.toMatchObject({ hash: 'abc123' });
    await expect(gatewayOps.openPR('Title', 'Body', 'main')).resolves.toBe('https://example.test/pr/1');

    expect(gitOps.status).toHaveBeenCalledTimes(1);
    expect(gitOps.diff).toHaveBeenCalledWith({ staged: false });
    expect(gitOps.createBranch).toHaveBeenCalledWith('feature/demo', 'main');
    expect(gitOps.applyPatch).toHaveBeenCalledWith('src/feature.ts', 'export const x = 1;');
    expect(gitOps.commit).toHaveBeenCalledWith('message', 'intent', 'scope');
    expect(gitOps.openPR).toHaveBeenCalledWith('Title', 'Body', 'main');
  });

  it('runs git RPCs against git repo root even when workspace policy root is outside the repo', async () => {
    const socketPath = join(tmpdir(), `psfn-git-root-split-${randomUUID()}.sock`);
    const repoRoot = mkdtempSync(join(tmpdir(), 'psfn-git-rpc-repo-'));
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'psfn-git-rpc-workspace-'));

    try {
      execFileSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });
      writeFileSync(join(repoRoot, 'tracked.txt'), 'hello from repo');

      server = new GatewayServer({
        ...createServerOptions(socketPath, new GitOps({ repoRoot })),
        policyConfig: {
          workspacePath: workspaceRoot,
        },
      });
      server.start();

      client = await GatewayClient.connect(socketPath, 1024);
      const gatewayOps = new GatewayGitOps(client);

      const status = await gatewayOps.status();
      expect(status.branch.length).toBeGreaterThan(0);
      expect(status.untracked).toContain('tracked.txt');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
