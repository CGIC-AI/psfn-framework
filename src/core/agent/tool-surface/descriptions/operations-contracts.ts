import { action, type CanonicalToolSurfaceContract } from './contracts.js';

export const OPERATIONS_TOOL_CONTRACTS = {
  self_status: {
    purpose: 'Read bounded runtime state and manage this companion\'s coarse availability lease.',
    actions: [
      action('snapshot', [], ['recentChannelLimit']), action('diagnose'),
      action('logs', [], ['windowMs', 'sinceMs', 'limit', 'includeFileLogs']), action('conformance'),
      action('availability_read'), action('availability_publish', ['state', 'expires_at_ms', 'revision']),
      action('availability_clear', ['expected_revision']), action('availability_list_peers'),
    ],
    output: 'It returns bounded operational or already-known peer state and never returns message content or lifecycle controls.',
    guidance: 'Do not use it to change settings, restart, or rebuild; use system.',
    example: { action: 'snapshot', recentChannelLimit: 3 },
  },
  system: {
    purpose: 'Read safe runtime settings and request guarded lifecycle operations; under Kubernetes it also reports deployment mode and routes restart/rebuild through the approval-gated kube pipeline.',
    actions: [
      action('read', [], ['key', 'keys', 'list']),
      action('restart', ['reason']), action('rebuild', ['reason']),
    ],
    output: 'It returns settings (plus kube deployment status when applicable) or a lifecycle acknowledgement; on Kubernetes restart requires operator approval and rebuild refuses in-pod builds, and it never bypasses supervisor safeguards.',
    guidance: 'Do not use it for diagnosis; use self_status.',
    example: { action: 'read', list: true },
  },
  skill: {
    purpose: 'Discover, inspect, measure, and author reusable workflow guidance.',
    actions: [
      action('list', [], ['includeSkipped', 'includeContent']), action('view', ['name']),
      action('stats', [], ['name']), action('create', ['name', 'category', 'content'], ['description']),
      action('update', ['name', 'content'], ['description']),
    ],
    output: 'It returns managed skill metadata and writes only personal skills; it never executes the skill body.',
    guidance: 'Do not use skills as executable capabilities or durable reference documents; use a tool or wiki.',
    example: { action: 'view', name: 'incident-response' },
  },
  wiki: {
    purpose: 'Manage runtime-owned durable reference documents and personal knowledge notes.',
    actions: [
      action('list'), action('read', ['id']), action('search', ['query'], ['limit']),
      action('semantic_search', ['query'], ['limit']),
      action('write', ['title', 'body'], ['id', 'tags', 'source_class', 'provenance_refs', 'sensitivity', 'summary']),
      action('import', ['title', 'body', 'source_class', 'provenance_refs'], ['id', 'tags', 'sensitivity', 'summary']),
      action('propose_shared_world', ['site_id', 'title', 'body', 'source_ref', 'provenance_refs', 'sensitivity'], ['id', 'tags']),
    ],
    output: 'It returns documents or matches, writes personal provenance-bearing reference material, or queues a public shared-world proposal for operator review; semantic search fails closed when unwired.',
    guidance: 'Do not use wiki for lived memory or journal reflection; use memory or journal. A shared-world proposal never publishes directly.',
    example: { action: 'search', query: 'greenhouse watering protocol' },
  },
  schedule: {
    purpose: 'Manage durable follow-ups, reminders, heartbeat templates, and one-shot scheduled prompts.',
    actions: [
      action('list', [], ['limit', 'contact_id', 'include_activated', 'include_completed', 'include_dismissed']),
      action('create_follow_up', ['content', 'channel_id', 'channel_type'], ['priority', 'timing', 'due_at', 'contact_id', 'source_message_id', 'context_summary', 'wake_conditions']),
      action('activate_follow_up', ['follow_up_id'], ['activation_reason']),
      action('create_reminder', ['title', 'content', 'due_at', 'channel_id', 'channel_type'], ['kind', 'classification', 'reminder_schedule', 'reason', 'contact_id', 'source_message_id']),
      action('trigger_reminder', ['reminder_id']), action('list_templates'),
      action('update_template', [], ['name', 'prompt', 'interval_ms', 'enabled', 'send_to_discord', 'internal_state_input', 'mode', 'deliberation'], {
        id: 'update_template', requiredAnyOf: [['template_id'], ['id', 'name', 'prompt', 'interval_ms']],
        rule: 'template_id updates an existing template; the id branch creates a new template',
      }),
      action('run_template', ['template_id'], ['send_to_discord', 'defer_if_busy']),
      action('schedule_prompt', ['name', 'prompt'], [], { id: 'schedule_prompt', requiredAnyOf: [['delay_minutes'], ['run_at']], rule: 'supply exactly one timing field' }),
    ],
    output: 'It returns durable identifiers or run state and does not replace untimed orient concerns.',
    guidance: 'Do not invent registry-category verbs; only the concrete actions above are callable.',
    example: { action: 'schedule_prompt', name: 'check seedlings', prompt: 'Review the greenhouse notes.', delay_minutes: 60 },
  },
  north_star: {
    purpose: 'Maintain a small ordered set of long-horizon guiding intentions.',
    actions: [
      action('list'), action('create', ['title', 'content'], ['scope', 'enabled']),
      action('update', ['item_id'], ['title', 'content', 'scope', 'enabled'], { id: 'update', rule: 'include at least one changed field' }),
      action('delete', ['item_id']), action('reorder', ['item_ids']),
    ],
    output: 'It returns exact item IDs and ordered state.',
    guidance: 'Do not use it for current concerns or persona changes; use orient or identity.',
    example: { action: 'create', title: 'Protect time for art', content: 'Keep a weekly block for self-directed drawing.' },
  },
  beads: {
    purpose: 'Read and update the canonical tracked-work database when work must survive the current conversation.',
    actions: [
      action('ready', [], ['limit']), action('show', ['id']),
      action('create', ['title'], ['issue_type', 'priority', 'deps', 'parent', 'actor']),
      action('update', ['id'], ['status', 'priority', 'actor'], { id: 'update', rule: 'include status or priority' }),
      action('close', ['id', 'reason'], ['actor']), action('sync'),
    ],
    output: 'It returns plain issue IDs and structured tracker state; later calls require the exact ID string.',
    guidance: 'Do not create throwaway tracked work for temporary notes; use scratchpad.',
    example: { action: 'show', id: 'psfn-framework-123' },
  },
} as const satisfies Record<string, CanonicalToolSurfaceContract>;
