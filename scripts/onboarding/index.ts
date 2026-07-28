// ── `npm run onboard` entrypoint (psfn-framework-wckv.1.1 / wckv.1.2) ──
// Interactive, fail-closed onboarding: install-mode selection, provider/model
// selection, optional voice, optional connectivity check, then abort-safe
// generation of the canonical JSON owner files (validated against the real
// settings-contract guard) plus a .env bootstrap for secrets.

import { resolve } from 'node:path';
import { createReadlinePrompter, OnboardingAbort } from './prompter.js';
import { runOnboarding, OnboardingCancelled, resolveDefaultEnvPath } from './flow.js';

const HELP = `PSFN onboarding

Usage:
  npm run onboard [-- <options>]

Options:
  --seed-dir <dir>   Owner-file seed directory (default: ./config or $CONFIG_DIR)
  --env-file <path>  .env bootstrap path to write (default: ./.env)
  -h, --help         Show this help

What it does:
  1. Asks the install mode — Docker Compose, Kubernetes, or local dev.
  2. Asks the LLM provider + models (and optional voice STT/TTS).
  3. Optionally runs a connectivity check against the provider.
  4. Generates the canonical JSON owner files for the chosen mode, validated
     against the settings-contract guard, and writes secrets to .env.

Guarantees:
  - Abort-safe: aborting at any prompt writes zero files.
  - Idempotent: an existing config offers update vs abort, never a silent overwrite.
  - Secrets are entered masked and written only to .env, never to owner files.
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
      case '--env-file':
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

  try {
    await runOnboarding({
      prompter: createReadlinePrompter(),
      seedDir: options.seedDir,
      envPath: options.envPath,
    });
  } catch (error) {
    if (error instanceof OnboardingAbort || error instanceof OnboardingCancelled) {
      process.stderr.write(`\n${error.message}\n`);
      process.exitCode = 130;
      return;
    }
    throw error;
  }
}

main().catch((error) => {
  process.stderr.write(`\nOnboarding failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
