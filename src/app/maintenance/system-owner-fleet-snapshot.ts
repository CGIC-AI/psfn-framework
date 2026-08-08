#!/usr/bin/env tsx

import '../../shared/utils/load-dotenv.js';
import { resolve } from 'node:path';
import {
  captureSystemOwnerFleetSnapshot,
  restoreSystemOwnerFleetSnapshot,
} from '../../persistence/system-owner-fleet-snapshot.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { resolveSystemOwnerFleetContext } from './system-owner-fleet-context.js';

function optionValue(argv: string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function assertExactOptions(argv: string[], expected: ReadonlySet<string>): void {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value) continue;
    if (!value.startsWith('--')) continue;
    if (!expected.has(value)) throw new Error(`Unknown option: ${value}`);
    index += 1;
  }
}

function main(): void {
  const [command, ...argv] = process.argv.slice(2);
  if (command === 'capture') {
    assertExactOptions(argv, new Set(['--output']));
    const outputDir = resolve(optionValue(argv, '--output'));
    const { layout, fleet } = resolveSystemOwnerFleetContext(process.env);
    const result = captureSystemOwnerFleetSnapshot({
      systemDataDir: layout.systemDataDir,
      fleet,
      outputDir,
    });
    console.log(JSON.stringify({ status: 'captured', manifestPath: result.manifestPath }, null, 2));
    return;
  }
  if (command === 'restore') {
    assertExactOptions(argv, new Set(['--manifest', '--restore-runtime-root']));
    const result = restoreSystemOwnerFleetSnapshot({
      manifestPath: resolve(optionValue(argv, '--manifest')),
      restorePersistenceRoot: resolve(optionValue(argv, '--restore-runtime-root')),
    });
    console.log(JSON.stringify({ status: 'restored', ...result }, null, 2));
    return;
  }
  throw new Error(
    'Usage: system-owner-fleet-snapshot <capture --output DIR | '
    + 'restore --manifest FILE --restore-runtime-root DIR>',
  );
}

try {
  main();
} catch (error) {
  console.error(`System-owner fleet snapshot failed: ${toErrorMessage(error)}`);
  process.exit(1);
}
