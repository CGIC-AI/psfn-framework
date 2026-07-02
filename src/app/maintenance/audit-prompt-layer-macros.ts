import '../../shared/utils/load-dotenv.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../../system/config/load-config.js';
import {
  resolveConfiguredCompanionDataDir,
  resolvePromptLayersPath,
  resolvePromptRegistryPath,
} from '../../persistence/layout.js';
import {
  auditPromptMacroUsage,
  type PromptMacroAuditFinding,
  type PromptMacroAuditLayerInput,
  type PromptMacroAuditRegistryInput,
} from '../../core/identity/prompt-macro-audit.js';
import { isRecord } from '../../shared/utils/types.js';
import { toErrorMessage } from '../../shared/utils/errors.js';

// CLI wrapper for the E2.5 persisted prompt macro audit (report-only). Reads
// the raw persisted files directly so the scan itself never triggers store
// auto-healing or migrations.

function readJsonArray(filePath: string, description: string): unknown[] {
  if (!existsSync(filePath)) {
    return [];
  }
  const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`${description} must contain a JSON array (${filePath})`);
  }
  return parsed;
}

function readPersistedLayers(filePath: string): PromptMacroAuditLayerInput[] {
  return readJsonArray(filePath, 'Prompt layers file')
    .filter(isRecord)
    .map((layer, index) => ({
      id: typeof layer.id === 'string' ? layer.id : `index:${index}`,
      label: [
        typeof layer.type === 'string' ? layer.type : 'unknown',
        typeof layer.identifier === 'string' && layer.identifier
          ? layer.identifier
          : (typeof layer.name === 'string' ? layer.name : `layer[${index}]`),
      ].join(':'),
      ...(typeof layer.enabled === 'boolean' ? { enabled: layer.enabled } : {}),
      content: typeof layer.content === 'string' ? layer.content : '',
    }));
}

function readPersistedRegistryEntries(filePath: string): PromptMacroAuditRegistryInput[] {
  return readJsonArray(filePath, 'Prompt registry file')
    .filter(isRecord)
    .map((entry, index) => ({
      key: typeof entry.key === 'string' ? entry.key : `index:${index}`,
      text: typeof entry.text === 'string' ? entry.text : '',
    }));
}

interface CliOptions {
  layersPath?: string;
  registryPath?: string;
  json: boolean;
  showHelp: boolean;
}

function printUsage(): void {
  console.log('Usage: npm run audit:prompt-macros [-- OPTIONS]');
  console.log('');
  console.log('Scans persisted prompt layers and the prompt registry for references to');
  console.log('removed prompt macros (E2.5 macro consolidation) and unregistered macro');
  console.log('names, reporting the canonical replacement for each removed name.');
  console.log('Report only: it never rewrites prompt content.');
  console.log('');
  console.log('Options:');
  console.log('  --layers <path>     Override the prompt layers file path (default: companion-data prompt layers).');
  console.log('  --registry <path>   Override the prompt registry file path (default: companion-data prompt registry).');
  console.log('  --json              Emit the full audit report as JSON.');
  console.log('  -h, --help          Show this help message.');
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { json: false, showHelp: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.showHelp = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--layers' || arg === '--registry') {
      const value = argv[i + 1];
      if (!value) throw new Error(`Missing value for ${arg}`);
      if (arg === '--layers') options.layersPath = resolve(value);
      else options.registryPath = resolve(value);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function formatFinding(finding: PromptMacroAuditFinding): string {
  const lines = [
    `- [${finding.source}] ${finding.label} (id: ${finding.id}${finding.enabled === false ? ', disabled' : ''})`,
  ];
  for (const removed of finding.removedMacros) {
    lines.push(`    removed macro {{${removed.name}}} -> use ${removed.canonical}`);
  }
  for (const unregistered of finding.unregisteredMacros) {
    lines.push(`    unregistered macro {{${unregistered}}} (no manifest entry; will not resolve)`);
  }
  return lines.join('\n');
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (options.showHelp) {
    printUsage();
    return;
  }

  let layersPath = options.layersPath;
  let registryPath = options.registryPath;
  if (!layersPath || !registryPath) {
    const config = loadConfig();
    const companionDataDir = resolveConfiguredCompanionDataDir(config);
    layersPath ??= resolvePromptLayersPath(companionDataDir);
    registryPath ??= resolvePromptRegistryPath(companionDataDir);
  }

  const report = auditPromptMacroUsage({
    layers: readPersistedLayers(layersPath),
    registryEntries: readPersistedRegistryEntries(registryPath),
  });

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Scanned ${report.scannedLayerCount} prompt layer(s) (${layersPath})`);
    console.log(`Scanned ${report.scannedRegistryEntryCount} prompt registry entrie(s) (${registryPath})`);
    if (report.ok) {
      console.log('OK: no removed or unregistered macro references found.');
    } else {
      console.log(`Found ${report.findings.length} affected entrie(s):`);
      for (const finding of report.findings) {
        console.log(formatFinding(finding));
      }
      console.log('');
      console.log('Edit the listed layers/prompts to the canonical macros (docs/prompt-macros.md, "Removed macros").');
      console.log('Report only — nothing was rewritten.');
    }
  }

  if (!report.ok) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(`Prompt macro audit failed: ${toErrorMessage(error)}`);
  process.exit(1);
}
