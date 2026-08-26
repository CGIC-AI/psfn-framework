#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Complete root file graph reached by the fast eval TypeScript build and test
// entries. The scope contract test derives this graph and fails if a new root
// import is introduced without updating this manifest.
export const EVALS_INPUT_PATTERNS = Object.freeze([
  /^tools\/evals\//,
  /^src\/core\/emotion\/(?:calibration|state)\.ts$/,
  /^src\/shared\/contracts\/emotion-contracts\.ts$/,
  /^src\/shared\/utils\/(?:load-dotenv|numeric|types)\.ts$/,
]);

export function affectsEvals(paths) {
  return paths.some((path) => EVALS_INPUT_PATTERNS.some((pattern) => pattern.test(path)));
}

export function detectChangeScope(paths) {
  const matches = (pattern) => paths.some((path) => pattern.test(path));
  const adminUi = matches(/^admin-ui\//);
  const companionUi = matches(/^companion-ui\//);
  const satelliteHub = matches(
    /^(?:apps\/satellite-hub\/|docker\/satellite-hub\/|companion-ui\/src\/lib\/protocol\/)/,
  );
  const rootSourcePaths = paths.filter((path) => /^src\//.test(path));
  const rootScriptPaths = paths.filter((path) => /^scripts\/(?!ci\/)/.test(path));
  const isRootTestPath = (path) => /(?:\.test|\.test-fixtures)\.[cm]?[jt]sx?$/.test(path);
  const rootProduct = rootSourcePaths.some((path) => !isRootTestPath(path));
  const rootScriptProduct = rootScriptPaths.some((path) => !isRootTestPath(path));
  const rootToolchain = matches(
    /^(?:package-lock\.json$|tsconfig[^/]*\.json$|vitest[^/]*\.[cm]?[jt]s$|eslint[^/]*\.[cm]?[jt]s$)/,
  );
  const rootBuildContract = matches(/^(?:tsup\.config\.ts|tsconfig\.tsup\.json)$/);
  const rootRuntime = rootProduct || rootScriptProduct || rootToolchain;
  const rootTestOnly = [...rootSourcePaths, ...rootScriptPaths].some(isRootTestPath) && !rootRuntime;
  const rootValidation = rootRuntime || rootTestOnly || rootBuildContract;
  const evals = affectsEvals(paths);
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
    evals,
    root_build_contract: rootBuildContract,
    root_runtime: rootRuntime,
    root_test_only: rootTestOnly,
    root_validation: rootValidation,
    clean_environment:
      rootValidation ||
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
  if (!base) throw new Error('--base requires a commit');
  if (!head) throw new Error('--head requires a commit');
  const resolvedBase = execFileSync('git', ['merge-base', base, head], {
    encoding: 'utf8',
  }).trim();
  const resolvedHead = execFileSync('git', ['rev-parse', '--verify', `${head}^{commit}`], {
    encoding: 'utf8',
  }).trim();
  const output = execFileSync(
    'git',
    ['diff', '--name-only', '-M', resolvedBase, resolvedHead],
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
