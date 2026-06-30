import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  PromptRegistryStore,
  EXTRACTION_PROMPT_KEY,
  COMPACTION_SUMMARY_PROMPT_KEY,
  RECENT_SESSION_SUMMARY_PROMPT_KEY,
  PROFILE_SYNTHESIS_PROMPT_KEY,
  SLEEPTIME_ORIENTATION_PROMPT_KEY,
  getDefaultPromptText,
} from './prompt-registry.js';

describe('PromptRegistryStore', () => {
  let tmpDir: string;
  let filePath: string;
  let historyPath: string;
  let store: PromptRegistryStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'psfn-prompt-registry-'));
    filePath = join(tmpDir, 'prompt-registry.json');
    historyPath = join(tmpDir, 'prompt-registry-history.jsonl');
    writeFileSync(filePath, JSON.stringify([
      {
        key: EXTRACTION_PROMPT_KEY,
        text: getDefaultPromptText(EXTRACTION_PROMPT_KEY),
        description: 'Memory extraction system prompt.',
        consumers: ['src/faculties/memory/extraction.ts'],
        version: 1,
        updatedAt: new Date().toISOString(),
        updatedBy: 'system',
        checksum: 'seed',
      },
      {
        key: COMPACTION_SUMMARY_PROMPT_KEY,
        text: getDefaultPromptText(COMPACTION_SUMMARY_PROMPT_KEY),
        description: 'Session compaction system prompt used when conversation context exceeds budget.',
        consumers: ['src/core/session/manager.ts'],
        version: 1,
        updatedAt: new Date().toISOString(),
        updatedBy: 'system',
        checksum: 'seed',
      },
      {
        key: PROFILE_SYNTHESIS_PROMPT_KEY,
        text: getDefaultPromptText(PROFILE_SYNTHESIS_PROMPT_KEY),
        description: 'Canonical contact profile synthesis prompt.',
        consumers: ['src/faculties/memory/extraction.ts'],
        version: 1,
        updatedAt: new Date().toISOString(),
        updatedBy: 'system',
        checksum: 'seed',
      },
    ]), 'utf-8');
    store = new PromptRegistryStore(filePath, historyPath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('seeds the registry file when it is missing', () => {
    rmSync(filePath, { force: true });
    const seeded = new PromptRegistryStore(filePath, historyPath);

    expect(seeded.list().map(entry => entry.key)).toEqual([
      EXTRACTION_PROMPT_KEY,
      PROFILE_SYNTHESIS_PROMPT_KEY,
      SLEEPTIME_ORIENTATION_PROMPT_KEY,
      COMPACTION_SUMMARY_PROMPT_KEY,
      RECENT_SESSION_SUMMARY_PROMPT_KEY,
    ]);
    expect(seeded.getPrompt(EXTRACTION_PROMPT_KEY)).toBe(getDefaultPromptText(EXTRACTION_PROMPT_KEY));
  });

  it('seeds the extraction prompt with group-room name and macro hygiene guidance', () => {
    const prompt = getDefaultPromptText(EXTRACTION_PROMPT_KEY);

    expect(prompt).toContain('human participant(s), named speakers, and relevant relationships');
    expect(prompt).toContain('Preserve the named speaker/contact when known');
    expect(prompt).toContain('source_message_ids');
    expect(prompt).toContain('subject_name');
    expect(prompt).toContain('Use subject_name "room", "channel", "group", or "conversation"');
    expect(prompt).toContain('address_mode');
    expect(prompt).toContain('direct_to_companion|mention_of_companion|reply_to_user|overheard_room_context|system_api');
    expect(prompt).toContain('Never output raw character-card macros');
    expect(prompt).toContain('{{user}}');
    expect(prompt).toContain('{{char}}');
    expect(prompt).not.toContain('extract important facts about the user');
    expect(prompt).not.toContain('Only extract durable, user-centric facts');
    expect(prompt).not.toMatch(/the primary user/i);
  });

  it('seeds the profile synthesis prompt with target-aware attribution rules', () => {
    const prompt = getDefaultPromptText(PROFILE_SYNTHESIS_PROMPT_KEY);

    expect(prompt).toContain('Target contact:');
    expect(prompt).toContain('{target_contact}');
    expect(prompt).toContain('Do not infer aliases for the target from names merely mentioned');
    expect(prompt).toContain('If the target mentioned or discussed another person');
  });

  it('seeds the sleeptime orientation prompt without assigning companion identity or mood', () => {
    const prompt = getDefaultPromptText(SLEEPTIME_ORIENTATION_PROMPT_KEY);

    expect(prompt).toContain('Review recent conversation evidence for one channel scope');
    expect(prompt).toContain('Do not assign the companion an identity');
    expect(prompt).toContain('Do not override the character card');
    expect(prompt).toContain('"orient"');
    expect(prompt).not.toMatch(/you are an? .*assistant/i);
  });

  it('seeds the recent session summary prompt for prose summaries without tool-result dumps', () => {
    const prompt = getDefaultPromptText(RECENT_SESSION_SUMMARY_PROMPT_KEY);

    expect(prompt).toContain('one compact prose paragraph');
    expect(prompt).toContain('Do not write a transcript');
    expect(prompt).toContain('Do not repeat tool results');
    expect(prompt).not.toBe(getDefaultPromptText(COMPACTION_SUMMARY_PROMPT_KEY));
  });

  it('updates prompt text and writes history entry', () => {
    const updated = store.update(
      COMPACTION_SUMMARY_PROMPT_KEY,
      'Summarize this excerpt in 3 bullet points and preserve action items.',
      'admin',
    );
    expect(updated.version).toBe(2);
    expect(updated.updatedBy).toBe('admin');

    const history = store.getPromptHistory(COMPACTION_SUMMARY_PROMPT_KEY);
    expect(history).toHaveLength(1);
    expect(history[0].version).toBe(1);
    expect(history[0].previousText).toContain('Summarize this conversation excerpt');
    expect(history[0].newText).toContain('3 bullet points');
  });

  it('fails closed when prompt history cannot be written', () => {
    mkdirSync(historyPath);

    expect(() => {
      store.update(
        COMPACTION_SUMMARY_PROMPT_KEY,
        'Summarize this excerpt in 3 bullet points and preserve action items.',
        'admin',
      );
    }).toThrow('Failed to write prompt registry history');

    expect(store.getByKey(COMPACTION_SUMMARY_PROMPT_KEY)?.version).toBe(1);
    expect(store.getPrompt(COMPACTION_SUMMARY_PROMPT_KEY)).toBe(getDefaultPromptText(COMPACTION_SUMMARY_PROMPT_KEY));
  });

  it('rejects extraction prompt updates that remove required placeholders', () => {
    expect(() => {
      store.update(
        EXTRACTION_PROMPT_KEY,
        'Extract facts from the chat and output XML.',
        'admin',
      );
    }).toThrow('must include {existing_facts}');
  });

  it('reloads edited prompt file from disk without restart', () => {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as Array<Record<string, unknown>>;
    const nextText = 'Summarize the excerpt in one paragraph with clear timeline ordering.';
    const next = parsed.map(entry =>
      entry.key === COMPACTION_SUMMARY_PROMPT_KEY
        ? { ...entry, text: nextText, version: 7, updatedBy: 'external' }
        : entry
    );
    writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf-8');
    const now = new Date(Date.now() + 1500);
    utimesSync(filePath, now, now);

    expect(store.getPrompt(COMPACTION_SUMMARY_PROMPT_KEY)).toBe(nextText);
    expect(store.getByKey(COMPACTION_SUMMARY_PROMPT_KEY)?.version).toBe(7);
  });

  it('fails closed when the registry file becomes invalid', () => {
    writeFileSync(filePath, '{"broken":', 'utf-8');
    const now = new Date(Date.now() + 1500);
    utimesSync(filePath, now, now);

    expect(() => store.getPrompt(COMPACTION_SUMMARY_PROMPT_KEY)).toThrow('Failed to load prompt registry');
  });
});
