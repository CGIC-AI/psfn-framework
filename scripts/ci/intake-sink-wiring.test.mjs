import assert from 'node:assert/strict';
import test from 'node:test';
import {
  verifyIntakeSinkWiring,
} from '../verify-intake-sink-wiring.mjs';

const CONTRACT_PATH = 'src/shared/contracts/intake-envelope.ts';

function sourceTree(overrides = {}) {
  return {
    [CONTRACT_PATH]: `
      export const INTAKE_SINKS = [
        'prompt_assembly',
        'memory_write',
      ] as const;
    `,
    'src/prompt.ts': "gate.evaluate('prompt_assembly', envelopes)",
    'src/memory.ts': "gate.evaluate('memory_write', envelopes)",
    ...overrides,
  };
}

const DIRECT_CATALOG = {
  prompt_assembly: [{ file: 'src/prompt.ts', pattern: /gate\.evaluate\(\s*['"]prompt_assembly['"]/u }],
  memory_write: [{ file: 'src/memory.ts', pattern: /gate\.evaluate\(\s*['"]memory_write['"]/u }],
};

test('accepts one real wired gate call site for every canonical IntakeSink', () => {
  assert.deepEqual(verifyIntakeSinkWiring({
    readFile: file => sourceTree()[file],
    catalog: DIRECT_CATALOG,
  }), ['prompt_assembly', 'memory_write']);
});

test('fails when the canonical IntakeSink vocabulary grows without wiring evidence', () => {
  assert.throws(() => verifyIntakeSinkWiring({
    readFile: file => sourceTree({
      [CONTRACT_PATH]: `
        export const INTAKE_SINKS = [
          'prompt_assembly',
          'memory_write',
          'new_sink',
        ] as const;
      `,
    })[file],
    catalog: DIRECT_CATALOG,
  }), /missing wiring evidence: new_sink/u);
});

test('fails when a catalogued sink loses its production gate call site', () => {
  assert.throws(() => verifyIntakeSinkWiring({
    readFile: file => sourceTree({ 'src/memory.ts': 'memory write without a gate' })[file],
    catalog: DIRECT_CATALOG,
  }), /memory_write.*src\/memory\.ts/u);
});

test('requires an architectural justification for indirect sink wiring', () => {
  assert.throws(() => verifyIntakeSinkWiring({
    readFile: file => sourceTree()[file],
    catalog: {
      ...DIRECT_CATALOG,
      memory_write: [{
        file: 'src/memory.ts',
        pattern: /gate\.evaluate/u,
        indirect: true,
        justification: '   ',
      }],
    },
  }), /memory_write.*indirect wiring evidence requires a justification/u);
});
