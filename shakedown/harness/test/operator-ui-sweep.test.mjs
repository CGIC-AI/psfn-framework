import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const SCRIPT = fileURLToPath(new URL('../operator-ui-sweep.mjs', import.meta.url));
const BODY = 'The Trunk Dashboard overview Direct runtime tool availability Registered Prompt Soil Layered prompt composition stack Memory Browser Scoped Memory Tags Session Browser sessions Runtime configuration and tuning The Climate Identity Character identity and card data Visitors Contacts Rhythms Scheduler Prompt Monitor Skills Values Events Models Chat';

// The boundary double is deliberately limited to Playwright. The actual CLI,
// verdict calculation, artifact writer, and process exit status all run intact.
for (const mode of ['healthy', 'missing-copy', 'console-error', 'signed-out']) {
  test(`operator sweep CLI verdict: ${mode}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-ui-sweep-verdict-'));
    try {
      mkdirSync(join(root, 'node_modules', 'playwright'), { recursive: true });
      writeFileSync(join(root, 'package.json'), '{}');
      writeFileSync(join(root, 'node_modules/playwright/index.js'), `
        const mode = ${JSON.stringify(mode)};
        const body = ${JSON.stringify(BODY)};
        const newPage = async () => {
          const listeners = {};
          return {
            on: (name, callback) => { listeners[name] = callback; },
            goto: async () => { if (mode === 'console-error') listeners.console?.({ type: () => 'error', text: () => 'Fixture request failed' }); },
            waitForTimeout: async () => {}, title: async () => 'Fixture Garden',
            locator: () => ({ innerText: async () => mode === 'missing-copy' ? 'Empty route' : body }),
            getByLabel: () => ({ count: async () => 0 }),
            screenshot: async () => {}, close: async () => {},
            evaluate: async () => mode !== 'signed-out',
          };
        };
        module.exports = { devices: { 'Desktop Chrome': {} }, chromium: { launch: async () => ({ newContext: async () => ({ newPage }), close: async () => {} }) } };
      `);
      const output = join(root, 'result.json');
      const result = spawnSync(process.execPath, [SCRIPT], {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          PSFN_ADMIN_BASE: 'http://127.0.0.1:19053',
          ADMIN_TOKEN: 'fixture-secret-not-for-artifacts',
          PSFN_BROWSER_PROBE_ROOT: root,
          PSFN_SHAKEDOWN_ARTIFACT_ROOT: root,
          PSFN_UI_SWEEP_OUTPUT: output,
        },
      });
      assert.equal(result.status, mode === 'healthy' ? 0 : 1, result.stderr);
      const artifact = readFileSync(output, 'utf8');
      const report = JSON.parse(artifact);
      assert.equal(report.failures.length === 0, mode === 'healthy');
      assert.equal(artifact.includes('fixture-secret-not-for-artifacts'), false);
      if (mode === 'signed-out') assert.ok(report.failures.includes('authentication'));
      if (mode === 'console-error') assert.ok(report.pages.every(page => page.errorSignals.includes('Fixture request failed')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
