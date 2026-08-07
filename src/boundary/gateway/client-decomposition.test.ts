import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const GATEWAY_CLIENT_RATIFIED_LINE_THRESHOLD = 2_000;

describe('GatewayClient protocol-capability decomposition', () => {
  it('keeps the public facade below the ratified god-file threshold', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./client.ts', import.meta.url)),
      'utf8',
    );
    const lineCount = source.split('\n').length;

    expect(lineCount).toBeLessThan(GATEWAY_CLIENT_RATIFIED_LINE_THRESHOLD);
  });

  it('assigns transport, reverse-RPC, and session-integrity state to explicit owners', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./client.ts', import.meta.url)),
      'utf8',
    );

    expect(source).toContain("from './client/transport-runtime.js'");
    expect(source).toContain("from './client/reverse-rpc-runtime.js'");
    expect(source).toContain("from './client/session-integrity-runtime.js'");
  });
});
