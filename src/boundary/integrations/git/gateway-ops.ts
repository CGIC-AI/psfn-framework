// ── Gateway-backed Git Operations ──
// Agent-side adapter that routes all git self-modification operations
// through the host gateway RPC surface.

import type { GatewayClient } from '../../gateway/client.js';
import type {
  GitOperations,
  GitStatusResult,
  GitDiffResult,
  GitCommitResult,
} from './ops.js';

export class GatewayGitOps implements GitOperations {
  private gateway: GatewayClient;

  constructor(gateway: GatewayClient) {
    this.gateway = gateway;
  }

  async status(): Promise<GitStatusResult> {
    return this.gateway.gitStatus();
  }

  async diff(opts?: { staged?: boolean }): Promise<GitDiffResult> {
    return this.gateway.gitDiff(opts);
  }

  async createBranch(name: string, startPoint?: string): Promise<string> {
    return this.gateway.gitCreateBranch(name, startPoint);
  }

  async applyPatch(filePath: string, content: string): Promise<void> {
    await this.gateway.gitApplyPatch(filePath, content);
  }

  async commit(message: string, intent: string, scope?: string): Promise<GitCommitResult> {
    return this.gateway.gitCommit(message, intent, scope);
  }

  async openPR(title: string, body: string, base?: string): Promise<string> {
    return this.gateway.gitOpenPR(title, body, base);
  }
}
