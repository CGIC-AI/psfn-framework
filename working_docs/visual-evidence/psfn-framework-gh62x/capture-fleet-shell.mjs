/**
 * Visual-evidence capture for bead psfn-framework-gh62x.
 *
 * Serves the built admin-ui SPA (admin-ui/build) with mocked fleet API
 * responses and screenshots the new /fleet narrow-rail shell at desktop and
 * mobile widths for comparison against the Magic Patterns source (project
 * gpkjwgpcw9ex6tq43nvvvd, artifact 7d5a7b67-f0c2-4aa1-b71b-e5d54f95ef12,
 * components/IconRail.tsx + pages/Cluster.tsx).
 *
 * Run from the worktree root:
 *   node working_docs/visual-evidence/psfn-framework-gh62x/capture-fleet-shell.mjs
 */
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const { chromium } = require(join(ROOT, 'companion-ui', 'node_modules', 'playwright'));

const BUILD_DIR = join(ROOT, 'admin-ui', 'build');
const OUT_DIR = fileURLToPath(new URL('.', import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.br': 'application/octet-stream',
};

const COMPANIONS = [
  {
    companionId: '11111111-1111-4111-8111-111111111111',
    displayName: 'Companion',
    health: { agentRpc: 'up', adminTransport: 'up', channels: 'up' },
    posture: {
      status: 'available',
      updatedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
      charge: { state: 'clear', utilizationPercent: 22 },
      fatigue: { state: 'clear', utilizationPercent: 8 },
    },
    gardenPath: '/companions/11111111-1111-4111-8111-111111111111/garden',
  },
  {
    companionId: '22222222-2222-4222-8222-222222222222',
    displayName: 'Vesper',
    health: { agentRpc: 'up', adminTransport: 'down', channels: 'unknown' },
    posture: {
      status: 'stale',
      updatedAt: new Date(Date.now() - 6 * 3_600_000).toISOString(),
      charge: { state: 'pressured', utilizationPercent: 71 },
      fatigue: { state: 'pressured', utilizationPercent: 44 },
    },
    gardenPath: '/companions/22222222-2222-4222-8222-222222222222/garden',
  },
  {
    companionId: '33333333-3333-4333-8333-333333333333',
    displayName: 'Hollow',
    health: { agentRpc: 'unknown', adminTransport: 'unknown', channels: 'unknown' },
    posture: { status: 'unavailable' },
    gardenPath: '/companions/33333333-3333-4333-8333-333333333333/garden',
  },
];

const PORTAL_PROJECTION = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  session: { state: 'authenticated' },
  companions: COMPANIONS,
};

const USAGE = [
  { calls: 1284, inputTokens: 4_120_000, outputTokens: 913_000, cacheReadTokens: 2_204_000, cacheWriteTokens: 61_000 },
  { calls: 402, inputTokens: 1_004_000, outputTokens: 233_000, cacheReadTokens: 501_000, cacheWriteTokens: 12_000 },
  { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
];
const COMBINED = USAGE.reduce((total, row) => ({
  calls: total.calls + row.calls,
  inputTokens: total.inputTokens + row.inputTokens,
  outputTokens: total.outputTokens + row.outputTokens,
  cacheReadTokens: total.cacheReadTokens + row.cacheReadTokens,
  cacheWriteTokens: total.cacheWriteTokens + row.cacheWriteTokens,
  totalTokens: total.totalTokens + row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens,
}), { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 });

const MODEL_USAGE_PROJECTION = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  resolvedRange: {
    range: 'today',
    timezone: 'UTC',
    sinceMs: 0,
    untilMs: 86_400_000,
    bucket: 'hour',
    boundary: '[sinceMs, untilMs)',
    calendarWeekStartsOn: 'monday',
  },
  combined: COMBINED,
  companions: COMPANIONS.map((companion, index) => ({
    companionId: companion.companionId,
    usage: { ...USAGE[index], totalTokens: USAGE[index].inputTokens + USAGE[index].outputTokens + USAGE[index].cacheReadTokens + USAGE[index].cacheWriteTokens },
  })),
};

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;

    if (path === '/v1/fleet/portal') return json(response, 200, PORTAL_PROJECTION);
    if (path === '/v1/fleet/model-usage') return json(response, 200, MODEL_USAGE_PROJECTION);
    if (path.endsWith('/api/admin/image-references')) {
      if (path.includes('22222222')) return json(response, 503, { error: 'transport down' });
      if (path.includes('33333333')) return json(response, 400, { error: 'bad request' });
      return json(response, 200, { references: [] });
    }
    if (path.startsWith('/v1/') || path.startsWith('/api/')) {
      return json(response, 404, { error: 'not mocked' });
    }

    const filePath = join(BUILD_DIR, path === '/' ? 'index.html' : path);
    try {
      const content = await readFile(filePath);
      response.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream' });
      response.end(content);
    } catch {
      const content = await readFile(join(BUILD_DIR, 'index.html'));
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(content);
    }
  })().catch((error) => {
    response.writeHead(500);
    response.end(String(error));
  });
});

await new Promise(resolveListening => server.listen(0, '127.0.0.1', resolveListening));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
await mkdir(OUT_DIR, { recursive: true });

const browser = await chromium.launch();

async function capture({ name, width, height, path, action }) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  await page.goto(`${baseUrl}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  if (action) await action(page);
  await page.screenshot({ path: join(OUT_DIR, name), fullPage: false });
  console.log(`captured ${name}`);
  await context.close();
}

await capture({ name: 'desktop-1440-info.png', width: 1440, height: 900, path: '/fleet' });
await capture({ name: 'desktop-1440-usage.png', width: 1440, height: 900, path: '/fleet?view=usage' });
await capture({ name: 'desktop-1440-firewall.png', width: 1440, height: 900, path: '/fleet?view=firewall' });
await capture({ name: 'mobile-390-info.png', width: 390, height: 844, path: '/fleet' });
await capture({
  name: 'mobile-390-drawer.png',
  width: 390,
  height: 844,
  path: '/fleet',
  action: async (page) => {
    await page.getByRole('button', { name: 'Open cluster navigation' }).click();
    await page.waitForTimeout(300);
  },
});
await capture({
  name: 'desktop-1440-overflow-check.png',
  width: 1440,
  height: 900,
  path: '/fleet',
  action: async (page) => {
    const overflow = await page.evaluate(() => (
      document.documentElement.scrollWidth - document.documentElement.clientWidth
    ));
    console.log(`desktop horizontal overflow px: ${overflow}`);
  },
});

await capture({
  name: 'mobile-390-overflow-check.png',
  width: 390,
  height: 844,
  path: '/fleet?view=usage',
  action: async (page) => {
    const overflow = await page.evaluate(() => (
      document.documentElement.scrollWidth - document.documentElement.clientWidth
    ));
    console.log(`mobile horizontal overflow px: ${overflow}`);
  },
});

await browser.close();
server.close();
console.log('done');
