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
import { screenChatMessageBody } from '../../core/cogsec/intake/chat-message-screening.js';
import type { IntakeScreeningService } from '../../core/cogsec/intake/screening.js';
import { createComponentLogger } from '../../shared/logger.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { isRecord } from '../../shared/utils/types.js';
import { normalizeMulticaOrigin } from './origin.js';

const MULTICA_RUNTIME_PROVIDER = 'psfn';
const MULTICA_RUNTIME_VERSION = 'gateway-channel-v1';
const MULTICA_DEVICE_NAME = 'PSFN Gateway';
const DEFAULT_MULTICA_HEARTBEAT_INTERVAL_MS = 15_000;
const MULTICA_MAX_OPERATION_ATTEMPTS = 3;

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

interface MulticaOperatorAlert {
  title: string;
  message: string;
  idempotencyKey: string;
}

type MulticaOperatorAlertHandler = (alert: MulticaOperatorAlert) => Promise<void>;

export interface MulticaAdapterOptions {
  fetchImpl?: FetchLike;
  log?: MulticaAdapterLogger;
  heartbeatIntervalMs?: number;
  requestTimeoutMs?: number;
  intakeScreening?: IntakeScreeningService | null;
}

interface MulticaRuntimeRegistration {
  id: string;
  provider: string;
}

interface MulticaTaskAgent {
  instructions?: string;
}

interface MulticaCoalescedComment {
  author_name?: string;
  content?: string;
}

interface MulticaClaimedTask {
  id: string;
  runtime_id: string;
  workspace_id: string;
  issue_id?: string;
  kind?: string;
  created_at?: string;
  project_title?: string;
  project_description?: string;
  is_leader_task?: boolean;
  leader_role_resolved?: boolean;
  squad_name?: string;
  handoff_note?: string;
  trigger_comment_id?: string;
  trigger_comment_content?: string;
  coalesced_comments?: MulticaCoalescedComment[];
  chat_session_id?: string;
  chat_message?: string;
  autopilot_run_id?: string;
  autopilot_title?: string;
  autopilot_description?: string;
  quick_create_prompt?: string;
  auth_token?: string;
  agent?: MulticaTaskAgent;
}

interface MulticaIssue {
  id: string;
  workspace_id: string;
  identifier?: string;
  title?: string;
  description?: string;
  status?: string;
  priority?: string;
}

class MulticaWorkspaceBoundaryError extends Error {}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(toErrorMessage(error));
}

function combineErrors(message: string, errors: readonly unknown[]): Error {
  return new AggregateError(errors.map(asError), message);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Multica response field ${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Multica response field ${field} must be a string when present`);
  }
  return value.trim() || undefined;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`Multica response field ${field} must be a boolean when present`);
  }
  return value;
}

function parseTaskAgent(value: unknown): MulticaTaskAgent | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw new Error('Multica response field task.agent must be an object when present');
  }
  const instructions = optionalString(value.instructions, 'task.agent.instructions');
  return instructions ? { instructions } : {};
}

function parseCoalescedComments(value: unknown): MulticaCoalescedComment[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error('Multica response field task.coalesced_comments must be an array when present');
  }
  return value.map((comment, index) => {
    if (!isRecord(comment)) {
      throw new Error(`Multica response field task.coalesced_comments[${index}] must be an object`);
    }
    const authorName = optionalString(comment.author_name, `task.coalesced_comments[${index}].author_name`);
    const content = optionalString(comment.content, `task.coalesced_comments[${index}].content`);
    return {
      ...(authorName ? { author_name: authorName } : {}),
      ...(content ? { content } : {}),
    };
  });
}

function parseRegistrationResponse(value: unknown): MulticaRuntimeRegistration {
  if (!isRecord(value) || !Array.isArray(value.runtimes)) {
    throw new Error('Multica registration response must contain runtimes[]');
  }
  const runtimes = value.runtimes.map((runtime, index) => {
    if (!isRecord(runtime)) {
      throw new Error(`Multica registration response runtimes[${index}] must be an object`);
    }
    return {
      id: requiredString(runtime.id, `runtimes[${index}].id`),
      provider: requiredString(runtime.provider, `runtimes[${index}].provider`).toLowerCase(),
    };
  });
  const runtime = runtimes.find(entry => entry.provider === MULTICA_RUNTIME_PROVIDER);
  if (!runtime) throw new Error('Multica registration response did not contain the PSFN runtime');
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
  const task = value.task;
  const read = (field: string): string | undefined => optionalString(task[field], `task.${field}`);
  const issueId = read('issue_id');
  const kind = read('kind');
  const createdAt = read('created_at');
  const projectTitle = read('project_title');
  const projectDescription = read('project_description');
  const squadName = read('squad_name');
  const handoffNote = read('handoff_note');
  const triggerCommentId = read('trigger_comment_id');
  const triggerCommentContent = read('trigger_comment_content');
  const chatSessionId = read('chat_session_id');
  const chatMessage = read('chat_message');
  const autopilotRunId = read('autopilot_run_id');
  const autopilotTitle = read('autopilot_title');
  const autopilotDescription = read('autopilot_description');
  const quickCreatePrompt = read('quick_create_prompt');
  const authToken = read('auth_token');
  const isLeaderTask = optionalBoolean(task.is_leader_task, 'task.is_leader_task');
  const leaderRoleResolved = optionalBoolean(task.leader_role_resolved, 'task.leader_role_resolved');
  const comments = parseCoalescedComments(task.coalesced_comments);
  const agent = parseTaskAgent(task.agent);
  return {
    id: requiredString(task.id, 'task.id'),
    runtime_id: requiredString(task.runtime_id, 'task.runtime_id'),
    workspace_id: requiredString(task.workspace_id, 'task.workspace_id'),
    ...(issueId ? { issue_id: issueId } : {}),
    ...(kind ? { kind } : {}),
    ...(createdAt ? { created_at: createdAt } : {}),
    ...(projectTitle ? { project_title: projectTitle } : {}),
    ...(projectDescription ? { project_description: projectDescription } : {}),
    ...(isLeaderTask === undefined ? {} : { is_leader_task: isLeaderTask }),
    ...(leaderRoleResolved === undefined ? {} : { leader_role_resolved: leaderRoleResolved }),
    ...(squadName ? { squad_name: squadName } : {}),
    ...(handoffNote ? { handoff_note: handoffNote } : {}),
    ...(triggerCommentId ? { trigger_comment_id: triggerCommentId } : {}),
    ...(triggerCommentContent ? { trigger_comment_content: triggerCommentContent } : {}),
    ...(comments ? { coalesced_comments: comments } : {}),
    ...(chatSessionId ? { chat_session_id: chatSessionId } : {}),
    ...(chatMessage ? { chat_message: chatMessage } : {}),
    ...(autopilotRunId ? { autopilot_run_id: autopilotRunId } : {}),
    ...(autopilotTitle ? { autopilot_title: autopilotTitle } : {}),
    ...(autopilotDescription ? { autopilot_description: autopilotDescription } : {}),
    ...(quickCreatePrompt ? { quick_create_prompt: quickCreatePrompt } : {}),
    ...(authToken ? { auth_token: authToken } : {}),
    ...(agent ? { agent } : {}),
  };
}

function parseIssueResponse(value: unknown): MulticaIssue {
  if (!isRecord(value)) throw new Error('Multica issue response must be an object');
  const identifier = optionalString(value.identifier, 'issue.identifier');
  const title = optionalString(value.title, 'issue.title');
  const description = optionalString(value.description, 'issue.description');
  const status = optionalString(value.status, 'issue.status');
  const priority = optionalString(value.priority, 'issue.priority');
  return {
    id: requiredString(value.id, 'issue.id'),
    workspace_id: requiredString(value.workspace_id, 'issue.workspace_id'),
    ...(identifier ? { identifier } : {}),
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(status ? { status } : {}),
    ...(priority ? { priority } : {}),
  };
}

function channelIdForTask(task: MulticaClaimedTask): string {
  const prefix = `multica:${task.workspace_id}`;
  if (task.issue_id) return `${prefix}:issue:${task.issue_id}`;
  if (task.chat_session_id) return `${prefix}:chat:${task.chat_session_id}`;
  if (task.autopilot_run_id) return `${prefix}:autopilot:${task.autopilot_run_id}`;
  return `${prefix}:task:${task.id}`;
}

function appendSection(lines: string[], heading: string, content: string | undefined): void {
  const normalized = content?.trim();
  if (normalized) lines.push('', `## ${heading}`, normalized);
}

function formatTaskContent(task: MulticaClaimedTask, issue: MulticaIssue | null): string {
  const lines = ['# Multica work item', `Task ID: ${task.id}`, `Task kind: ${task.kind || 'direct'}`];
  if (issue?.identifier) lines.push(`Issue: ${issue.identifier}`);
  if (task.project_title) lines.push(`Project: ${task.project_title}`);
  if (task.squad_name) lines.push(`Squad: ${task.squad_name}`);
  if (task.leader_role_resolved) lines.push(`Squad role: ${task.is_leader_task ? 'leader' : 'worker'}`);
  if (issue) {
    appendSection(lines, 'Issue', [
      issue.title,
      issue.status ? `Status: ${issue.status}` : undefined,
      issue.priority ? `Priority: ${issue.priority}` : undefined,
      issue.description,
    ].filter((entry): entry is string => Boolean(entry)).join('\n'));
  }
  appendSection(lines, 'Handoff', task.handoff_note);
  appendSection(lines, 'New comment', task.trigger_comment_content);
  if (task.coalesced_comments?.length) {
    appendSection(lines, 'Earlier comments included in this run', task.coalesced_comments
      .map(comment => `- ${comment.author_name || 'Multica source'}: ${comment.content || ''}`)
      .join('\n'));
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
    chatTypes: ['channel', 'thread'], media: false, reactions: false,
    threads: true, streaming: false, promptChannelType: 'multica_work_item',
  };
  readonly config: ChannelConfigAdapter;
  readonly outbound: ChannelOutboundAdapter;
  readonly gateway: ChannelGatewayAdapter;
  readonly security: ChannelSecurityAdapter = { supportsDirectMessages: false };
  readonly prompt: ChannelPromptAdapter = {
    resolveChannelType: () => 'multica_work_item',
    resolveTaskKind: () => 'work_item',
  };

  private readonly multica: MulticaAdapterConfig;
  private readonly fetchImpl: FetchLike;
  private readonly log: MulticaAdapterLogger;
  private readonly heartbeatIntervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly intakeScreening: IntakeScreeningService | null;
  private handler: MessageHandler | null = null;
  private operatorAlertHandler: MulticaOperatorAlertHandler | null = null;
  private runtimeId: string | null = null;
  private running = false;
  private runController: AbortController | null = null;
  private pollLoopPromise: Promise<void> | null = null;
  private heartbeatLoopPromise: Promise<void> | null = null;
  private terminalFailurePromise: Promise<void> | null = null;
  private terminalError: Error | null = null;

  constructor(config: MulticaAdapterConfig, options: MulticaAdapterOptions = {}) {
    this.multica = { ...config, baseUrl: normalizeMulticaOrigin(config.baseUrl, 'Multica adapter baseUrl') };
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_MULTICA_HEARTBEAT_INTERVAL_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_MULTICA_HEARTBEAT_INTERVAL_MS;
    this.intakeScreening = options.intakeScreening ?? null;
    this.log = options.log ?? createComponentLogger('MulticaAdapter');
    this.config = { enabled: config.enabled, connectionLabel: this.multica.baseUrl };
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

  async init(): Promise<void> { await this.gateway.init(); }
  onMessage(handler: MessageHandler): void { this.handler = handler; }
  onOperatorAlert(handler: MulticaOperatorAlertHandler): void { this.operatorAlertHandler = handler; }
  async send(channelId: string, content: string): Promise<void> {
    await this.outbound.sendText({ channelId }, content);
  }

  async start(): Promise<void> {
    if (!this.multica.enabled || this.running) return;
    if (!this.handler) throw new Error('Multica adapter requires an inbound message handler before start');
    if (!this.operatorAlertHandler) throw new Error('Multica adapter requires an operator alert handler before start');
    try {
      const registration = await this.withAttempts('Multica runtime registration', async attemptSignal => (
        parseRegistrationResponse(await this.postJson('/api/daemon/register', {
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
        }, this.multica.token, attemptSignal))
      ));
      this.runtimeId = registration.id;
      await this.withAttempts('Multica orphan recovery', async attemptSignal => await this.postJson(
        `/api/daemon/runtimes/${encodeURIComponent(registration.id)}/recover-orphans`,
        {},
        this.multica.token,
        attemptSignal,
      ));
    } catch (error) {
      let startupError = asError(error);
      try {
        await this.alertOperator('startup', 'Multica channel failed to start', startupError);
      } catch (alertError) {
        this.log.error('Multica startup operator alert failed', { error: toErrorMessage(alertError) });
        startupError = combineErrors('Multica startup and operator alert failed', [startupError, alertError]);
      }
      try {
        await this.cleanupFailedStartup();
      } catch (cleanupError) {
        this.log.error('Multica failed-start runtime cleanup failed', {
          error: toErrorMessage(cleanupError),
        });
        startupError = combineErrors('Multica startup and cleanup failed', [startupError, cleanupError]);
      }
      throw startupError;
    }
    this.running = true;
    this.terminalFailurePromise = null;
    this.runController = new AbortController();
    this.pollLoopPromise = this.runPollLoop(this.runController.signal);
    this.heartbeatLoopPromise = this.runHeartbeatLoop(this.runController.signal);
  }

  async stop(): Promise<void> {
    if (!this.running && !this.runtimeId) {
      const terminalError = this.terminalError;
      this.terminalError = null;
      if (terminalError) throw terminalError;
      return;
    }
    this.running = false;
    this.runController?.abort();
    await Promise.all([this.pollLoopPromise, this.heartbeatLoopPromise]);
    this.pollLoopPromise = null;
    this.heartbeatLoopPromise = null;
    this.runController = null;
    const runtimeId = this.runtimeId;
    let stopError = this.terminalError;
    if (runtimeId) {
      try {
        await this.deregisterRuntime(runtimeId);
      } catch (error) {
        stopError = stopError
          ? combineErrors('Multica terminal failure and deregistration failed', [stopError, error])
          : asError(error);
        try {
          await this.alertOperator('deregistration', 'Multica channel failed to deregister', error);
        } catch (alertError) {
          this.log.error('Multica deregistration operator alert failed', {
            error: toErrorMessage(alertError),
          });
          stopError = combineErrors('Multica stop and operator alert failed', [stopError, alertError]);
        }
      }
    }
    this.terminalError = null;
    if (stopError) throw stopError;
  }

  private async runPollLoop(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (this.running && !signal.aborted) {
      try {
        await this.claimAndHandleOne(signal);
        failures = 0;
      } catch (error) {
        if (isAbortError(error)) break;
        failures += 1;
        this.log.error('Multica task polling failed', {
          attempt: failures, maxAttempts: MULTICA_MAX_OPERATION_ATTEMPTS, error: toErrorMessage(error),
        });
        if (failures >= MULTICA_MAX_OPERATION_ATTEMPTS) {
          await this.failRuntime('polling', error);
          return;
        }
      }
      await waitForNextPoll(this.multica.pollIntervalMs, signal);
    }
  }

  private async runHeartbeatLoop(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (this.running && !signal.aborted) {
      const runtimeId = this.runtimeId;
      if (!runtimeId) return;
      try {
        await this.postJson('/api/daemon/heartbeat', { runtime_id: runtimeId }, this.multica.token, signal);
        failures = 0;
      } catch (error) {
        if (isAbortError(error)) break;
        failures += 1;
        this.log.warn('Multica runtime heartbeat failed', {
          attempt: failures, maxAttempts: MULTICA_MAX_OPERATION_ATTEMPTS, error: toErrorMessage(error),
        });
        if (failures >= MULTICA_MAX_OPERATION_ATTEMPTS) {
          await this.failRuntime('heartbeat', error);
          return;
        }
      }
      await waitForNextPoll(this.heartbeatIntervalMs, signal);
    }
  }

  private async claimAndHandleOne(signal: AbortSignal): Promise<void> {
    const runtimeId = this.runtimeId;
    const handler = this.handler;
    if (!runtimeId || !handler) return;
    const task = parseClaimResponse(await this.postJson(
      `/api/daemon/runtimes/${encodeURIComponent(runtimeId)}/tasks/claim`, {}, this.multica.token, signal,
    ));
    if (!task) return;
    try {
      this.assertTaskBoundary(task, runtimeId);
      const issue = task.issue_id ? await this.getIssue(task.issue_id, task.auth_token, signal) : null;
      if (issue) this.assertIssueBoundary(task, issue);
      await this.withAttempts(`Multica task ${task.id} start`, async attemptSignal => await this.postJson(
        `/api/daemon/tasks/${encodeURIComponent(task.id)}/start`, {}, this.multica.token, attemptSignal,
      ), signal);
      const response = await handler(
        await this.toSubstrateMessage(task, issue),
        { signal } satisfies MessageHandlerOptions,
      );
      try {
        await this.withAttempts(`Multica task ${task.id} completion`, async attemptSignal => await this.postJson(
          `/api/daemon/tasks/${encodeURIComponent(task.id)}/complete`,
          { output: response.content }, this.multica.token, attemptSignal,
        ), signal);
      } catch (error) {
        if (!signal.aborted) await this.failRuntime('completion-settlement', error, task.id);
      }
    } catch (error) {
      if (signal.aborted) return;
      const message = toErrorMessage(error);
      this.log.error('Multica task handling failed', { taskId: task.id, error: message });
      if (error instanceof MulticaWorkspaceBoundaryError) {
        await this.failRuntime('workspace-boundary', error, task.id);
        return;
      }
      try {
        await this.withAttempts(`Multica task ${task.id} failure settlement`, async attemptSignal => await this.postJson(
          `/api/daemon/tasks/${encodeURIComponent(task.id)}/fail`,
          { error: message, failure_reason: 'psfn_gateway_companion_error' },
          this.multica.token,
          attemptSignal,
        ));
      } catch (reportError) {
        await this.failRuntime('failure-settlement', reportError, task.id);
      }
    }
  }

  private assertTaskBoundary(task: MulticaClaimedTask, runtimeId: string): void {
    if (task.runtime_id !== runtimeId) {
      throw new MulticaWorkspaceBoundaryError(
        `Multica claimed task ${task.id} for runtime ${task.runtime_id}, expected ${runtimeId}`,
      );
    }
    if (task.workspace_id !== this.multica.workspaceId) {
      throw new MulticaWorkspaceBoundaryError(
        `Multica claimed task ${task.id} for workspace ${task.workspace_id}, expected ${this.multica.workspaceId}`,
      );
    }
  }

  private assertIssueBoundary(task: MulticaClaimedTask, issue: MulticaIssue): void {
    if (issue.id !== task.issue_id) {
      throw new MulticaWorkspaceBoundaryError(
        `Multica task ${task.id} requested issue ${task.issue_id}, received ${issue.id}`,
      );
    }
    if (issue.workspace_id !== this.multica.workspaceId) {
      throw new MulticaWorkspaceBoundaryError(
        `Multica issue ${issue.id} belongs to workspace ${issue.workspace_id}, expected ${this.multica.workspaceId}`,
      );
    }
  }

  private async getIssue(issueId: string, taskToken: string | undefined, signal: AbortSignal): Promise<MulticaIssue> {
    const token = taskToken?.trim();
    if (!token) throw new Error(`Multica task for issue ${issueId} did not include a task-scoped credential`);
    return parseIssueResponse(await this.requestJson(
      `/api/issues/${encodeURIComponent(issueId)}`, { method: 'GET' }, token, signal,
    ));
  }

  private async toSubstrateMessage(task: MulticaClaimedTask, issue: MulticaIssue | null): Promise<SubstrateMessage> {
    const channelId = channelIdForTask(task);
    const screened = await screenChatMessageBody({
      content: formatTaskContent(task, issue),
      screening: this.intakeScreening,
      sourceClass: 'tool_output',
      surface: 'multica',
      channelId,
      messageId: task.id,
      channelPrivacy: 'invite_only',
      channelTopology: 'group',
    });
    return {
      id: task.id,
      channelId,
      channelType: 'multica',
      authorId: `multica:system:${task.workspace_id}`,
      authorName: 'Multica system',
      content: screened.content,
      timestamp: timestampForTask(task),
      isDirectMessage: false,
      ...(task.trigger_comment_id ? { replyToMessageId: task.trigger_comment_id } : {}),
      routing: {
        source: 'multica',
        channelPrivacy: 'invite_only',
        authorIsMachineIntelligence: true,
        ...(screened.snapshot ? { intakeEnvelopes: [screened.snapshot] } : {}),
      },
    };
  }

  private async withAttempts<T>(
    operation: string,
    action: (attemptSignal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MULTICA_MAX_OPERATION_ATTEMPTS; attempt += 1) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      try {
        return await this.withOperationTimeout(action, signal);
      } catch (error) {
        if (isAbortError(error) || signal?.aborted) throw error;
        lastError = error;
        if (attempt < MULTICA_MAX_OPERATION_ATTEMPTS) {
          this.log.warn(`${operation} failed; retrying`, {
            attempt, maxAttempts: MULTICA_MAX_OPERATION_ATTEMPTS, error: toErrorMessage(error),
          });
        }
      }
    }
    throw new Error(`${operation} failed after ${MULTICA_MAX_OPERATION_ATTEMPTS} attempts: ${toErrorMessage(lastError)}`);
  }

  private async failRuntime(kind: string, error: unknown, taskId?: string): Promise<void> {
    this.terminalFailurePromise ??= this.terminateRuntime(kind, error, taskId);
    await this.terminalFailurePromise;
  }

  private async terminateRuntime(kind: string, error: unknown, taskId?: string): Promise<void> {
    this.running = false;
    this.runController?.abort();
    this.log.error('Multica channel runtime stopped after bounded failures', {
      kind, ...(taskId ? { taskId } : {}), error: toErrorMessage(error),
    });
    let terminalError = asError(error);
    try {
      await this.alertOperator(kind, 'Multica channel stopped', terminalError, taskId);
    } catch (alertError) {
      this.log.error('Multica terminal operator alert failed', {
        kind, error: toErrorMessage(alertError),
      });
      terminalError = combineErrors('Multica runtime and operator alert failed', [terminalError, alertError]);
    }
    const runtimeId = this.runtimeId;
    if (!runtimeId) {
      this.terminalError = terminalError;
      return;
    }
    try {
      await this.deregisterRuntime(runtimeId);
    } catch (deregisterError) {
      this.log.error('Multica runtime deregistration failed after channel stop', {
        runtimeId, error: toErrorMessage(deregisterError),
      });
      terminalError = combineErrors('Multica runtime and deregistration failed', [
        terminalError,
        deregisterError,
      ]);
      try {
        await this.alertOperator(
          'deregistration',
          'Multica runtime could not deregister',
          deregisterError,
        );
      } catch (alertError) {
        this.log.error('Multica deregistration operator alert failed', {
          error: toErrorMessage(alertError),
        });
        terminalError = combineErrors('Multica runtime alerts failed', [terminalError, alertError]);
      }
    }
    this.terminalError = terminalError;
  }

  private async cleanupFailedStartup(): Promise<void> {
    const runtimeId = this.runtimeId;
    if (!runtimeId) return;
    await this.deregisterRuntime(runtimeId);
  }

  private async deregisterRuntime(runtimeId: string): Promise<void> {
    await this.withAttempts(
      `Multica runtime ${runtimeId} deregistration`,
      async attemptSignal => await this.postJson(
        '/api/daemon/deregister',
        { runtime_ids: [runtimeId] },
        this.multica.token,
        attemptSignal,
      ),
    );
    if (this.runtimeId === runtimeId) this.runtimeId = null;
  }

  private async alertOperator(kind: string, title: string, error: unknown, taskId?: string): Promise<void> {
    const handler = this.operatorAlertHandler;
    if (!handler) {
      throw new Error(`Multica operator alert handler is unavailable for ${kind}`);
    }
    const disposition = kind === 'workspace-boundary'
      ? 'The crossed work item was rejected before companion ingress.'
      : `The channel stopped after ${MULTICA_MAX_OPERATION_ATTEMPTS} attempts and will not claim more work.`;
    await this.withAttempts(`Multica ${kind} operator alert`, async () => await handler({
      title,
      message: [
        `Multica gateway channel failure (${kind})${taskId ? ` for task ${taskId}` : ''}.`,
        toErrorMessage(error),
        disposition,
      ].join('\n'),
      idempotencyKey: `multica-channel:${this.multica.workspaceId}:${kind}${taskId ? `:${taskId}` : ''}`,
    }));
  }

  private async withOperationTimeout<T>(
    action: (signal: AbortSignal) => Promise<T>,
    parentSignal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    const signal = parentSignal
      ? AbortSignal.any([parentSignal, controller.signal])
      : controller.signal;
    let timeout: NodeJS.Timeout | undefined;
    const abortPromise = new Promise<never>((_resolve, reject) => {
      const rejectForAbort = (): void => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      if (signal.aborted) {
        rejectForAbort();
        return;
      }
      signal.addEventListener('abort', rejectForAbort, { once: true });
    });
    try {
      timeout = setTimeout(() => {
        controller.abort(new Error('Multica operation timed out'));
      }, this.requestTimeoutMs);
      timeout.unref();
      return await Promise.race([
        action(signal),
        abortPromise,
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (!controller.signal.aborted) controller.abort();
    }
  }

  private async postJson(
    path: string,
    body: Record<string, unknown>,
    token = this.multica.token,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return await this.requestJson(path, { method: 'POST', body: JSON.stringify(body) }, token, signal);
  }

  private async requestJson(path: string, init: RequestInit, token: string, signal?: AbortSignal): Promise<unknown> {
    return await this.withOperationTimeout(async requestSignal => {
      const response = await this.fetchImpl(
        new URL(path, `${this.multica.baseUrl}/`),
        {
          ...init,
          signal: requestSignal,
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${token}`,
            ...(init.body ? { 'content-type': 'application/json' } : {}),
          },
        },
      );
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
    }, signal);
  }
}
