import '../../shared/utils/load-dotenv.js';
import { loadConfig } from '../../system/config/load-config.js';
import { importCharacterCardToPath } from '../../core/identity/importer.js';
import { toErrorMessage } from '../../shared/utils/errors.js';

function usage(): void {
  console.error('Usage: npm run import-character <source-path>');
}

async function main(): Promise<void> {
  const sourcePath = process.argv[2];
  if (!sourcePath) {
    usage();
    process.exit(1);
  }

  const config = loadConfig();
  if (!config.characterCardPath.trim()) {
    throw new Error('CHARACTER_CARD_PATH is not configured');
  }

  const result = importCharacterCardToPath(sourcePath, config.characterCardPath);
  console.log(`Imported "${result.card.data.name}" from ${result.sourcePath}`);
  console.log(`Detected format: ${result.containerFormat} (${result.sourceFormat}, ${result.spec})`);
  if (result.warnings.length > 0) {
    console.log(`Warnings: ${result.warnings.join('; ')}`);
  }
  console.log(`Wrote normalized card to ${result.destinationPath}`);
}

main().catch((error) => {
  const message = toErrorMessage(error);
  console.error(`Import failed: ${message}`);
  process.exit(1);
});
