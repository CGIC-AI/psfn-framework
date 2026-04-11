import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const TEMP_DIRS: string[] = [];

afterEach(() => {
  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop();
    if (!dir) continue;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('chat-cockpit smoke harness', () => {
  it('writes a JSON report artifact for the split-runtime bootstrap and chat check', async () => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');

      if (req.method === 'GET' && url.pathname === '/api/admin/chat/bootstrap') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          canonicalContactId: 'contact-1',
          defaultSessionId: 'session-1',
          defaultAuthorId: 'author-1',
          defaultAuthorName: 'Author One',
          selectedTarget: {
            channel: 'api',
            canonicalContactId: 'contact-1',
          },
          api: {
            chatCompletionsUrl: '/v1/chat/completions',
            voiceWebSocketUrl: '/v1/voice/websocket',
          },
          runtime: {
            model: {
              id: 'companion-model',
              label: 'Companion Model',
            },
          },
        }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          model: 'companion-model',
          choices: [{
            message: {
              role: 'assistant',
              content: 'smoke ok',
            },
          }],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 3,
            total_tokens: 15,
          },
        }));
        return;
      }

      res.statusCode = 404;
      res.end('not found');
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('Smoke test server did not bind to an IPv4 port');
    }

    const tempDir = mkdtempSync(join(tmpdir(), 'psfn-smoke-report-'));
    TEMP_DIRS.push(tempDir);
    const reportPath = join(tempDir, 'smoke-report.json');
    const scriptPath = join(process.cwd(), 'scripts', 'chat-cockpit-smoke.mjs');
    const adminUrl = `http://127.0.0.1:${address.port}`;

    try {
      await execFileAsync('node', [
        scriptPath,
        '--admin-url', adminUrl,
        '--api-key', 'smoke-secret',
        '--report-path', reportPath,
        '--message', 'Smoke test message.',
      ], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PSFN_LIVE_ENV: '',
        },
        maxBuffer: 10 * 1024 * 1024,
      });

      const report = JSON.parse(readFileSync(reportPath, 'utf8')) as {
        status?: string;
        adminUrl?: string;
        bootstrap?: { canonicalContactId?: string; api?: { hasBootstrapApiKey?: boolean } };
        chat?: { contentPreview?: string; model?: string };
        voice?: { skipped?: boolean };
      };

      expect(report.status).toBe('ok');
      expect(report.adminUrl).toBe(adminUrl);
      expect(report.bootstrap?.canonicalContactId).toBe('contact-1');
      expect(report.bootstrap?.api?.hasBootstrapApiKey).toBe(false);
      expect(report.chat?.contentPreview).toContain('smoke ok');
      expect(report.chat?.model).toBe('companion-model');
      expect(report.voice?.skipped).toBe(true);
      expect(JSON.stringify(report)).not.toContain('smoke-secret');
    } finally {
      server.close();
    }
  });
});
