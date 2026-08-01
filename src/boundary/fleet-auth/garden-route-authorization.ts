import type { FleetAuthAction } from '../../system/config/fleet-auth-config.js';
import {
  FLEET_AUTH_ACTION_BASE_ROLE,
  type FleetAuthBaseRole,
} from './role-action-policy.js';
import type {
  GardenForwardMethod,
  GardenResourceArea,
  GardenWorkspaceScope,
} from './garden-route-types.js';

export type GardenSubjectRelation =
  | 'none'
  | 'current_companion'
  | 'self'
  | 'self_or_co_subject';

/**
 * Assurance tiers under the Discord-SSO-only doctrine (operator rulings D1/D2,
 * 2026-07-30):
 * - `oauth`: an authenticated Discord SSO browser session. This is the only
 *   authentication tier; mutation routes gate on role + explicit confirmation.
 * - `escalated`: the route additionally requires a consumed audited escalation
 *   grant (reason + TTL, one audit event per grant). Reserved for the D1
 *   escalation surfaces: other-humans' sensitive memories and cogsec
 *   remediation actions.
 * - `privacy_break_glass`: the companion-privacy disclosure confirm phase; the
 *   gateway mints the `break_glass` session assurance from the same audited
 *   escalation grant path.
 */
export type GardenAssuranceRequirement = 'none' | 'oauth' | 'escalated' | 'privacy_break_glass';
export type GardenApprovalRequirement = 'contact_approval' | 'cogsec' | 'independent_reviewer';
export type GardenPublicAccess = 'never' | 'always' | 'feature_off_only';
export type GardenRecoveryAccess = 'forbidden' | 'trusted_host_exact_scope';

export interface GardenRouteAuthorization {
  readonly action: FleetAuthAction;
  readonly baseRole: FleetAuthBaseRole;
  readonly resource: {
    readonly scope: GardenWorkspaceScope;
    readonly area: GardenResourceArea;
  };
  readonly subjectRelation: GardenSubjectRelation;
  /** These requirements are conjunctive; satisfying one never bypasses another. */
  readonly requirements: {
    readonly assurance: GardenAssuranceRequirement;
    readonly confirmation: 'none' | 'explicit';
    readonly approvals: readonly GardenApprovalRequirement[];
  };
  readonly publicAccess: GardenPublicAccess;
  readonly recoveryAccess: GardenRecoveryAccess;
}

interface RouteAuthorizationGroup {
  readonly action: FleetAuthAction;
  readonly area: GardenResourceArea;
  readonly routeIds: readonly string[];
  readonly scope?: GardenWorkspaceScope;
  readonly subjectRelation?: GardenSubjectRelation;
  readonly assurance?: GardenAssuranceRequirement;
  readonly confirmation?: 'none' | 'explicit';
  readonly approvals?: readonly GardenApprovalRequirement[];
  readonly publicAccess?: GardenPublicAccess;
  readonly recoveryAccess?: GardenRecoveryAccess;
}

function ids(
  methods: GardenForwardMethod | readonly GardenForwardMethod[],
  patterns: readonly string[],
): string[] {
  const expandedMethods = typeof methods === 'string' ? [methods] : methods;
  return patterns.flatMap((pattern) => expandedMethods.map((method) => `${method} ${pattern}`));
}

const pageIds = (patterns: readonly string[]): string[] => ids(['GET', 'HEAD'], patterns);

const routeAuthorizationGroups: readonly RouteAuthorizationGroup[] = [
  {
    action: 'contacts.bind', area: 'contacts',
    routeIds: ids('POST', ['/v1/fleet-auth/lifecycle/binding/complete']),
    confirmation: 'explicit',
  },
  {
    action: 'provider.link', area: 'identity',
    routeIds: ids('POST', ['/v1/fleet-auth/lifecycle/provider/complete']),
    confirmation: 'explicit',
  },
  {
    action: 'roles.manage', area: 'identity',
    routeIds: ids('POST', ['/v1/fleet-auth/lifecycle/role/complete']),
    confirmation: 'explicit',
  },
  {
    action: 'public.read', area: 'garden_ui', routeIds: [
      ...ids('GET', ['/health']),
      ...ids(['GET', 'HEAD'], ['/_app/*assetPath']),
    ], publicAccess: 'always', subjectRelation: 'none', assurance: 'none',
  },
  {
    action: 'public.read', area: 'garden_ui', routeIds: ids('GET', ['/login']),
    publicAccess: 'feature_off_only', subjectRelation: 'none', assurance: 'none',
  },
  {
    action: 'legacy_session.manage', area: 'garden_ui',
    routeIds: ids('POST', ['/login', '/api/admin/logout']),
    publicAccess: 'feature_off_only', subjectRelation: 'none', assurance: 'none',
  },
  {
    action: 'recovery.begin', area: 'sessions', routeIds: pageIds(['/session-recovery']),
    scope: 'garden_surface', subjectRelation: 'none', assurance: 'none',
    recoveryAccess: 'trusted_host_exact_scope',
  },
  {
    action: 'companion.read', area: 'garden_ui', routeIds: pageIds([
      '/', '/channels', '/chat', '/primer', '/theme',
    ]),
  },
  {
    action: 'companion.interact', area: 'garden_ui',
    routeIds: ids('POST', ['/v1/chat/completions']),
  },
  {
    action: 'action_pipe.read', area: 'action_pipe', routeIds: [
      ...ids('GET', [
        '/api/admin/action-pipe', '/api/admin/tool-conformance/latest', '/api/admin/tools/adaptive',
      ]),
      ...pageIds(['/action-pipe', '/tools']),
    ],
  },
  {
    action: 'action_pipe.manage', area: 'action_pipe', routeIds: ids('POST', [
      '/api/admin/tool-conformance/run',
      '/api/admin/action-pipe/actions/:actionRef/acknowledge',
      '/api/admin/action-pipe/actions/:actionRef/cancel',
    ]), confirmation: 'explicit',
  },
  {
    // Unload is reversible; the next selected MCP operation reconnects lazily.
    action: 'action_pipe.manage', area: 'action_pipe', routeIds: ids('POST', [
      '/api/admin/tools/mcp/release',
    ]),
  },
  {
    action: 'audit.read', area: 'audit', routeIds: [
      ...ids('GET', [
        '/api/admin/audit/history', '/api/admin/audit/history/:entryId',
        '/api/admin/evals/observer-sidecar/export', '/api/admin/evals/observer-sidecar/health',
        '/api/admin/evals/observer-sidecar/latest', '/api/admin/evals/observer-sidecar/lever-events',
        '/api/admin/evals/observer-sidecar/observations', '/api/admin/evals/observer-sidecar/runs',
      ]),
      ...pageIds(['/evals/emotion-sidecar']),
    ],
  },
  {
    action: 'charges.read', area: 'charges', routeIds: [
      ...ids('GET', ['/api/admin/charge-costs', '/api/admin/charges']),
      ...pageIds(['/charge-budget']),
    ],
  },
  {
    action: 'garden.read', area: 'companion', routeIds: [
      ...ids('GET', ['/api/admin/dashboard', '/api/admin/dashboard/analysis-workbench-traces']),
      ...pageIds(['/analysis-workbench']),
    ],
  },
  {
    action: 'diagnostics.read', area: 'diagnostics', routeIds: [
      ...ids('GET', ['/api/admin/diagnostics', '/api/admin/subsystem-health']),
      ...pageIds(['/subsystem-health']),
    ],
  },
  {
    action: 'channels.read', area: 'channels', routeIds: [
      ...ids('GET', [
        '/api/admin/rooms', '/api/admin/rooms/:channelId/roster',
        '/api/admin/channels/bearer-companion',
        '/api/admin/channels/context-envelope',
        '/api/admin/channels/context-envelope/demotion-notice',
      ]),
      ...pageIds(['/rooms']),
    ],
  },
  {
    action: 'channels.manage', area: 'channels',
    routeIds: ids('POST', [
      '/api/admin/channels/bearer-companion',
      '/api/admin/channels/context-envelope',
      '/api/admin/channels/context-envelope/demote',
    ]),
    confirmation: 'explicit',
  },
  {
    // Subject-bound session reads (88u3): fleet principals reach these only
    // through the subject-bound session projection, which scopes every row to
    // the requester's authenticated contact binding. Role never widens
    // visibility, mirroring the memory subject projection.
    action: 'sessions.read', area: 'sessions', routeIds: [
      ...ids('GET', [
        '/api/admin/sessions', '/api/admin/sessions/:channelId',
        '/api/admin/sessions/:channelId/detail', '/api/admin/sessions/:channelId/search',
        '/api/admin/sessions/:channelId/turns/:turnId',
      ]),
      ...pageIds(['/sessions']),
    ], subjectRelation: 'self_or_co_subject',
  },
  {
    // Session route-recovery and CogSec readers stay on the unpartitioned
    // session service and remain fail-closed for fleet principals.
    action: 'sessions.read', area: 'sessions', routeIds: ids('GET', [
      '/api/admin/session-routes', '/api/admin/session-routes/cogsec/events',
    ]),
  },
  {
    action: 'sessions.repair', area: 'sessions', routeIds: ids('POST', [
      '/api/admin/session-routes/cogsec/apply', '/api/admin/session-routes/cogsec/preview',
      '/api/admin/session-routes/reset',
    ]), assurance: 'escalated', confirmation: 'explicit', approvals: ['cogsec'],
  },
  {
    action: 'cogsec.read', area: 'cognitive_security', routeIds: [
      ...ids('GET', [
        '/api/admin/concerns', '/api/admin/concerns/:concernId/arcs',
        '/api/admin/intake/drift-reviews', '/api/admin/intake/policy',
        '/api/admin/intake/quarantine', '/api/admin/intake/source-lists',
        '/api/admin/intake/drift-reviews/:id', '/api/admin/intake/quarantine/:id',
      ]),
      ...pageIds([
        '/cognitive-security/approvals', '/cognitive-security/drift',
        '/cognitive-security/firewall', '/cognitive-security/remediation', '/concerns',
      ]),
    ],
  },
  {
    action: 'cogsec.manage', area: 'cognitive_security', routeIds: [
      ...ids('POST', [
        '/api/admin/concerns/resolve-stale', '/api/admin/intake/source-lists',
        '/api/admin/concerns/:concernId/resolve', '/api/admin/concerns/:concernId/suppress',
        '/api/admin/concerns/:concernId/transition',
        '/api/admin/intake/drift-reviews/:id/resolve', '/api/admin/intake/quarantine/:id/confirm',
        '/api/admin/intake/quarantine/:id/decide',
      ]),
    ], assurance: 'escalated', confirmation: 'explicit', approvals: ['cogsec'],
  },
  {
    action: 'confirmations.read', area: 'confirmations', routeIds: [
      ...ids('GET', ['/api/admin/confirmations']), ...pageIds(['/confirmations']),
    ],
  },
  {
    action: 'confirmations.manage', area: 'confirmations',
    routeIds: ids('POST', ['/api/admin/confirmations/resolve']),
    confirmation: 'explicit',
  },
  {
    action: 'contact_approvals.read', area: 'contacts', routeIds: [
      ...ids('GET', ['/api/admin/contact-approvals']), ...pageIds(['/contact-approvals']),
    ],
  },
  {
    action: 'contact_approvals.manage', area: 'contacts', routeIds: ids('POST', [
      '/api/admin/contact-approvals/:id/approve', '/api/admin/contact-approvals/:id/deny',
      '/api/admin/contact-approvals/:id/reset',
    ]), confirmation: 'explicit', approvals: ['contact_approval'],
  },
  {
    action: 'contacts.read', area: 'contacts', routeIds: [
      ...ids('GET', ['/api/admin/contacts', '/api/admin/contacts/:id']),
      // Partner Affect shadow inspection (docs/partner-affect.md slice 1):
      // sensitive relational data about the bound partner contact, so it is
      // gated with the contact-read authority rather than diagnostics.
      ...ids('GET', ['/api/admin/partner-affect/shadow', '/api/admin/partner-affect/observations']),
      ...pageIds(['/contacts']),
    ],
  },
  {
    action: 'contacts.manage', area: 'contacts', routeIds: [
      ...ids('POST', [
        '/api/admin/contacts', '/api/admin/contacts/:id/merge', '/api/admin/contacts/:id/unlink',
        '/api/admin/contacts/:id/conversation-channel/delete',
      ]),
      ...ids(['PUT', 'PATCH', 'DELETE'], ['/api/admin/contacts/:id']),
    ], confirmation: 'explicit', approvals: ['contact_approval'],
  },
  {
    action: 'devices.read', area: 'devices', routeIds: [
      ...ids('GET', ['/api/admin/enrollments']), ...pageIds(['/enrollment']),
    ],
  },
  {
    action: 'devices.manage', area: 'devices', routeIds: [
      ...ids('POST', ['/api/admin/enrollments']),
      ...ids('DELETE', ['/api/admin/enrollments/:hubIdentityId']),
    ], confirmation: 'explicit',
  },
  {
    action: 'graph.read', area: 'graph', routeIds: [
      ...ids('GET', ['/api/admin/graph-proposals']), ...pageIds(['/graph-proposals']),
    ],
  },
  {
    action: 'graph.manage', area: 'graph', routeIds: ids('POST', [
      '/api/admin/graph-proposals/:id/approve', '/api/admin/graph-proposals/:id/reject',
    ]), confirmation: 'explicit', approvals: ['contact_approval'],
  },
  {
    action: 'identity.read', area: 'identity', routeIds: [
      ...ids('GET', ['/api/admin/identity']), ...pageIds(['/identity']),
    ],
  },
  {
    action: 'identity.manage', area: 'identity', routeIds: [
      ...ids('POST', [
        '/api/admin/identity/diff', '/api/admin/identity/import', '/api/admin/identity/onboarding',
        '/api/admin/identity/rollback', '/api/admin/identity/upload',
      ]),
      ...ids('PATCH', ['/api/admin/identity/fields']),
    ], confirmation: 'explicit',
  },
  {
    action: 'images.read', area: 'images', routeIds: [
      ...ids('GET', [
        '/api/admin/image-references', '/api/admin/images/generated',
        '/api/admin/image-references/:id/blob', '/api/admin/images/generated/:id/blob',
        '/api/admin/image-references/:id/lineage',
      ]),
      ...pageIds(['/images']),
    ],
  },
  {
    action: 'images.manage', area: 'images', routeIds: [
      ...ids('POST', [
        '/api/admin/image-references/upload', '/api/admin/image-references/:id/default',
        '/api/admin/image-references/rollback-default',
        '/api/admin/images/generated/:id/promote-reference',
      ]),
      ...ids('PATCH', ['/api/admin/image-references/:id', '/api/admin/images/generated/:id']),
    ],
  },
  {
    action: 'images.manage', area: 'images', routeIds: ids('DELETE', ['/api/admin/image-references/:id']),
    confirmation: 'explicit',
  },
  {
    action: 'memory.read.self', area: 'memory', routeIds: [
      ...ids('GET', [
        '/api/admin/episodic-memory/episodes', '/api/admin/episodic-memory/threads',
        '/api/admin/group-memory', '/api/admin/memory',
        '/api/admin/memory/scopes', '/api/admin/memory/search',
        '/api/admin/memory/shared-background', '/api/admin/episodic-memory/episodes/:id',
        '/api/admin/episodic-memory/episodes/:id/arcs',
        '/api/admin/episodic-memory/episodes/:id/provenance',
        '/api/admin/episodic-memory/threads/:threadId', '/api/admin/group-memory/:channelId',
        '/api/admin/memory/:id', '/api/admin/memory/:id/links',
        '/api/admin/memory/scopes/:scopeKey/detail',
      ]),
      ...pageIds(['/episodic-memory', '/memory']),
    ], subjectRelation: 'self_or_co_subject',
  },
  {
    action: 'memory.reveal', area: 'memory', routeIds: [
      ...ids('GET', ['/api/admin/memory/elevation']),
      ...ids('POST', ['/api/admin/memory/elevation', '/api/admin/memory/:id/reveal']),
      ...ids('DELETE', ['/api/admin/memory/elevation']),
    ], subjectRelation: 'self_or_co_subject', assurance: 'escalated', confirmation: 'explicit',
  },
  {
    action: 'privacy.break_glass', area: 'memory', routeIds: ids('POST', [
      '/api/admin/privacy-break-glass/memory/:id/confirm',
    ]), subjectRelation: 'none', assurance: 'privacy_break_glass', confirmation: 'explicit',
  },
  {
    action: 'privacy.break_glass', area: 'memory', routeIds: ids('POST', [
      '/api/admin/privacy-break-glass/memory/:id/decide',
    ]), subjectRelation: 'none', assurance: 'oauth', confirmation: 'explicit',
  },
  {
    action: 'privacy.break_glass', area: 'contacts', routeIds: ids('POST', [
      '/api/admin/privacy-break-glass/profile/:id/confirm',
    ]), subjectRelation: 'none', assurance: 'privacy_break_glass', confirmation: 'explicit',
  },
  {
    action: 'privacy.break_glass', area: 'contacts', routeIds: ids('POST', [
      '/api/admin/privacy-break-glass/profile/:id/decide',
    ]), subjectRelation: 'none', assurance: 'oauth', confirmation: 'explicit',
  },
  {
    // Companion-private journals (values timeline, metacognition, daily and
    // free-form reflections) are welfare-sensitive substrates. The confirm
    // phase demands the same per-request `privacy_break_glass` step-up as
    // memory/profile so the gateway mints the `break_glass` session assurance
    // the disclosure requires; the decide phase then discloses one exact
    // journal window under that authority.
    action: 'privacy.break_glass', area: 'values', routeIds: ids('POST', [
      '/api/admin/privacy-break-glass/journal/:id/confirm',
    ]), subjectRelation: 'none', assurance: 'privacy_break_glass', confirmation: 'explicit',
  },
  {
    action: 'privacy.break_glass', area: 'values', routeIds: ids('POST', [
      '/api/admin/privacy-break-glass/journal/:id/decide',
    ]), subjectRelation: 'none', assurance: 'oauth', confirmation: 'explicit',
  },
  {
    action: 'memory.manage', area: 'memory', routeIds: [
      ...ids('POST', [
        '/api/admin/memory/bulk-delete', '/api/admin/memory/bulk-update',
        '/api/admin/memory/link',
        '/api/admin/memory/scope-update', '/api/admin/group-memory/:channelId/backfill',
      ]),
      ...ids('DELETE', ['/api/admin/memory/link', '/api/admin/memory/:id']),
      ...ids('PATCH', ['/api/admin/memory/:id/patch']),
    ], subjectRelation: 'self_or_co_subject', confirmation: 'explicit',
  },
  {
    action: 'models.read', area: 'models', routeIds: [
      ...ids('GET', [
        '/api/admin/fleet-model-usage', '/api/admin/model-usage', '/api/admin/model-usage/export',
        '/api/admin/chat/model-room/bootstrap', '/api/admin/models',
      ]),
      ...pageIds(['/fleet-costs', '/model-room', '/models']),
    ],
  },
  {
    action: 'models.manage', area: 'models', routeIds: ids('POST', ['/api/admin/models/refresh']),
    confirmation: 'explicit',
  },
  {
    action: 'places.read', area: 'places', routeIds: [
      ...ids('GET', ['/api/admin/places', '/api/admin/places/map', '/api/admin/satellites']),
      ...pageIds(['/places', '/satellites']),
    ],
  },
  {
    action: 'places.manage', area: 'places',
    routeIds: ids('PATCH', ['/api/admin/places/satellites/:satelliteId/binding']),
    confirmation: 'explicit',
  },
  {
    action: 'prompts.read', area: 'prompts', routeIds: [
      ...ids('GET', [
        '/api/admin/prompts', '/api/admin/prompts/constitution', '/api/admin/prompts/foundation',
        '/api/admin/prompts/north-star', '/api/admin/prompts/:layerId',
        '/api/admin/prompts/:layerId/diff',
      ]),
      ...ids('POST', ['/api/admin/prompts/count-tokens']),
      ...pageIds(['/prompt-monitor', '/prompts']),
    ],
  },
  {
    action: 'prompts.manage', area: 'prompts', routeIds: [
      ...ids('POST', [
        '/api/admin/prompts', '/api/admin/prompts/reorder',
        '/api/admin/prompts/:layerId/rollback', '/api/admin/prompts/:layerId/toggle',
      ]),
      ...ids('PUT', [
        '/api/admin/prompts/constitution', '/api/admin/prompts/foundation',
        '/api/admin/prompts/north-star', '/api/admin/prompts/runtime-blocks',
      ]),
      ...ids('PATCH', ['/api/admin/prompts/:layerId']),
    ], confirmation: 'explicit',
  },
  {
    action: 'scheduler.read', area: 'scheduler', routeIds: [
      ...ids('GET', ['/api/admin/scheduler', '/api/admin/scheduler/wake-window']),
      ...pageIds(['/scheduler']),
    ],
  },
  {
    action: 'scheduler.manage', area: 'scheduler', routeIds: [
      ...ids('POST', ['/api/admin/scheduler/tasks']),
      ...ids('PATCH', [
        '/api/admin/scheduler/reflections/:reflectionId', '/api/admin/scheduler/tasks/:taskId',
      ]),
      ...ids('DELETE', ['/api/admin/scheduler/tasks/:taskId']),
    ], confirmation: 'explicit',
  },
  {
    action: 'shared_workspace.read', area: 'shared_workspace',
    scope: 'governed_shared_workspace',
    routeIds: ids('GET', ['/api/admin/shared-workspace', '/api/admin/shared-workspace/artifact']),
  },
  {
    action: 'shared_workspace.manage', area: 'shared_workspace',
    scope: 'governed_shared_workspace',
    routeIds: ids('POST', ['/api/admin/shared-workspace/proposals']),
  },
  {
    action: 'shared_workspace.manage', area: 'shared_workspace',
    scope: 'governed_shared_workspace',
    routeIds: ids('POST', ['/api/admin/shared-workspace/reviews/:reviewId/cogsec']),
    assurance: 'escalated', confirmation: 'explicit', approvals: ['cogsec'],
  },
  {
    action: 'shared_workspace.manage', area: 'shared_workspace',
    scope: 'governed_shared_workspace',
    routeIds: ids('POST', ['/api/admin/shared-workspace/reviews/:reviewId/decision']),
    assurance: 'escalated', confirmation: 'explicit',
    approvals: ['cogsec', 'independent_reviewer'],
  },
  {
    action: 'skills.read', area: 'skills', routeIds: [
      ...ids('GET', ['/api/admin/skills']), ...pageIds(['/skills']),
    ],
  },
  {
    action: 'skills.manage', area: 'skills', routeIds: [
      ...ids(['POST', 'PATCH'], ['/api/admin/skills']),
      ...ids('POST', ['/api/admin/skills/toggle']),
      ...ids('DELETE', ['/api/admin/skills/:name']),
    ], confirmation: 'explicit',
  },
  {
    action: 'settings.read', area: 'personal_settings', routeIds: [
      ...ids('GET', [
        '/api/admin/settings', '/api/admin/settings/models', '/api/admin/settings/schema',
        '/api/admin/settings/:key', '/api/settings/:key',
      ]),
      ...pageIds(['/settings']),
    ],
  },
  {
    action: 'settings.write', area: 'personal_settings', routeIds: [
      ...ids('PATCH', ['/api/admin/settings']),
      ...ids('POST', ['/api/admin/settings/models', '/api/admin/settings/:key', '/api/settings/:key']),
    ], confirmation: 'explicit',
  },
  {
    action: 'autonomy.read', area: 'autonomy', routeIds: [
      ...ids('GET', ['/api/admin/icp-autonomy', '/api/admin/room-arbiter']),
      ...pageIds(['/autonomy', '/room-arbiter']),
    ],
  },
  {
    action: 'autonomy.manage', area: 'autonomy', routeIds: ids('POST', [
      '/api/admin/icp-autonomy/do-not-disturb', '/api/admin/icp-autonomy/emergency-disable',
      '/api/admin/icp-autonomy/candidates/:candidateId/cancel',
    ]), confirmation: 'explicit',
  },
  {
    action: 'audit.read', area: 'audit', routeIds: [
      ...ids('GET', [
        '/api/admin/shards',
        '/api/admin/shards/:shardId',
        '/api/admin/shards/:shardId/configuration',
      ]),
      ...pageIds(['/shards', '/shards/:shardId']),
    ],
  },
  {
    action: 'settings.write', area: 'personal_settings',
    routeIds: ids('PATCH', ['/api/admin/shards/:shardId/configuration']),
    confirmation: 'explicit',
  },
  {
    action: 'memory.manage', area: 'memory',
    routeIds: ids('POST', ['/api/admin/shards/:shardId/review']),
    confirmation: 'explicit',
  },
  {
    action: 'values.read', area: 'values', routeIds: [
      ...ids('GET', [
        '/api/admin/values', '/api/admin/values/reflections/daily',
        '/api/admin/values/reflections/journal', '/api/admin/values/reflections/metacognition',
      ]),
      ...pageIds(['/values']),
    ],
  },
  {
    action: 'wiki.read', area: 'wiki', routeIds: [
      ...ids('GET', [
        '/api/admin/wiki', '/api/admin/wiki/scopes', '/api/admin/wiki/search', '/api/admin/wiki/:id',
        '/api/admin/wishlist',
      ]),
      ...pageIds(['/wiki', '/wishlist']),
    ],
  },
  {
    action: 'wiki.manage', area: 'wiki', routeIds: ids('POST', [
      '/api/admin/wishlist/:wishId/acknowledge',
      '/api/admin/wishlist/:wishId/respond',
      '/api/admin/wishlist/:wishId/convert-to-bead',
      '/api/admin/wishlist/:wishId/done',
    ]), confirmation: 'explicit',
  },
  {
    action: 'wiki.read', area: 'wiki', scope: 'governed_shared_workspace',
    routeIds: ids('GET', [
      '/api/admin/wiki/shared-world/:siteId',
      '/api/admin/wiki/shared-world-proposals',
      '/api/admin/wiki/shared-world-proposals/:proposalId',
    ]),
  },
  {
    action: 'wiki.manage', area: 'wiki', scope: 'governed_shared_workspace',
    routeIds: ids('POST', [
      '/api/admin/wiki/shared-world/:siteId/import', '/api/admin/wiki/shared-world/:siteId/publish',
      '/api/admin/wiki/shared-world-proposals/cleanup',
      '/api/admin/wiki/shared-world-proposals/:proposalId/approve',
      '/api/admin/wiki/shared-world-proposals/:proposalId/reject',
    ]), assurance: 'escalated', confirmation: 'explicit', approvals: ['cogsec'],
  },
  {
    action: 'models.read', area: 'models',
    routeIds: ids('GET', ['/api/admin/chat/bootstrap']),
  },
  {
    action: 'models.manage', area: 'models',
    routeIds: ids(['PATCH', 'POST'], ['/api/admin/chat/bootstrap']),
    confirmation: 'explicit',
  },
  {
    action: 'telemetry.read', area: 'telemetry', routeIds: [
      ...ids('WS', ['/api/admin/events']), ...pageIds(['/telemetry']),
    ], scope: 'garden_surface',
  },
];

function buildRouteAuthorizationCatalogue(): ReadonlyMap<string, GardenRouteAuthorization> {
  const catalogue = new Map<string, GardenRouteAuthorization>();
  for (const group of routeAuthorizationGroups) {
    const baseRole = FLEET_AUTH_ACTION_BASE_ROLE[group.action];
    for (const routeId of group.routeIds) {
      if (catalogue.has(routeId)) {
        throw new Error(`Duplicate Garden route authorization classification: ${routeId}`);
      }
      catalogue.set(routeId, Object.freeze({
        action: group.action,
        baseRole,
        resource: Object.freeze({
          scope: group.scope ?? (group.area === 'garden_ui' ? 'garden_surface' : 'personal_workspace'),
          area: group.area,
        }),
        subjectRelation: group.subjectRelation ?? 'current_companion',
        requirements: Object.freeze({
          assurance: group.assurance ?? 'oauth',
          confirmation: group.confirmation ?? 'none',
          approvals: Object.freeze([...(group.approvals ?? [])]),
        }),
        publicAccess: group.publicAccess ?? 'never',
        recoveryAccess: group.recoveryAccess ?? 'forbidden',
      }));
    }
  }
  return catalogue;
}

export const GARDEN_ROUTE_AUTHORIZATION = buildRouteAuthorizationCatalogue();

export function requireGardenRouteAuthorization(routeId: string): GardenRouteAuthorization {
  const authorization = GARDEN_ROUTE_AUTHORIZATION.get(routeId);
  if (!authorization) {
    throw new Error(`Garden route has no authorization classification: ${routeId}`);
  }
  return authorization;
}
