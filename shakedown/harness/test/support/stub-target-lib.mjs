#!/usr/bin/env node
// Stub of lib/target.mjs's CLI, for the shell-level revert / flip-abort tests.
// It isolates the run-live-shakedown-matrix.sh trap + fail-closed control flow
// from the HTTP contract (which target-contract.test.mjs covers) by backing the
// tier with a plain state file and recording every set-tier to a log.
//
//   get-tier        -> print the tier in STUB_STATE_FILE (fail-closed if unset)
//   set-tier <tier> -> if <tier> == STUB_FAIL_SET_TIER: log a FAIL line and exit
//                      non-zero (models an unconfirmed flip); else persist it,
//                      log an "ok" line, and print the confirmed tier.
//   check-gateway   -> "ok"
//   check-postgres  -> "ok"
//
// Env:
//   STUB_STATE_FILE      (required for get-tier/set-tier) — holds the tier
//   STUB_SETTIER_LOG     (required for set-tier)          — append-only call log
//   STUB_FAIL_SET_TIER   (optional) — a tier value whose set-tier must fail

import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';

function requireEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    process.stderr.write(`stub-target-lib: missing required env ${name}\n`);
    process.exit(1);
  }
  return value;
}

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case 'check-gateway':
  case 'check-postgres':
    process.stdout.write('ok\n');
    break;
  case 'get-tier': {
    const stateFile = requireEnv('STUB_STATE_FILE');
    const tier = readFileSync(stateFile, 'utf8').trim();
    if (tier.length === 0) {
      process.stderr.write('stub-target-lib: state file is empty\n');
      process.exit(1);
    }
    process.stdout.write(`${tier}\n`);
    break;
  }
  case 'set-tier': {
    const tier = rest[0];
    if (typeof tier !== 'string' || tier.trim().length === 0) {
      process.stderr.write('stub-target-lib: set-tier requires a tier\n');
      process.exit(2);
    }
    const stateFile = requireEnv('STUB_STATE_FILE');
    const logFile = requireEnv('STUB_SETTIER_LOG');
    const failOn = process.env.STUB_FAIL_SET_TIER;
    if (typeof failOn === 'string' && failOn.trim().length > 0 && tier === failOn) {
      appendFileSync(logFile, `set-tier ${tier} FAIL\n`);
      process.stderr.write(`stub-target-lib: forced failure flipping to '${tier}' (unconfirmed)\n`);
      process.exit(1);
    }
    writeFileSync(stateFile, `${tier}\n`);
    appendFileSync(logFile, `set-tier ${tier} ok\n`);
    process.stdout.write(`${tier}\n`);
    break;
  }
  default:
    process.stderr.write(`stub-target-lib: unknown command ${command}\n`);
    process.exit(2);
}
