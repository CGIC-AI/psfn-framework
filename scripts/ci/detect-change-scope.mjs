#!/usr/bin/env node

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { collectRangeStats } from './check-change-budget.mjs';

export function detectChangeScope(paths) {
  const matches = (pattern) => paths.some((path) => pattern.test(path));
  const adminUi = matches(/^admin-ui\//);
  const companionUi = matches(/^companion-ui\//);
  const satelliteHub = matches(
    /^(?:apps\/satellite-hub\/|docker\/satellite-hub\/|companion-ui\/src\/lib\/protocol\/)/,
  );
  const rootRuntime = matches(
    /^(?:src\/|scripts\/(?!ci\/)|package-lock\.json$|tsconfig[^/]*\.json$|vitest[^/]*\.[cm]?[jt]s$|eslint[^/]*\.[cm]?[jt]s$)/,
  );
  return {
    settings: matches(
      /^(?:\.env\.example|src\/shared\/contracts\/runtime\.ts|src\/system\/config\/|src\/system\/settings(?:\.ts|\/)|src\/operator\/garden\/.*settings|admin-ui\/src\/.*settings|scripts\/(?:verify-settings-contract|hardcoded-settings))/,
    ),
    supply_chain: matches(
      /(?:^|\/)package(?:-lock)?\.json$|(?:^|\/)Dockerfile[^/]*$|^\.github\/workflows\/|^scripts\/verify-supply-chain\./,
    ),
    admin_ui: adminUi,
    companion_ui: companionUi,
    satellite_hub: satelliteHub,
    evals: matches(/^tools\/evals\//) || rootRuntime,
    root_runtime: rootRuntime,
    clean_environment:
      rootRuntime ||
      adminUi ||
      companionUi ||
      satelliteHub ||
      matches(/^tools\/evals\//),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const baseIndex = args.indexOf('--base');
  const headIndex = args.indexOf('--head');
  const base = baseIndex === -1 ? '' : args[baseIndex + 1];
  const head = headIndex === -1 ? 'HEAD' : args[headIndex + 1];
  const { execFileSync } = await import('node:child_process');
  const stats = collectRangeStats({ base, head });
  const output = execFileSync(
    'git',
    ['diff', '--name-only', '-M', stats.base, stats.head],
    { encoding: 'utf8' },
  ).trim();
  const paths = output ? output.split('\n') : [];
  const scope = detectChangeScope(paths);
  const lines = Object.entries(scope).map(([name, enabled]) => `${name}=${String(enabled)}`);

  console.log(`Changed paths: ${paths.length}; scopes: ${lines.join(', ')}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
