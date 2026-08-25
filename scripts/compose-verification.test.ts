import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertCompletedPersistedTurn,
  composeApiPrincipalId,
  composeTurnRecordPath,
  findMatchingPersistedTurn,
} from './compose-verification.js';

describe('Compose functional verification', () => {
  it('derives stable API principals without exposing the credential', () => {
    const principal = composeApiPrincipalId('test-only-api-key');
    expect(principal).toMatch(/^api-key-[0-9a-f]{24}$/u);
    expect(principal).not.toContain('test-only-api-key');
  });

  it('resolves the canonical per-companion TurnRecord path', () => {
    const root = join(tmpdir(), 'psfn-compose-verification');
    const path = composeTurnRecordPath(root, 'test-only-api-key', 'session-one');
    expect(path).toBe(join(
      root,
      'companion-data/main/state/sessions/_turn_records',
      `${encodeURIComponent(`api:${composeApiPrincipalId('test-only-api-key')}:session-one`)}.jsonl`,
    ));
  });

  it('binds the exact HTTP reply to the exact completed persisted turn', () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-compose-turn-'));
    const path = join(root, 'turn.jsonl');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, [
      JSON.stringify({
        status: 'completed',
        userMessage: { content: 'older' },
        assistantMessage: { content: 'older response' },
      }),
      JSON.stringify({
        status: 'completed',
        userMessage: { content: 'exact request' },
        assistantMessage: { content: 'exact response' },
      }),
      '{partial',
    ].join('\n'), 'utf8');

    const turn = findMatchingPersistedTurn(path, 'exact request');
    expect(() => assertCompletedPersistedTurn(turn, 'exact request', 'exact response')).not.toThrow();
    expect(() => assertCompletedPersistedTurn(turn, 'exact request', 'different')).toThrow(
      /does not match/u,
    );
  });
});
