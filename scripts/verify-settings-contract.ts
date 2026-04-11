import { verifySettingsContractGuard } from '../src/system/config/settings-contract-guard.js';

const result = verifySettingsContractGuard();

if (!result.ok) {
  console.error('Settings contract verification failed:');
  for (const error of result.errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log('Settings contract verification passed.');
