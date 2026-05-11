import { describe, expect, it } from 'vitest';
import { buildRLMSystemPrompt } from './prompt.js';

describe('buildRLMSystemPrompt', () => {
  it('preserves the production prompt contract while keeping parent mutation guidance read-only by default', () => {
    const prompt = buildRLMSystemPrompt();

    expect(prompt).toContain('constrained JavaScript REPL');
    expect(prompt).toContain('out-of-process with a default-deny helper protocol');
    expect(prompt).toContain('### Repository');
    expect(prompt).toContain('`await repo_status()`');
    expect(prompt).toContain('`await repo_diff(staged?)`');
    expect(prompt).toContain('Surface that error verbatim instead of inventing placeholder branch or diff data.');
    expect(prompt).not.toContain('`await repo_apply_patch(filePath, content)`');
    expect(prompt).not.toContain('`await repo_commit(message, intent?, scope?)`');
    expect(prompt).toContain('Repository mutation is disabled in this sandbox.');
    expect(prompt).not.toContain('`await write_file(path, content)`');
    expect(prompt).toContain('Workspace writes are disabled in this sandbox.');
    expect(prompt).not.toContain('shell_exec');
    expect(prompt).not.toContain('memory_write');
    expect(prompt).not.toContain('memory_upsert');
    expect(prompt).not.toContain('session_append_note');
    expect(prompt).not.toContain('schedule_add');
    expect(prompt).not.toContain('module_install');
    expect(prompt).not.toContain('nested_analysis');
    expect(prompt).toContain('`await web("fetch", url, { prompt? })`');
    expect(prompt).toContain('`await web("browse", url, { prompt? })`');
    expect(prompt).toContain('`await web("search", query, { maxUrls? })`');
    expect(prompt).toContain('Session continuity lookup still belongs to `session_search`');
  });

  it('keeps explicitly writable sandboxes model-visible as review-only workspaces', () => {
    const prompt = buildRLMSystemPrompt(undefined, {
      allowRepoMutation: true,
      allowWorkspaceWrite: true,
    });

    expect(prompt).not.toContain('`await repo_apply_patch(filePath, content)`');
    expect(prompt).not.toContain('`await repo_commit(message, intent?, scope?)`');
    expect(prompt).not.toContain('`await write_file(path, content)`');
    expect(prompt).toContain('Repository mutation is intentionally not part of the model-visible workbench surface.');
    expect(prompt).toContain('Workspace writes are intentionally not part of the model-visible workbench surface.');
  });
});
