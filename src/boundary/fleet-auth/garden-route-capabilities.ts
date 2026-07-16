import type { FleetAuthAction } from '../../system/config/fleet-auth-config.js';

export const GARDEN_FORWARD_METHODS = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'WS',
] as const;
export type GardenForwardMethod = typeof GARDEN_FORWARD_METHODS[number];

export type GardenWorkspaceScope =
  | 'personal_workspace'
  | 'governed_shared_workspace'
  | 'garden_surface';

export type GardenResourceArea =
  | 'action_pipe'
  | 'attachments'
  | 'audit'
  | 'beads'
  | 'channels'
  | 'channel_artifacts'
  | 'cognitive_security'
  | 'contacts'
  | 'devices'
  | 'filesystem'
  | 'garden_ui'
  | 'identity'
  | 'images'
  | 'memory'
  | 'models'
  | 'personal_settings'
  | 'scheduler'
  | 'shared_workspace'
  | 'shell'
  | 'skills'
  | 'telemetry'
  | 'wiki';

export interface GardenQueryFieldPolicy {
  readonly cardinality: 'singleton' | 'multiple';
  readonly maxValues: number;
}

export interface GardenBodyPolicy {
  readonly mode: 'forbidden' | 'optional' | 'required';
  readonly maxBytes: number;
}

export interface GardenRouteCapability {
  readonly id: string;
  readonly method: GardenForwardMethod;
  /** Canonical path template. `:name` captures one segment; `*name` captures the remainder. */
  readonly pattern: string;
  readonly query: Readonly<Partial<Record<string, GardenQueryFieldPolicy>>>;
  readonly body: GardenBodyPolicy;
  readonly action: FleetAuthAction;
  readonly resource: {
    readonly scope: GardenWorkspaceScope;
    readonly area: GardenResourceArea;
  };
}

export interface ResolvedGardenRouteCapability {
  readonly capability: GardenRouteCapability;
  readonly pathParams: Readonly<Record<string, string>>;
}

const NO_QUERY = Object.freeze({}) as Readonly<Partial<Record<string, GardenQueryFieldPolicy>>>;
const NO_BODY = Object.freeze({ mode: 'forbidden', maxBytes: 0 }) as GardenBodyPolicy;
const OPTIONAL_BODY = Object.freeze({ mode: 'optional', maxBytes: 65_536 }) as GardenBodyPolicy;
const REQUIRED_BODY = Object.freeze({ mode: 'required', maxBytes: 65_536 }) as GardenBodyPolicy;
const UPLOAD_BODY = Object.freeze({ mode: 'required', maxBytes: 12 * 1_024 * 1_024 }) as GardenBodyPolicy;

const singleton = (fields: readonly string[]): Readonly<Partial<Record<string, GardenQueryFieldPolicy>>> =>
  Object.freeze(Object.fromEntries(fields.map((field) => [field, Object.freeze({
    cardinality: 'singleton' as const,
    maxValues: 1,
  })])));

const modelUsageQuery = Object.freeze({
  ...singleton([
    'sinceMs', 'untilMs', 'limit', 'topN', 'provider', 'model', 'toolName', 'purpose',
    'originStage', 'service', 'process', 'sessionId', 'channelId', 'turnId', 'requestId',
    'toolCallId', 'chargeEventId', 'chargeRunId', 'chargeRootRunId', 'chargeParentRunId',
    'shardId', 'subagentId', 'conversationId', 'rootInitiationId', 'workloadType',
    'workloadId', 'slotKey', 'requestedProvider', 'requestedModel', 'runId', 'timezone',
    'cursor', 'callKind', 'callType', 'originType', 'channelType', 'runtimeLaneClass',
    'chargeLane', 'chargeSurface', 'status', 'costSource', 'range', 'bucket', 'sortBy',
    'sortDirection', 'eventOrder',
  ]),
  groupBy: Object.freeze({ cardinality: 'multiple' as const, maxValues: 2 }),
});

const queryPolicies: Readonly<Partial<Record<string, Readonly<Partial<Record<string, GardenQueryFieldPolicy>>>>>> =
  Object.freeze({
    '/api/admin/audit/history': singleton([
      'limit', 'offset', 'actionType', 'decision', 'timeRange', 'source', 'query',
    ]),
    '/api/admin/charge-costs': singleton([
      'sinceMs', 'untilMs', 'lane', 'surface', 'channelId', 'runId', 'rootRunId',
    ]),
    '/api/admin/charges': singleton([
      'limit', 'sinceMs', 'untilMs', 'runId', 'channelId', 'peerContactId', 'dayKey',
    ]),
    '/api/admin/concerns': singleton(['includeResolved', 'includeExpired', 'limit', 'contactId']),
    '/api/admin/contacts': singleton(['limit', 'contactId', 'actor', 'field']),
    '/api/admin/dashboard': singleton(['costWindow']),
    '/api/admin/diagnostics': singleton(['windowMs', 'sinceMs', 'limit', 'includeFileLogs']),
    '/api/admin/enrollments/:hubIdentityId': singleton(['actor']),
    '/api/admin/episodic-memory/episodes': singleton(['limit', 'offset', 'threadId', 'from', 'to']),
    '/api/admin/episodic-memory/episodes/:id/arcs': singleton(['direction', 'arcKind', 'limit']),
    '/api/admin/episodic-memory/threads': singleton(['limit']),
    '/api/admin/evals/observer-sidecar/export': singleton([
      'limit', 'sinceMs', 'untilMs', 'minDivergenceScore', 'privacyClass', 'status',
      'runId', 'evalSessionId', 'scenarioId', 'testRunId', 'turnId', 'format',
    ]),
    '/api/admin/evals/observer-sidecar/latest': singleton([
      'limit', 'sinceMs', 'untilMs', 'minDivergenceScore', 'privacyClass', 'status',
      'runId', 'evalSessionId', 'scenarioId', 'testRunId', 'turnId',
    ]),
    '/api/admin/evals/observer-sidecar/lever-events': singleton([
      'limit', 'sinceMs', 'untilMs', 'lever', 'runId',
    ]),
    '/api/admin/evals/observer-sidecar/observations': singleton([
      'limit', 'sinceMs', 'untilMs', 'minDivergenceScore', 'privacyClass', 'status',
      'runId', 'evalSessionId', 'scenarioId', 'testRunId', 'turnId',
    ]),
    '/api/admin/evals/observer-sidecar/runs': singleton([
      'limit', 'sinceMs', 'untilMs', 'status', 'evalSessionId', 'scenarioId', 'testRunId',
    ]),
    '/api/admin/images/generated': singleton(['tags', 'favorite', 'meaningful', 'q']),
    '/api/admin/image-references/upload': singleton(['description', 'tags', 'setDefault']),
    '/api/admin/memory': singleton([
      'type', 'sensitivity', 'retention', 'startDate', 'endDate', 'limit', 'offset', 'preference',
    ]),
    '/api/admin/memory/scopes': singleton(['kind']),
    '/api/admin/memory/search': singleton(['q']),
    '/api/admin/memory/shared-background': singleton(['a', 'b', 'limit']),
    '/api/admin/model-usage': modelUsageQuery,
    '/api/admin/model-usage/export': Object.freeze({ ...modelUsageQuery, ...singleton(['format']) }),
    '/api/admin/rooms': singleton(['limit', 'offset']),
    '/api/admin/rooms/:channelId/roster': singleton(['limit', 'offset', 'channel']),
    '/api/admin/sessions': singleton(['limit', 'beforeId', 'messagesOnly', 'includeTurns']),
    '/api/admin/sessions/:channelId': singleton(['limit', 'beforeId', 'messagesOnly', 'includeTurns']),
    '/api/admin/sessions/:channelId/detail': singleton(['limit', 'beforeId', 'messagesOnly', 'includeTurns']),
    '/api/admin/sessions/:channelId/search': singleton(['q', 'limit']),
    '/api/admin/shared-workspace/artifact': singleton(['path']),
    '/api/admin/wiki': singleton(['scope']),
    '/api/admin/wiki/search': singleton(['query', 'limit']),
    '/api/admin/wiki/shared-world/:siteId': singleton(['id']),
  });

const requiredBodyPatterns = new Set([
  'POST /login',
  'POST /api/admin/chat/bootstrap',
  'PATCH /api/admin/chat/bootstrap',
  'POST /api/admin/concerns/:concernId/transition',
  'POST /api/admin/confirmations/resolve',
  'POST /api/admin/contacts',
  'PUT /api/admin/contacts/:id',
  'PATCH /api/admin/contacts/:id',
  'POST /api/admin/enrollments',
  'POST /api/admin/identity/diff',
  'PATCH /api/admin/identity/fields',
  'POST /api/admin/identity/import',
  'POST /api/admin/identity/onboarding',
  'POST /api/admin/identity/rollback',
  'POST /api/admin/memory/bulk-delete',
  'POST /api/admin/memory/bulk-update',
  'POST /api/admin/memory/link',
  'DELETE /api/admin/memory/link',
  'PATCH /api/admin/memory/:id/patch',
  'POST /api/admin/memory/scope-update',
  'POST /api/admin/prompts',
  'PATCH /api/admin/prompts/:layerId',
  'POST /api/admin/prompts/reorder',
  'PUT /api/admin/prompts/runtime-blocks',
  'PUT /api/admin/prompts/foundation',
  'PUT /api/admin/prompts/constitution',
  'PUT /api/admin/prompts/north-star',
  'POST /api/admin/settings/models',
  'PATCH /api/admin/settings',
  'POST /api/admin/shared-workspace/proposals',
  'POST /api/admin/shared-workspace/reviews/:reviewId/cogsec',
  'POST /api/admin/shared-workspace/reviews/:reviewId/decision',
]);

const noBodyMutationPatterns = new Set([
  'POST /api/admin/logout',
  'POST /api/admin/action-pipe/actions/:actionRef/acknowledge',
  'POST /api/admin/action-pipe/actions/:actionRef/cancel',
  'POST /api/admin/contact-approvals/:id/approve',
  'POST /api/admin/contact-approvals/:id/deny',
  'POST /api/admin/contact-approvals/:id/reset',
  'POST /api/admin/graph-proposals/:id/approve',
  'POST /api/admin/graph-proposals/:id/reject',
  'POST /api/admin/group-memory/:channelId/backfill',
  'POST /api/admin/image-references/:id/default',
  'POST /api/admin/models/refresh',
  'POST /api/admin/prompts/:layerId/rollback',
  'POST /api/admin/prompts/:layerId/toggle',
  'POST /api/admin/session-routes/reset',
  'POST /api/admin/wiki/shared-world/:siteId/publish',
]);

function classifyAction(method: GardenForwardMethod, pattern: string): FleetAuthAction {
  if (pattern.startsWith('/api/admin/settings') || pattern.startsWith('/api/settings/')) {
    return method === 'GET' ? 'settings.read' : 'settings.write';
  }
  if (pattern.startsWith('/api/admin/memory')) {
    if (pattern.endsWith('/reveal') || pattern.endsWith('/elevation')) return 'memory.jit.self';
    if (method === 'GET') return 'memory.read.self';
  }
  if (pattern.startsWith('/api/admin/contacts') || pattern.startsWith('/api/admin/contact-approvals')) {
    return method === 'GET' ? 'garden.read' : 'contacts.bind';
  }
  if (pattern.startsWith('/api/admin/enrollments')) return method === 'GET' ? 'garden.read' : 'devices.manage';
  if (method === 'GET' || method === 'HEAD' || method === 'WS') return 'garden.read';
  return 'tools.execute';
}

function classifyResource(pattern: string): GardenRouteCapability['resource'] {
  if (pattern === '/' || pattern === '/login' || pattern === '/health' || pattern.startsWith('/_app/')) {
    return { scope: 'garden_surface', area: 'garden_ui' };
  }
  if (pattern === '/api/admin/events') return { scope: 'garden_surface', area: 'telemetry' };
  if (pattern.startsWith('/api/admin/shared-workspace')) {
    return { scope: 'governed_shared_workspace', area: 'shared_workspace' };
  }
  if (pattern.startsWith('/api/admin/wiki/shared-world')) {
    return { scope: 'governed_shared_workspace', area: 'wiki' };
  }
  if (pattern.includes('/image')) return { scope: 'personal_workspace', area: 'images' };
  if (pattern.startsWith('/api/admin/wiki')) return { scope: 'personal_workspace', area: 'wiki' };
  if (pattern.startsWith('/api/admin/memory') || pattern.includes('episodic-memory') || pattern.includes('group-memory')) {
    return { scope: 'personal_workspace', area: 'memory' };
  }
  if (pattern.includes('/settings') || pattern.startsWith('/api/settings/')) {
    return { scope: 'personal_workspace', area: 'personal_settings' };
  }
  if (pattern.includes('/contacts') || pattern.includes('/contact-approvals')) {
    return { scope: 'personal_workspace', area: 'contacts' };
  }
  if (pattern.includes('/enrollments')) return { scope: 'personal_workspace', area: 'devices' };
  if (pattern.includes('/sessions') || pattern.includes('/rooms') || pattern.includes('/channels')) {
    return { scope: 'personal_workspace', area: 'channel_artifacts' };
  }
  if (pattern.includes('/models') || pattern.includes('/model-')) {
    return { scope: 'personal_workspace', area: 'models' };
  }
  if (pattern.includes('/scheduler')) return { scope: 'personal_workspace', area: 'scheduler' };
  if (pattern.includes('/skills')) return { scope: 'personal_workspace', area: 'skills' };
  if (pattern.includes('/audit') || pattern.includes('/charges') || pattern.includes('/evals/')) {
    return { scope: 'personal_workspace', area: 'audit' };
  }
  if (pattern.includes('/intake/') || pattern.includes('/concerns') || pattern.includes('/confirmations')) {
    return { scope: 'personal_workspace', area: 'cognitive_security' };
  }
  if (pattern.includes('/identity')) return { scope: 'personal_workspace', area: 'identity' };
  if (pattern.includes('/action-pipe') || pattern.includes('/tool')) {
    return { scope: 'personal_workspace', area: 'action_pipe' };
  }
  return { scope: 'personal_workspace', area: 'channels' };
}

type RouteTuple = readonly [GardenForwardMethod | readonly GardenForwardMethod[], string];

const fixedRoutes: readonly RouteTuple[] = [
  [['GET', 'POST'], '/login'], ['GET', '/health'], ['POST', '/api/admin/logout'],
  ['GET', '/api/admin/action-pipe'], ['GET', '/api/admin/audit/history'],
  ['GET', '/api/admin/charge-costs'], ['GET', '/api/admin/charges'],
  ['GET', '/api/admin/concerns'], ['POST', '/api/admin/concerns/resolve-stale'],
  ['GET', '/api/admin/confirmations'], ['POST', '/api/admin/confirmations/resolve'],
  ['GET', '/api/admin/contact-approvals'], [['GET', 'POST'], '/api/admin/contacts'],
  ['GET', '/api/admin/dashboard'], ['GET', '/api/admin/diagnostics'],
  [['GET', 'POST'], '/api/admin/enrollments'],
  ['GET', '/api/admin/episodic-memory/episodes'], ['GET', '/api/admin/episodic-memory/threads'],
  ['GET', '/api/admin/evals/observer-sidecar/export'], ['GET', '/api/admin/evals/observer-sidecar/health'],
  ['GET', '/api/admin/evals/observer-sidecar/latest'], ['GET', '/api/admin/evals/observer-sidecar/lever-events'],
  ['GET', '/api/admin/evals/observer-sidecar/observations'], ['GET', '/api/admin/evals/observer-sidecar/runs'],
  ['GET', '/api/admin/graph-proposals'], ['GET', '/api/admin/group-memory'],
  ['GET', '/api/admin/identity'], ['POST', '/api/admin/identity/diff'],
  ['PATCH', '/api/admin/identity/fields'], ['POST', '/api/admin/identity/import'],
  ['POST', '/api/admin/identity/onboarding'], ['POST', '/api/admin/identity/rollback'],
  ['POST', '/api/admin/identity/upload'], ['GET', '/api/admin/image-references'],
  ['POST', '/api/admin/image-references/upload'], ['GET', '/api/admin/images/generated'],
  ['GET', '/api/admin/memory'], ['POST', '/api/admin/memory/bulk-delete'],
  ['POST', '/api/admin/memory/bulk-update'], [['GET', 'POST', 'DELETE'], '/api/admin/memory/elevation'],
  [['POST', 'DELETE'], '/api/admin/memory/link'], ['POST', '/api/admin/memory/scope-update'],
  ['GET', '/api/admin/memory/scopes'], ['GET', '/api/admin/memory/search'],
  ['GET', '/api/admin/memory/shared-background'], ['GET', '/api/admin/model-usage'],
  ['GET', '/api/admin/model-usage/export'], ['GET', '/api/admin/places'],
  ['GET', '/api/admin/places/map'], [['GET', 'POST'], '/api/admin/prompts'],
  [['GET', 'PUT'], '/api/admin/prompts/constitution'], [['GET', 'PUT'], '/api/admin/prompts/foundation'],
  [['GET', 'PUT'], '/api/admin/prompts/north-star'], ['POST', '/api/admin/prompts/reorder'],
  ['PUT', '/api/admin/prompts/runtime-blocks'], ['GET', '/api/admin/rooms'],
  ['GET', '/api/admin/satellites'], ['GET', '/api/admin/scheduler'],
  ['POST', '/api/admin/scheduler/tasks'], ['GET', '/api/admin/scheduler/wake-window'],
  ['GET', '/api/admin/session-routes'], ['POST', '/api/admin/session-routes/cogsec/apply'],
  ['GET', '/api/admin/session-routes/cogsec/events'], ['POST', '/api/admin/session-routes/cogsec/preview'],
  ['POST', '/api/admin/session-routes/reset'], ['GET', '/api/admin/sessions'],
  ['GET', '/api/admin/shards'], ['GET', '/api/admin/shared-workspace'],
  ['GET', '/api/admin/shared-workspace/artifact'], ['POST', '/api/admin/shared-workspace/proposals'],
  [['GET', 'POST', 'PATCH'], '/api/admin/skills'], ['POST', '/api/admin/skills/toggle'],
  ['GET', '/api/admin/subsystem-health'], ['GET', '/api/admin/tool-conformance/latest'],
  ['POST', '/api/admin/tool-conformance/run'], ['GET', '/api/admin/tools/adaptive'],
  ['GET', '/api/admin/values'], ['GET', '/api/admin/values/reflections/daily'],
  ['GET', '/api/admin/values/reflections/journal'], ['GET', '/api/admin/values/reflections/metacognition'],
  ['GET', '/api/admin/wiki'], ['GET', '/api/admin/wiki/scopes'], ['GET', '/api/admin/wiki/search'],
  [['GET', 'POST'], '/api/admin/channels/context-envelope'],
  [['GET', 'PATCH', 'POST'], '/api/admin/chat/bootstrap'], ['GET', '/api/admin/chat/model-room/bootstrap'],
  ['GET', '/api/admin/intake/drift-reviews'], ['GET', '/api/admin/intake/policy'],
  ['GET', '/api/admin/intake/quarantine'], [['GET', 'POST'], '/api/admin/intake/source-lists'],
  ['GET', '/api/admin/models'], ['POST', '/api/admin/models/refresh'],
  [['GET', 'PATCH'], '/api/admin/settings'], [['GET', 'POST'], '/api/admin/settings/models'],
  ['GET', '/api/admin/settings/schema'], ['GET', '/api/admin/icp-autonomy'],
  ['POST', '/api/admin/icp-autonomy/do-not-disturb'], ['POST', '/api/admin/icp-autonomy/emergency-disable'],
];

const dynamicRoutes: readonly RouteTuple[] = [
  [['GET', 'PUT', 'PATCH', 'DELETE'], '/api/admin/contacts/:id'],
  ['POST', '/api/admin/contacts/:id/merge'], ['POST', '/api/admin/contacts/:id/unlink'],
  ['POST', '/api/admin/contacts/:id/conversation-channel/delete'],
  ['POST', '/api/admin/action-pipe/actions/:actionRef/acknowledge'],
  ['POST', '/api/admin/action-pipe/actions/:actionRef/cancel'], ['GET', '/api/admin/audit/history/:entryId'],
  ['POST', '/api/admin/concerns/:concernId/resolve'], ['POST', '/api/admin/concerns/:concernId/suppress'],
  ['POST', '/api/admin/concerns/:concernId/transition'],
  ['POST', '/api/admin/contact-approvals/:id/approve'], ['POST', '/api/admin/contact-approvals/:id/deny'],
  ['POST', '/api/admin/contact-approvals/:id/reset'], ['DELETE', '/api/admin/enrollments/:hubIdentityId'],
  ['GET', '/api/admin/episodic-memory/episodes/:id'], ['GET', '/api/admin/episodic-memory/episodes/:id/arcs'],
  ['GET', '/api/admin/episodic-memory/episodes/:id/provenance'],
  ['GET', '/api/admin/episodic-memory/threads/:threadId'],
  ['POST', '/api/admin/graph-proposals/:id/approve'], ['POST', '/api/admin/graph-proposals/:id/reject'],
  ['GET', '/api/admin/group-memory/:channelId'], ['POST', '/api/admin/group-memory/:channelId/backfill'],
  [['PATCH', 'DELETE'], '/api/admin/image-references/:id'], ['GET', '/api/admin/image-references/:id/blob'],
  ['POST', '/api/admin/image-references/:id/default'], ['PATCH', '/api/admin/images/generated/:id'],
  ['GET', '/api/admin/images/generated/:id/blob'], [['GET', 'DELETE'], '/api/admin/memory/:id'],
  ['GET', '/api/admin/memory/:id/links'], ['PATCH', '/api/admin/memory/:id/patch'],
  ['POST', '/api/admin/memory/:id/reveal'], ['GET', '/api/admin/memory/scopes/:scopeKey/detail'],
  ['PATCH', '/api/admin/places/satellites/:satelliteId/binding'],
  [['GET', 'PATCH'], '/api/admin/prompts/:layerId'], ['GET', '/api/admin/prompts/:layerId/diff'],
  ['POST', '/api/admin/prompts/:layerId/rollback'], ['POST', '/api/admin/prompts/:layerId/toggle'],
  ['GET', '/api/admin/rooms/:channelId/roster'], ['PATCH', '/api/admin/scheduler/reflections/:reflectionId'],
  [['PATCH', 'DELETE'], '/api/admin/scheduler/tasks/:taskId'],
  ['GET', '/api/admin/sessions/:channelId'], ['GET', '/api/admin/sessions/:channelId/detail'],
  ['GET', '/api/admin/sessions/:channelId/search'], ['GET', '/api/admin/sessions/:channelId/turns/:turnId'],
  ['GET', '/api/admin/shards/:shardId'], ['POST', '/api/admin/shards/:shardId/review'],
  ['POST', '/api/admin/shared-workspace/reviews/:reviewId/cogsec'],
  ['POST', '/api/admin/shared-workspace/reviews/:reviewId/decision'], ['DELETE', '/api/admin/skills/:name'],
  ['GET', '/api/admin/wiki/:id'], ['GET', '/api/admin/wiki/shared-world/:siteId'],
  ['POST', '/api/admin/wiki/shared-world/:siteId/import'], ['POST', '/api/admin/wiki/shared-world/:siteId/publish'],
  ['GET', '/api/admin/intake/drift-reviews/:id'], ['POST', '/api/admin/intake/drift-reviews/:id/resolve'],
  ['GET', '/api/admin/intake/quarantine/:id'], ['POST', '/api/admin/intake/quarantine/:id/confirm'],
  ['POST', '/api/admin/intake/quarantine/:id/decide'],
  ['POST', '/api/admin/icp-autonomy/candidates/:candidateId/cancel'],
  [['GET', 'POST'], '/api/admin/settings/:key'], [['GET', 'POST'], '/api/settings/:key'],
];

export const GARDEN_CLIENT_ROUTES = Object.freeze([
  '/', '/action-pipe', '/autonomy', '/channels', '/charge-budget', '/chat',
  '/cognitive-security/approvals', '/cognitive-security/drift', '/cognitive-security/firewall',
  '/cognitive-security/remediation', '/confirmations', '/contact-approvals', '/contacts',
  '/enrollment', '/evals/emotion-sidecar', '/episodic-memory', '/graph-proposals', '/identity',
  '/images', '/memory', '/model-room', '/models', '/places', '/primer', '/prompt-monitor',
  '/prompts', '/rooms', '/satellites', '/scheduler', '/session-recovery', '/sessions',
  '/settings', '/shards', '/skills', '/subsystem-health', '/telemetry', '/theme', '/tools',
  '/values', '/wiki',
] as const);

function bodyPolicy(method: GardenForwardMethod, pattern: string): GardenBodyPolicy {
  const key = `${method} ${pattern}`;
  if (method === 'POST' && pattern === '/api/admin/image-references/upload') return UPLOAD_BODY;
  if (requiredBodyPatterns.has(key)) return REQUIRED_BODY;
  if (method === 'GET' || method === 'HEAD' || method === 'WS' || noBodyMutationPatterns.has(key)) {
    return NO_BODY;
  }
  return OPTIONAL_BODY;
}

function buildCatalogue(): readonly GardenRouteCapability[] {
  const tuples: RouteTuple[] = [
    ...fixedRoutes,
    ...dynamicRoutes,
    [['GET', 'HEAD'], '/_app/*assetPath'],
    ['WS', '/api/admin/events'],
    ...GARDEN_CLIENT_ROUTES.map((path): RouteTuple => [['GET', 'HEAD'], path]),
  ];
  const capabilities: GardenRouteCapability[] = [];
  const ids = new Set<string>();
  for (const [methodOrMethods, pattern] of tuples) {
    const methods = typeof methodOrMethods === 'string' ? [methodOrMethods] : methodOrMethods;
    for (const method of methods) {
      const id = `${method} ${pattern}`;
      if (ids.has(id)) throw new Error(`Duplicate Garden route capability: ${id}`);
      ids.add(id);
      capabilities.push(Object.freeze({
        id,
        method,
        pattern,
        query: queryPolicies[pattern] ?? NO_QUERY,
        body: bodyPolicy(method, pattern),
        action: classifyAction(method, pattern),
        resource: Object.freeze(classifyResource(pattern)),
      }));
    }
  }
  return Object.freeze(capabilities);
}

export const GARDEN_ROUTE_CAPABILITIES = buildCatalogue();

function matchPattern(
  pattern: string,
  canonicalPath: string,
): Readonly<Record<string, string>> | null {
  const expected = pattern.split('/');
  const actual = canonicalPath.split('/');
  const params: Record<string, string> = {};
  for (let index = 0; index < expected.length; index += 1) {
    const expectedPart = expected[index];
    if (expectedPart.startsWith('*')) {
      if (index !== expected.length - 1 || actual.length <= index) return null;
      params[expectedPart.slice(1)] = actual.slice(index).map(decodeURIComponent).join('/');
      return Object.freeze(params);
    }
    const actualPart = actual.at(index);
    if (actualPart === undefined) return null;
    if (expectedPart.startsWith(':')) params[expectedPart.slice(1)] = decodeURIComponent(actualPart);
    else if (expectedPart !== actualPart) return null;
  }
  return actual.length === expected.length ? Object.freeze(params) : null;
}

export function resolveGardenRouteCapability(
  method: GardenForwardMethod,
  canonicalPath: string,
): ResolvedGardenRouteCapability | null {
  for (const capability of GARDEN_ROUTE_CAPABILITIES) {
    if (capability.method !== method) continue;
    const pathParams = matchPattern(capability.pattern, canonicalPath);
    if (pathParams) return { capability, pathParams };
  }
  return null;
}

export function assertGardenRouteDeclarationsCovered(
  routes: readonly { readonly method: string; readonly match: { readonly capabilityPattern: string } }[],
): void {
  const declared = new Set(GARDEN_ROUTE_CAPABILITIES.map(({ method, pattern }) => `${method} ${pattern}`));
  for (const route of routes) {
    const key = `${route.method} ${route.match.capabilityPattern}`;
    if (!declared.has(key)) throw new Error(`Garden route is absent from capability catalogue: ${key}`);
  }
}
