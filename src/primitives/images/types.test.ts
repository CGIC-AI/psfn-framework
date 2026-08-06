import { describe, expect, it } from 'vitest';
import { normalizeImageWorkflowSettings } from './types.js';

describe('image workflow JSON normalization', () => {
  it('preserves the owner-file and provider-wire JSON projection', () => {
    const settings = normalizeImageWorkflowSettings({
      comfyUi: {
        create: {
          workflow: {
            observedAt: new Date('2026-08-06T12:00:00.000Z'),
            omitted: undefined,
            rows: [undefined, { label: 'kept' }],
            nested: { enabled: true },
          },
        },
      },
    });

    expect(settings.comfyUi?.create?.workflow).toEqual({
      observedAt: '2026-08-06T12:00:00.000Z',
      rows: [null, { label: 'kept' }],
      nested: { enabled: true },
    });
  });

  it('rejects unsupported cyclic workflow values', () => {
    const workflow: Record<string, unknown> = {};
    workflow.self = workflow;

    expect(() => normalizeImageWorkflowSettings({
      comfyUi: { create: { workflow } },
    })).toThrow();
  });
});
