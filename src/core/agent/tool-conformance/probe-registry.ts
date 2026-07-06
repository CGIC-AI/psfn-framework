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
//     analysis_workbench sandbox, notify, media, selfie_create, subagent,
//     shard, vault, beads, response_control) → schema_only. Their only "read"
//     actions depend on a live gateway, external processes, or arguments that
//     do not belong in a hermetic handler smoke, and several have no read
//     action at all.
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
  memory: { kind: 'read_only', action: 'census', args: { action: 'census' } },
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
  analysis_workbench: { kind: 'schema_only' },
  response_control: { kind: 'schema_only' },
  notify: { kind: 'schema_only' },
  media: { kind: 'schema_only' },
  selfie_create: { kind: 'schema_only' },
  subagent: { kind: 'schema_only' },
  shard: { kind: 'schema_only' },
  vault: { kind: 'schema_only' },
  beads: { kind: 'schema_only' },
};

export function getToolProbeSpec(toolName: string): ToolProbeSpec | undefined {
  return Object.prototype.hasOwnProperty.call(TOOL_CONFORMANCE_PROBE_REGISTRY, toolName)
    ? TOOL_CONFORMANCE_PROBE_REGISTRY[toolName]
    : undefined;
}
