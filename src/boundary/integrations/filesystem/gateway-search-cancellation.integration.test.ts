import { fromAny } from '@total-typescript/shoehorn';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GatewayClient } from '../../gateway/client.js';
import { GatewayServer } from '../../gateway/server.js';
import { createGatewayOpsPortFromClient } from '../../gateway/gateway-ops-port.js';
import { createSocketClient, type GatewayRpcConnection } from '../../gateway/transport.js';
import { EventBus } from '../../../shared/event-bus.js';
import { createCompanionId } from '../../../shared/routing/companion-id.js';
import { isRecord } from '../../../shared/utils/types.js';
import { testShadowIntakeScreening } from '../../../test-support/intake-screening.js';
import { GatewayFilesystemOps } from './gateway-ops.js';
import { createFsTool } from './tools.js';

describe('filesystem search cancellation over the real gateway socket', () => {
  let root: string;
  let server: GatewayServer;
  let connection: GatewayRpcConnection;
  let client: GatewayClient;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'psfn-search-client-cancel-'));
    await writeFile(join(root, 'hostile.txt'), `${'a'.repeat(8_191)}!`);
    await writeFile(join(root, 'healthy.txt'), 'healthy');
    const socketPath = join(root, 'gateway.sock');
    server = new GatewayServer({
      socketPath, companionId: createCompanionId('11111111-1111-4111-8111-111111111111'),
      llmProvider: fromAny({}), embeddingService: fromAny({}),
      discordAdapter: fromAny({ id: 'discord', outbound: { textChunkLimit: 2000, sendText: async () => {} } }),
      policyConfig: { workspacePath: root },
      intakeScreeningMode: 'shadow', intakeScreening: testShadowIntakeScreening(),
      sessionHmacKeyring: { activeVersion: 'v1', keys: { v1: 'test-only-session-secret' } },
      wyomingShardRouting: { enabled: false }, eventBus: new EventBus(),
      approvalParentLabelProvider: () => 'Test Companion',
    });
    server.start();
    connection = await createSocketClient({ socketPath });
    client = new GatewayClient(connection, 1024);
  });

  afterEach(async () => {
    client.destroy();
    await server.stop();
    await rm(root, { recursive: true, force: true });
  });

  it('joins every cancelled evaluator before rejecting and immediately accepts a full healthy batch', async () => {
    let abortedReplies = 0;
    connection.onMessage(reply => {
      if (isRecord(reply) && isRecord(reply.error) && reply.error.message === 'fs search aborted') {
        abortedReplies += 1;
      }
    });
    const controllers = Array.from({ length: 4 }, () => new AbortController());
    const attacks = Promise.allSettled(controllers.map(controller => client.fsSearch({
      query: '^(a|aa)+$', mode: 'regex', glob: 'hostile.txt', signal: controller.signal,
    })));
    await delay(100);
    await expect(client.fsSearch({ query: 'healthy', mode: 'regex', glob: 'healthy.txt' }))
      .rejects.toThrow('fs search regex resources unavailable');
    controllers.forEach(controller => controller.abort());
    const cancelled = await attacks;
    const repliesWhenSettled = abortedReplies;
    const healthy = await Promise.allSettled(controllers.map(() => client.fsSearch({
      query: 'healthy', mode: 'regex', glob: 'healthy.txt',
    })));
    expect.soft(repliesWhenSettled).toBe(4);
    expect.soft(cancelled.map(result => result.status)).toEqual(['rejected', 'rejected', 'rejected', 'rejected']);
    expect.soft(cancelled).toEqual(Array.from({ length: 4 }, () => ({
      status: 'rejected', reason: expect.objectContaining({ name: 'SearchAbortedError', message: 'fs search aborted' }),
    })));
    expect(healthy).toEqual(Array.from({ length: 4 }, () => ({
      status: 'fulfilled', value: expect.objectContaining({ matches: [expect.objectContaining({ preview: 'healthy' })] }),
    })));
  });

  it.each(['pre-aborted', 'active'] as const)('withholds %s private abort reasons from every gateway-backed tool result field', async phase => {
    const tool = createFsTool(new GatewayFilesystemOps(createGatewayOpsPortFromClient(client)));
    const controller = new AbortController();
    const reason = new Error('PRIVATE-SEARCH-CANCELLATION-SENTINEL', {
      cause: { details: 'PRIVATE-SEARCH-CANCELLATION-SENTINEL' },
    });
    if (phase === 'pre-aborted') controller.abort(reason);
    const pending = tool.execute('cancelled-search', {
      action: 'search', query: '^(a|aa)+$', mode: 'regex', glob: 'hostile.txt',
    }, controller.signal);
    if (phase === 'active') {
      await delay(100);
      controller.abort(reason);
    }
    const result = await pending;
    expect.soft(JSON.stringify(result)).not.toContain('PRIVATE-SEARCH-CANCELLATION-SENTINEL');
    expect.soft(result.content).toEqual([{ type: 'text', text: 'fs failed: fs search aborted' }]);
    expect(result.details).toMatchObject({ isError: true, rawDiagnostic: 'fs search aborted' });
    expect((await client.fsSearch({ query: 'healthy', mode: 'regex', glob: 'healthy.txt' })).matches)
      .toHaveLength(1);
  });

  it('settles an aborted search when its socket disconnects before the server reply', async () => {
    const controller = new AbortController();
    const pending = client.fsSearch({
      query: '^(a|aa)+$', mode: 'regex', glob: 'hostile.txt', signal: controller.signal,
    });
    const observed = expect(pending).rejects.toMatchObject({ name: 'SearchAbortedError', message: 'fs search aborted' });
    await delay(100);
    controller.abort(new Error('PRIVATE-DISCONNECT-ABORT-REASON'));
    connection.destroy();
    await observed;
  });
});
