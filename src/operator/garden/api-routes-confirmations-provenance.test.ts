import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { buildAdminApiRoutes } from './api-routes.js';
import type { AuthorizedAdminApiRoute } from './routes/types.js';
import type { ConfirmationQueueAdminApi, AdminChatBootstrapApi } from './admin-contract.js';
import type {
  AdminContactsService,
  AdminDashboardService,
  AdminImagesService,
  AdminIdentityService,
  AdminMemoryService,
  AdminPromptsService,
  AdminSessionService,
  AdminSettingsService,
  AdminShardFoldReviewService,
} from './services/types.js';
import type { ConfirmationQueueEntry } from '../../system/capabilities/confirmation-queue.js';
import { buildShareCandidate } from '../../core/cogsec/disclosure/index.js';

class CapturingResponse {
  status = 0;
  headers: Record<string, string> = {};
  body = '';

  writeHead(status: number, headers?: Record<string, string>): this {
    this.status = status;
    this.headers = headers ?? {};
    return this;
  }

  end(body?: string): this {
    this.body = body ?? '';
    return this;
  }
}

function makeRequest(url: string): IncomingMessage {
  return { url, headers: { host: 'localhost' } } as IncomingMessage;
}

function makeRoutes(confirmationQueueApi: ConfirmationQueueAdminApi | null): AuthorizedAdminApiRoute[] {
  return buildAdminApiRoutes({
    config: {} as SubstrateConfig,
    dashboardService: {} as AdminDashboardService,
    imagesService: {} as AdminImagesService,
    shardFoldReviewService: {} as AdminShardFoldReviewService,
    memoryService: {} as AdminMemoryService,
    sessionService: {} as AdminSessionService,
    contactsService: {} as AdminContactsService,
    settingsService: {} as AdminSettingsService,
    identityService: {} as AdminIdentityService,
    promptsService: {} as AdminPromptsService,
    chatBootstrapService: {} as AdminChatBootstrapApi,
    confirmationQueueApi,
    withBody: () => {},
  });
}

async function invokeConfirmationsGet(routes: AuthorizedAdminApiRoute[]): Promise<CapturingResponse> {
  const route = routes.find(
    r => r.method === 'GET' && r.match('/api/admin/confirmations'),
  );
  expect(route).toBeDefined();
  const response = new CapturingResponse();
  route!.handle(
    makeRequest('/api/admin/confirmations'),
    response as unknown as ServerResponse,
    {},
  );
  // Flush the listConfirmationQueue promise + its .then before reading the body.
  await new Promise(resolve => setImmediate(resolve));
  return response;
}

function entry(overrides: Partial<ConfirmationQueueEntry>): ConfirmationQueueEntry {
  return {
    id: 'entry-1',
    method: 'artifact.share',
    action: 'share',
    scope: 'artifact',
    params: {},
    companionReason: 'reason',
    requestedAt: 1,
    expiresAt: 2,
    ...overrides,
  };
}

describe('GET /api/admin/confirmations disclosure-provenance enrichment', () => {
  it('attaches a content-free provenance view to a publication candidate and leaves others untouched', async () => {
    const candidate = buildShareCandidate({
      candidateId: 'cand-1',
      content: { body: 'a private reflection body', mediaRefs: [] },
      proposedDestinations: [{ kind: 'publication' }],
      effectiveSensitivity: 'intimate',
      provenanceRefs: ['memory:m1', 'session:dm:contact-7'],
      subjectContactIds: ['contact-7'],
      createdAt: '2026-07-19T00:00:00.000Z',
    });

    const confirmationQueueApi = {
      listConfirmationQueue: vi.fn(async () => ({
        entries: [
          entry({ id: 'ordinary', method: 'identity.card.update', params: { field: 'x' } }),
          entry({
            id: 'candidate',
            method: 'share.capsule.request',
            params: { shareCandidate: candidate },
          }),
        ],
      })),
      resolveConfirmationQueue: vi.fn(),
    } as unknown as ConfirmationQueueAdminApi;

    const response = await invokeConfirmationsGet(makeRoutes(confirmationQueueApi));
    expect(response.status).toBe(200);
    const payload = JSON.parse(response.body) as {
      available: boolean;
      entries: Array<Record<string, unknown>>;
    };
    expect(payload.available).toBe(true);

    const ordinary = payload.entries.find(e => e.id === 'ordinary')!;
    expect(ordinary.disclosureProvenance).toBeUndefined();

    const candidateEntry = payload.entries.find(e => e.id === 'candidate')!;
    const prov = candidateEntry.disclosureProvenance as Record<string, unknown>;
    expect(prov).toBeDefined();
    expect(prov.isPublicationCandidate).toBe(true);
    expect(prov.malformed).toBe(false);
    expect(prov.candidateId).toBe('cand-1');
    expect(prov.effectiveSensitivity).toBe('intimate');
    expect(prov.sourceCount).toBe(2);
    expect((prov.sources as Array<{ kind: string }>).map(s => s.kind)).toEqual(['memory', 'conversation']);
    expect(prov.subjectContactIds).toEqual(['contact-7']);

    // Content-free: the candidate body never leaks into the provenance view.
    expect(JSON.stringify(prov)).not.toContain('a private reflection body');
  });

  it('fails closed to a malformed provenance view when a candidate carries a garbled provenance object', async () => {
    const confirmationQueueApi = {
      listConfirmationQueue: vi.fn(async () => ({
        entries: [
          entry({
            id: 'broken',
            method: 'share.capsule.request',
            params: { shareCandidate: 'garbled' },
          }),
        ],
      })),
      resolveConfirmationQueue: vi.fn(),
    } as unknown as ConfirmationQueueAdminApi;

    const response = await invokeConfirmationsGet(makeRoutes(confirmationQueueApi));
    expect(response.status).toBe(200);
    const payload = JSON.parse(response.body) as { entries: Array<Record<string, unknown>> };
    const prov = payload.entries[0].disclosureProvenance as Record<string, unknown>;
    expect(prov).toBeDefined();
    expect(prov.isPublicationCandidate).toBe(true);
    expect(prov.malformed).toBe(true);
    expect(prov.effectiveSensitivity).toBe('unknown');
    expect((prov.status as Record<string, unknown>).sources).toBe('unknown');
  });

  it('returns available:false without touching provenance when the queue is unavailable', async () => {
    const response = await invokeConfirmationsGet(makeRoutes(null));
    expect(response.status).toBe(200);
    const payload = JSON.parse(response.body) as { available: boolean; entries: unknown[] };
    expect(payload.available).toBe(false);
    expect(payload.entries).toEqual([]);
  });
});
