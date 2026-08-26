import type {
  ChannelAdapterPort,
  ChannelCapabilities,
  ChannelConfigAdapter,
  ChannelGatewayAdapter,
  ChannelOutboundAdapter,
  ChannelPromptAdapter,
  ChannelSecurityAdapter,
  MessageHandler,
  MessageHandlerOptions,
  OutboundContext,
} from '../backplane/types.js';
import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import { toErrorMessage } from '../../shared/utils/errors.js';

const MULTICA_RUNTIME_PROVIDER = 'psfn';
const MULTICA_RUNTIME_VERSION = 'gateway-channel-v1';
const MULTICA_DEVICE_NAME = 'PSFN Gateway';
const DEFAULT_MULTICA_HEARTBEAT_INTERVAL_MS = 15_000;

type FetchLike = typeof fetch;

export interface MulticaAdapterConfig {
  enabled: boolean;
  baseUrl: string;
  workspaceId: string;
  companionId: string;
  token: string;
  pollIntervalMs: number;
  runtimeName?: string;
}

export interface MulticaAdapterLogger {
  error(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface MulticaAdapterOptions {
  fetchImpl?: FetchLike;
  log?: MulticaAdapterLogger;
  heartbeatIntervalMs?: number;
}

interface MulticaRuntimeRegistration {
  id: string;
  provider: string;
}

interface MulticaTaskAgent {
  id?: string;
  name?: string;
  instructions?: string;
}

interface MulticaClaimedTask {
  id: string;
  agent_id?: string;
  runtime_id: string;
  issue_id?: string;
  workspace_id: string;
  kind?: string;
  created_at?: string;
  project_id?: string;
  project_title?: string;
  project_description?: string;
  is_leader_task?: boolean;
  leader_role_resolved?: boolean;
  squad_id?: string;
  squad_name?: string;
  handoff_note?: string;
  trigger_comment_id?: string;
  trigger_thread_id?: string;
  trigger_comment_content?: string;
  trigger_author_type?: string;
  trigger_author_name?: string;
  coalesced_comments?: Array<{
    id?: string;
    author_name?: string;
    content?: string;
  }>;
  chat_session_id?: string;
  chat_message?: string;
  autopilot_run_id?: string;
  autopilot_title?: string;
  autopilot_description?: string;
  quick_create_prompt?: string;
  initiator_type?: string;
  initiator_id?: string;
  initiator_name?: string;
  requesting_user_name?: string;
  auth_token?: string;
  agent?: MulticaTaskAgent;
}

interface MulticaIssue {
  id: string;
  workspace_id?: string;
  identifier?: string;
  title?: string;
  description?: string | null;
  status?: string;
  priority?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function requiredString(
  value: unknown,
  field: string,
): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Multica response field ${field} must be a non-empty string`);
  }
  return value.trim();
}

function parseRegistrationResponse(value: unknown): MulticaRuntimeRegistration {
  if (!isRecord(value) || !Array.isArray(value.runtimes)) {
    throw new Error('Multica registration response must contain runtimes[]');
  }
  const runtimes = value.runtimes.filter(isRecord).map((runtime) => ({
    id: requiredString(runtime.id, 'runtimes[].id'),
    provider: requiredString(runtime.provider, 'runtimes[].provider').toLowerCase(),
  }));
  const runtime = runtimes.find(entry => entry.provider === MULTICA_RUNTIME_PROVIDER);
  if (!runtime) {
    throw new Error('Multica registration response did not contain the PSFN runtime');
  }
  return runtime;
}

function parseClaimResponse(value: unknown): MulticaClaimedTask | null {
  if (!isRecord(value) || !Object.hasOwn(value, 'task')) {
    throw new Error('Multica claim response must contain task');
  }
  if (value.task === null) return null;
  if (!isRecord(value.task)) {
    throw new Error('Multica claim response task must be an object or null');
  }
  return {
    ...value.task,
    id: requiredString(value.task.id, 'task.id'),
    runtime_id: requiredString(value.task.runtime_id, 'task.runtime_id'),
    workspace_id: requiredString(value.task.workspace_id, 'task.workspace_id'),
  } as MulticaClaimedTask;
}

function parseIssueResponse(value: unknown): MulticaIssue {
  if (!isRecord(value)) {
    throw new Error('Multica issue response must be an object');
  }
  return {
    ...value,
    id: requiredString(value.id, 'issue.id'),
  } as MulticaIssue;
}

function channelIdForTask(task: MulticaClaimedTask): string {
  if (task.issue_id) return `multica:issue:${task.issue_id}`;
  if (task.chat_session_id) return `multica:chat:${task.chat_session_id}`;
  if (task.autopilot_run_id) return `multica:autopilot:${task.autopilot_run_id}`;
  return `multica:task:${task.id}`;
}

function authorForTask(task: MulticaClaimedTask): { id: string; name: string } {
  const initiatorId = task.initiator_id?.trim();
  const initiatorType = task.initiator_type?.trim() || 'actor';
  if (initiatorId) {
    return {
      id: `multica:${initiatorType}:${initiatorId}`,
      name: task.initiator_name?.trim() || task.trigger_author_name?.trim() || 'Multica user',
    };
  }
  return {
    id: `multica:workspace:${task.workspace_id}`,
    name: task.requesting_user_name?.trim() || task.trigger_author_name?.trim() || 'Multica',
  };
}

function appendSection(lines: string[], heading: string, content: string | undefined): void {
  const normalized = content?.trim();
  if (!normalized) return;
  lines.push('', `## ${heading}`, normalized);
}

function formatTaskContent(task: MulticaClaimedTask, issue: MulticaIssue | null): string {
  const lines = [
    '# Multica work item',
    `Task ID: ${task.id}`,
    `Task kind: ${task.kind?.trim() || 'direct'}`,
  ];
  if (issue?.identifier) lines.push(`Issue: ${issue.identifier}`);
  if (task.project_title) lines.push(`Project: ${task.project_title}`);
  if (task.squad_name) lines.push(`Squad: ${task.squad_name}`);
  if (task.leader_role_resolved) {
    lines.push(`Squad role: ${task.is_leader_task ? 'leader' : 'worker'}`);
  }

  if (issue) {
    appendSection(lines, 'Issue', [
      issue.title?.trim(),
      issue.status ? `Status: ${issue.status}` : undefined,
      issue.priority ? `Priority: ${issue.priority}` : undefined,
      issue.description?.trim(),
    ].filter((entry): entry is string => Boolean(entry)).join('\n'));
  }
  appendSection(lines, 'Handoff', task.handoff_note);
  appendSection(lines, 'New comment', task.trigger_comment_content);
  if (task.coalesced_comments?.length) {
    appendSection(
      lines,
      'Earlier comments included in this run',
      task.coalesced_comments
        .map(comment => `- ${comment.author_name?.trim() || 'Multica user'}: ${comment.content?.trim() || ''}`)
        .join('\n'),
    );
  }
  appendSection(lines, 'Chat message', task.chat_message);
  appendSection(lines, 'Quick-create request', task.quick_create_prompt);
  appendSection(lines, 'Autopilot', task.autopilot_description || task.autopilot_title);
  appendSection(lines, 'Multica assignment context', task.agent?.instructions);
  appendSection(lines, 'Project context', task.project_description);
  return lines.join('\n');
}

function timestampForTask(task: MulticaClaimedTask): Date {
  if (task.created_at) {
    const parsed = new Date(task.created_at);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

function waitForNextPoll(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref();
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class MulticaAdapter implements ChannelAdapterPort {
  readonly id = 'multica';
  readonly name = this.id;
  readonly meta = { label: 'Multica' };
  readonly capabilities: ChannelCapabilities = {
    chatTypes: ['channel', 'thread'],
    media: false,
    reactions: false,
    threads: true,
    streaming: false,
    promptChannelType: 'multica_work_item',
  };
  readonly config: ChannelConfigAdapter;
  readonly outbound: ChannelOutboundAdapter;
  readonly gateway: ChannelGatewayAdapter;
  readonly security: ChannelSecurityAdapter = {
    supportsDirectMessages: false,
  };
  readonly prompt: ChannelPromptAdapter = {
    resolveChannelType: () => 'multica_work_item',
    resolveTaskKind: () => 'work_item',
  };

  private readonly multica: MulticaAdapterConfig;
  private readonly fetchImpl: FetchLike;
  private readonly log: MulticaAdapterLogger;
  private readonly heartbeatIntervalMs: number;
  private handler: MessageHandler | null = null;
  private runtimeId: string | null = null;
  private running = false;
  private runController: AbortController | null = null;
  private pollLoopPromise: Promise<void> | null = null;
  private heartbeatLoopPromise: Promise<void> | null = null;

  constructor(config: MulticaAdapterConfig, options: MulticaAdapterOptions = {}) {
    this.multica = config;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs
      ?? DEFAULT_MULTICA_HEARTBEAT_INTERVAL_MS;
    this.log = options.log ?? {
      error: () => undefined,
      warn: () => undefined,
    };
    this.config = {
      enabled: config.enabled,
      connectionLabel: config.baseUrl,
    };
    this.outbound = {
      textChunkLimit: 100_000,
      sendText: async (_ctx: OutboundContext, _text: string): Promise<void> => {
        throw new Error('Multica task replies are delivered from the channel handler result');
      },
    };
    this.gateway = {
      init: async () => undefined,
      start: async () => this.start(),
      stop: async () => this.stop(),
    };
  }

  async init(): Promise<void> {
    await this.gateway.init();
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  async send(channelId: string, content: string): Promise<void> {
    await this.outbound.sendText({ channelId }, content);
  }

  async start(): Promise<void> {
    if (!this.multica.enabled || this.running) return;
    if (!this.handler) {
      throw new Error('Multica adapter requires an inbound message handler before start');
    }
    const registration = await this.postJson('/api/daemon/register', {
      workspace_id: this.multica.workspaceId,
      daemon_id: `psfn-gateway-${this.multica.companionId}`,
      legacy_daemon_ids: [],
      device_name: MULTICA_DEVICE_NAME,
      cli_version: MULTICA_RUNTIME_VERSION,
      launched_by: 'gateway',
      runtimes: [{
        name: this.multica.runtimeName?.trim() || 'PSFN Companion',
        type: MULTICA_RUNTIME_PROVIDER,
        version: MULTICA_RUNTIME_VERSION,
        status: 'online',
      }],
      failed_profiles: [],
    });
    this.runtimeId = parseRegistrationResponse(registration).id;
    this.running = true;
    this.runController = new AbortController();
    this.pollLoopPromise = this.runPollLoop(this.runController.signal);
    this.heartbeatLoopPromise = this.runHeartbeatLoop(this.runController.signal);
  }

  async stop(): Promise<void> {
    if (!this.running && !this.runtimeId) return;
    this.running = false;
    this.runController?.abort();
    await Promise.all([this.pollLoopPromise, this.heartbeatLoopPromise]);
    this.pollLoopPromise = null;
    this.heartbeatLoopPromise = null;
    this.runController = null;

    const runtimeId = this.runtimeId;
    this.runtimeId = null;
    if (runtimeId) {
      await this.postJson('/api/daemon/deregister', { runtime_ids: [runtimeId] });
    }
  }

  private async runPollLoop(signal: AbortSignal): Promise<void> {
    while (this.running && !signal.aborted) {
      try {
        await this.claimAndHandleOne(signal);
      } catch (error) {
        if (isAbortError(error)) break;
        this.log.error('Multica task polling failed', { error: toErrorMessage(error) });
      }
      await waitForNextPoll(this.multica.pollIntervalMs, signal);
    }
  }

  private async runHeartbeatLoop(signal: AbortSignal): Promise<void> {
    while (this.running && !signal.aborted) {
      const runtimeId = this.runtimeId;
      if (!runtimeId) return;
      try {
        await this.postJson('/api/daemon/heartbeat', { runtime_id: runtimeId }, this.multica.token, signal);
      } catch (error) {
        if (isAbortError(error)) break;
        this.log.warn('Multica runtime heartbeat failed', { error: toErrorMessage(error) });
      }
      await waitForNextPoll(this.heartbeatIntervalMs, signal);
    }
  }

  private async claimAndHandleOne(signal: AbortSignal): Promise<void> {
    const runtimeId = this.runtimeId;
    const handler = this.handler;
    if (!runtimeId || !handler) return;
    const claim = await this.postJson(
      `/api/daemon/runtimes/${encodeURIComponent(runtimeId)}/tasks/claim`,
      {},
      this.multica.token,
      signal,
    );
    const task = parseClaimResponse(claim);
    if (!task) return;
    if (task.runtime_id !== runtimeId) {
      throw new Error(`Multica claimed task ${task.id} for an unexpected runtime`);
    }

    try {
      const issue = task.issue_id
        ? await this.getIssue(task.issue_id, task.auth_token, signal)
        : null;
      await this.postJson(
        `/api/daemon/tasks/${encodeURIComponent(task.id)}/start`,
        {},
        this.multica.token,
        signal,
      );
      const response = await handler(
        this.toSubstrateMessage(task, issue),
        { signal } satisfies MessageHandlerOptions,
      );
      await this.postJson(
        `/api/daemon/tasks/${encodeURIComponent(task.id)}/complete`,
        { output: response.content },
        this.multica.token,
        signal,
      );
    } catch (error) {
      if (signal.aborted) return;
      const message = toErrorMessage(error);
      this.log.error('Multica task handling failed', { taskId: task.id, error: message });
      try {
        await this.postJson(
          `/api/daemon/tasks/${encodeURIComponent(task.id)}/fail`,
          { error: message, failure_reason: 'psfn_gateway_companion_error' },
          this.multica.token,
        );
      } catch (reportError) {
        this.log.error('Multica task failure report failed', {
          taskId: task.id,
          error: toErrorMessage(reportError),
        });
      }
    }
  }

  private async getIssue(
    issueId: string,
    taskToken: string | undefined,
    signal: AbortSignal,
  ): Promise<MulticaIssue> {
    const token = taskToken?.trim();
    if (!token) {
      throw new Error(`Multica task ${issueId} did not include a task-scoped credential`);
    }
    const response = await this.requestJson(
      `/api/issues/${encodeURIComponent(issueId)}`,
      { method: 'GET' },
      token,
      signal,
    );
    return parseIssueResponse(response);
  }

  private toSubstrateMessage(
    task: MulticaClaimedTask,
    issue: MulticaIssue | null,
  ): SubstrateMessage {
    const author = authorForTask(task);
    return {
      id: task.id,
      channelId: channelIdForTask(task),
      channelType: 'multica',
      authorId: author.id,
      authorName: author.name,
      content: formatTaskContent(task, issue),
      timestamp: timestampForTask(task),
      isDirectMessage: false,
      ...(task.trigger_comment_id ? { replyToMessageId: task.trigger_comment_id } : {}),
      routing: {
        source: 'multica',
        channelPrivacy: 'invite_only',
        ...(task.trigger_author_type === 'agent'
          ? { authorIsMachineIntelligence: true }
          : {}),
      },
    };
  }

  private async postJson(
    path: string,
    body: Record<string, unknown>,
    token = this.multica.token,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return await this.requestJson(path, {
      method: 'POST',
      body: JSON.stringify(body),
    }, token, signal);
  }

  private async requestJson(
    path: string,
    init: RequestInit,
    token: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await this.fetchImpl(new URL(path, `${this.multica.baseUrl}/`), {
      ...init,
      ...(signal ? { signal } : {}),
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Multica ${init.method ?? 'GET'} ${path} returned ${response.status}: ${text}`);
    }
    if (!text.trim()) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`Multica ${init.method ?? 'GET'} ${path} returned invalid JSON`);
    }
  }
}
