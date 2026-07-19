#!/usr/bin/env tsx

// One-time companion prompt-layer migration. The apply path edits the raw JSON
// text so unknown fields, formatting, ordering, and all pre-existing bytes are
// preserved; only the missing identifier property is inserted.

import '../../shared/utils/load-dotenv.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROMPT_LAYER_IDENTIFIER_BACKFILL_COMMAND } from '../../core/identity/prompt-manager.js';
import {
  resolveConfiguredCompanionDataDir,
  resolvePromptLayersPath,
} from '../../persistence/layout.js';
import { writeFileDurableAtomicSync } from '../../shared/utils/fs.js';
import { isRecord } from '../../shared/utils/types.js';
import {
  bootstrapMaintenanceRuntime,
  isMaintenanceCliEntrypoint,
  parseCommonMaintenanceArgs,
  runMaintenanceCli,
} from './cli-harness.js';

export interface PromptLayerIdentifierBackfillEntry {
  index: number;
  layerId: string;
  layerName: string;
  location: string;
}

export interface PromptLayerIdentifierBackfillReport {
  mode: 'dry-run' | 'apply';
  layersPath: string;
  scannedLayers: number;
  identifierLessBaseLayers: number;
  updated: number;
  entries: PromptLayerIdentifierBackfillEntry[];
}

export interface PromptLayerIdentifierBackfillOptions {
  layersPath: string;
  apply?: boolean;
}

interface ObjectRange {
  start: number;
  end: number;
}

interface PlannedInsertion extends PromptLayerIdentifierBackfillEntry {
  offset: number;
  text: string;
}

function findTopLevelObjectRanges(source: string, layersPath: string): ObjectRange[] {
  const arrayStart = source.search(/\S/);
  if (arrayStart < 0 || source[arrayStart] !== '[') {
    throw new Error(`Prompt layers file must contain a JSON array (${layersPath})`);
  }

  const ranges: ObjectRange[] = [];
  let arrayDepth = 0;
  let objectDepth = 0;
  let objectStart = -1;
  let inString = false;
  let escaped = false;

  for (let index = arrayStart; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '[') {
      arrayDepth += 1;
      continue;
    }
    if (character === ']') {
      arrayDepth -= 1;
      continue;
    }
    if (character === '{') {
      if (arrayDepth === 1 && objectDepth === 0) {
        objectStart = index;
      }
      objectDepth += 1;
      continue;
    }
    if (character === '}') {
      objectDepth -= 1;
      if (arrayDepth === 1 && objectDepth === 0 && objectStart >= 0) {
        ranges.push({ start: objectStart, end: index + 1 });
        objectStart = -1;
      }
    }
  }

  return ranges;
}

function buildIdentifierInsertion(source: string, range: ObjectRange, layersPath: string): {
  offset: number;
  text: string;
} {
  let firstPropertyOffset = range.start + 1;
  while (firstPropertyOffset < range.end && /\s/.test(source[firstPropertyOffset] ?? '')) {
    firstPropertyOffset += 1;
  }
  if (source[firstPropertyOffset] !== '"') {
    throw new Error(`Prompt layer object has no property insertion point (${layersPath})`);
  }

  const propertySource = source.slice(firstPropertyOffset, range.end);
  const propertyMatch = /^"(?:\\.|[^"\\])*"(\s*):(\s*)/.exec(propertySource);
  if (!propertyMatch) {
    throw new Error(`Prompt layer object has invalid property syntax (${layersPath})`);
  }
  const keyValueSpacing = `${propertyMatch[1]}:${propertyMatch[2]}`;
  const leadingWhitespace = source.slice(range.start + 1, firstPropertyOffset);
  const newline = leadingWhitespace.includes('\r\n')
    ? '\r\n'
    : leadingWhitespace.includes('\n')
      ? '\n'
      : null;
  const fieldSeparator = newline
    ? `${newline}${leadingWhitespace.slice(leadingWhitespace.lastIndexOf('\n') + 1)}`
    : leadingWhitespace.length > 0
      ? ' '
      : '';

  return {
    offset: firstPropertyOffset,
    text: `"identifier"${keyValueSpacing}"main",${fieldSeparator}`,
  };
}

function describeLayer(
  layer: Record<string, unknown>,
  index: number,
  layersPath: string,
): PromptLayerIdentifierBackfillEntry {
  return {
    index,
    layerId: typeof layer.id === 'string' && layer.id.length > 0
      ? layer.id
      : `index:${String(index)}`,
    layerName: typeof layer.name === 'string' && layer.name.length > 0
      ? layer.name
      : `layer[${String(index)}]`,
    location: `${layersPath}#layers[${String(index)}]`,
  };
}

export function backfillPromptLayerIdentifiers(
  options: PromptLayerIdentifierBackfillOptions,
): PromptLayerIdentifierBackfillReport {
  const layersPath = resolve(options.layersPath);
  const source = existsSync(layersPath) ? readFileSync(layersPath, 'utf8') : '[]';
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(
      `Failed to parse prompt layers file ${layersPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Prompt layers file must contain a JSON array (${layersPath})`);
  }
  if (!parsed.every(isRecord)) {
    throw new Error(`Prompt layers file entries must all be JSON objects (${layersPath})`);
  }

  const ranges = findTopLevelObjectRanges(source, layersPath);
  if (ranges.length !== parsed.length) {
    throw new Error(
      `Could not map every prompt layer record to its source bytes (${layersPath}); nothing was changed`,
    );
  }

  const planned: PlannedInsertion[] = [];
  for (let index = 0; index < parsed.length; index += 1) {
    const layer = parsed[index];
    if (layer.type !== 'base') continue;

    const identifier = layer.identifier;
    if (typeof identifier === 'string' && identifier.trim().length > 0) continue;
    const description = describeLayer(layer, index, layersPath);
    if (Object.hasOwn(layer, 'identifier')) {
      throw new Error(
        `${description.location} has an identifier field that is not a non-empty string; `
        + 'the surgical backfill only adds missing fields, so nothing was changed',
      );
    }

    planned.push({
      ...description,
      ...buildIdentifierInsertion(source, ranges[index], layersPath),
    });
  }

  const apply = options.apply === true;
  if (apply && planned.length > 0) {
    let updatedSource = source;
    for (const insertion of [...planned].sort((left, right) => right.offset - left.offset)) {
      updatedSource = updatedSource.slice(0, insertion.offset)
        + insertion.text
        + updatedSource.slice(insertion.offset);
    }
    writeFileDurableAtomicSync(layersPath, updatedSource);
  }

  const entries = planned.map(({ offset: _offset, text: _text, ...entry }) => entry);
  return {
    mode: apply ? 'apply' : 'dry-run',
    layersPath,
    scannedLayers: parsed.length,
    identifierLessBaseLayers: entries.length,
    updated: apply ? entries.length : 0,
    entries,
  };
}

export function formatPromptLayerIdentifierBackfillReport(
  report: PromptLayerIdentifierBackfillReport,
): string[] {
  return [
    `Mode: ${report.mode}`,
    `Prompt layers file: ${report.layersPath}`,
    `Scanned layers: ${String(report.scannedLayers)}`,
    `Identifier-less base layers: ${String(report.identifierLessBaseLayers)}`,
    `Updated: ${String(report.updated)}`,
    ...report.entries.map(entry => (
      `- ${entry.location} id=${entry.layerId} name=${JSON.stringify(entry.layerName)} `
      + `identifier=main status=${report.mode === 'apply' ? 'updated' : 'would-update'}`
    )),
  ];
}

interface CliOptions {
  apply: boolean;
  layersPath?: string;
  showHelp: boolean;
}

function printUsage(): void {
  console.log(`Usage: ${PROMPT_LAYER_IDENTIFIER_BACKFILL_COMMAND.replace(' --apply', '')} [OPTIONS]`);
  console.log('');
  console.log('Adds identifier "main" to persisted base prompt layers that have no identifier.');
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
