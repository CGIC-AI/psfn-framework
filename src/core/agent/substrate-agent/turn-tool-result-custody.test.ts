// Regression pin for the turn-execution <-> turn-records import cycle.
//
// `turn-execution/contracts.ts` once imported `TurnToolResultCustodyRecord`
// from `turn-records.ts` while `turn-records.ts` imported `TurnSessionIdentity`
// back out of `turn-execution/contracts.ts`, which is a real cycle the
// repository gate rejects. The shared row now lives in its own module, and a
// type-only import is easy to reintroduce by reflex, so this asserts the two
// files still do not reach across the seam at each other.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));

function readSource(relativePath: string): string {
  return readFileSync(resolve(HERE, relativePath), 'utf8');
}

describe('turn tool-result custody record module', () => {
  it('keeps turn-execution contracts off turn-records', () => {
    const contracts = readSource('turn-execution/contracts.ts');
    expect(contracts).not.toMatch(/from '\.\.\/turn-records\.js'/u);
    expect(contracts).toMatch(
      /import type \{ TurnToolResultCustodyRecord \} from '\.\.\/turn-tool-result-custody\.js';/u,
    );
  });

  it('keeps turn-records off the turn-execution contracts for this row', () => {
    const records = readSource('turn-records.ts');
    expect(records).toMatch(
      /import type \{ TurnToolResultCustodyRecord \} from '\.\/turn-tool-result-custody\.js';/u,
    );
    expect(records).not.toMatch(/export interface TurnToolResultCustodyRecord/u);
  });

  it('holds the row in a module that imports neither side of the seam', () => {
    const shared = readSource('turn-tool-result-custody.ts');
    const imports = shared.split('\n').filter(line => line.startsWith('import'));
    expect(imports.join('\n')).not.toMatch(/turn-records\.js|turn-execution\//u);
    expect(shared).toMatch(/export interface TurnToolResultCustodyRecord/u);
  });
});
