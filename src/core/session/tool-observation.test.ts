import { describe, expect, it } from 'vitest';
import {
  formatToolObservationForContext,
  MASKED_TOOL_OBSERVATION_CONTENT,
  normalizeToolObservation,
} from './tool-observation.js';

describe('tool observation context shaping', () => {
  it('keeps concise natural-language tool outcomes inline in context', () => {
    const observation = normalizeToolObservation({
      toolName: 'search_logs',
      content: 'Found 3 matching log entries.',
    });

    expect(observation.metadata.contextDisplayMode).toBe('full');
    expect(observation.metadata.contextSummary).toBe('Found 3 matching log entries.');
    expect(observation.metadata.maskedContextSummary).toBe('Captured 1 line of text output.');
    expect(formatToolObservationForContext(observation.content, observation.metadata)).toBe(
      '[Tool result: search_logs] Found 3 matching log entries.',
    );
  });

  it('summarizes structured machine payloads for chat context', () => {
    const observation = normalizeToolObservation({
      toolName: 'search_logs',
      content: JSON.stringify({
        status: 'ok',
        total: 2,
        matches: [{ id: 'a' }, { id: 'b' }],
      }),
    });

    expect(observation.metadata.contextDisplayMode).toBe('summary');
    expect(observation.metadata.contextSummary).toBe(
      'Returned JSON object: status=ok; total=2; matches=2.',
    );
    expect(observation.metadata.maskedContextSummary).toBe(
      'Returned JSON object: status=ok; total=2; matches=2.',
    );
    expect(formatToolObservationForContext(observation.content, observation.metadata)).toBe(
      '[Tool result: search_logs] Returned JSON object: status=ok; total=2; matches=2.',
    );
    expect(formatToolObservationForContext(MASKED_TOOL_OBSERVATION_CONTENT, observation.metadata)).toBe(
      '[Tool result: search_logs] Returned JSON object: status=ok; total=2; matches=2.',
    );
  });

  it('replaces credential-like raw values with a safe summary', () => {
    const secret = 'sk-live-leak-audit-sentinel';
    const observation = normalizeToolObservation({
      toolName: 'diagnostic_dump',
      content: `raw token: ${secret}`,
    });

    expect(observation.metadata.contextDisplayMode).toBe('summary');
    expect(observation.metadata.contextSummary).toBe(
      'Captured 1 line of text output with credential-like values omitted.',
    );
    expect(observation.metadata.maskedContextSummary).toBe(
      'Captured 1 line of text output with credential-like values omitted.',
    );

    const rendered = formatToolObservationForContext(observation.content, observation.metadata);
    expect(rendered).toBe(
      '[Tool result: diagnostic_dump] Captured 1 line of text output with credential-like values omitted.',
    );
    expect(rendered).not.toContain(secret);
  });

  it('summarizes stale masked tool dumps while keeping current-turn dumps verbatim', () => {
    const rawDump = 'Orientation note: keep the trust policy lane isolated.';
    const observation = normalizeToolObservation({
      toolName: 'orientation_dump',
      content: rawDump,
    });

    expect(observation.metadata.contextDisplayMode).toBe('full');
    expect(formatToolObservationForContext(observation.content, observation.metadata)).toBe(
      '[Tool result: orientation_dump] Orientation note: keep the trust policy lane isolated.',
    );
    expect(formatToolObservationForContext(MASKED_TOOL_OBSERVATION_CONTENT, observation.metadata)).toBe(
      '[Tool result: orientation_dump] Captured 1 line of text output.',
    );
    expect(formatToolObservationForContext(MASKED_TOOL_OBSERVATION_CONTENT, observation.metadata)).not.toContain(rawDump);
  });
});
