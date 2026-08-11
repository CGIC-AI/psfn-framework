import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

describe('values journal privacy break-glass adoption', () => {
  it('uses one browser-session ceremony while keeping locked counts and task health visible', () => {
    expect(page).toContain('JournalPrivacyBreakGlass');
    expect(page).toContain('JOURNAL_PRIVACY_TARGETS');
    expect(page).toContain('lockedPrivacyTargets');
    expect(page).toContain('rememberJournalDisclosure');
    expect(page).toContain('handleJournalDisclosure');
    expect(page).toContain('getJournalStatus()');
    expect(page).toContain('Counts and run health stay visible while journal bodies are sealed.');
    expect(page).not.toContain('getValuesData()');
    expect(page).not.toContain('getReflectionMetacognitionData()');
    expect(page).not.toContain('getReflectionDailyData()');
    expect(page).not.toContain('getReflectionJournalData()');
  });
});
