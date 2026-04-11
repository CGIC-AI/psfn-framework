// ── Gateway-backed Git Operations ──
// Agent-side adapter that routes all git self-modification operations
// through the host gateway RPC surface.

import type { GatewayOpsPort } from '../../gateway/gateway-ops-port.js';
import type {
  GitOperations,
  GitStatusResult,
  GitDiffResult,
  GitCommitResult,
} from './ops.js';

export class GatewayGitOps implements GitOperations {
  private readonly gitOps: GitOperations;

  constructor(gatewayOps: Pick<GatewayOpsPort, 'git'> | GitOperations) {
    this.gitOps = 'git' in gatewayOps ? gatewayOps.git : gatewayOps;
  }

  async status(): Promise<GitStatusResult> {
    return this.gitOps.status();
  }

  async diff(opts?: { staged?: boolean }): Promise<GitDiffResult> {
    return this.gitOps.diff(opts);
  }

  async createBranch(name: string, startPoint?: string): Promise<string> {
    return this.gitOps.createBranch(name, startPoint);
  }

  async applyPatch(filePath: string, content: string): Promise<void> {
    await this.gitOps.applyPatch(filePath, content);
  }

  async commit(message: string, intent: string, scope?: string): Promise<GitCommitResult> {
    return this.gitOps.commit(message, intent, scope);
  }

  async openPR(title: string, body: string, base?: string): Promise<string> {
    return this.gitOps.openPR(title, body, base);
  }
}
