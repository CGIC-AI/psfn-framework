import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  PromptRegistryStore,
  EXTRACTION_PROMPT_KEY,
  COMPACTION_SUMMARY_PROMPT_KEY,
  PROFILE_SYNTHESIS_PROMPT_KEY,
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
    store = new PromptRegistryStore(filePath, historyPath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('seeds required prompt keys when registry file is missing', () => {
    expect(existsSync(filePath)).toBe(true);
    const entries = store.list();
    expect(entries.map(e => e.key)).toEqual([
      EXTRACTION_PROMPT_KEY,
      PROFILE_SYNTHESIS_PROMPT_KEY,
      COMPACTION_SUMMARY_PROMPT_KEY,
    ]);
    expect(store.getPrompt(EXTRACTION_PROMPT_KEY)).toContain('{existing_facts}');
    expect(store.getPrompt(EXTRACTION_PROMPT_KEY)).toContain('{recent_messages}');
    expect(store.getPrompt(PROFILE_SYNTHESIS_PROMPT_KEY)).toContain('{memory_facts}');
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

  it('falls back to last known good prompts when file becomes invalid', () => {
    const knownGood = store.getPrompt(COMPACTION_SUMMARY_PROMPT_KEY);
    writeFileSync(filePath, '{"broken":', 'utf-8');
    const now = new Date(Date.now() + 1500);
    utimesSync(filePath, now, now);

    expect(store.getPrompt(COMPACTION_SUMMARY_PROMPT_KEY)).toBe(knownGood);
  });
});
