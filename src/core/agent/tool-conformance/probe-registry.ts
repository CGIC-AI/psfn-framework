// ── Tool-surface conformance probe registry ──
//
// Every canonical first-party tool MUST appear here, classified as either:
//   - read_only : a genuinely side-effect-free action (list / status / census /
//     read) that the harness invokes directly against the tool handler.
//   - schema_only: no safe read-only action exists for a hermetic smoke, so the
//     harness validates only that the parameter schema is well-formed and never
//     invokes the handler.
//
// NEVER classify a mutating action (write / create / send / delete / restart /
// exec / spawn / generate) as read_only.
//
// Classification rule of thumb:
//   - internal runtime state surfaces (memory, session, contact, orient,
//     identity, skill, wiki, schedule, north_star, scratchpad, journal,
//     toolset, tool_search, self_status) → read_only.
//   - boundary/external/side-effecting surfaces (fs, repo, shell, web,
//     analysis_workbench sandbox, notify, generate_image, selfie_create, subagent,
//     beads, world, response_control) → schema_only. Their only "read"
//     actions depend on a live gateway, external processes, or arguments that
//     do not belong in a hermetic handler smoke, and several have no read
//     action at all.
//   - the optional vault surface is the deliberate external exception: when it
//     is live, a bounded no-match search verifies the gateway/Obsidian bridge
//     without requiring a pre-existing note or mutating the vault.
//
// The static coverage test (probe-registry.test.ts) fails when a canonical tool
// is added without a classification here, and the runtime harness fails closed
// when a LIVE tool has no entry.

export interface ReadOnlyToolProbeSpec {
  kind: 'read_only';
  /** Optional action label recorded on the result; also the dispatched action. */
  action?: string;
  /** Exact, safe arguments passed to tool.execute. Must not mutate. */
  args: Record<string, unknown>;
}

export interface SchemaOnlyToolProbeSpec {
  kind: 'schema_only';
}

export type ToolProbeSpec = ReadOnlyToolProbeSpec | SchemaOnlyToolProbeSpec;

export const TOOL_CONFORMANCE_PROBE_REGISTRY: Readonly<Record<string, ToolProbeSpec>> = {
  // ── Adaptive tooling ──
  tool_search: { kind: 'read_only', action: 'search', args: { action: 'search', query: 'status' } },
  toolset: { kind: 'read_only', action: 'list', args: { action: 'list' } },

  // ── System / orientation / identity ──
  self_status: { kind: 'read_only', args: { recentChannelLimit: 1 } },
  // system.read shares a surface with restart/rebuild and its read semantics
  // depend on a settings key we cannot safely assume here; validate schema only.
  // The required-action rejection_check still covers system.
  system: { kind: 'schema_only' },
  orient: { kind: 'read_only', action: 'list_concerns', args: { action: 'list_concerns' } },
  identity: { kind: 'read_only', action: 'list_layers', args: { action: 'list_layers' } },

  // ── Memory family ──
  memory: {
    kind: 'read_only',
    action: 'census',
    // census runs context-free in admin/post-rollout sweeps, so the probe
    // supplies the channel scope explicitly (found live by Purrsephone:
    // the request-context fallback is absent outside a chat turn).
    args: {
      action: 'census',
      channel_id: 'internal:tool-conformance',
      trust_level: 'primary',
      channel_visibility: 'private',
    },
  },
  scratchpad: { kind: 'read_only', action: 'list', args: { action: 'list' } },
  journal: { kind: 'read_only', action: 'list', args: { action: 'list' } },

  // ── Continuity / contacts ──
  session: { kind: 'read_only', action: 'list', args: { action: 'list' } },
  contact: { kind: 'read_only', action: 'list', args: { action: 'list' } },

  // ── Knowledge / scheduling / orientation-extended ──
  skill: { kind: 'read_only', action: 'list', args: { action: 'list' } },
  wiki: { kind: 'read_only', action: 'list', args: { action: 'list' } },
  schedule: { kind: 'read_only', action: 'list', args: { action: 'list' } },
  north_star: { kind: 'read_only', action: 'list', args: { action: 'list' } },

  // ── Boundary / external / side-effecting → schema-only ──
  fs: { kind: 'schema_only' },
  repo: { kind: 'schema_only' },
  shell: { kind: 'schema_only' },
  web: { kind: 'schema_only' },
  mcp: { kind: 'schema_only' },
  analysis_workbench: { kind: 'schema_only' },
  response_control: { kind: 'schema_only' },
  notify: { kind: 'schema_only' },
  generate_image: { kind: 'schema_only' },
  selfie_create: { kind: 'schema_only' },
  // publication submits/revises share candidates onto the operator approval queue
  // (mutating, gated by Operator approval) and its status read requires a live,
  // wired approval-queue port that fails closed in partial runtimes — no hermetic
  // read-only probe exists, so validate schema only.
  publication: { kind: 'schema_only' },
  subagent: { kind: 'schema_only' },
  vault: {
    kind: 'read_only',
    action: 'search',
    args: {
      action: 'search',
      query: '__psfn_tool_conformance_no_match__',
      limit: 1,
    },
  },
  beads: { kind: 'schema_only' },
  // world's read actions (perceive/list) require live gateway ops against the
  // Home Assistant places registry, and move/control mutate world state, so no
  // hermetic read-only probe exists.
  world: { kind: 'schema_only' },
};

export function getToolProbeSpec(toolName: string): ToolProbeSpec | undefined {
  return Object.prototype.hasOwnProperty.call(TOOL_CONFORMANCE_PROBE_REGISTRY, toolName)
    ? TOOL_CONFORMANCE_PROBE_REGISTRY[toolName]
    : undefined;
}

// ── Per-action extended coverage (bead 65rk.7) ──────────────────────────────
//
// The registry above probes ONE action per tool. The per-action registry below
// classifies EVERY canonical action of every action-aware tool into exactly one
// of three kinds. The static coverage test (probe-registry.test.ts) fails closed
// when a new verb is added to a canonical surface without a classification here,
// and the extended sweep fails closed at runtime on the same gap.
//
//   - safe_read       : a genuinely side-effect-free read the harness invokes
//     directly (list / census / snapshot / read-of-all). `args` MUST NOT mutate
//     and MUST carry the isolated channel scope where the handler needs one.
//   - scoped_mutation : a reversible mutation that runs ONLY when the caller
//     passes the isolated-scope flag. It executes against the
//     internal:tool-conformance channel and MUST supply a `cleanup` teardown so
//     the sweep leaves no residue. Default (unflagged) runs record it skipped and
//     never execute it. No canonical first-party action is currently classified
//     scoped_mutation: every real mutation is withheld as schema_assert until a
//     per-tool reversibility audit certifies a safe isolated-channel teardown.
//     The kind, its execution path, and its cleanup/gate machinery are fully
//     implemented and tested so a certified verb can adopt it without new wiring.
//   - schema_assert   : no safe hermetic invocation exists (mutation, external
//     send, live-gateway read, restart/rebuild, or the conformance action itself
//     which would recurse). The handler is NEVER invoked; only its parameter
//     schema is validated.

export const TOOL_CONFORMANCE_INTERNAL_CHANNEL = 'internal:tool-conformance';

const READ_CHANNEL_SCOPE = {
  channel_id: TOOL_CONFORMANCE_INTERNAL_CHANNEL,
  trust_level: 'primary',
  channel_visibility: 'private',
} as const;

export type ActionProbeClassification = 'safe_read' | 'scoped_mutation' | 'schema_assert';

export interface SafeReadActionProbe {
  kind: 'safe_read';
  /** Exact, side-effect-free arguments passed to tool.execute (includes `action`). */
  args: Record<string, unknown>;
}

export interface SchemaAssertActionProbe {
  kind: 'schema_assert';
}

/**
 * How a scoped_mutation handler is guaranteed to STOP when the harness cancels a
 * timed-out mutation. Registration of a scoped_mutation without a valid contract
 * is rejected (the harness never runs teardown against a mutation it cannot prove
 * has terminated). Bead 65rk.7 fix for the latent teardown race.
 *   - abort_signal : the handler observes the AbortSignal threaded into
 *     tool.execute and settles (resolve/reject) promptly once it is aborted.
 *   - transaction  : the mutation runs inside a transaction the cleanup rolls
 *     back atomically, so a timed-out mutation cannot durably commit.
 */
export type ScopedMutationCancellation =
  | { kind: 'abort_signal' }
  | { kind: 'transaction' };

export interface ScopedMutationActionProbe {
  kind: 'scoped_mutation';
  /** Mutation arguments, scoped to the internal:tool-conformance channel. */
  args: Record<string, unknown>;
  /**
   * Cancellation contract the handler MUST honor. The harness aborts a timed-out
   * mutation and waits for confirmed settlement before it runs teardown; a
   * handler that neither settles on abort nor rolls back is a `mutation_uncancellable`
   * failure and its cleanup is withheld.
   */
  cancellation: ScopedMutationCancellation;
  /**
   * Teardown that reverses the mutation. Executed after the mutation has
   * TERMINATED (settled normally, or aborted-and-settled within grace). A failed
   * teardown is a conformance failure (`cleanup_failed`) — fail closed, never
   * leave residue.
   */
  cleanup: { args: Record<string, unknown> };
}

export type ActionProbeSpec = SafeReadActionProbe | ScopedMutationActionProbe | SchemaAssertActionProbe;

function safeRead(args: Record<string, unknown>): SafeReadActionProbe {
  return { kind: 'safe_read', args };
}

const SCHEMA_ASSERT: SchemaAssertActionProbe = { kind: 'schema_assert' };

/**
 * Classify one canonical action into safe_read / scoped_mutation / schema_assert.
 * Every action listed on a canonical tool surface (tool-surface/registry.ts)
 * MUST have an entry here. Tools with no `actions` array carry no entry.
 */
export const TOOL_CONFORMANCE_ACTION_REGISTRY:
  Readonly<Record<string, Readonly<Record<string, ActionProbeSpec>>>> = {
  toolset: {
    list: safeRead({ action: 'list' }),
    suggest: SCHEMA_ASSERT,
    describe: SCHEMA_ASSERT,
    pin: SCHEMA_ASSERT,
    unpin: SCHEMA_ASSERT,
  },
  response_control: {
    no_reply: SCHEMA_ASSERT,
  },
  fs: {
    read: SCHEMA_ASSERT,
    list: SCHEMA_ASSERT,
    search: SCHEMA_ASSERT,
    write: SCHEMA_ASSERT,
    edit: SCHEMA_ASSERT,
  },
  repo: {
    inspect: SCHEMA_ASSERT,
    patch: SCHEMA_ASSERT,
    commit: SCHEMA_ASSERT,
    branch: SCHEMA_ASSERT,
    publish: SCHEMA_ASSERT,
  },
  shell: {
    exec: SCHEMA_ASSERT,
  },
  web: {
    fetch: SCHEMA_ASSERT,
    browse: SCHEMA_ASSERT,
    search: SCHEMA_ASSERT,
  },
  mcp: {
    catalog: SCHEMA_ASSERT,
    search: SCHEMA_ASSERT,
    inspect: SCHEMA_ASSERT,
    call: SCHEMA_ASSERT,
    release: SCHEMA_ASSERT,
  },
  world: {
    perceive: SCHEMA_ASSERT,
    list: SCHEMA_ASSERT,
    control: SCHEMA_ASSERT,
    move: SCHEMA_ASSERT,
  },
  orient: {
    append: SCHEMA_ASSERT,
    replace: SCHEMA_ASSERT,
    reorient: SCHEMA_ASSERT,
    values_list: safeRead({ action: 'values_list' }),
    values_add: SCHEMA_ASSERT,
    values_update: SCHEMA_ASSERT,
    create_concern: SCHEMA_ASSERT,
    list_concerns: safeRead({ action: 'list_concerns' }),
    resolve_concern: SCHEMA_ASSERT,
    transition_concern: SCHEMA_ASSERT,
    introspection_consent_get: safeRead({ action: 'introspection_consent_get' }),
    introspection_consent_set: SCHEMA_ASSERT,
    introspection_turn_sensitivity_set: SCHEMA_ASSERT,
  },
  identity: {
    list_layers: safeRead({ action: 'list_layers' }),
    get_layer: SCHEMA_ASSERT,
    diff_layer: SCHEMA_ASSERT,
    history: SCHEMA_ASSERT,
    update_layer: SCHEMA_ASSERT,
    rollback_layer: SCHEMA_ASSERT,
    toggle_layer: SCHEMA_ASSERT,
    update_persona: SCHEMA_ASSERT,
    commit_stage: SCHEMA_ASSERT,
    cancel_stage: SCHEMA_ASSERT,
  },
  memory: {
    // census runs context-free with an explicit channel scope (see the per-tool
    // registry note above). All memory mutations are withheld.
    census: safeRead({ action: 'census', ...READ_CHANNEL_SCOPE }),
    write: SCHEMA_ASSERT,
    search: SCHEMA_ASSERT,
    episode_search: SCHEMA_ASSERT,
    get: SCHEMA_ASSERT,
    shared_background: SCHEMA_ASSERT,
    exists: SCHEMA_ASSERT,
    timeline: SCHEMA_ASSERT,
    import: SCHEMA_ASSERT,
    patch: SCHEMA_ASSERT,
    redact: SCHEMA_ASSERT,
    delete: SCHEMA_ASSERT,
    restore: SCHEMA_ASSERT,
  },
  scratchpad: {
    list: safeRead({ action: 'list' }),
    add: SCHEMA_ASSERT,
    replace: SCHEMA_ASSERT,
    append: SCHEMA_ASSERT,
    remove: SCHEMA_ASSERT,
  },
  contact: {
    list: safeRead({ action: 'list' }),
    search: SCHEMA_ASSERT,
    lookup: SCHEMA_ASSERT,
    note: SCHEMA_ASSERT,
    set_trust: SCHEMA_ASSERT,
    propose_trust: SCHEMA_ASSERT,
    set_relationship: SCHEMA_ASSERT,
    propose_relationship: SCHEMA_ASSERT,
    link_identity: SCHEMA_ASSERT,
    set_channel_privacy: SCHEMA_ASSERT,
    set_machine_intelligence: SCHEMA_ASSERT,
    block: SCHEMA_ASSERT,
    unblock: SCHEMA_ASSERT,
  },
  session: {
    list: safeRead({ action: 'list' }),
    new: SCHEMA_ASSERT,
    resume: SCHEMA_ASSERT,
    search: SCHEMA_ASSERT,
    grep: SCHEMA_ASSERT,
    wake_return: SCHEMA_ASSERT,
    start_focus: SCHEMA_ASSERT,
    complete_focus: SCHEMA_ASSERT,
  },
  self_status: {
    capabilities: safeRead({ action: 'capabilities' }),
    snapshot: safeRead({ action: 'snapshot', recentChannelLimit: 1 }),
    diagnose: SCHEMA_ASSERT,
    logs: SCHEMA_ASSERT,
    // Invoking `conformance` inside the conformance sweep would recurse; withhold.
    conformance: SCHEMA_ASSERT,
    availability_read: SCHEMA_ASSERT,
    availability_publish: SCHEMA_ASSERT,
    availability_clear: SCHEMA_ASSERT,
    availability_list_peers: SCHEMA_ASSERT,
  },
  system: {
    // read depends on a settings key we cannot safely assume; restart/rebuild are
    // never behaviorally probed.
    read: SCHEMA_ASSERT,
    restart: SCHEMA_ASSERT,
    rebuild: SCHEMA_ASSERT,
  },
  skill: {
    list: safeRead({ action: 'list' }),
    view: SCHEMA_ASSERT,
    stats: SCHEMA_ASSERT,
    create: SCHEMA_ASSERT,
    update: SCHEMA_ASSERT,
    // 9xe2n governance surface: history reads a named skill's journal (args
    // not safely assumable), rollback is destructive — schema-only, like the
    // other write actions.
    history: SCHEMA_ASSERT,
    rollback: SCHEMA_ASSERT,
  },
  wiki: {
    list: safeRead({ action: 'list' }),
    read: SCHEMA_ASSERT,
    search: SCHEMA_ASSERT,
    semantic_search: SCHEMA_ASSERT,
    write: SCHEMA_ASSERT,
    import: SCHEMA_ASSERT,
    propose_shared_world: SCHEMA_ASSERT,
    wish_list: safeRead({ action: 'wish_list' }),
    wish_read: SCHEMA_ASSERT,
    wish_create: SCHEMA_ASSERT,
    project_list: safeRead({ action: 'project_list' }),
    project_read: SCHEMA_ASSERT,
    project_create: SCHEMA_ASSERT,
    project_update: SCHEMA_ASSERT,
    project_add_artifact: SCHEMA_ASSERT,
    project_share: SCHEMA_ASSERT,
    wardrobe_list: safeRead({ action: 'wardrobe_list' }),
    wardrobe_read: SCHEMA_ASSERT,
    wardrobe_save: SCHEMA_ASSERT,
    wardrobe_revise: SCHEMA_ASSERT,
  },
  schedule: {
    list: safeRead({ action: 'list' }),
    create_follow_up: SCHEMA_ASSERT,
    activate_follow_up: SCHEMA_ASSERT,
    create_reminder: SCHEMA_ASSERT,
    trigger_reminder: SCHEMA_ASSERT,
    list_templates: safeRead({ action: 'list_templates' }),
    update_template: SCHEMA_ASSERT,
    run_template: SCHEMA_ASSERT,
    schedule_prompt: SCHEMA_ASSERT,
  },
  north_star: {
    list: safeRead({ action: 'list' }),
    create: SCHEMA_ASSERT,
    update: SCHEMA_ASSERT,
    delete: SCHEMA_ASSERT,
    reorder: SCHEMA_ASSERT,
  },
  beads: {
    ready: SCHEMA_ASSERT,
    show: SCHEMA_ASSERT,
    create: SCHEMA_ASSERT,
    update: SCHEMA_ASSERT,
    close: SCHEMA_ASSERT,
    sync: SCHEMA_ASSERT,
  },
  notify: {
    brief: SCHEMA_ASSERT,
    send: SCHEMA_ASSERT,
    consider: SCHEMA_ASSERT,
    approval_request: SCHEMA_ASSERT,
    clarify: SCHEMA_ASSERT,
  },
  generate_image: {
    generate: SCHEMA_ASSERT,
    edit: SCHEMA_ASSERT,
    analyze: SCHEMA_ASSERT,
  },
  publication: {
    // submit/revise enqueue a fresh share candidate onto the operator approval
    // queue — mutations, gated by Operator approval, never hermetically invocable.
    submit: SCHEMA_ASSERT,
    revise: SCHEMA_ASSERT,
    // status is conceptually read-only but requires a live, wired approval-queue
    // port; the tool fails closed when that port is unwired (partial runtimes),
    // so no safe hermetic read exists — assert schema only.
    status: SCHEMA_ASSERT,
  },
  subagent: {
    spawn: SCHEMA_ASSERT,
    message: SCHEMA_ASSERT,
    wait: SCHEMA_ASSERT,
    cancel: SCHEMA_ASSERT,
    status: SCHEMA_ASSERT,
  },
  vault: {
    write: SCHEMA_ASSERT,
    read: SCHEMA_ASSERT,
    search: safeRead({
      action: 'search',
      query: '__psfn_tool_conformance_no_match__',
      limit: 1,
    }),
    daily: SCHEMA_ASSERT,
  },
  journal: {
    list: safeRead({ action: 'list' }),
    read: SCHEMA_ASSERT,
    write: SCHEMA_ASSERT,
    append: SCHEMA_ASSERT,
    search: SCHEMA_ASSERT,
  },
};

export function getActionProbeSpec(toolName: string, action: string): ActionProbeSpec | undefined {
  const actions = Object.prototype.hasOwnProperty.call(TOOL_CONFORMANCE_ACTION_REGISTRY, toolName)
    ? TOOL_CONFORMANCE_ACTION_REGISTRY[toolName]
    : undefined;
  if (!actions) return undefined;
  return Object.prototype.hasOwnProperty.call(actions, action) ? actions[action] : undefined;
}

export function getToolActionProbes(toolName: string): Readonly<Record<string, ActionProbeSpec>> | undefined {
  return Object.prototype.hasOwnProperty.call(TOOL_CONFORMANCE_ACTION_REGISTRY, toolName)
    ? TOOL_CONFORMANCE_ACTION_REGISTRY[toolName]
    : undefined;
}
