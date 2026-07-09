#!/usr/bin/env tsx

/**
 * Supply-chain advisory check for the deliberate dependency-update workflow.
 *
 * Runs when the lockfile changes: it cross-references the (name, version) pairs
 * ADDED or CHANGED between the git HEAD lockfile and the working-tree lockfile
 * against recent OSV.dev advisories (which aggregate the GitHub Advisory
 * Database / GHSA), and fails loudly on a hit.
 *
 * This is NOT an in-app or always-on scanner. It is a gate in the pin-then-plan
 * update cycle. See docs/operations.md "Dependency update policy (pin-then-plan)".
 *
 * Usage:
 *   npm run verify:supply-chain
 *   npm run verify:supply-chain -- --allow-offline   # documented risk-accepted escape hatch
 *   npm run verify:supply-chain -- --ref <git-ref>   # compare against a ref other than HEAD
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { checkSupplyChain } from './lib/supply-chain-check.js';

const LOCKFILE_PATH = 'package-lock.json';

interface CliOptions {
  allowOffline: boolean;
  ref: string;
}

function printUsage(): void {
  console.log('Usage: tsx scripts/verify-supply-chain.ts [options]');
  console.log('');
  console.log('Cross-references lockfile changes against OSV.dev / GitHub Advisory Database.');
  console.log('Fails loudly (nonzero) on any advisory hit or unverifiable feed.');
  console.log('');
  console.log('Options:');
  console.log('  --allow-offline   Downgrade a feed outage to a loud warning (exit 0).');
  console.log('                    Only acceptable with a documented risk acceptance.');
  console.log('  --ref <git-ref>   Compare the working tree against <git-ref> (default: HEAD).');
  console.log('  -h, --help        Show this help.');
}

function parseArgs(argv: string[]): CliOptions {
  let allowOffline = false;
  let ref = 'HEAD';

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--allow-offline') {
      allowOffline = true;
      continue;
    }
    if (arg === '--ref') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('Missing value for --ref');
      }
      ref = value;
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { allowOffline, ref };
}

function readRefLockfile(ref: string): string {
  try {
    return execFileSync('git', ['show', `${ref}:${LOCKFILE_PATH}`], {
      encoding: 'utf-8',
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(
      `Unable to read ${LOCKFILE_PATH} at ${ref}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function readWorkingTreeLockfile(): string {
  const absolute = resolve(process.cwd(), LOCKFILE_PATH);
  try {
    return readFileSync(absolute, 'utf-8');
  } catch (error) {
    throw new Error(
      `Unable to read working-tree ${LOCKFILE_PATH}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Supply-chain check argument error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  let oldLockText: string;
  let newLockText: string;
  try {
    oldLockText = readRefLockfile(options.ref);
    newLockText = readWorkingTreeLockfile();
  } catch (error) {
    console.error(`Supply-chain check could not load lockfiles: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  const result = await checkSupplyChain({
    oldLockText,
    newLockText,
    fetchImpl: fetch,
    allowOffline: options.allowOffline,
  });

  if (result.status === 'no-changes') {
    console.log(result.report);
    process.exitCode = 0;
    return;
  }

  console.log(
    `Supply-chain check: ${result.changedPackages.length} changed/added package version(s) to verify against OSV.dev.`,
  );

  if (result.exitCode !== 0) {
    console.error(result.report);
    process.exitCode = result.exitCode;
    return;
  }

  console.log(result.report);
  process.exitCode = 0;
}

main().catch((error) => {
  console.error(`Supply-chain check crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
