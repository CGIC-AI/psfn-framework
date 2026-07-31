// Stub Garden settings API that mirrors the REAL capability-tier contract, so
// the harness tier-flip is tested against the same shapes the live Garden
// enforces (verified empirically against the k3d cluster, 2026-07-17):
//
//   GET  /api/admin/settings/capabilities -> 200 JSON {"tier","customTokens":[…]}
//        (the raw capability-tier.json owner object the runtime hot-reloads).
//   POST /api/admin/settings/capabilities  -> form field configJson=<full owner
//        JSON>; 200 text "capability-tier.json saved". Rewrites the whole file,
//        so a flip that drops customTokens is a data-loss bug this stub exposes.
//   PATCH /api/admin/settings {capabilityTier} -> 400 wrong_owner. capabilityTier
//        is an owner-mapped field rejected by validateSettingsPayload before any
//        mutation — the OLD (buggy) flip path. This stub 400s it so a regression
//        back to PATCH fails the test.
//
// Every route requires `Authorization: Bearer <adminToken>`. The server records
// a request log so tests can assert which path the flip actually used.

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
export async function startStubSettingsServer({
  tier = 'apprentice',
  customTokens = [],
  adminToken = 'stub-admin-token',
  transientCapabilityReadFailures = 0,
} = {}) {
  const state = { tier, customTokens: [...customTokens] };
  const log = [];
  let remainingCapabilityReadFailures = transientCapabilityReadFailures;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    log.push({ method: req.method, path: url.pathname });

    const auth = req.headers.authorization;
    if (auth !== `Bearer ${adminToken}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    // OLD buggy path: PATCH the owner-mapped capabilityTier field. Rejected.
    if (req.method === 'PATCH' && url.pathname === '/api/admin/settings') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'capabilityTier is owned by capability-tier.json; edit that canonical config instead',
        validationErrors: [{ field: 'capabilityTier', code: 'wrong_owner' }],
      }));
      return;
    }

    if (url.pathname === '/api/admin/settings/capabilities') {
      if (req.method === 'GET') {
        if (remainingCapabilityReadFailures > 0) {
          remainingCapabilityReadFailures -= 1;
          res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'transient upstream failure' }));
          return;
        }
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
        // Whole-file replace, exactly like saveCapabilityTier.
        state.tier = parsed.tier;
        state.customTokens = Array.isArray(parsed.customTokens) ? parsed.customTokens : [];
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('capability-tier.json saved');
        return;
      }
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
