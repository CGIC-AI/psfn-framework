import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCompanionId } from '../../../../../src/shared/routing/companion-id.js';
import {
  compileGatewayGardenRequestTarget,
  validateGardenRequestMetadata,
} from '../../../../../src/boundary/fleet-auth/request-capability-target.js';
import { getChannelDemotionNotice } from './channels';
import { getCustodySourceEgresses } from './custody';
import { revokeEnrollment } from './enrollment';
import { getHumanEscalations } from './human-escalations';
import { listGeneratedImages } from './images';
import { searchSessionMessages } from './sessions';
import { searchWikiDocuments } from './wiki';
import { withQuery } from '../query';

vi.mock('$lib/stores/auth.svelte', () => ({ getToken: () => '' }));

const companionId = createCompanionId('11111111-1111-4111-8111-111111111111');
const searchText = "Reader's notes + (draft)! ~ café";
const fixtures = [
  {
    routeId: 'GET /api/admin/escalations',
    invoke: () => getHumanEscalations(),
    query: { state: ['open'] },
  },
  {
    routeId: 'GET /api/admin/escalations',
    invoke: () => getHumanEscalations('all'),
    query: { state: ['all'] },
  },
  {
    routeId: 'GET /api/admin/channels/context-envelope/demotion-notice',
    invoke: () => getChannelDemotionNotice('channel:example'),
    query: { channelId: ['channel:example'] },
  },
  {
    routeId: 'DELETE /api/admin/enrollments/:hubIdentityId',
    invoke: () => revokeEnrollment('identity example'),
    query: {},
  },
  {
    routeId: 'GET /api/admin/wiki/search',
    invoke: () => searchWikiDocuments(searchText),
    query: { query: [searchText], limit: ['20'] },
  },
  {
    routeId: 'GET /api/admin/sessions/:channelId/search',
    invoke: () => searchSessionMessages('session example', searchText, 10),
    query: { q: [searchText], limit: ['10'] },
  },
  {
    routeId: 'GET /api/admin/images/generated',
    invoke: () => listGeneratedImages({ q: searchText, tags: ["reader's notes", 'draft'] }),
    query: { q: [searchText], tags: ["reader's notes,draft"] },
  },
  {
    routeId: 'GET /api/admin/custody/sources',
    invoke: () => getCustodySourceEgresses({ sourceRef: searchText, cursor: 'next+page=' }),
    query: { sourceRef: [searchText], cursor: ['next+page='] },
  },
];

afterEach(() => vi.unstubAllGlobals());

describe('Garden client query-policy conformance', () => {
  it.each(fixtures)('admits the real endpoint request for $routeId', async fixture => {
    const requests: { rawTarget: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (rawTarget: string, init: RequestInit) => {
      // Model the HTTP(S) URL serializer used by fetch, including apostrophes.
      const url = new URL(new Request(`https://garden.example.test${rawTarget}`).url);
      requests.push({ rawTarget: `${url.pathname}${url.search}`, init });
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    });

    await fixture.invoke();

    expect(requests).toHaveLength(1);
    const request = requests[0];
    const compiled = compileGatewayGardenRequestTarget({
      rawTarget: request.rawTarget,
      method: request.init.method ?? 'GET',
      companionId,
      body: new Uint8Array(),
    });
    expect(compiled.resource.routeId).toBe(fixture.routeId);
    expect(compiled.resource.query).toEqual(fixture.query);
  });

  it.each([
    ['/api/admin/escalations', 'state', 'open'],
    ['/api/admin/channels/context-envelope/demotion-notice', 'channelId', 'channel:example'],
    ['/api/admin/wiki/search', 'query', searchText],
  ])('preserves rejection of undeclared and duplicate selectors on %s', (path, key, value) => {
    const params = new URLSearchParams([[key, value]]);
    params.append('undeclared', 'example');
    expect(() => validateGardenRequestMetadata({
      rawTarget: withQuery(path, params), method: 'GET',
    })).toThrow('query field undeclared is not declared');

    params.delete('undeclared');
    params.append(key, value);
    expect(() => validateGardenRequestMetadata({
      rawTarget: withQuery(path, params), method: 'GET',
    })).toThrow(`query field ${key} exceeds its cardinality`);
  });

  it('keeps browser actor attribution out of enrollment revocation', () => {
    expect(() => validateGardenRequestMetadata({
      rawTarget: '/api/admin/enrollments/identity-example?actor=browser', method: 'DELETE',
    })).toThrow('query field actor is not declared');
  });
});
