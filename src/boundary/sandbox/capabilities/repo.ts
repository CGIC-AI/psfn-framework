import { isAllowedRepoRelativePath } from '../../../system/security/policy-constants.js';
import type { ThinkEvidence } from '../../../repl/types.js';
import type { GatewayREPLCapabilities, GitCommitView, GitDiffView, GitStatusView } from './contracts.js';
import { addEvidence, normalizeRepoPath, toErrorMessage } from './common.js';

export interface RepoCapabilities {
  repo_status: () => Promise<GitStatusView | { error: string }>;
  repo_diff: (staged?: boolean) => Promise<GitDiffView | { error: string }>;
  repo_apply_patch: (filePath: string, content: string) => Promise<{ ok: boolean; error?: string }>;
  repo_commit: (message: string, intent?: string, scope?: string) => Promise<GitCommitView | { error: string }>;
}

interface CreateRepoCapabilitiesOptions {
  gatewayCaps: GatewayREPLCapabilities;
  pushEvidence: (entry: ThinkEvidence) => void;
}

export function createRepoCapabilities(options: CreateRepoCapabilitiesOptions): RepoCapabilities {
  const repo_status = async (): Promise<GitStatusView | { error: string }> => {
    if (typeof options.gatewayCaps.gitStatus !== 'function') {
      return { error: 'repo ops require gateway git policy (gitStatus unavailable)' };
    }

    const status = await options.gatewayCaps.gitStatus();
    addEvidence(options.pushEvidence, {
      source: 'repo',
      query: 'repo_status',
      snippet: `${status.branch} staged=${status.staged.length} modified=${status.modified.length} untracked=${status.untracked.length}`,
      resultCount: status.staged.length + status.modified.length + status.untracked.length,
    });
    return status;
  };

  const repo_diff = async (staged = false): Promise<GitDiffView | { error: string }> => {
    if (typeof options.gatewayCaps.gitDiff !== 'function') {
      return { error: 'repo ops require gateway git policy (gitDiff unavailable)' };
    }

    const diff = await options.gatewayCaps.gitDiff({ staged });
    addEvidence(options.pushEvidence, {
      source: 'repo',
      query: `repo_diff staged=${staged}`,
      snippet: staged ? diff.staged : diff.unstaged,
    });
    return diff;
  };

  const repo_apply_patch = async (
    filePath: string,
    content: string,
  ): Promise<{ ok: boolean; error?: string }> => {
    if (typeof options.gatewayCaps.gitApplyPatch !== 'function') {
      return { ok: false, error: 'repo ops require gateway git policy (gitApplyPatch unavailable)' };
    }

    const normalized = normalizeRepoPath(filePath);
    if (!normalized) {
      return { ok: false, error: 'filePath is required' };
    }
    if (!isAllowedRepoRelativePath(normalized)) {
      return { ok: false, error: `path not allowed: ${normalized}` };
    }
    if (typeof content !== 'string' || content.length === 0) {
      return { ok: false, error: 'patch content is required' };
    }
    if (content.length > 200_000) {
      return { ok: false, error: 'patch content too large (max 200000 chars)' };
    }

    try {
      await options.gatewayCaps.gitApplyPatch(normalized, content);
      addEvidence(options.pushEvidence, {
        source: 'repo',
        query: `repo_apply_patch ${normalized}`,
        snippet: content,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: toErrorMessage(err) };
    }
  };

  const repo_commit = async (
    message: string,
    intent = 'self_modification',
    scope?: string,
  ): Promise<GitCommitView | { error: string }> => {
    if (typeof options.gatewayCaps.gitCommit !== 'function') {
      return { error: 'repo ops require gateway git policy (gitCommit unavailable)' };
    }
    if (typeof message !== 'string' || message.trim().length < 5) {
      return { error: 'commit message must be at least 5 characters' };
    }
    if (typeof intent !== 'string' || intent.trim().length < 2) {
      return { error: 'intent is required' };
    }

    const commit = await options.gatewayCaps.gitCommit(message.trim(), intent.trim(), scope?.trim() || undefined);
    addEvidence(options.pushEvidence, {
      source: 'repo',
      query: `repo_commit ${commit.hash.slice(0, 7)}`,
      snippet: commit.message,
      resultCount: commit.filesChanged,
    });
    return commit;
  };

  return {
    repo_status,
    repo_diff,
    repo_apply_patch,
    repo_commit,
  };
}
