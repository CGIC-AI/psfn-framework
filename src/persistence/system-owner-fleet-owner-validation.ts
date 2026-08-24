import { join } from 'node:path';
import {
  CHARGE_POLICY_FILE_NAME,
  validateChargePolicyConfig,
} from '../system/config/charge-policy-config.js';
import {
  SKILLS_FILE_NAME,
  validateSkillsConfig,
} from '../system/config/skills-config.js';
import {
  readPinnedRegularFile,
  type InspectedPinnedFile,
  type PinnedDirectory,
} from './pinned-filesystem.js';

const SCHEMA_BOUND_OWNER_FILES = new Set([
  CHARGE_POLICY_FILE_NAME,
  SKILLS_FILE_NAME,
]);

function parseOwnerJson(content: Buffer, sourcePath: string): unknown {
  try {
    return JSON.parse(content.toString('utf8')) as unknown;
  } catch (error) {
    throw new Error(`Malformed JSON in migration owner ${sourcePath}: ${String(error)}`);
  }
}

export function validatePinnedMigrationOwner(
  directory: PinnedDirectory,
  ownerFile: string,
  label: string,
): InspectedPinnedFile {
  const sourcePath = join(directory.logicalPath, ownerFile);
  const pinned = readPinnedRegularFile(directory, ownerFile, label);
  if (SCHEMA_BOUND_OWNER_FILES.has(ownerFile)) {
    const raw = parseOwnerJson(pinned.content, sourcePath);
    if (ownerFile === CHARGE_POLICY_FILE_NAME) {
      validateChargePolicyConfig(raw, sourcePath);
    } else {
      validateSkillsConfig(raw, sourcePath);
    }
  }
  return {
    bytes: pinned.bytes,
    sha256: pinned.sha256,
    device: pinned.device,
    inode: pinned.inode,
    linkCount: pinned.linkCount,
    mode: pinned.mode,
  };
}
