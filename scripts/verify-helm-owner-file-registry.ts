import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PER_COMPANION_OWNER_FILES } from '../src/system/config/settings-contract.js';

const helpersPath = resolve('deploy/helm/psfn/templates/_helpers.tpl');
const helpers = readFileSync(helpersPath, 'utf8');
const match = helpers.match(
  /{{- define "psfn\.perCompanionOwnerFilePattern" -}}\s*([^\n]+)\s*{{- end -}}/,
);

if (!match) {
  throw new Error(`Missing generated per-companion owner-file pattern in ${helpersPath}`);
}

const helmOwnerFiles = match[1]
  .split('|')
  .map(ownerFile => ownerFile.trim())
  .filter(Boolean);
const runtimeOwnerFiles = [...PER_COMPANION_OWNER_FILES];

if (JSON.stringify(helmOwnerFiles) !== JSON.stringify(runtimeOwnerFiles)) {
  throw new Error(
    'Helm per-companion owner-file registry drifted from '
      + `PER_COMPANION_OWNER_FILES: helm=${JSON.stringify(helmOwnerFiles)} `
      + `runtime=${JSON.stringify(runtimeOwnerFiles)}`,
  );
}

console.log('Helm per-companion owner-file registry verification passed.');
