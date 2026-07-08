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
});
