import { describe, expect, it } from 'vitest';
import { detectRuntimeDatetimeContradiction } from './runtime-datetime-contradiction-guard.js';

describe('runtime datetime contradiction guard', () => {
  it('detects anchors stored in final system prompt snapshots', () => {
    const result = detectRuntimeDatetimeContradiction(
      {
        finalSystemPrompt: [
          '<runtime.current_datetime authority="canonical">',
          'Thursday, March 18, 2026 at 9:30 AM',
          '</runtime.current_datetime>',
        ].join('\n'),
      },
      'The clock is off, that cannot be right.',
    );

    expect(result).toEqual({
      anchorDetected: true,
      contradictionDetected: true,
      matchedSignals: ['clock_is_off', 'cannot_be_right'],
    });
  });

  it('detects anchors stored in final system section telemetry', () => {
    const result = detectRuntimeDatetimeContradiction(
      {
        finalSystemSections: [
          {
            id: 'runtime.current_datetime',
            content: 'Thursday, March 18, 2026 at 9:30 AM',
          },
        ],
      },
      'Time is wrong. Are you sure this is right?',
    );

    expect(result).toEqual({
      anchorDetected: true,
      contradictionDetected: true,
      matchedSignals: ['time_is_wrong', 'are_you_sure'],
    });
  });

  const ANCHORED_CONTEXT = {
    finalSystemPrompt: [
      '<runtime.current_datetime authority="canonical">',
      'Thursday, March 18, 2026 at 9:30 AM',
      '</runtime.current_datetime>',
    ].join('\n'),
  };

  it('passes a non-datetime "are you sure?" reply through untouched (psfn-framework-upx0.13)', () => {
    const result = detectRuntimeDatetimeContradiction(
      ANCHORED_CONTEXT,
      'Are you sure you want me to delete all three branches? That seems drastic.',
    );

    expect(result).toEqual({
      anchorDetected: true,
      contradictionDetected: false,
      matchedSignals: [],
    });
  });

  it('passes a non-datetime "must be a bug" reply through untouched', () => {
    const result = detectRuntimeDatetimeContradiction(
      ANCHORED_CONTEXT,
      'The deploy keeps crashing on startup — it must be a bug in the loader, and that does not sound right for a clean build.',
    );

    expect(result).toEqual({
      anchorDetected: true,
      contradictionDetected: false,
      matchedSignals: [],
    });
  });

  it('still catches a genuine datetime contradiction phrased with broad signals', () => {
    const result = detectRuntimeDatetimeContradiction(
      ANCHORED_CONTEXT,
      'Are you sure? My clock says it is 9:30 AM, and that cannot be right.',
    );

    expect(result).toEqual({
      anchorDetected: true,
      contradictionDetected: true,
      matchedSignals: ['cannot_be_right', 'are_you_sure'],
    });
  });

  it('matches datetime-inherent phrases without needing extra adjacency', () => {
    const result = detectRuntimeDatetimeContradiction(
      ANCHORED_CONTEXT,
      'The clock is off.',
    );

    expect(result).toEqual({
      anchorDetected: true,
      contradictionDetected: true,
      matchedSignals: ['clock_is_off'],
    });
  });

  it('does not let a distant datetime mention convert an unrelated broad phrase', () => {
    const filler = 'Here is the summary of the refactor plan you asked about, with each module listed in order of risk and the migration steps spelled out per package so nothing gets missed along the way. '.repeat(3);
    const result = detectRuntimeDatetimeContradiction(
      ANCHORED_CONTEXT,
      `We met on Tuesday about the outage. ${filler}Are you sure you want the force-push?`,
    );

    expect(result).toEqual({
      anchorDetected: true,
      contradictionDetected: false,
      matchedSignals: [],
    });
  });
});
