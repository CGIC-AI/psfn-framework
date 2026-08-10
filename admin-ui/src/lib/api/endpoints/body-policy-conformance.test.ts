import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withQuery } from '../query';

vi.mock('$lib/stores/auth.svelte', () => ({ getToken: () => '' }));
vi.mock('$lib/api/fleet-escalation', () => ({
  FLEET_ESCALATION_GRANT_HEADER: 'x-psfn-escalation-grant',
  withFleetEscalationGrant: async <T>(
    _request: unknown,
    spend: (grant: { grantId: string }, signal: AbortSignal) => Promise<T>,
  ): Promise<T> => await spend(
    { grantId: '22222222-2222-4222-8222-222222222222' },
    new AbortController().signal,
  ),
}));

import { createCompanionId } from '../../../../../src/shared/routing/companion-id.js';
import {
  GARDEN_ROUTE_CAPABILITIES,
} from '../../../../../src/boundary/fleet-auth/garden-route-capabilities.js';
import {
  compileGatewayGardenRequestTarget,
} from '../../../../../src/boundary/fleet-auth/request-capability-target.js';
import { acknowledgeActionPipeAction, cancelActionPipeAction } from './action-pipe';
import {
  approveContactApproval,
  denyContactApproval,
  resetContactApproval,
} from './contact-approvals';
import { setBearerApiCompanionPin } from './channels';
import { approveGraphProposal, rejectGraphProposal } from './graph-proposals';
import { rollbackPrompt } from './prompts';
import {
  applyCogSecRemediation,
  previewCogSecRemediation,
  resetSourceChannelSession,
} from './sessions';
import { acknowledgeWish, completeWish } from './wishlist';

const companionId = createCompanionId('11111111-1111-4111-8111-111111111111');
const encoder = new TextEncoder();
const adminSourceDirectory = fileURLToPath(new URL('../../../', import.meta.url));

interface MutationHelperPolicy {
  readonly bodyArgument: number | null;
  readonly contentType: string | null;
  readonly initArgument: number | null;
  readonly method: string | null;
}

const MUTATION_HELPERS = Object.freeze({
  apiDelete: {
    method: 'DELETE',
    bodyArgument: null,
    initArgument: null,
    contentType: null,
  },
  apiFetch: {
    method: null,
    bodyArgument: null,
    initArgument: 1,
    contentType: null,
  },
  apiPatch: {
    method: 'PATCH',
    bodyArgument: 1,
    initArgument: null,
    contentType: 'application/json',
  },
  apiPost: {
    method: 'POST',
    bodyArgument: 1,
    initArgument: null,
    contentType: 'application/json',
  },
  apiPostProtected: {
    method: 'POST',
    bodyArgument: 1,
    initArgument: null,
    contentType: 'application/json',
  },
  apiPostForm: {
    method: 'POST',
    bodyArgument: 1,
    initArgument: null,
    contentType: 'application/x-www-form-urlencoded',
  },
  apiPostMultipart: {
    method: 'POST',
    bodyArgument: 1,
    initArgument: null,
    contentType: null,
  },
  apiPut: {
    method: 'PUT',
    bodyArgument: 1,
    initArgument: null,
    contentType: 'application/json',
  },
  fetch: {
    method: null,
    bodyArgument: null,
    initArgument: 1,
    contentType: null,
  },
} satisfies Readonly<Record<string, MutationHelperPolicy>>);

interface StaticClientCallSite {
  readonly bodyPresent: boolean;
  readonly contentType: string | null;
  readonly helper: keyof typeof MUTATION_HELPERS;
  readonly location: string;
  readonly method: string;
  readonly path: string;
}

const MUTATION_METHODS = new Set(['DELETE', 'PATCH', 'POST', 'PUT']);
const RAW_FETCH_GARDEN_PATH = /^(?:\/api\/admin(?:\/|$)|\/login$|\/v1\/chat\/completions$)/u;

function concretePath(pattern: string): string {
  return pattern
    .replace(/:[A-Za-z][A-Za-z0-9_]*/gu, 'fixture-id')
    .replace(/\*[A-Za-z][A-Za-z0-9_]*/gu, 'fixture/path');
}

function headersRecord(headers: HeadersInit | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(headers).entries());
}

function staticString(
  expression: ts.Expression,
  constants: ReadonlyMap<string, string>,
  pathBuilders: ReadonlyMap<string, string> = new Map(),
): string | null {
  if (ts.isStringLiteralLike(expression)) return expression.text;
  // scopeGardenDataPath is a pure companion-scope prefixer; the catalogue
  // route is the inner path it wraps, so resolve through it.
  if (ts.isCallExpression(expression)
    && ts.isIdentifier(expression.expression)
    && expression.expression.text === 'scopeGardenDataPath'
    && expression.arguments.length >= 1) {
    return staticString(expression.arguments[0]!, constants, pathBuilders);
  }
  if (ts.isIdentifier(expression)) return constants.get(expression.text) ?? null;
  if (ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isSatisfiesExpression(expression)
    || ts.isTypeAssertionExpression(expression)) {
    return staticString(expression.expression, constants, pathBuilders);
  }
  if (ts.isBinaryExpression(expression)
    && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticString(expression.left, constants, pathBuilders);
    const right = staticString(expression.right, constants, pathBuilders);
    return left === null || right === null ? null : `${left}${right}`;
  }
  if (ts.isConditionalExpression(expression)) {
    const whenTrue = staticString(expression.whenTrue, constants, pathBuilders);
    const whenFalse = staticString(expression.whenFalse, constants, pathBuilders);
    if (whenTrue === whenFalse) return whenTrue;
    if (whenTrue === '' && ts.isTemplateExpression(expression.whenFalse)
      && expression.whenFalse.head.text.startsWith('?')) return '';
    if (whenFalse === '' && ts.isTemplateExpression(expression.whenTrue)
      && expression.whenTrue.head.text.startsWith('?')) return '';
    return null;
  }
  if (ts.isTemplateExpression(expression)) {
    let value = expression.head.text;
    for (const [index, span] of expression.templateSpans.entries()) {
      const substitution = staticString(span.expression, constants, pathBuilders);
      if (substitution === null) {
        const isExplicitQuerySuffix = index === expression.templateSpans.length - 1
          && span.literal.text === ''
          && ts.isIdentifier(span.expression)
          && span.expression.text === 'query';
        if (isExplicitQuerySuffix) return value;
        return null;
      }
      value += substitution;
      value += span.literal.text;
    }
    return value;
  }
  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
    if (expression.expression.text === 'encodeURIComponent') return 'fixture-id';
    if (expression.expression.text === 'withQuery' && expression.arguments[0]) {
      return staticString(expression.arguments[0], constants, pathBuilders);
    }
    return pathBuilders.get(expression.expression.text) ?? null;
  }
  return null;
}

function moduleStringConstants(sourceFile: ts.SourceFile): ReadonlyMap<string, string> {
  const constants = new Map<string, string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const statement of sourceFile.statements) {
      if (!ts.isVariableStatement(statement)
        || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        const value = staticString(declaration.initializer, constants);
        if (value !== null && constants.get(declaration.name.text) !== value) {
          constants.set(declaration.name.text, value);
          changed = true;
        }
      }
    }
  }
  return constants;
}

function modulePathBuilders(
  sourceFile: ts.SourceFile,
  constants: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  const pathBuilders = new Map<string, string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.body) continue;
    const returnStatement = statement.body.statements.find(ts.isReturnStatement);
    if (!returnStatement?.expression) continue;
    const path = staticString(returnStatement.expression, constants, pathBuilders);
    if (path?.startsWith('/')) pathBuilders.set(statement.name.text, path);
  }
  return pathBuilders;
}

function adminSourceModulePaths(directory = adminSourceDirectory): readonly string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...adminSourceModulePaths(path));
      continue;
    }
    if (!entry.isFile()
      || (!entry.name.endsWith('.ts') && !entry.name.endsWith('.svelte'))
      || /\.test\.[^.]+$/u.test(entry.name)
      || ['lib/api/client.ts', 'lib/api/protected-mutation.ts'].includes(
        relative(adminSourceDirectory, path),
      )) {
      continue;
    }
    paths.push(path);
  }
  return paths.sort();
}

function parseableModuleText(path: string): string {
  const sourceText = readFileSync(path, 'utf8');
  if (!path.endsWith('.svelte')) return sourceText;
  const scripts = [...sourceText.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/giu)];
  return scripts.map((match) => {
    const content = match[1] ?? '';
    const contentOffset = (match.index ?? 0) + match[0].indexOf(content);
    const precedingLineCount = sourceText.slice(0, contentOffset).split('\n').length - 1;
    return `${'\n'.repeat(precedingLineCount)}${content}`;
  }).join('\n');
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isSatisfiesExpression(expression)
    || ts.isTypeAssertionExpression(expression)) {
    return unwrapExpression(expression.expression);
  }
  return expression;
}

function objectProperty(
  expression: ts.Expression | undefined,
  name: string,
): ts.Expression | undefined {
  if (!expression) return undefined;
  const unwrapped = unwrapExpression(expression);
  if (!ts.isObjectLiteralExpression(unwrapped)) return undefined;
  for (const property of unwrapped.properties) {
    if (ts.isPropertyAssignment(property)) {
      const propertyName = ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)
        ? property.name.text
        : null;
      if (propertyName === name) return property.initializer;
    }
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) {
      return property.name;
    }
  }
  return undefined;
}

function spreadCanSetProperty(expression: ts.Expression, name: string): boolean {
  const unwrapped = unwrapExpression(expression);
  if (ts.isConditionalExpression(unwrapped)) {
    return spreadCanSetProperty(unwrapped.whenTrue, name)
      || spreadCanSetProperty(unwrapped.whenFalse, name);
  }
  if (!ts.isObjectLiteralExpression(unwrapped)) return true;
  return unwrapped.properties.some((property) => {
    if (ts.isSpreadAssignment(property)) {
      return spreadCanSetProperty(property.expression, name);
    }
    if (ts.isShorthandPropertyAssignment(property)) return property.name.text === name;
    if (!ts.isPropertyAssignment(property)) return true;
    return (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name))
      && property.name.text === name;
  });
}

function expressionIsPresent(expression: ts.Expression | undefined): boolean {
  return expression !== undefined
    && !(ts.isIdentifier(expression) && expression.text === 'undefined');
}

function resolveDynamicHelper(
  node: ts.CallExpression,
  helper: 'apiFetch' | 'fetch',
  policy: MutationHelperPolicy,
  constants: ReadonlyMap<string, string>,
  pathBuilders: ReadonlyMap<string, string>,
  location: string,
): Pick<StaticClientCallSite, 'bodyPresent' | 'contentType' | 'method'> | null {
  const init = policy.initArgument === null ? undefined : node.arguments[policy.initArgument];
  const unwrappedInit = init ? unwrapExpression(init) : undefined;
  expect(
    unwrappedInit === undefined || ts.isObjectLiteralExpression(unwrappedInit),
    `${location} ${helper} init must be a statically enumerable object literal`,
  ).toBe(true);
  if (unwrappedInit && !ts.isObjectLiteralExpression(unwrappedInit)) return null;
  if (unwrappedInit) {
    for (const propertyName of ['method', 'body']) {
      const unresolvedSpread = unwrappedInit.properties.some(
        property => ts.isSpreadAssignment(property)
          && spreadCanSetProperty(property.expression, propertyName),
      );
      expect(
        unresolvedSpread,
        `${location} ${helper} ${propertyName} must not come from an unresolvable spread`,
      ).toBe(false);
    }
  }
  const methodExpression = objectProperty(init, 'method');
  const method = methodExpression
    ? staticString(methodExpression, constants, pathBuilders)?.toUpperCase() ?? null
    : 'GET';
  expect(method, `${location} ${helper} method must be statically enumerable`).not.toBeNull();
  if (method === null || !MUTATION_METHODS.has(method)) return null;
  return {
    method,
    bodyPresent: expressionIsPresent(objectProperty(init, 'body')),
    contentType: null,
  };
}

function enumerateMutationCallSites(): readonly StaticClientCallSite[] {
  const callSites: StaticClientCallSite[] = [];
  for (const modulePath of adminSourceModulePaths()) {
    const moduleName = relative(adminSourceDirectory, modulePath);
    const sourceText = parseableModuleText(modulePath);
    const sourceFile = ts.createSourceFile(
      moduleName,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const constants = moduleStringConstants(sourceFile);
    const pathBuilders = modulePathBuilders(sourceFile, constants);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const helper = node.expression.text as keyof typeof MUTATION_HELPERS;
        const helperPolicy = MUTATION_HELPERS[helper];
        if (helperPolicy) {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
          const location = `${moduleName}:${line}`;
          const dynamicPolicy = helper === 'apiFetch' || helper === 'fetch'
            ? resolveDynamicHelper(
                node,
                helper,
                helperPolicy,
                constants,
                pathBuilders,
                location,
              )
            : null;
          if ((helper === 'apiFetch' || helper === 'fetch') && dynamicPolicy === null) {
            ts.forEachChild(node, visit);
            return;
          }
          const pathExpression = node.arguments[0];
          const path = pathExpression
            ? staticString(pathExpression, constants, pathBuilders)
            : null;
          expect(path, `${location} ${helper} path must be statically enumerable`)
            .not.toBeNull();
          if (path !== null) {
            if (helper === 'fetch' && !RAW_FETCH_GARDEN_PATH.test(path.split('?', 1)[0]!)) {
              ts.forEachChild(node, visit);
              return;
            }
            const bodyArgument = helperPolicy.bodyArgument;
            callSites.push({
              helper,
              method: dynamicPolicy?.method ?? helperPolicy.method ?? 'GET',
              path: path.split('?', 1)[0]!,
              bodyPresent: dynamicPolicy?.bodyPresent
                ?? (bodyArgument !== null && expressionIsPresent(node.arguments[bodyArgument])),
              contentType: dynamicPolicy?.contentType ?? helperPolicy.contentType,
              location,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return callSites;
}

interface ClientMutationFixture {
  readonly routeId: string;
  readonly path: string;
  readonly body?: string;
  readonly invoke: () => Promise<unknown>;
}

const cogSecRemediationInput: Parameters<typeof previewCogSecRemediation>[0] = {
  caseId: 'case-one',
  sourceChannelId: 'discord:channel-one',
  affectedLogicalSessionIds: ['logical-session-one'],
  affectedMessageRanges: [{
    sourceChannelId: 'discord:channel-one',
    logicalSessionId: 'logical-session-one',
    messageIds: [1, 2],
  }],
  type: 'content_poisoning',
  severity: 'high',
  reason: 'remove poisoned context',
  actor: 'browser-supplied-actor',
  cutEpoch: true,
};

// Mirrors authority- and body-policy-sensitive mutation call sites. Each case
// calls the real client function so the compiler checks the bytes that the
// browser actually serializes rather than a synthetic empty object.
const CLIENT_MUTATION_FIXTURES: readonly ClientMutationFixture[] = [
  {
    routeId: 'POST /api/admin/graph-proposals/:id/approve',
    path: '/api/admin/graph-proposals/proposal%20one/approve',
    body: '{"relationshipType":"friend"}',
    invoke: () => approveGraphProposal('proposal one', 'friend'),
  },
  {
    routeId: 'POST /api/admin/graph-proposals/:id/reject',
    path: '/api/admin/graph-proposals/proposal%20one/reject',
    invoke: () => rejectGraphProposal('proposal one'),
  },
  {
    routeId: 'POST /api/admin/contact-approvals/:id/approve',
    path: '/api/admin/contact-approvals/contact%20one/approve',
    invoke: () => approveContactApproval('contact one'),
  },
  {
    routeId: 'POST /api/admin/contact-approvals/:id/deny',
    path: '/api/admin/contact-approvals/contact%20one/deny',
    invoke: () => denyContactApproval('contact one'),
  },
  {
    routeId: 'POST /api/admin/contact-approvals/:id/reset',
    path: '/api/admin/contact-approvals/contact%20one/reset',
    invoke: () => resetContactApproval('contact one'),
  },
  {
    routeId: 'POST /api/admin/wishlist/:wishId/acknowledge',
    path: '/api/admin/wishlist/wish%20one/acknowledge',
    invoke: () => acknowledgeWish('wish one'),
  },
  {
    routeId: 'POST /api/admin/wishlist/:wishId/done',
    path: '/api/admin/wishlist/wish%20one/done',
    invoke: () => completeWish('wish one'),
  },
  {
    routeId: 'POST /api/admin/action-pipe/actions/:actionRef/cancel',
    path: '/api/admin/action-pipe/actions/action%20one/cancel',
    body: '{"reason":"operator stop"}',
    invoke: () => cancelActionPipeAction('action one', 'operator stop'),
  },
  {
    routeId: 'POST /api/admin/action-pipe/actions/:actionRef/acknowledge',
    path: '/api/admin/action-pipe/actions/action%20one/acknowledge',
    body: '{"detail":"reviewed"}',
    invoke: () => acknowledgeActionPipeAction('action one', 'reviewed'),
  },
  {
    routeId: 'POST /api/admin/prompts/:layerId/rollback',
    path: '/api/admin/prompts/layer%20one/rollback',
    body: '{"version":2}',
    invoke: () => rollbackPrompt('layer one', { version: 2 }),
  },
  {
    routeId: 'POST /api/admin/session-routes/reset',
    path: '/api/admin/session-routes/reset',
    body: '{"sourceChannelId":"discord:channel-one","reason":"operator reset","mode":"fresh_split"}',
    invoke: () => resetSourceChannelSession({
      sourceChannelId: 'discord:channel-one',
      reason: 'operator reset',
      actor: 'browser-supplied-actor',
      mode: 'fresh_split',
    }),
  },
  {
    routeId: 'POST /api/admin/session-routes/cogsec/preview',
    path: '/api/admin/session-routes/cogsec/preview',
    body: '{"caseId":"case-one","sourceChannelId":"discord:channel-one","affectedLogicalSessionIds":["logical-session-one"],"affectedMessageRanges":[{"sourceChannelId":"discord:channel-one","logicalSessionId":"logical-session-one","messageIds":[1,2]}],"type":"content_poisoning","severity":"high","reason":"remove poisoned context","cutEpoch":true}',
    invoke: () => previewCogSecRemediation(cogSecRemediationInput),
  },
  {
    routeId: 'POST /api/admin/session-routes/cogsec/apply',
    path: '/api/admin/session-routes/cogsec/apply',
    body: '{"caseId":"case-one","sourceChannelId":"discord:channel-one","affectedLogicalSessionIds":["logical-session-one"],"affectedMessageRanges":[{"sourceChannelId":"discord:channel-one","logicalSessionId":"logical-session-one","messageIds":[1,2]}],"type":"content_poisoning","severity":"high","reason":"remove poisoned context","cutEpoch":true}',
    invoke: () => applyCogSecRemediation(cogSecRemediationInput),
  },
  {
    routeId: 'POST /api/admin/channels/bearer-companion',
    path: '/api/admin/channels/bearer-companion',
    invoke: () => setBearerApiCompanionPin(),
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Garden catalogue body-policy conformance', () => {
  it('preserves endpoint query encoding, duplicate order, and empty paths', () => {
    const params = new URLSearchParams();
    params.append('timezone', 'America/New_York');
    params.append('timezone', 'Europe/Paris');

    expect(withQuery('/api/admin/model-usage', params)).toBe(
      '/api/admin/model-usage?timezone=America%2FNew_York&timezone=Europe%2FParis',
    );
    expect(withQuery('/api/admin/model-usage', new URLSearchParams()))
      .toBe('/api/admin/model-usage');
  });

  it('admits a canonical representative request for every catalogue body policy', () => {
    for (const capability of GARDEN_ROUTE_CAPABILITIES) {
      const body = capability.body.mode === 'forbidden'
        ? encoder.encode('')
        : encoder.encode('{}');

      expect(() => compileGatewayGardenRequestTarget({
        rawTarget: concretePath(capability.pattern),
        method: capability.method,
        companionId,
        body,
        ...(body.byteLength > 0
          ? { headers: { 'content-type': 'application/json' } }
          : {}),
      }), capability.id).not.toThrow();
    }
  });

  it('admits every statically enumerated admin source mutation call site', () => {
    const callSites = enumerateMutationCallSites();
    expect(callSites.length).toBeGreaterThan(0);
    const routeIds = callSites.map(({ method, path }) => `${method} ${path}`);
    expect(routeIds).toEqual(expect.arrayContaining([
      'POST /api/admin/prompts/reorder',
      'DELETE /api/admin/memory/link',
      'PATCH /api/admin/settings',
      'POST /login',
      'POST /api/admin/logout',
      'POST /v1/chat/completions',
    ]));

    for (const callSite of callSites) {
      const body = encoder.encode(callSite.bodyPresent ? '{}' : '');
      expect(() => compileGatewayGardenRequestTarget({
        rawTarget: callSite.path,
        method: callSite.method,
        companionId,
        body,
        ...(callSite.contentType && body.byteLength > 0
          ? { headers: { 'content-type': callSite.contentType } }
          : {}),
      }), `${callSite.location} ${callSite.helper}(${callSite.path})`).not.toThrow();
    }
  });

  it.each(CLIENT_MUTATION_FIXTURES)(
    'admits the real admin client request for $routeId',
    async ({ routeId, path, body, invoke }) => {
      const fetchMock = vi.fn(async () => new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
      vi.stubGlobal('fetch', fetchMock);

      await invoke();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [actualPath, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      const actualBody = typeof init.body === 'string' ? init.body : undefined;
      const actualHeaders = headersRecord(init.headers);
      expect(actualPath).toBe(path);
      expect(init.method).toBe('POST');
      expect(actualBody).toBe(body);
      expect(actualHeaders['content-type']).toBe(
        body === undefined ? undefined : 'application/json',
      );

      const compiled = compileGatewayGardenRequestTarget({
        rawTarget: actualPath,
        method: init.method ?? 'GET',
        companionId,
        body: encoder.encode(actualBody ?? ''),
        headers: actualHeaders,
      });
      expect(compiled.resource.routeId).toBe(routeId);
      expect(compiled.bodyLength).toBe(encoder.encode(body ?? '').byteLength);
    },
  );

  it('routes every escalation-gated admin POST through the canonical protected mutation seam', () => {
    const callSites = enumerateMutationCallSites();
    for (const callSite of callSites) {
      if (callSite.method !== 'POST') continue;
      const compiled = compileGatewayGardenRequestTarget({
        rawTarget: callSite.path,
        method: callSite.method,
        companionId,
        body: encoder.encode(callSite.bodyPresent ? '{}' : ''),
        ...(callSite.contentType && callSite.bodyPresent
          ? { headers: { 'content-type': callSite.contentType } }
          : {}),
      });
      const assurance = compiled.authorization.requirements.assurance;
      if (assurance === 'escalated' || assurance === 'privacy_break_glass') {
        expect(
          callSite.helper,
          `${callSite.location} ${compiled.resource.routeId} must use apiPostProtected`,
        ).toBe('apiPostProtected');
      }
    }
  });
});
