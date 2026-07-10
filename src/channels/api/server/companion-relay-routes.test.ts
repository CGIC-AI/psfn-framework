import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../../../shared/event-bus.js';
import { ApiServer } from '../server.js';
import type { SubstrateAgent } from '../../../core/agent/substrate-agent.js';
import type { SessionManager } from '../../../core/session/manager.js';
import { DEFAULT_COMPANION_ID } from '../../../core/identity/companion-naming.js';
import { deriveApiKeyPrincipalId } from '../../backplane/http/auth.js';
import { parseSatelliteRegistryConfig } from '../../backplane/satellite-registry.js';
import { CompanionEventRelay } from '../../backplane/companion-relay/relay.js';
import {
  redactApprovalRequested,
  redactApprovalResolved,
} from '../../backplane/companion-relay/redaction.js';
import { ConfirmationQueue } from '../../../system/capabilities/confirmation-queue.js';
import type { CompanionRelayAuditEntry } from './companion-relay-routes.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';

const API_KEY = 'companion-relay-test-key';
const HUB_PRINCIPAL_ID = deriveApiKeyPrincipalId(API_KEY);
const AUTH = { Authorization: `Bearer ${API_KEY}` };
const HUB_QUERY = 'satelliteId=hub-node&endpointId=hub-endpoint&claimType=satellite-hub';
const WAIT_TIMEOUT_MS = 2_000;

function endpointFixture(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    displayName: 'Test Endpoint',
    claimTypes: ['satellite-hub'],
    promptChannelType: 'satellite_hub',
    auth: { mode: 'api_key', apiKeyPrincipalIds: [HUB_PRINCIPAL_ID] },
    defaultIdentity: {
      authorId: 'test-user',
      authorName: 'Test User',
      canonicalContactId: 'contact-test-user',
      channelPrivacy: 'private',
    },
    maxCapabilities: ['text'],
    telemetryScopes: [],
    ...overrides,
  };
}

const TEST_REGISTRY = parseSatelliteRegistryConfig({
  schemaVersion: 1,
  enabled: true,
  satellites: [
    {
      satelliteId: 'hub-node',
      displayName: 'Test Hub Node',
      mobility: 'static',
      endpoints: [
        endpointFixture({
          endpointId: 'hub-endpoint',
          telemetryScopes: ['approvals', 'artifacts', 'tool_activity'],
        }),
      ],
    },
    {
      satelliteId: 'approvals-node',
      displayName: 'Approvals Only Node',
      mobility: 'static',
      endpoints: [
        endpointFixture({
          endpointId: 'approvals-endpoint',
          telemetryScopes: ['approvals'],
        }),
      ],
    },
    {
      satelliteId: 'bare-node',
      displayName: 'No Companion Scopes Node',
      mobility: 'static',
      endpoints: [
        endpointFixture({
          endpointId: 'bare-endpoint',
          telemetryScopes: ['presence'],
        }),
      ],
    },
    {
      satelliteId: 'foreign-node',
      displayName: 'Foreign Principal Node',
      mobility: 'static',
      endpoints: [
        endpointFixture({
          endpointId: 'foreign-endpoint',
          auth: { mode: 'api_key', apiKeyPrincipalIds: ['api-key-someoneelse0000000000'] },
          telemetryScopes: ['approvals', 'artifacts', 'tool_activity'],
        }),
      ],
    },
  ],
});

function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate port')));
        return;
      }
      const { port } = address;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

function request(
  port: number,
  method: string,
  path: string,
  body?: object,
  headers?: Record<string, string>,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      { hostname: '127.0.0.1', port, method, path, headers: { 'Content-Type': 'application/json', ...headers } },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: data }));
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

interface SseStream {
  status: number;
  headers: http.IncomingHttpHeaders;
  frames: Array<{ event: string; data: string }>;
  close: () => void;
}

function openSseStream(port: number, path: string, headers?: Record<string, string>): Promise<SseStream> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, method: 'GET', path, headers: { Accept: 'text/event-stream', ...headers } },
      (res) => {
        const stream: SseStream = {
          status: res.statusCode!,
          headers: res.headers,
          frames: [],
          close: () => {
            res.destroy();
            req.destroy();
          },
        };
        let buffer = '';
        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          let frameEnd = buffer.indexOf('\n\n');
          while (frameEnd !== -1) {
            const frame = buffer.slice(0, frameEnd);
            buffer = buffer.slice(frameEnd + 2);
            let event = 'message';
            const dataLines: string[] = [];
            for (const line of frame.split(/\r?\n/)) {
              if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
              else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trimStart());
            }
            if (dataLines.length > 0) {
              stream.frames.push({ event, data: dataLines.join('\n') });
            }
            frameEnd = buffer.indexOf('\n\n');
          }
        });
        resolve(stream);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function stopServer(server: ApiServer): Promise<void> {
  try {
    await server.stop();
  } catch (error) {
    const message = toErrorMessage(error);
    if (message.includes('ERR_SERVER_NOT_RUNNING') || message.includes('Server is not running')) return;
    throw error;
  }
}

describe('companion relay routes', () => {
  let port: number;
  let server: ApiServer;
  let eventBus: EventBus;
  let relay: CompanionEventRelay;
  let queue: ConfirmationQueue;
  let tempDir: string;
  let auditEntries: CompanionRelayAuditEntry[];
  let auditFailure: Error | null;
  let nowMs: number;

  beforeEach(async () => {
    port = await allocatePort();
    tempDir = mkdtempSync(join(tmpdir(), 'companion-routes-'));
    eventBus = new EventBus();
    auditEntries = [];
    auditFailure = null;
    nowMs = 1_700_000_000_000;

    // Mirrors the gateway approval-boundary wiring: queue lifecycle →
    // redaction at emission → typed companion.* bus events.
    queue = new ConfirmationQueue({
      defaultExpiryMs: 60_000,
      now: () => nowMs,
      observer: {
        onEnqueued: (entry) => {
          void eventBus.emit('companion.approval.requested', {
            payload: redactApprovalRequested(entry),
            timestamp: Date.now(),
          });
        },
        onResolved: (outcome) => {
          void eventBus.emit('companion.approval.resolved', {
            payload: redactApprovalResolved(outcome),
            timestamp: Date.now(),
          });
        },
      },
    });
    relay = new CompanionEventRelay({
      eventBus,
      previewRoots: [tempDir],
      maxPreviewBytes: 1_000,
    });

    server = new ApiServer({
      companionId: DEFAULT_COMPANION_ID,
      port,
      host: '127.0.0.1',
      agentLoop: { handleMessage: vi.fn() } as unknown as SubstrateAgent,
      eventBus,
      sessionManager: {
        getMessageCount: vi.fn(() => 0),
        recordUserMessage: vi.fn(),
        recordAssistantMessage: vi.fn(),
      } as unknown as SessionManager,
      apiKey: API_KEY,
      satelliteRegistry: TEST_REGISTRY,
      companionRelay: {
        relay,
        approvals: {
          resolve: (params) => queue.resolve(params),
          findHistory: (id) => queue.listHistory().find((entry) => entry.id === id) ?? null,
        },
        audit: async (entry) => {
          if (auditFailure) throw auditFailure;
          auditEntries.push(entry);
        },
      },
    });
    await server.init();
    await server.start();
  });

  afterEach(async () => {
    await stopServer(server);
    relay.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function enqueueApproval(execute: () => Promise<unknown> = async () => undefined, expiresInMs?: number) {
    return queue.enqueue(
      {
        method: 'fs.write',
        action: 'write file',
        scope: '/workspace/todo.txt',
        params: { path: '/workspace/todo.txt', content: 'raw-secret-content' },
        companionReason: 'Updating the shared todo list',
        ...(expiresInMs !== undefined ? { expiresInMs } : {}),
      },
      execute,
    );
  }

  describe('auth rejection', () => {
    it('rejects a missing bearer token with 401', async () => {
      const res = await request(port, 'GET', `/v1/companion/events?${HUB_QUERY}`);
      expect(res.status).toBe(401);
    });

    it('rejects a wrong bearer token with 401', async () => {
      const res = await request(port, 'GET', `/v1/companion/events?${HUB_QUERY}`, undefined, {
        Authorization: 'Bearer wrong-key',
      });
      expect(res.status).toBe(401);
    });

    it('rejects an authenticated principal not registered for the endpoint with 403', async () => {
      const res = await request(
        port,
        'GET',
        '/v1/companion/events?satelliteId=foreign-node&endpointId=foreign-endpoint&claimType=satellite-hub',
        undefined,
        AUTH,
      );
      expect(res.status).toBe(403);
      expect(res.body).toContain('satellite_principal_not_allowed');
    });

    it('rejects an unknown satellite endpoint with 403', async () => {
      const res = await request(
        port,
        'GET',
        '/v1/companion/events?satelliteId=ghost-node&endpointId=ghost&claimType=satellite-hub',
        undefined,
        AUTH,
      );
      expect(res.status).toBe(403);
      expect(res.body).toContain('companion_relay_not_registered');
    });
  });

  describe('deny-by-default scope policy', () => {
    it('rejects the event stream for an endpoint with no companion scopes', async () => {
      const res = await request(
        port,
        'GET',
        '/v1/companion/events?satelliteId=bare-node&endpointId=bare-endpoint&claimType=satellite-hub',
        undefined,
        AUTH,
      );
      expect(res.status).toBe(403);
      expect(res.body).toContain('companion_events_not_allowed');
    });

    it('rejects artifact previews for an endpoint without the artifacts scope', async () => {
      const res = await request(
        port,
        'GET',
        '/v1/companion/artifacts/art-1/preview?satelliteId=approvals-node&endpointId=approvals-endpoint&claimType=satellite-hub',
        undefined,
        AUTH,
      );
      expect(res.status).toBe(403);
      expect(res.body).toContain('companion_artifacts_not_allowed');
    });
  });

  describe('SSE stream', () => {
    it('frames redacted events as `event: companion` and filters kinds by scope', async () => {
      const fullStream = await openSseStream(port, `/v1/companion/events?${HUB_QUERY}`, AUTH);
      const approvalsStream = await openSseStream(
        port,
        '/v1/companion/events?satelliteId=approvals-node&endpointId=approvals-endpoint&claimType=satellite-hub',
        AUTH,
      );
      expect(fullStream.status).toBe(200);
      expect(fullStream.headers['content-type']).toBe('text/event-stream');

      const entry = enqueueApproval();
      await eventBus.emit('companion.tool.activity', {
        payload: { id: 'call-1', tool: 'shell', phase: 'started', timestamp: new Date().toISOString() },
        channelId: 'chan-1',
        timestamp: Date.now(),
      });

      await waitFor(() => fullStream.frames.length >= 2, 'full stream frames');
      await waitFor(() => approvalsStream.frames.length >= 1, 'approvals stream frames');
      // Give any misrouted tool.activity frame a chance to arrive before asserting.
      await new Promise((r) => setTimeout(r, 50));

      const fullEvents = fullStream.frames.map((f) => ({ event: f.event, data: JSON.parse(f.data) }));
      expect(fullEvents.every((f) => f.event === 'companion')).toBe(true);
      const kinds = fullEvents.map((f) => f.data.kind);
      expect(kinds).toContain('approval.requested');
      expect(kinds).toContain('tool.activity');

      const approvalFrame = fullEvents.find((f) => f.data.kind === 'approval.requested')!;
      expect(approvalFrame.data.payload).toEqual({
        id: entry.id,
        title: 'write file: /workspace/todo.txt',
        requestedAt: new Date(entry.requestedAt).toISOString(),
        expiresAt: new Date(entry.expiresAt).toISOString(),
        redactedContext: 'Updating the shared todo list',
        status: 'pending',
      });
      expect(JSON.stringify(fullEvents)).not.toContain('raw-secret-content');
      expect(typeof approvalFrame.data.emittedAt).toBe('string');

      const approvalsKinds = approvalsStream.frames.map((f) => (JSON.parse(f.data) as { kind: string }).kind);
      expect(approvalsKinds).toEqual(['approval.requested']);

      fullStream.close();
      approvalsStream.close();
    });
  });

  describe('approval decision round-trip', () => {
    const decisionBody = (decision: 'approve' | 'deny') => ({
      decision,
      satelliteId: 'hub-node',
      deviceId: 'device-1',
    });

    it('approves through the confirmation queue and audits the actor', async () => {
      const execute = vi.fn(async () => undefined);
      const entry = enqueueApproval(execute);

      const res = await request(port, 'POST', `/v1/companion/approvals/${entry.id}`, decisionBody('approve'), AUTH);
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ id: entry.id, status: 'approved' });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(auditEntries).toEqual([
        {
          method: 'companion.approval.decision',
          decision: 'ALLOW',
          params: {
            approvalId: entry.id,
            decision: 'approve',
            satelliteId: 'hub-node',
            endpointId: 'hub-endpoint',
            deviceId: 'device-1',
          },
        },
      ]);
    });

    it('denies through the confirmation queue', async () => {
      const execute = vi.fn(async () => undefined);
      const entry = enqueueApproval(execute);

      const res = await request(port, 'POST', `/v1/companion/approvals/${entry.id}`, decisionBody('deny'), AUTH);
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ id: entry.id, status: 'denied' });
      expect(execute).not.toHaveBeenCalled();
    });

    it('returns 404 for an unknown approval id', async () => {
      const res = await request(port, 'POST', '/v1/companion/approvals/no-such-id', decisionBody('approve'), AUTH);
      expect(res.status).toBe(404);
      expect(res.body).toContain('approval_not_found');
    });

    it('returns 409 when the approval was already resolved', async () => {
      const entry = enqueueApproval();
      await queue.resolve({ id: entry.id, decision: 'deny' });

      const res = await request(port, 'POST', `/v1/companion/approvals/${entry.id}`, decisionBody('approve'), AUTH);
      expect(res.status).toBe(409);
      expect(res.body).toContain('approval_already_resolved');
    });

    it('returns 409 when the approval expired before resolution', async () => {
      const entry = enqueueApproval(async () => undefined, 10);
      nowMs += 60_000;

      const res = await request(port, 'POST', `/v1/companion/approvals/${entry.id}`, decisionBody('approve'), AUTH);
      expect(res.status).toBe(409);
      expect(res.body).toContain('approval_expired');
    });

    it('rejects a satellite without the approvals scope and audits the denial', async () => {
      const entry = enqueueApproval();
      const res = await request(port, 'POST', `/v1/companion/approvals/${entry.id}`, {
        decision: 'approve',
        satelliteId: 'bare-node',
        deviceId: 'device-1',
      }, AUTH);
      expect(res.status).toBe(403);
      expect(res.body).toContain('companion_approvals_not_allowed');
      expect(auditEntries).toEqual([
        expect.objectContaining({
          method: 'companion.approval.decision',
          decision: 'DENY',
        }),
      ]);
    });

    it('rejects malformed decisions and device ids', async () => {
      const entry = enqueueApproval();
      const badDecision = await request(port, 'POST', `/v1/companion/approvals/${entry.id}`, {
        decision: 'modify',
        satelliteId: 'hub-node',
        deviceId: 'device-1',
      }, AUTH);
      expect(badDecision.status).toBe(400);

      const badDevice = await request(port, 'POST', `/v1/companion/approvals/${entry.id}`, {
        decision: 'approve',
        satelliteId: 'hub-node',
        deviceId: 'bad device id with spaces',
      }, AUTH);
      expect(badDevice.status).toBe(400);
    });

    it('fails closed when the audit write fails', async () => {
      const execute = vi.fn(async () => undefined);
      const entry = enqueueApproval(execute);
      auditFailure = new Error('audit backend down');

      const res = await request(port, 'POST', `/v1/companion/approvals/${entry.id}`, decisionBody('approve'), AUTH);
      expect(res.status).toBe(503);
      expect(res.body).toContain('audit_unavailable');
      expect(execute).not.toHaveBeenCalled();
      expect(queue.getPending(entry.id)?.id).toBe(entry.id);
    });
  });

  describe('artifact preview', () => {
    async function announceArtifact(id: string, fileName: string, bytes: number, sizeBytes = bytes) {
      const filePath = join(tempDir, fileName);
      writeFileSync(filePath, Buffer.alloc(bytes, 7));
      await eventBus.emit('companion.artifact.created', {
        payload: {
          id,
          label: fileName,
          mediaType: 'image/png',
          provenance: 'image_generation',
          createdAt: new Date().toISOString(),
          previewable: true,
        },
        preview: { artifactId: id, localPath: filePath, mediaType: 'image/png', sizeBytes },
        timestamp: Date.now(),
      });
      return filePath;
    }

    it('serves a registered preview to an artifacts-scoped endpoint', async () => {
      await announceArtifact('art-ok', 'ok.png', 128);
      const res = await request(port, 'GET', `/v1/companion/artifacts/art-ok/preview?${HUB_QUERY}`, undefined, AUTH);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.body.length).toBe(128);
    });

    it('404s for unknown artifacts and 403s for oversized ones', async () => {
      const unknown = await request(port, 'GET', `/v1/companion/artifacts/art-missing/preview?${HUB_QUERY}`, undefined, AUTH);
      expect(unknown.status).toBe(404);

      await announceArtifact('art-big', 'big.png', 100, 5_000);
      const oversized = await request(port, 'GET', `/v1/companion/artifacts/art-big/preview?${HUB_QUERY}`, undefined, AUTH);
      expect(oversized.status).toBe(403);
      expect(oversized.body).toContain('artifact_preview_denied');
    });
  });

  it('fails closed with 503 when the relay surface is not configured', async () => {
    const bare = new ApiServer({
      companionId: DEFAULT_COMPANION_ID,
      port: await allocatePort(),
      host: '127.0.0.1',
      agentLoop: { handleMessage: vi.fn() } as unknown as SubstrateAgent,
      eventBus: new EventBus(),
      sessionManager: {
        getMessageCount: vi.fn(() => 0),
        recordUserMessage: vi.fn(),
        recordAssistantMessage: vi.fn(),
      } as unknown as SessionManager,
      apiKey: API_KEY,
      satelliteRegistry: TEST_REGISTRY,
    });
    await bare.init();
    await bare.start();
    try {
      const res = await request(
        (bare as unknown as { port: number }).port,
        'GET',
        `/v1/companion/events?${HUB_QUERY}`,
        undefined,
        AUTH,
      );
      expect(res.status).toBe(503);
      expect(res.body).toContain('companion_relay_not_configured');
    } finally {
      await stopServer(bare);
    }
  });
});
