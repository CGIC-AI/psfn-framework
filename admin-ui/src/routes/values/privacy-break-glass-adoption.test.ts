import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

describe('values journal privacy break-glass adoption', () => {
  it('routes every protected view through the exact-stream ceremony instead of direct GETs', () => {
    expect(page).toContain('JournalPrivacyBreakGlass');
    expect(page).toContain("stream: 'values-journal'");
    expect(page).toContain("stream: 'reflection-metacognition'");
    expect(page).toContain("stream: 'reflection-daily'");
    expect(page).toContain("stream: 'reflection-journal'");
    expect(page).toContain('{#key activePrivacyTarget.stream}');
    expect(page).toContain('handleJournalDisclosure');
    expect(page).not.toContain('getValuesData()');
    expect(page).not.toContain('getReflectionMetacognitionData()');
    expect(page).not.toContain('getReflectionDailyData()');
    expect(page).not.toContain('getReflectionJournalData()');
  });
});
