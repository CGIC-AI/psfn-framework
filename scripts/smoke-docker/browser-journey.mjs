import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';

export async function runBrowserJourney(options) {
  const env = { ...process.env, ADMIN_TOKEN: options.adminToken,
    PSFN_SMOKE_FLEET_ORIGIN: options.fleetOrigin, PSFN_SMOKE_EVIDENCE_DIR: options.evidenceDir };
  function run(command, args) {
    const result = spawnSync(command, args, { cwd: options.repoRoot, env, stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error('Real-stack browser command failed');
  }
  options.checkpoint('browser_dependencies');
  run('npm', ['run', 'deps:ensure', '--', '--project', 'companion-ui']);
  const cli = resolve(options.repoRoot, 'companion-ui/node_modules/@playwright/test/cli.js');
  options.checkpoint('browser_install');
  run(process.execPath, [cli, 'install', 'chromium']);
  options.checkpoint('browser_journeys');
  run(process.execPath, [cli, 'test', '--config', 'companion-ui/playwright.runtime.config.ts']);
  options.report('real browser login, final reply, durable reload readback, authority isolation and logout passed');
  return { browser: 'chromium', realTransport: true };
}
