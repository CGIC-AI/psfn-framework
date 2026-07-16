import { describe, expect, it } from 'vitest';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import {
  compileAgentGardenRequestTarget,
  compileGatewayGardenRequestTarget,
  compileOperatorGardenRequestTarget,
  GardenRequestTargetError,
  parseCanonicalGardenRequestPath,
} from './request-capability-target.js';

const companionId = createCompanionId('11111111-1111-4111-8111-111111111111');
const emptyBody = Buffer.alloc(0);

function compile(rawTarget: string, method = 'GET', body: Buffer = emptyBody) {
  return compileGatewayGardenRequestTarget({ rawTarget, method, companionId, body });
}

describe('Garden fleet request capability target', () => {
  it('canonicalizes declared query order and binds typed connection authority', () => {
    const first = compile('/api/admin/images/generated?q=cat&favorite=true');
    const second = compile('/api/admin/images/generated?favorite=true&q=cat');
    const changed = compile('/api/admin/images/generated?favorite=true&q=dog');

    expect(first.canonicalRequestTarget).toBe('/api/admin/images/generated?favorite=true&q=cat');
    expect(first.targetDigest).toBe(second.targetDigest);
    expect(first.resourceDigest).not.toBe(changed.resourceDigest);
    expect(first.targetDigest).not.toBe(changed.targetDigest);
    expect(first.companionId).toBe(companionId);
    expect(first.action).toBe('garden.read');
    expect(first.resource).toMatchObject({
      scope: 'personal_workspace',
      area: 'images',
      companionId,
    });
  });

  it('hashes exact bounded bytes once and returns the same body object for forwarding', () => {
    const body = Buffer.from('{"favorite":true}', 'utf8');
    const compiled = compile('/api/admin/images/generated/image-a', 'PATCH', body);
    const changed = compile(
      '/api/admin/images/generated/image-a',
      'PATCH',
      Buffer.from('{"favorite":false}', 'utf8'),
    );

    expect(compiled.body).toBe(body);
    expect(compiled.bodyLength).toBe(body.byteLength);
    expect(compiled.bodyDigest).not.toBe(changed.bodyDigest);
    expect(compiled.resourceDigest).not.toBe(changed.resourceDigest);
    expect(compiled.targetDigest).not.toBe(changed.targetDigest);
  });

  it('produces identical gateway, operator, and agent golden targets', () => {
    const body = Buffer.from('{"action":"browser-value","resource":"browser-value"}');
    const input = {
      rawTarget: '/api/admin/images/generated/image-a',
      method: 'PATCH',
      companionId,
      body,
      headers: { 'content-type': 'application/json' },
    } as const;

    const gateway = compileGatewayGardenRequestTarget(input);
    const operator = compileOperatorGardenRequestTarget(input);
    const agent = compileAgentGardenRequestTarget(input);
    expect(operator).toEqual(gateway);
    expect(agent).toEqual(gateway);
    expect(operator.body).toBe(body);
    expect(agent.action).toBe('tools.execute');
    expect(agent.resource.routeId).toBe('PATCH /api/admin/images/generated/:id');
  });

  it.each([
    ['unknown route', '/api/admin/not-declared', 'GET'],
    ['unknown method', '/api/admin/images/generated', 'POST'],
    ['case alias', '/api/admin/Images/generated', 'GET'],
    ['trailing slash', '/api/admin/images/generated/', 'GET'],
    ['duplicate slash', '/api/admin//images/generated', 'GET'],
    ['raw dot segment', '/api/admin/../images/generated', 'GET'],
    ['encoded dot segment', '/api/admin/%2E%2E/images/generated', 'GET'],
    ['encoded slash', '/api/admin/images%2Fgenerated', 'GET'],
    ['encoded backslash', '/api/admin/images%5Cgenerated', 'GET'],
    ['malformed encoding', '/api/admin/images/%GG', 'GET'],
    ['absolute target', 'https://garden.example/api/admin/images/generated', 'GET'],
    ['authority target', '//garden.example/api/admin/images/generated', 'GET'],
    ['fragment', '/api/admin/images/generated#fragment', 'GET'],
    ['unknown query', '/api/admin/images/generated?unknown=true', 'GET'],
    ['duplicate singleton', '/api/admin/images/generated?q=a&q=b', 'GET'],
    ['form-space alias', '/api/admin/images/generated?q=big+cat', 'GET'],
    ['empty query field', '/api/admin/images/generated?q=cat&', 'GET'],
  ])('rejects %s', (_label, rawTarget, method) => {
    expect(() => compile(rawTarget, method)).toThrow(GardenRequestTargetError);
  });

  it('rejects browser-controlled companion/workspace authority in every selector surface', () => {
    expect(() => compile('/api/admin/images/generated?companionId=other')).toThrow(/authority selector/u);
    expect(() => compileGatewayGardenRequestTarget({
      rawTarget: '/api/admin/images/generated',
      method: 'GET',
      companionId,
      body: emptyBody,
      headers: { 'x-psfn-companion-id': 'other' },
    })).toThrow(/authority header/u);
    expect(() => compileGatewayGardenRequestTarget({
      rawTarget: '/api/admin/images/generated/image-a',
      method: 'PATCH',
      companionId,
      body: Buffer.from('{"workspacePath":"/other"}'),
      headers: { 'content-type': 'application/json' },
    })).toThrow(/authority body field/u);
  });

  it('rejects body-policy violations', () => {
    expect(() => compile('/api/admin/images/generated', 'GET', Buffer.from('x')))
      .toThrow(/body is forbidden/u);
    expect(() => compileGatewayGardenRequestTarget({
      rawTarget: '/api/admin/chat/bootstrap',
      method: 'POST',
      companionId,
      body: emptyBody,
    })).toThrow(/body is required/u);
    expect(() => compileGatewayGardenRequestTarget({
      rawTarget: '/api/admin/images/generated/image-a',
      method: 'PATCH',
      companionId,
      body: Buffer.alloc(65_537),
    })).toThrow(/body exceeds/u);
  });

  it('retains canonical encoded Personal Workspace identifiers', () => {
    expect(parseCanonicalGardenRequestPath('/api/admin/memory/scopes/contact%3Aalice/detail'))
      .toEqual({
        canonicalPath: '/api/admin/memory/scopes/contact:alice/detail',
        rawQuery: '',
      });
    expect(compile('/api/admin/memory/scopes/contact%3Aalice/detail').resource.pathParams)
      .toEqual({ scopeKey: 'contact:alice' });
  });
});
