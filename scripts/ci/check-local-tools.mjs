#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const REQUIRED_UBS_VERSION = '5.3.7';

function run(executable, args) {
  try {
    return execFileSync(executable, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${executable} is unavailable or unhealthy: ${detail}`);
  }
}

export function validateToolReport({ nodeVersion, ubsVersion }) {
  const major = Number.parseInt(nodeVersion.replace(/^v/, '').split('.')[0] ?? '', 10);
  if (!Number.isInteger(major) || major < 22) {
    throw new Error(`Node >=22 is required; found ${nodeVersion || 'unknown'}`);
  }
  if (!new RegExp(`\\bv${REQUIRED_UBS_VERSION.replaceAll('.', '\\.')}\\b`).test(ubsVersion)) {
    throw new Error(`UBS ${REQUIRED_UBS_VERSION} is required; found ${ubsVersion || 'unknown'}`);
  }
}

export function checkLocalTools() {
  const report = {
    nodeVersion: process.version,
    npmVersion: run('npm', ['--version']),
    gitVersion: run('git', ['--version']),
    ghVersion: run('gh', ['--version']).split('\n')[0],
    dockerVersion: run('docker', ['version', '--format', '{{.Server.Version}}']),
    ubsVersion: run('ubs', ['--version']),
  };
  run('gh', ['auth', 'status']);
  validateToolReport(report);
  return report;
}

export function main() {
  const report = checkLocalTools();
  console.log(
    [
      `Node ${report.nodeVersion}`,
      `npm ${report.npmVersion}`,
      report.gitVersion,
      report.ghVersion,
      `Docker server ${report.dockerVersion}`,
      report.ubsVersion,
      'GitHub authentication: ready',
    ].join('\n'),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
