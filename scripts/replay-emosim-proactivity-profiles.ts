import { readFileSync } from 'node:fs';

import { replayEmoSimProactivityProfiles } from '../src/core/emotion/emosim-proactivity-replay.js';

const USAGE = [
  'Usage: npm run replay:emosim-proactivity -- --baseline <profile.json> --candidate <profile.json> --corpus <corpus.json>',
  '',
  'Profiles are canonical thresholdProfile objects. The corpus must be content-redacted',
  'and contain event_direction, mood_trajectory, and outreach_timing lanes.',
].join('\n');

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const baselinePath = option(args, '--baseline');
  const candidatePath = option(args, '--candidate');
  const corpusPath = option(args, '--corpus');
  const report = await replayEmoSimProactivityProfiles({
    baseline: readJson(baselinePath),
    candidate: readJson(candidatePath),
    corpus: readJson(corpusPath),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1]?.trim() : '';
  if (!value) throw new Error(`Missing ${name}\n\n${USAGE}`);
  return value;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `Unable to read replay input ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
