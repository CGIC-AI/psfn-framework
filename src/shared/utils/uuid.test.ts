import { readdirSync, readFileSync } from 'node:fs';
import { sep } from 'node:path';
import { describe, expect, it } from 'vitest';

import { requireUuid, type UuidRejection } from './uuid.js';

class SpecializedUuidError extends Error {}

const rejectSpecialized: UuidRejection = (message) => {
  throw new SpecializedUuidError(`Specialized rejection: ${message}`);
};

function productionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}${sep}${entry.name}`;
    if (entry.isDirectory()) return productionTypeScriptFiles(path);
    return entry.isFile()
      && path.endsWith('.ts')
      && !path.endsWith('.test.ts')
      && !path.endsWith('.spec.ts')
      ? [path]
      : [];
  });
}

describe('requireUuid', () => {
  it('uses the generic Error contract and exact default diagnostic', () => {
    const uuid = '123e4567-e89b-42d3-a456-426614174000';
    expect(requireUuid(uuid, 'companionId')).toBe(uuid);

    const invalid = () => requireUuid('not-a-uuid', 'companionId');
    expect(invalid).toThrow(Error);
    expect(invalid).toThrow('companionId must be a lowercase RFC-4122 UUID');
  });

  it('preserves caller-owned rejection classes and alternate wording', () => {
    const invalid = () => requireUuid(
      'not-a-uuid',
      'companionId',
      'RFC 4122 UUID',
      rejectSpecialized,
    );
    expect(invalid).toThrow(SpecializedUuidError);
    expect(invalid).toThrow('Specialized rejection: companionId must be an RFC 4122 UUID');
  });

  it('has exactly one production function definition', () => {
    const sourceRoot = `${process.cwd()}${sep}src`;
    const definitions = productionTypeScriptFiles(sourceRoot).flatMap((path) => {
      const matches = readFileSync(path, 'utf8')
        .match(/\b(?:export\s+)?function\s+requireUuid\s*\(/gu);
      return matches?.map(() => path) ?? [];
    });

    expect(definitions).toEqual([
      `${process.cwd()}${sep}src${sep}shared${sep}utils${sep}uuid.ts`,
    ]);
  });
});
