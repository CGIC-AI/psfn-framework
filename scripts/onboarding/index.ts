// ── `npm run onboard` entrypoint (psfn-framework-wckv.1.1 / wckv.1.2) ──
// Interactive, fail-closed onboarding: install-mode selection, provider/model
// selection, optional voice, optional connectivity check, then abort-safe
// generation of the canonical JSON owner files (validated against the real
// settings-contract guard) plus a .env bootstrap for secrets.

import { resolve } from 'node:path';
import { createReadlinePrompter, OnboardingAbort } from './prompter.js';
import { runOnboarding, OnboardingCancelled, resolveDefaultEnvPath } from './flow.js';
import { CompanionImportError } from './companion-import.js';

const HELP = `PSFN onboarding

Usage:
  npm run onboard [-- <options>]

Options:
  --seed-dir <dir>   Owner-file seed directory (default: ./config or $CONFIG_DIR)
  --env-path <path>  .env bootstrap path to write (default: ./.env)
  -h, --help         Show this help

Note: node's runtime reserves --env-file for its own env loader and consumes
it wherever it appears on the command line, so this installer's flag is
spelled --env-path. If you pass --env-file, node itself will try to LOAD that
file (and exit if it does not exist) before onboarding starts.

What it does:
  1. Asks the install mode — Docker Compose, Kubernetes, or local dev.
  2. Asks the LLM provider + models (and optional voice STT/TTS).
  3. Optionally runs a connectivity check against the provider.
  4. Imports an existing companion (Character Card V3, SoulMD, or plain persona
     markdown) or scaffolds a fresh one, with a preview/confirm before writing.
  5. Generates the canonical JSON owner files for the chosen mode, validated
     against the settings-contract guard, writes the companion card, and writes
     secrets to .env.

Guarantees:
  - Abort-safe: aborting at any prompt writes zero files.
  - Idempotent: an existing config offers update vs abort, never a silent overwrite.
  - Secrets are entered masked and written only to .env, never to owner files.
  - Malformed companion definitions are rejected with a specific error before
    anything is written.
`;

interface CliOptions {
  seedDir: string;
  envPath: string;
  help: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    seedDir: process.env.CONFIG_DIR?.trim() || resolve('config'),
    envPath: resolveDefaultEnvPath(),
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '--seed-dir':
        options.seedDir = resolve(requireValue(argv, ++i, arg));
        break;
      // node's runtime consumes --env-file wherever it appears on the command
      // line (its env loader is position-independent), so that spelling can
      // never reach this parser. --env-path is the collision-free flag; the
      // --env-file case stays only so any invocation shape that DOES deliver
      // it keeps working instead of erroring as unknown.
      case '--env-file':
      case '--env-path':
        options.envPath = resolve(requireValue(argv, ++i, arg));
        break;
      default:
        throw new Error(`Unknown argument: ${arg}. Run with --help for usage.`);
    }
  }
  return options;
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined) throw new Error(`Missing value for ${flag}.`);
  return value;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  const prompter = createReadlinePrompter();
  try {
    await runOnboarding({
      prompter,
      seedDir: options.seedDir,
      envPath: options.envPath,
    });
  } catch (error) {
    if (error instanceof OnboardingAbort || error instanceof OnboardingCancelled) {
      process.stderr.write(`\n${error.message}\n`);
      process.exitCode = 130;
      return;
    }
    if (error instanceof CompanionImportError) {
      process.stderr.write(`\nCompanion import rejected: ${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  } finally {
    prompter.dispose?.();
  }
}

main().catch((error) => {
  process.stderr.write(`\nOnboarding failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
