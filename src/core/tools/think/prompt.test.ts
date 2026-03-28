import { describe, expect, it } from 'vitest';
import { buildRLMSystemPrompt } from './prompt.js';

describe('buildRLMSystemPrompt', () => {
  it('preserves the production prompt contract while keeping parent mutation guidance read-only by default', () => {
    const prompt = buildRLMSystemPrompt();

    expect(prompt).toContain('### Repository');
    expect(prompt).toContain('`await repo_status()`');
    expect(prompt).toContain('`await repo_diff(staged?)`');
    expect(prompt).not.toContain('`await repo_apply_patch(filePath, content)`');
    expect(prompt).not.toContain('`await repo_commit(message, intent?, scope?)`');
    expect(prompt).toContain('Repository mutation is disabled in this sandbox.');
    expect(prompt).not.toContain('`await write_file(path, content)`');
    expect(prompt).toContain('Workspace writes are disabled in this sandbox.');
  });

  it('can render mutable repository helpers for explicitly writable sandboxes', () => {
    const prompt = buildRLMSystemPrompt(undefined, {
      allowRepoMutation: true,
      allowWorkspaceWrite: true,
    });

    expect(prompt).toContain('`await repo_apply_patch(filePath, content)`');
    expect(prompt).toContain('`await repo_commit(message, intent?, scope?)`');
    expect(prompt).toContain('`await write_file(path, content)`');
  });
});
