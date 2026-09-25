import { describe, expect, it } from 'vitest';
import {
  buildStackEntries,
  canDeleteLayer,
  creatableLayerTypes,
  isProtected,
  operatorIdentifierError,
} from './page-helpers';

describe('prompt stack token counts', () => {
  it('uses backend-provided counts for fixed prompt previews without estimating locally', () => {
    const entries = buildStackEntries({
      constitutionPreviewText: 'constitution',
      constitutionTokenCount: 17,
      constitutionImmutableBlockCount: 1,
      northStarPreviewText: 'north star',
      northStarTokenCount: 9,
      northStarActiveCount: 1,
      northStarLimit: 3,
      sortedLayers: [],
      orderedRuntimeBlocks: [],
    });

    expect(entries.map(entry => entry.kind === 'fixed' ? entry.fixed.tokenCount : null))
      .toEqual([17, 9]);
  });
});

describe('operator prompt layer UI gating (psfn-framework-cavke)', () => {
  const operatorLayer = (updatedBy: string) => ({
    id: 'layer-operator',
    type: 'operator',
    name: 'Briefing',
    identifier: 'operator.briefing',
    content: 'Stay concise.',
    enabled: true,
    priority: 0,
    updatedAt: '2026-09-25T00:00:00.000Z',
    updatedBy,
    checksum: 'abc',
    version: 1,
  }) as unknown as import('$lib/types').PromptLayer;

  it('offers the operator type only to operator writers', () => {
    expect(creatableLayerTypes(false)).toEqual(['runtime', 'channel', 'task']);
    expect(creatableLayerTypes(true)).toContain('operator');
  });

  it('locks operator layers for non-writers and lets writers delete only operator-authored ones', () => {
    expect(isProtected(operatorLayer('admin'), false)).toBe(true);
    expect(isProtected(operatorLayer('admin'), true)).toBe(false);
    expect(canDeleteLayer(operatorLayer('admin'), true)).toBe(true);
    expect(canDeleteLayer(operatorLayer('admin'), false)).toBe(false);
    expect(canDeleteLayer(operatorLayer('system:temporal-rules-seed'), true)).toBe(false);
    expect(canDeleteLayer({ ...operatorLayer('admin'), type: 'runtime' }, true)).toBe(false);
  });

  it('mirrors the server operator identifier rule', () => {
    expect(operatorIdentifierError('operator.briefing')).toBeNull();
    expect(operatorIdentifierError('')).toMatch(/operator\./u);
    expect(operatorIdentifierError('briefing')).toMatch(/operator\.briefing/u);
    expect(operatorIdentifierError('operator.temporal_rules')).toMatch(/reserved/u);
  });
});
