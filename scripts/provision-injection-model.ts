// ── Provision the L1.5 intake injection-classifier model (htm9.5) ──
//
// Fetch-on-provision step for src/boundary/gateway/intake/injection-classifier.ts.
// Downloads protectai/deberta-v3-base-prompt-injection-v2 (Apache-2.0) at a
// PINNED revision, verifies every file against a pinned sha256, and writes
// atomically. The runtime classifier only ever loads from the provisioned
// local directory and never downloads — a missing provision fails startup
// with a pointer to this script.
//
// Weights are large (~704 MiB) and are deliberately NOT committed to git.
//
// Usage:
//   npm run provision:injection-model -- --dest <dir> [--dry-run]
//   (default dest: $PSFN_INJECTION_MODEL_DIR or ./models/prompt-injection-v2)

import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const MODEL_ID = 'protectai/deberta-v3-base-prompt-injection-v2';
const MODEL_REVISION = 'b722c7fcbeae674abb1a1afb170a0291a379d12e';
const DEFAULT_DEST = './models/prompt-injection-v2';

interface ProvisionFile {
  /** Path within the HF repo (the onnx/ export tree is the canonical source). */
  remotePath: string;
  /** Path within the destination model directory (transformers.js layout). */
  localPath: string;
  sha256: string;
}

/**
 * Pinned manifest. The config/tokenizer files come from the repo's onnx/
 * export subtree (published alongside the ONNX weights) and are laid out the
 * way @huggingface/transformers expects a local model directory.
 */
const PROVISION_FILES: ProvisionFile[] = [
  {
    remotePath: 'onnx/config.json',
    localPath: 'config.json',
    sha256: '3093743035223c46b1497a72e939e56fa0a50afbd7bafbf7eb8aad060b8d23f8',
  },
  {
    remotePath: 'onnx/tokenizer.json',
    localPath: 'tokenizer.json',
    sha256: '752fe5f0d5678ad563e1bd2ecc1ddf7a3ba7e2024d0ac1dba1a72975e26dff2f',
  },
  {
    remotePath: 'onnx/tokenizer_config.json',
    localPath: 'tokenizer_config.json',
    sha256: '77d3dd1a9c30397a06545251ed9274bd92e4a85feb98497eeed50c920f962274',
  },
  {
    remotePath: 'onnx/special_tokens_map.json',
    localPath: 'special_tokens_map.json',
    sha256: 'b2f1b2f15f29a6b6d9d6ea4eca1675d2c231a71477f151d48f79cc83a625ba21',
  },
  {
    remotePath: 'onnx/added_tokens.json',
    localPath: 'added_tokens.json',
    sha256: 'dc046d04c9b0ada7ae6f1dc89c465801799acdf0c9a6aab8c15a1b2d5ca4e91f',
  },
  {
    remotePath: 'onnx/model.onnx',
    localPath: path.join('onnx', 'model.onnx'),
    sha256: 'f0ea7f239f765aedbde7c9e163a7cb38a79c5b8853d3f76db5152172047b228c',
  },
];

interface ProvisionCliOptions {
  dest: string;
  dryRun: boolean;
}

function printUsage(): void {
  console.log('Usage: npm run provision:injection-model -- [options]');
  console.log('');
  console.log(`Provisions ${MODEL_ID}@${MODEL_REVISION.slice(0, 12)} (pinned, sha256-verified)`);
  console.log('for the gateway intake injection classifier.');
  console.log('');
  console.log('Options:');
  console.log(`  --dest <dir>   Destination model directory (default: $PSFN_INJECTION_MODEL_DIR or ${DEFAULT_DEST})`);
  console.log('  --dry-run      Print the resolved plan without downloading');
  console.log('  --help         Show this help');
}

function parseCliOptions(args: string[]): ProvisionCliOptions {
  let dest = process.env.PSFN_INJECTION_MODEL_DIR?.trim() || DEFAULT_DEST;
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case '--dest': {
        const value = args[index + 1]?.trim();
        if (!value) {
          throw new Error('--dest requires a value');
        }
        index += 1;
        dest = value;
        break;
      }
      case '--dry-run':
        dryRun = true;
        break;
      case '--help':
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`Unsupported option: ${arg}`);
    }
  }
  return {
    dest: path.isAbsolute(dest) ? dest : path.resolve(process.cwd(), dest),
    dryRun,
  };
}

function sha256OfFile(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

async function downloadVerified(file: ProvisionFile, destDir: string): Promise<'downloaded' | 'already-provisioned'> {
  const finalPath = path.join(destDir, file.localPath);
  if (existsSync(finalPath)) {
    const existing = sha256OfFile(finalPath);
    if (existing === file.sha256) {
      return 'already-provisioned';
    }
    throw new Error(
      `${finalPath} exists with unexpected sha256 ${existing} (want ${file.sha256}); `
      + 'refusing to overwrite — remove the file to re-provision',
    );
  }

  const url = `https://huggingface.co/${MODEL_ID}/resolve/${MODEL_REVISION}/${file.remotePath}`;
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Download failed for ${file.remotePath}: HTTP ${String(response.status)} from ${url}`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  const actual = createHash('sha256').update(body).digest('hex');
  if (actual !== file.sha256) {
    throw new Error(
      `sha256 mismatch for ${file.remotePath}: got ${actual}, want ${file.sha256} — aborting provision`,
    );
  }

  mkdirSync(path.dirname(finalPath), { recursive: true });
  const tmpPath = `${finalPath}.provision-tmp`;
  writeFileSync(tmpPath, body);
  try {
    renameSync(tmpPath, finalPath);
  } catch (error) {
    rmSync(tmpPath, { force: true });
    throw error;
  }
  return 'downloaded';
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  console.log(`[provision:injection-model] model=${MODEL_ID}`);
  console.log(`[provision:injection-model] revision=${MODEL_REVISION}`);
  console.log(`[provision:injection-model] dest=${options.dest}`);
  if (options.dryRun) {
    for (const file of PROVISION_FILES) {
      console.log(`[provision:injection-model] would fetch ${file.remotePath} -> ${file.localPath} (${file.sha256})`);
    }
    console.log('[provision:injection-model] dry-run complete');
    return;
  }
  for (const file of PROVISION_FILES) {
    const outcome = await downloadVerified(file, options.dest);
    console.log(`[provision:injection-model] ${file.localPath}: ${outcome}`);
  }
  console.log('[provision:injection-model] provision complete (all files sha256-verified)');
  console.log(`[provision:injection-model] point the gateway at modelDir=${options.dest}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[provision:injection-model] failed: ${message}`);
  process.exit(1);
});
