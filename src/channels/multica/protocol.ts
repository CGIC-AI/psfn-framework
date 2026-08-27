import { isRecord, isRfc4122Uuid } from '../../shared/utils/types.js';

export interface MulticaRuntimeRegistration {
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

export interface MulticaClaimedTask {
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
  initiator_type?: 'member' | 'agent';
  initiator_id?: string;
  initiator_name?: string;
  auth_token?: string;
  agent?: MulticaTaskAgent;
}

export interface MulticaIssue {
  id: string;
  workspace_id: string;
  identifier?: string;
  title?: string;
  description?: string;
  status?: string;
  priority?: string;
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

export function parseRegistrationResponse(value: unknown, provider: string): MulticaRuntimeRegistration {
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
  const runtime = runtimes.find(entry => entry.provider === provider);
  if (!runtime) throw new Error(`Multica registration response did not contain the ${provider} runtime`);
  return runtime;
}

export function parseClaimResponse(value: unknown): MulticaClaimedTask | null {
  if (!isRecord(value) || !Object.hasOwn(value, 'task')) {
    throw new Error('Multica claim response must contain task');
  }
  if (value.task === null) return null;
  if (!isRecord(value.task)) {
    throw new Error('Multica claim response task must be an object or null');
  }
  const task = value.task;
  const read = (field: string): string | undefined => optionalString(task[field], `task.${field}`);
  const optionalStrings = {
    issue_id: read('issue_id'),
    kind: read('kind'),
    created_at: read('created_at'),
    project_title: read('project_title'),
    project_description: read('project_description'),
    squad_name: read('squad_name'),
    handoff_note: read('handoff_note'),
    trigger_comment_id: read('trigger_comment_id'),
    trigger_comment_content: read('trigger_comment_content'),
    chat_session_id: read('chat_session_id'),
    chat_message: read('chat_message'),
    autopilot_run_id: read('autopilot_run_id'),
    autopilot_title: read('autopilot_title'),
    autopilot_description: read('autopilot_description'),
    quick_create_prompt: read('quick_create_prompt'),
    initiator_name: read('initiator_name'),
    auth_token: read('auth_token'),
  };
  const definedStrings = Object.fromEntries(
    Object.entries(optionalStrings).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
  const isLeaderTask = optionalBoolean(task.is_leader_task, 'task.is_leader_task');
  const leaderRoleResolved = optionalBoolean(task.leader_role_resolved, 'task.leader_role_resolved');
  const comments = parseCoalescedComments(task.coalesced_comments);
  const agent = parseTaskAgent(task.agent);
  const initiatorType = read('initiator_type');
  const initiatorId = read('initiator_id');
  if ((initiatorType === undefined) !== (initiatorId === undefined)) {
    throw new Error('Multica response fields task.initiator_type and task.initiator_id must be provided together');
  }
  if (initiatorType !== undefined && initiatorType !== 'member' && initiatorType !== 'agent') {
    throw new Error('Multica response field task.initiator_type must be member or agent');
  }
  if (initiatorId !== undefined && !isRfc4122Uuid(initiatorId)) {
    throw new Error('Multica response field task.initiator_id must be a lowercase RFC-4122 UUID');
  }
  return {
    id: requiredString(task.id, 'task.id'),
    runtime_id: requiredString(task.runtime_id, 'task.runtime_id'),
    workspace_id: requiredString(task.workspace_id, 'task.workspace_id'),
    ...definedStrings,
    ...(isLeaderTask === undefined ? {} : { is_leader_task: isLeaderTask }),
    ...(leaderRoleResolved === undefined ? {} : { leader_role_resolved: leaderRoleResolved }),
    ...(initiatorType && initiatorId
      ? { initiator_type: initiatorType, initiator_id: initiatorId }
      : {}),
    ...(comments ? { coalesced_comments: comments } : {}),
    ...(agent ? { agent } : {}),
  };
}

export function parseIssueResponse(value: unknown): MulticaIssue {
  if (!isRecord(value)) throw new Error('Multica issue response must be an object');
  const optionalFields = {
    identifier: optionalString(value.identifier, 'issue.identifier'),
    title: optionalString(value.title, 'issue.title'),
    description: optionalString(value.description, 'issue.description'),
    status: optionalString(value.status, 'issue.status'),
    priority: optionalString(value.priority, 'issue.priority'),
  };
  const definedFields = Object.fromEntries(
    Object.entries(optionalFields).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
  return {
    id: requiredString(value.id, 'issue.id'),
    workspace_id: requiredString(value.workspace_id, 'issue.workspace_id'),
    ...definedFields,
  };
}

export function parseTaskStatusResponse(value: unknown): string {
  if (!isRecord(value)) throw new Error('Multica task status response must be an object');
  return requiredString(value.status, 'task.status').toLowerCase();
}

export function isTerminalTaskStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
