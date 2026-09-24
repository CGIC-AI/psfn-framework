// Shadow-mode agreement and latency report (epic 4lf3r .4).
//
//   npm --prefix tools/evals run eval:decision:shadow-report -- \
//     --input /path/to/<companion>/state/decision-shadow.jsonl [--input ...] [--out report.json]
//
// Reads the content-free comparison records written in shadow mode and prints
// a per-site Markdown summary (agreement, confusion, latency p50/p95, Jev cost,
// failures). --out also writes the full JSON report. Offline: no network.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  aggregateDecisionComparison,
  parseShadowRecordsJsonl,
  renderComparisonMarkdown,
} from './aggregate.js';

function parseArgs(args: readonly string[]): { inputs: string[]; out?: string } {
  const inputs: string[] = [];
  let out: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if ((arg === '--input' || arg === '--out') && (value === undefined || value.startsWith('--'))) {
      throw new Error(`${arg} requires a path`);
    }
    if (arg === '--input') {
      inputs.push(path.resolve(value!));
      index += 1;
    } else if (arg === '--out') {
      out = path.resolve(value!);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (inputs.length === 0) throw new Error('At least one --input decision-shadow.jsonl is required');
  return { inputs, ...(out ? { out } : {}) };
}

export function runShadowReport(args: readonly string[]): string {
  const options = parseArgs(args);
  const records = options.inputs.flatMap(input => parseShadowRecordsJsonl(readFileSync(input, 'utf8'), input));
  const report = aggregateDecisionComparison(records.map(record => ({ record })));
  if (options.out) writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return renderComparisonMarkdown(report);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(runShadowReport(process.argv.slice(2)));
}
