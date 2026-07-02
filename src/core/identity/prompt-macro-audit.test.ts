import { describe, expect, it } from 'vitest';
import { auditPromptMacroUsage } from './prompt-macro-audit.js';

describe('auditPromptMacroUsage (E2.5 persisted prompt safety valve)', () => {
  it('reports persisted layers using removed aliases with the canonical replacement', () => {
    const report = auditPromptMacroUsage({
      layers: [
        {
          id: 'layer-1',
          label: 'runtime:runtime.operator_custom',
          enabled: true,
          content: 'Time {{now}} / summary {{runtime_tooling_summary}} / ok {{current_datetime}}',
        },
        {
          id: 'layer-2',
          label: 'base:main',
          enabled: true,
          content: 'You are {{char}} speaking with {{user}}.',
        },
      ],
      registryEntries: [
        { key: 'memory.extraction', text: 'Extract facts. Date: {{date}}.' },
        { key: 'session.compaction.summary', text: 'Summarize by {{current_date}}.' },
      ],
    });

    expect(report.ok).toBe(false);
    expect(report.scannedLayerCount).toBe(2);
    expect(report.scannedRegistryEntryCount).toBe(2);
    expect(report.findings).toHaveLength(2);

    const layerFinding = report.findings.find(finding => finding.id === 'layer-1');
    expect(layerFinding?.source).toBe('prompt_layer');
    expect(layerFinding?.removedMacros).toEqual([
      { name: 'now', canonical: '{{current_datetime}}' },
      { name: 'runtime_tooling_summary', canonical: expect.stringContaining('runtime_tooling_active_count') },
    ]);

    const registryFinding = report.findings.find(finding => finding.id === 'memory.extraction');
    expect(registryFinding?.source).toBe('prompt_registry');
    expect(registryFinding?.removedMacros).toEqual([
      { name: 'date', canonical: '{{current_date}}' },
    ]);
  });

  it('reports unregistered macro names distinctly from removed ones', () => {
    const report = auditPromptMacroUsage({
      layers: [{
        id: 'layer-1',
        label: 'runtime:runtime.custom',
        enabled: false,
        content: '{{totally_made_up_macro}} and {{runtime_capability_tier}}',
      }],
      registryEntries: [],
    });

    expect(report.ok).toBe(false);
    expect(report.findings[0]?.removedMacros).toEqual([]);
    expect(report.findings[0]?.unregisteredMacros).toEqual(['totally_made_up_macro']);
    expect(report.findings[0]?.enabled).toBe(false);
  });

  it('returns ok for clean persisted content', () => {
    const report = auditPromptMacroUsage({
      layers: [{
        id: 'layer-1',
        label: 'runtime:runtime.state',
        enabled: true,
        content: '<runtime_state>{{runtime_chat_type}} at {{current_datetime}}</runtime_state>',
      }],
      registryEntries: [{ key: 'memory.extraction', text: 'No macros at all.' }],
    });

    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
  });
});
