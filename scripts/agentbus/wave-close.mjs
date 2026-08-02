#!/usr/bin/env node
// wave-close: validate a wave's agentbus run before the train publishes.
// A wave run that does not lint clean is not closed; fix by appending
// corrections, never by editing the file.
//
// Usage: node scripts/agentbus/wave-close.mjs [<run-file>]
// With no argument, lints every run file under ./bus/runs/.

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const [, , runFile] = process.argv;

let targets;
if (runFile) {
  targets = [runFile];
} else {
  // Shared bus home when AGENTBUS_DIR is set (cross-repo waves), else repo-local.
  const dir = process.env.AGENTBUS_DIR ?? join(process.cwd(), 'bus', 'runs');
  try {
    targets = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => join(dir, f));
  } catch {
    console.error(`no runs directory at ${dir}`);
    process.exit(2);
  }
  if (targets.length === 0) {
    console.error(`no run files under ${dir}`);
    process.exit(2);
  }
}

let failed = false;
for (const target of targets) {
  try {
    execFileSync('bus-lint', [target], { stdio: 'inherit' });
  } catch {
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
