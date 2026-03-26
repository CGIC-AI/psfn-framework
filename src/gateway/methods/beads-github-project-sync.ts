import { spawn } from 'node:child_process';
import { JSONRPCErrorException } from 'json-rpc-2.0';
import type {
  BeadsAction,
  GitHubProjectBulkSyncResult,
  GitHubProjectSyncResult,
} from '../protocol.js';
import { GatewayErrors } from '../protocol.js';
import { toErrorMessage } from '../../utils/errors.js';

const DEFAULT_COMMAND_TIMEOUT_MS = 12_000;
const MAX_COMMAND_OUTPUT_CHARS = 250_000;
const GH_PROJECT_SYNC_ENABLED_KEY = 'custom.github_project_sync.enabled';
const GH_PROJECT_SYNC_PROJECT_URL_KEY = 'custom.github_project_sync.project_url';
const GH_PROJECT_SYNC_OWNER_KEY = 'custom.github_project_sync.owner';
const GH_PROJECT_SYNC_PROJECT_NUMBER_KEY = 'custom.github_project_sync.project_number';
const ITEM_OWNER_METADATA_KEY = 'github_project_sync_owner';
const ITEM_PROJECT_NUMBER_METADATA_KEY = 'github_project_sync_project_number';
const ITEM_ID_METADATA_KEY = 'github_project_sync_item_id';
const DRAFT_CONTENT_ID_METADATA_KEY = 'github_project_sync_draft_content_id';
const ITEM_ARCHIVED_METADATA_KEY = 'github_project_sync_archived';
const PROJECT_URL_PATTERN = /^https:\/\/github\.com\/(?:users|orgs)\/([^/]+)\/projects\/(\d+)\/?$/i;

interface CommandRunner {
  run(command: string, args: readonly string[], options: { cwd: string; label: string }): Promise<string>;
}

interface GitHubProjectSyncConfig {
  owner: string;
  projectNumber: number;
}

interface GitHubProjectSyncDisabled {
  disabled: true;
  reason: string;
}

interface GitHubProjectSyncConfigError {
  disabled: false;
  error: string;
}

type GitHubProjectSyncConfigResult =
  | GitHubProjectSyncConfig
  | GitHubProjectSyncDisabled
  | GitHubProjectSyncConfigError;

interface BeadsIssueRecord {
  id: string;
  title: string;
  description?: string;
  notes?: string;
  status?: string;
  priority?: number;
  issue_type?: string;
  owner?: string;
  metadata?: Record<string, unknown>;
}

function createSpawnCommandRunner(): CommandRunner {
  return {
    async run(command, args, options) {
      return await new Promise<string>((resolveResult, rejectResult) => {
        const child = spawn(command, [...args], {
          cwd: options.cwd,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        let totalChars = 0;
        let truncated = false;
        let settled = false;
        let timedOut = false;

        const finalize = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutHandle);
          fn();
        };

        const append = (target: 'stdout' | 'stderr', chunk: Buffer | string): void => {
          const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
          if (!text) return;

          const remaining = MAX_COMMAND_OUTPUT_CHARS - totalChars;
          if (remaining <= 0) {
            truncated = true;
            return;
          }

          const next = text.length > remaining ? text.slice(0, remaining) : text;
          totalChars += next.length;
          if (target === 'stdout') stdout += next;
          else stderr += next;
          if (next.length < text.length) {
            truncated = true;
          }
        };

        const timeoutHandle = setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 250).unref();
        }, DEFAULT_COMMAND_TIMEOUT_MS);

        child.stdout.on('data', (chunk) => append('stdout', chunk));
        child.stderr.on('data', (chunk) => append('stderr', chunk));

        child.once('error', (error) => {
          finalize(() => {
            rejectResult(new JSONRPCErrorException(
              `${options.label} failed to start: ${toErrorMessage(error)}`,
              GatewayErrors.PROVIDER_ERROR,
            ));
          });
        });

        child.once('close', (code) => {
          finalize(() => {
            if (timedOut) {
              rejectResult(new JSONRPCErrorException(
                `${options.label} timed out after ${DEFAULT_COMMAND_TIMEOUT_MS}ms`,
                GatewayErrors.PROVIDER_ERROR,
              ));
              return;
            }
            if (truncated) {
              rejectResult(new JSONRPCErrorException(
                `${options.label} output exceeded ${MAX_COMMAND_OUTPUT_CHARS} chars`,
                GatewayErrors.PROVIDER_ERROR,
              ));
              return;
            }
            if (code !== 0) {
              const details = stderr.trim() || stdout.trim() || `exit code ${code}`;
              rejectResult(new JSONRPCErrorException(
                `${options.label} failed: ${details}`,
                GatewayErrors.PROVIDER_ERROR,
              ));
              return;
            }
            resolveResult(stdout);
          });
        });
      });
    },
  };
}

function parseJson<T>(stdout: string, label: string): T {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new JSONRPCErrorException(
      `${label} returned empty JSON output`,
      GatewayErrors.PROVIDER_ERROR,
    );
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch (error) {
    throw new JSONRPCErrorException(
      `${label} returned invalid JSON: ${toErrorMessage(error)}`,
      GatewayErrors.PROVIDER_ERROR,
    );
  }
}

function parseJsonLines<T>(stdout: string, label: string): T[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const lines = trimmed.split('\n').filter(Boolean);
  try {
    return lines.map((line) => JSON.parse(line) as T);
  } catch (error) {
    throw new JSONRPCErrorException(
      `${label} returned invalid JSONL: ${toErrorMessage(error)}`,
      GatewayErrors.PROVIDER_ERROR,
    );
  }
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  return undefined;
}

function parsePositiveInteger(value: unknown): number | undefined {
  const raw = asNonEmptyString(value);
  if (!raw) return undefined;
  if (!/^\d+$/.test(raw)) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function resolveProjectConfig(config: Record<string, unknown>): GitHubProjectSyncConfigResult {
  const enabled = parseBoolean(config[GH_PROJECT_SYNC_ENABLED_KEY]);
  if (enabled === false) {
    return {
      disabled: true,
      reason: `GitHub Project sync disabled via ${GH_PROJECT_SYNC_ENABLED_KEY}`,
    };
  }

  const owner = asNonEmptyString(config[GH_PROJECT_SYNC_OWNER_KEY]);
  const projectNumber = parsePositiveInteger(config[GH_PROJECT_SYNC_PROJECT_NUMBER_KEY]);
  if (owner && projectNumber) {
    return { owner, projectNumber };
  }

  const projectUrl = asNonEmptyString(config[GH_PROJECT_SYNC_PROJECT_URL_KEY]);
  if (projectUrl) {
    const match = projectUrl.match(PROJECT_URL_PATTERN);
    if (!match) {
      return {
        disabled: false,
        error: `Invalid ${GH_PROJECT_SYNC_PROJECT_URL_KEY}: expected https://github.com/users/<owner>/projects/<number> or https://github.com/orgs/<owner>/projects/<number>`,
      };
    }
    return {
      owner: match[1],
      projectNumber: Number.parseInt(match[2], 10),
    };
  }

  if (owner || config[GH_PROJECT_SYNC_PROJECT_NUMBER_KEY] !== undefined) {
    return {
      disabled: false,
      error: `Incomplete GitHub Project sync config: set both ${GH_PROJECT_SYNC_OWNER_KEY} and ${GH_PROJECT_SYNC_PROJECT_NUMBER_KEY}, or set ${GH_PROJECT_SYNC_PROJECT_URL_KEY}`,
    };
  }

  return {
    disabled: true,
    reason: `GitHub Project sync is not configured in beads config (${GH_PROJECT_SYNC_PROJECT_URL_KEY} or owner/project_number)`,
  };
}

function buildDraftTitle(issue: BeadsIssueRecord): string {
  return `${issue.id} ${issue.title}`.trim();
}

function buildDraftBody(issue: BeadsIssueRecord): string {
  const header = [
    `Source bead: ${issue.id}`,
    `Status: ${issue.status ?? 'open'}`,
    `Priority: ${typeof issue.priority === 'number' ? `P${issue.priority}` : 'unset'}`,
    `Type: ${issue.issue_type ?? 'task'}`,
    issue.owner ? `Owner: ${issue.owner}` : undefined,
  ].filter((line): line is string => Boolean(line));

  const sections = [header.join('\n')];
  const description = issue.description?.trim();
  sections.push(description ? description : '_No description provided._');

  const notes = issue.notes?.trim();
  if (notes) {
    sections.push(`Notes\n\n${notes}`);
  }

  return sections.join('\n\n');
}

function getMetadataValue(issue: BeadsIssueRecord, key: string): string | undefined {
  return asNonEmptyString(issue.metadata?.[key]);
}

function isMetadataArchived(issue: BeadsIssueRecord): boolean {
  const value = getMetadataValue(issue, ITEM_ARCHIVED_METADATA_KEY);
  return value === '1' || value === 'true';
}

function getMatchingItemId(
  issue: BeadsIssueRecord,
  config: GitHubProjectSyncConfig,
): string | undefined {
  const owner = getMetadataValue(issue, ITEM_OWNER_METADATA_KEY);
  const projectNumber = parsePositiveInteger(issue.metadata?.[ITEM_PROJECT_NUMBER_METADATA_KEY]);
  const itemId = getMetadataValue(issue, ITEM_ID_METADATA_KEY);
  if (!itemId) return undefined;
  if (owner && owner !== config.owner) return undefined;
  if (projectNumber && projectNumber !== config.projectNumber) return undefined;
  return itemId;
}

function getMatchingDraftContentId(
  issue: BeadsIssueRecord,
  config: GitHubProjectSyncConfig,
): string | undefined {
  const owner = getMetadataValue(issue, ITEM_OWNER_METADATA_KEY);
  const projectNumber = parsePositiveInteger(issue.metadata?.[ITEM_PROJECT_NUMBER_METADATA_KEY]);
  const draftContentId = getMetadataValue(issue, DRAFT_CONTENT_ID_METADATA_KEY);
  if (!draftContentId) return undefined;
  if (owner && owner !== config.owner) return undefined;
  if (projectNumber && projectNumber !== config.projectNumber) return undefined;
  return draftContentId;
}

function extractIssueId(action: BeadsAction, target: string, payload: unknown): string | undefined {
  if (action !== 'create') {
    return target === 'new' ? undefined : target;
  }
  const candidates = Array.isArray(payload) ? payload : [payload];
  for (const candidate of candidates) {
    if (
      candidate
      && typeof candidate === 'object'
      && typeof (candidate as Record<string, unknown>).id === 'string'
    ) {
      return ((candidate as Record<string, unknown>).id as string).trim() || undefined;
    }
  }
  return undefined;
}

async function loadConfig(
  runner: CommandRunner,
  workspacePath: string,
): Promise<GitHubProjectSyncConfigResult> {
  const stdout = await runner.run(
    'bd',
    ['config', 'list', '--json'],
    {
      cwd: workspacePath,
      label: 'bd config list',
    },
  );
  const payload = parseJson<Record<string, unknown>>(stdout, 'bd config list');
  return resolveProjectConfig(payload);
}

async function ensureProjectAccess(
  runner: CommandRunner,
  workspacePath: string,
  config: GitHubProjectSyncConfig,
): Promise<void> {
  await runner.run(
    'gh',
    ['project', 'view', String(config.projectNumber), '--owner', config.owner, '--format', 'json'],
    {
      cwd: workspacePath,
      label: `gh project view ${config.owner}/${config.projectNumber}`,
    },
  );
}

async function loadIssueById(
  runner: CommandRunner,
  workspacePath: string,
  issueId: string,
): Promise<BeadsIssueRecord> {
  const stdout = await runner.run(
    'bd',
    ['show', issueId, '--json'],
    {
      cwd: workspacePath,
      label: `bd show ${issueId}`,
    },
  );
  const payload = parseJson<unknown[]>(stdout, `bd show ${issueId}`);
  if (!Array.isArray(payload) || payload.length === 0 || !payload[0] || typeof payload[0] !== 'object') {
    throw new JSONRPCErrorException(
      `bd show ${issueId} returned no issue records`,
      GatewayErrors.PROVIDER_ERROR,
    );
  }
  return payload[0] as BeadsIssueRecord;
}

async function exportIssues(
  runner: CommandRunner,
  workspacePath: string,
): Promise<BeadsIssueRecord[]> {
  const stdout = await runner.run(
    'bd',
    ['export'],
    {
      cwd: workspacePath,
      label: 'bd export',
    },
  );
  return parseJsonLines<BeadsIssueRecord>(stdout, 'bd export');
}

async function lookupDraftContentIdByItemId(
  runner: CommandRunner,
  workspacePath: string,
  itemId: string,
): Promise<string> {
  const stdout = await runner.run(
    'gh',
    [
      'api',
      'graphql',
      '-f',
      'query=query($itemId:ID!) { node(id:$itemId) { ... on ProjectV2Item { id content { __typename ... on DraftIssue { id } } } } }',
      '-F',
      `itemId=${itemId}`,
    ],
    {
      cwd: workspacePath,
      label: `gh api graphql draft content ${itemId}`,
    },
  );
  const payload = parseJson<{
    data?: {
      node?: {
        content?: {
          __typename?: string;
          id?: string;
        };
      };
    };
  }>(stdout, `gh api graphql draft content ${itemId}`);
  const content = payload.data?.node?.content;
  if (!content || content.__typename !== 'DraftIssue' || !content.id) {
    throw new JSONRPCErrorException(
      `gh api graphql draft content ${itemId} did not resolve a draft issue content id`,
      GatewayErrors.PROVIDER_ERROR,
    );
  }
  return content.id;
}

async function persistItemMetadata(
  runner: CommandRunner,
  workspacePath: string,
  issueId: string,
  config: GitHubProjectSyncConfig,
  itemId: string,
  draftContentId: string,
  archived: boolean,
): Promise<void> {
  const args = [
    'update',
    issueId,
    '--set-metadata',
    `${ITEM_OWNER_METADATA_KEY}=${config.owner}`,
    '--set-metadata',
    `${ITEM_PROJECT_NUMBER_METADATA_KEY}=${config.projectNumber}`,
    '--set-metadata',
    `${ITEM_ID_METADATA_KEY}=${itemId}`,
    '--set-metadata',
    `${DRAFT_CONTENT_ID_METADATA_KEY}=${draftContentId}`,
  ];
  if (archived) {
    args.push('--set-metadata', `${ITEM_ARCHIVED_METADATA_KEY}=1`);
  } else {
    args.push('--unset-metadata', ITEM_ARCHIVED_METADATA_KEY);
  }
  args.push('--json');

  await runner.run(
    'bd',
    args,
    {
      cwd: workspacePath,
      label: `bd update ${issueId} metadata`,
    },
  );
}

async function createItem(
  runner: CommandRunner,
  workspacePath: string,
  config: GitHubProjectSyncConfig,
  issue: BeadsIssueRecord,
): Promise<GitHubProjectSyncResult> {
  const stdout = await runner.run(
    'gh',
    [
      'project',
      'item-create',
      String(config.projectNumber),
      '--owner',
      config.owner,
      '--title',
      buildDraftTitle(issue),
      '--body',
      buildDraftBody(issue),
      '--format',
      'json',
    ],
    {
      cwd: workspacePath,
      label: `gh project item-create ${issue.id}`,
    },
  );
  const payload = parseJson<Record<string, unknown>>(stdout, `gh project item-create ${issue.id}`);
  const itemId = asNonEmptyString(payload.id);
  if (!itemId) {
    throw new JSONRPCErrorException(
      `gh project item-create ${issue.id} returned no item id`,
      GatewayErrors.PROVIDER_ERROR,
    );
  }
  const draftContentId = await lookupDraftContentIdByItemId(runner, workspacePath, itemId);
  await persistItemMetadata(runner, workspacePath, issue.id, config, itemId, draftContentId, false);
  return {
    integration: 'github_project',
    state: 'synced',
    owner: config.owner,
    projectNumber: config.projectNumber,
    issueId: issue.id,
    itemId,
    draftContentId,
    created: true,
  };
}

async function maybeUnarchiveItem(
  runner: CommandRunner,
  workspacePath: string,
  config: GitHubProjectSyncConfig,
  itemId: string,
): Promise<void> {
  await runner.run(
    'gh',
    [
      'project',
      'item-archive',
      String(config.projectNumber),
      '--owner',
      config.owner,
      '--id',
      itemId,
      '--undo',
      '--format',
      'json',
    ],
    {
      cwd: workspacePath,
      label: `gh project item-archive --undo ${itemId}`,
    },
  );
}

async function syncOpenIssue(
  runner: CommandRunner,
  workspacePath: string,
  config: GitHubProjectSyncConfig,
  issue: BeadsIssueRecord,
): Promise<GitHubProjectSyncResult> {
  const itemId = getMatchingItemId(issue, config);
  if (!itemId) {
    return await createItem(runner, workspacePath, config, issue);
  }
  const draftContentId = getMatchingDraftContentId(issue, config)
    ?? await lookupDraftContentIdByItemId(runner, workspacePath, itemId);

  let reopened = false;
  if (isMetadataArchived(issue)) {
    try {
      await maybeUnarchiveItem(runner, workspacePath, config, itemId);
      reopened = true;
    } catch {
      reopened = false;
    }
  }

  await runner.run(
    'gh',
    [
      'project',
      'item-edit',
      '--id',
      draftContentId,
      '--title',
      buildDraftTitle(issue),
      '--body',
      buildDraftBody(issue),
      '--format',
      'json',
    ],
    {
      cwd: workspacePath,
      label: `gh project item-edit ${issue.id}`,
    },
  );

  if (isMetadataArchived(issue) || !getMatchingDraftContentId(issue, config)) {
    await persistItemMetadata(runner, workspacePath, issue.id, config, itemId, draftContentId, false);
  }

  return {
    integration: 'github_project',
    state: 'synced',
    owner: config.owner,
    projectNumber: config.projectNumber,
    issueId: issue.id,
    itemId,
    draftContentId,
    reopened,
  };
}

async function syncClosedIssue(
  runner: CommandRunner,
  workspacePath: string,
  config: GitHubProjectSyncConfig,
  issue: BeadsIssueRecord,
): Promise<GitHubProjectSyncResult> {
  const itemId = getMatchingItemId(issue, config);
  if (!itemId) {
    return {
      integration: 'github_project',
      state: 'skipped',
      owner: config.owner,
      projectNumber: config.projectNumber,
      issueId: issue.id,
      reason: 'Issue has no matching synced project item',
    };
  }
  if (isMetadataArchived(issue)) {
    return {
      integration: 'github_project',
      state: 'skipped',
      owner: config.owner,
      projectNumber: config.projectNumber,
      issueId: issue.id,
      itemId,
      reason: 'Project item is already marked archived in beads metadata',
    };
  }

  await runner.run(
    'gh',
    [
      'project',
      'item-archive',
      String(config.projectNumber),
      '--owner',
      config.owner,
      '--id',
      itemId,
      '--format',
      'json',
    ],
    {
      cwd: workspacePath,
      label: `gh project item-archive ${issue.id}`,
    },
  );
  const draftContentId = getMatchingDraftContentId(issue, config)
    ?? await lookupDraftContentIdByItemId(runner, workspacePath, itemId);
  await persistItemMetadata(runner, workspacePath, issue.id, config, itemId, draftContentId, true);

  return {
    integration: 'github_project',
    state: 'archived',
    owner: config.owner,
    projectNumber: config.projectNumber,
    issueId: issue.id,
    itemId,
    draftContentId,
  };
}

function toSyncErrorResult(
  issueId: string | undefined,
  config: GitHubProjectSyncConfig | undefined,
  error: unknown,
): GitHubProjectSyncResult {
  return {
    integration: 'github_project',
    state: 'error',
    ...(config ? { owner: config.owner, projectNumber: config.projectNumber } : {}),
    ...(issueId ? { issueId } : {}),
    reason: toErrorMessage(error),
  };
}

async function syncIssueRecord(
  runner: CommandRunner,
  workspacePath: string,
  config: GitHubProjectSyncConfig,
  issue: BeadsIssueRecord,
): Promise<GitHubProjectSyncResult> {
  if ((issue.status ?? 'open') === 'closed') {
    return await syncClosedIssue(runner, workspacePath, config, issue);
  }
  return await syncOpenIssue(runner, workspacePath, config, issue);
}

export async function syncMutatedBeadToGitHubProject(
  workspacePath: string,
  action: Extract<BeadsAction, 'create' | 'update' | 'close'>,
  target: string,
  payload: unknown,
  runner: CommandRunner = createSpawnCommandRunner(),
): Promise<GitHubProjectSyncResult | undefined> {
  let resolvedConfig: GitHubProjectSyncConfig | undefined;
  try {
    const config = await loadConfig(runner, workspacePath);
    if ('disabled' in config) {
      if (config.disabled) return undefined;
      return {
        integration: 'github_project',
        state: 'error',
        reason: config.error,
      };
    }
    resolvedConfig = config;

    const issueId = extractIssueId(action, target, payload);
    if (!issueId) {
      return {
        integration: 'github_project',
        state: 'error',
        owner: resolvedConfig.owner,
        projectNumber: resolvedConfig.projectNumber,
        reason: `Unable to determine bead id after beads.${action}`,
      };
    }

    await ensureProjectAccess(runner, workspacePath, resolvedConfig);
    const issue = await loadIssueById(runner, workspacePath, issueId);
    return await syncIssueRecord(runner, workspacePath, resolvedConfig, issue);
  } catch (error) {
    const issueId = action === 'create' ? extractIssueId(action, target, payload) : target;
    return toSyncErrorResult(issueId, resolvedConfig, error);
  }
}

export async function syncAllBeadsToGitHubProject(
  workspacePath: string,
  runner: CommandRunner = createSpawnCommandRunner(),
): Promise<GitHubProjectBulkSyncResult> {
  const config = await loadConfig(runner, workspacePath);
  if ('disabled' in config) {
    if (config.disabled) {
      return {
        integration: 'github_project',
        state: 'disabled',
        totalIssues: 0,
        synced: 0,
        archived: 0,
        skipped: 0,
      };
    }
    return {
      integration: 'github_project',
      state: 'error',
      totalIssues: 0,
      synced: 0,
      archived: 0,
      skipped: 0,
      errors: [
        {
          issueId: 'config',
          message: config.error,
        },
      ],
    };
  }

  await ensureProjectAccess(runner, workspacePath, config);
  const issues = await exportIssues(runner, workspacePath);
  const errors: Array<{ issueId: string; message: string }> = [];
  let synced = 0;
  let archived = 0;
  let skipped = 0;

  for (const issue of issues) {
    let result: GitHubProjectSyncResult;
    try {
      result = await syncIssueRecord(runner, workspacePath, config, issue);
    } catch (error) {
      result = toSyncErrorResult(issue.id, config, error);
    }
    if (result.state === 'synced') {
      synced += 1;
      continue;
    }
    if (result.state === 'archived') {
      archived += 1;
      continue;
    }
    if (result.state === 'skipped') {
      skipped += 1;
      continue;
    }
    errors.push({
      issueId: issue.id,
      message: result.reason ?? 'unknown sync error',
    });
  }

  return {
    integration: 'github_project',
    state: errors.length > 0 ? 'error' : 'synced',
    owner: config.owner,
    projectNumber: config.projectNumber,
    totalIssues: issues.length,
    synced,
    archived,
    skipped,
    ...(errors.length > 0 ? { errors } : {}),
  };
}
