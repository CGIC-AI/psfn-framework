// Stub Garden server for the tier-conformance-sweep test. It composes the REAL
// capability-tier owner-file contract (mirrored from stub-settings-server.mjs)
// with the tool-conformance endpoints the sweep drives, so tier-conformance-
// sweep.mjs can be exercised end to end with NO live cluster:
//
//   GET  /api/admin/settings/capabilities   -> 200 {"tier","customTokens":[…]}
//   POST /api/admin/settings/capabilities   -> form configJson=<owner JSON>;
//        200 "capability-tier.json saved" (whole-file replace).
//   PATCH /api/admin/settings {capabilityTier} -> 400 wrong_owner (rejected).
//   POST /api/admin/tool-conformance/run    -> 200 {ok:true}; optionally delayed
//        by `runDelayMs` so a test can signal the sweep mid-run.
//   GET  /api/admin/tool-conformance/latest -> 200 the configured `latestPayload`.
//
// Every route requires `Authorization: Bearer <adminToken>`. A request log lets
// tests assert the exact flip/run sequence.

import { createServer } from 'node:http';

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
  });
}

/**
 * Start the stub. Returns { baseUrl, log, getState, close }.
 *   state: { tier, customTokens }
 *   log:   [{ method, path }] in arrival order
 */
export async function startStubConformanceServer({
  tier = 'apprentice',
  customTokens = [],
  adminToken = 'stub-admin-token',
  latestPayload = { schemaVersion: 1, ranAt: 0, trigger: 'manual', results: [] },
  runDelayMs = 0,
} = {}) {
  const state = { tier, customTokens: [...customTokens] };
  const log = [];

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname.replace(/^\/companions\/[^/]+\/garden(?=\/)/u, '');
    log.push({ method: req.method, path });

    if (req.headers.authorization !== `Bearer ${adminToken}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    // OLD buggy path: PATCH the owner-mapped capabilityTier field. Rejected.
    if (req.method === 'PATCH' && path === '/api/admin/settings') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'capabilityTier is owned by capability-tier.json; edit that canonical config instead',
        validationErrors: [{ field: 'capabilityTier', code: 'wrong_owner' }],
      }));
      return;
    }

    if (path === '/api/admin/settings/capabilities') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ tier: state.tier, customTokens: state.customTokens }));
        return;
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const form = new URLSearchParams(body);
        const configJson = form.get('configJson');
        if (typeof configJson !== 'string' || configJson.trim().length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing configJson form field' }));
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(configJson);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'configJson must be valid JSON' }));
          return;
        }
        if (typeof parsed?.tier !== 'string' || parsed.tier.trim().length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'tier is required' }));
          return;
        }
        state.tier = parsed.tier;
        state.customTokens = Array.isArray(parsed.customTokens) ? parsed.customTokens : [];
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('capability-tier.json saved');
        return;
      }
    }

    if (req.method === 'POST' && path === '/api/admin/tool-conformance/run') {
      const respond = () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      };
      if (runDelayMs > 0) setTimeout(respond, runDelayMs);
      else respond();
      return;
    }

    if (req.method === 'GET' && path === '/api/admin/tool-conformance/latest') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(latestPayload));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    log,
    getState: () => ({ tier: state.tier, customTokens: [...state.customTokens] }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
