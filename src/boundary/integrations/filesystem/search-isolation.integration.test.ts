import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('fs.search interrupts overlapping alternation while its event loop stays responsive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'psfn-search-isolation-'));
  await writeFile(join(root, 'hostile.txt'), `${'a'.repeat(8_191)}!`);
  await writeFile(join(root, 'healthy.txt'), 'healthy');
  const serverUrl = new URL('../../gateway/server.ts', import.meta.url).href;
  const eventBusUrl = new URL('../../../shared/event-bus.ts', import.meta.url).href;
  const intakeFixtureUrl = new URL('../../../test-support/intake-screening.ts', import.meta.url).href;
  const source = String.raw`
    import { GatewayServer } from ${JSON.stringify(serverUrl)};
    import { EventBus } from ${JSON.stringify(eventBusUrl)};
    import { testShadowIntakeScreening } from ${JSON.stringify(intakeFixtureUrl)};
    import { createConnection } from 'node:net';
    import { once } from 'node:events';
    import { setTimeout } from 'node:timers/promises';
    const socketPath = ${JSON.stringify(join(root, 'gateway.sock'))};
    const server = new GatewayServer({
      socketPath, companionId: '11111111-1111-4111-8111-111111111111',
      llmProvider: {}, embeddingService: {},
      discordAdapter: { id: 'discord', outbound: { textChunkLimit: 2000, sendText: async () => {} } },
      policyConfig: { workspacePath: ${JSON.stringify(root)} },
      intakeScreeningMode: 'shadow', intakeScreening: testShadowIntakeScreening(),
      sessionHmacKeyring: { activeVersion: 'v1', keys: { v1: 'test-only-session-secret' } },
      wyomingShardRouting: { enabled: false }, eventBus: new EventBus(),
      approvalParentLabelProvider: () => 'Test Companion',
    });
    server.start();
    const connection = createConnection(socketPath);
    await once(connection, 'connect');
    connection.setEncoding('utf8');
    let buffer = '';
    const pending = new Map();
    connection.on('data', chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const reply = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        pending.get(reply.id)?.(reply);
        pending.delete(reply.id);
      }
    });
    const request = (id, params) => new Promise(resolve => {
      pending.set(id, resolve);
      connection.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'fs.search', params }) + '\n');
    });
    const heartbeat = setInterval(() => console.log('heartbeat'), 20);
    await setTimeout(50);
    console.log('search-start');
    try {
      const reply = await request(1, {
        query: '^(a|aa)+$', mode: 'regex', glob: 'hostile.txt',
      });
      console.log(reply.error ? 'search-error:' + reply.error.message : 'unexpected-success');
      const healthy = await request(2, { query: 'healthy', mode: 'regex', glob: 'healthy.txt' });
      console.log('next-search-matches:' + healthy.result?.matches.length);
    } finally {
      clearInterval(heartbeat);
      await server.stop();
    }
  `;
  try {
    const observed = await new Promise<{ output: string; expired: boolean; heartbeats: number }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      let expired = false;
      let heartbeats = 0;
      let started = false;
      let lines = '';
      let timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, 5_000);
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        output += chunk;
        lines += chunk;
        let newline: number;
        while ((newline = lines.indexOf('\n')) !== -1) {
          const line = lines.slice(0, newline);
          lines = lines.slice(newline + 1);
          if (line === 'search-start') {
            started = true;
            clearTimeout(timer);
            timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, 3_000);
          } else if (started && line === 'heartbeat') {
            heartbeats += 1;
          }
        }
      });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
      child.once('error', reject);
      child.once('close', () => {
        clearTimeout(timer);
        resolve({ output, expired, heartbeats });
      });
    });
    // Separate observations: the external deadline bounds a hung evaluator,
    // while heartbeats independently establish responsiveness during the call.
    expect.soft(observed.expired, JSON.stringify(observed)).toBe(false);
    expect.soft(observed.heartbeats, JSON.stringify(observed)).toBeGreaterThan(10);
    expect(observed.output).toContain('search-error:fs search budget exceeded: pattern took too long to evaluate and was aborted');
    expect(observed.output).toContain('next-search-matches:1');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
