import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { buildAdminGraphProposalRoutes } from './api-routes-graph-proposals.js';
import type { AdminGraphProposalsService } from './services/graph-proposals-service.js';

class CapturingResponse {
  status = 0;
  body = '';

  writeHead(status: number): this {
    this.status = status;
    return this;
  }

  end(body?: string): this {
    this.body = body ?? '';
    return this;
  }
}

function service(): AdminGraphProposalsService {
  return {
    listGraphProposals: vi.fn(async () => ({ proposals: [] })),
    approveGraphProposal: vi.fn(async () => ({ ok: true })),
    rejectGraphProposal: vi.fn(async () => ({ ok: true })),
  };
}

async function approveWithBody(body: unknown): Promise<{
  response: CapturingResponse;
  graphProposals: AdminGraphProposalsService;
}> {
  const graphProposals = service();
  const routes = buildAdminGraphProposalRoutes({
    graphProposalsService: graphProposals,
    withBody: (_req, _res, callback) => callback(body as never),
  });
  const route = routes.find(candidate => (
    candidate.match('/api/admin/graph-proposals/proposal-one/approve') !== null
  ));
  if (!route) throw new Error('Graph proposal approval route is unavailable');
  const response = new CapturingResponse();
  const params = route.match('/api/admin/graph-proposals/proposal-one/approve');
  route.handle(
    {} as IncomingMessage,
    response as unknown as ServerResponse,
    params ?? {},
  );
  await new Promise(resolve => setImmediate(resolve));
  return { response, graphProposals };
}

describe('graph proposal approval body contract', () => {
  it.each([
    { label: 'an empty body', body: '', adjustedType: undefined },
    { label: 'an empty JSON object', body: '{}', adjustedType: undefined },
    {
      label: 'a typed JSON object',
      body: '{"relationshipType":"friend"}',
      adjustedType: 'friend',
    },
    {
      label: 'an already-decoded object',
      body: { relationshipType: 'sibling' },
      adjustedType: 'sibling',
    },
  ])('accepts $label without reparsing failures', async ({ body, adjustedType }) => {
    const { response, graphProposals } = await approveWithBody(body);

    expect(response.status).toBe(200);
    expect(graphProposals.approveGraphProposal).toHaveBeenCalledWith(
      'proposal-one',
      adjustedType,
    );
  });

  it.each([
    { label: 'malformed JSON', body: '{' },
    { label: 'a non-object JSON value', body: '[]' },
    { label: 'a non-string relationship type', body: '{"relationshipType":7}' },
    { label: 'an unknown field', body: '{"relationshipType":"friend","actor":"forged"}' },
  ])('returns a typed 400 for $label', async ({ body }) => {
    const { response, graphProposals } = await approveWithBody(body);

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: expect.any(String) });
    expect(graphProposals.approveGraphProposal).not.toHaveBeenCalled();
  });
});
