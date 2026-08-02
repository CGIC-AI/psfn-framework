#!/usr/bin/env node
// wave-open: open one agentbus run for a multi-lane wave and print a
// ready-to-paste bus block for each lane's brief. The dispatcher runs this
// BEFORE spawning lanes so every lane wakes up with the run already open.
// Single-lane work does not get a bus; a bus with one writer is overhead
// with no reader.
//
// Usage: node scripts/agentbus/wave-open.mjs <wave-name> <lane-a> <lane-b> [...]
//
// Requires the bus wrappers on PATH (~/.local/bin/bus-*). Exit 2 on usage
// error; nonzero from any bus command aborts with that command's error.

import { execFileSync } from 'node:child_process';

const [, , waveName, ...lanes] = process.argv;

if (!waveName || lanes.length < 2 || lanes.some((l) => !/^[a-z0-9][a-z0-9-]*$/.test(l))) {
  console.error('usage: node scripts/agentbus/wave-open.mjs <wave-name> <lane-a> <lane-b> [...]');
  console.error('lane names: lowercase letters, digits, dashes; at least two lanes');
  process.exit(2);
}

const runPath = execFileSync('bus-new', [`wave-${waveName}`], { encoding: 'utf8' }).trim();

execFileSync('bus-append', [
  runPath, '--agent', 'orchestrator', '--type', 'note',
  '--body', JSON.stringify({
    text: `Wave ${waveName} opened with lanes: ${lanes.join(', ')}. Each lane appends findings, ranks, questions, handoffs, and costs as it works; lint before close.`,
  }),
], { stdio: ['ignore', 'ignore', 'inherit'] });

console.log(`run: ${runPath}\n`);
for (const lane of lanes) {
  console.log(`--- brief block: ${lane} ---`);
  console.log(`This wave shares one agentbus run: ${runPath}`);
  console.log(`Your bus agent name is \`${lane}\`. Append as you work:`);
  console.log(`  bus-append ${runPath} --agent ${lane} --type finding --body '{"id":"<id>","claim":"...","provenance":"computed|fetched|recalled|testimony","evidence":"...","refs":["..."]}'`);
  console.log('Findings need provenance; computed findings need inspectable refs. Corrections are appends (corrects/supersedes/retracts), never rewrites. Close substantial work with a cost line. The AGENTS.md "agent bus" section holds the full practice.');
  console.log('');
}
