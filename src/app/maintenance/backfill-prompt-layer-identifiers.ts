#!/usr/bin/env tsx

import '../../shared/utils/load-dotenv.js';
import { resolve } from 'node:path';
import { PROMPT_LAYER_IDENTIFIER_BACKFILL_COMMAND } from '../../core/identity/prompt-layer-identifier-contract.js';
import {
  resolveConfiguredCompanionDataDir,
  resolvePromptLayersPath,
} from '../../persistence/layout.js';
import {
  backfillPromptLayerIdentifiers,
  formatPromptLayerIdentifierBackfillReport,
  type PromptLayerIdentifierBackfillReport,
} from './prompt-layer-identifier-backfill.js';
import {
  bootstrapMaintenanceRuntime,
  isMaintenanceCliEntrypoint,
  parseCommonMaintenanceArgs,
  runMaintenanceCli,
} from './cli-harness.js';

interface CliOptions {
  apply: boolean;
  layersPath?: string;
  showHelp: boolean;
}

function printUsage(): void {
  console.log(`Usage: ${PROMPT_LAYER_IDENTIFIER_BACKFILL_COMMAND.replace(' --apply', '')} [OPTIONS]`);
  console.log('');
  console.log('Adds identifier "main" to a persisted base prompt layer that has no identifier.');
  console.log('Dry-run is the default. Apply mode inserts only the missing JSON property.');
  console.log('');
  console.log('Options:');
  console.log('  --apply             Apply the backfill. Without this, only report.');
  console.log('  --layers <path>     Override the prompt layers file path.');
  console.log('  -h, --help          Show this help message.');
}

function parseArgs(argv: readonly string[]): CliOptions {
  return parseCommonMaintenanceArgs<CliOptions>(argv, {
    initial: { apply: false, showHelp: false },
    extraFlags: {
      '--apply': ({ options }) => {
        options.apply = true;
      },
      '--layers': ({ options, readValue }) => {
        options.layersPath = resolve(readValue());
      },
    },
  });
}

async function run(options: CliOptions): Promise<PromptLayerIdentifierBackfillReport> {
  let layersPath = options.layersPath;
  if (!layersPath) {
    const { config } = await bootstrapMaintenanceRuntime({ hydrateSecrets: false });
    const companionDataDir = resolveConfiguredCompanionDataDir(config);
    layersPath = resolvePromptLayersPath(companionDataDir);
  }

  const report = backfillPromptLayerIdentifiers({
    layersPath,
    apply: options.apply,
  });
  for (const line of formatPromptLayerIdentifierBackfillReport(report)) {
    console.log(line);
  }
  return report;
}

if (isMaintenanceCliEntrypoint(import.meta.url)) {
  void runMaintenanceCli({
    label: 'Prompt layer identifier backfill',
    parseArgs,
    printUsage,
    run,
  });
}
