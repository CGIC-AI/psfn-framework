import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  injectPromptRuntimeTokens,
  orderPromptRuntimeSystemPromptSections,
  PromptRuntimeLayoutStore,
  renderPromptRuntimeTokens,
} from './prompt-runtime.js';

let tempDir: string | null = null;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

function makeTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'psfn-prompt-runtime-'));
  return tempDir;
}

describe('injectPromptRuntimeTokens', () => {
  const fixedNow = new Date('2026-02-20T13:45:27.000Z');

  it('injects datetime/date/time/timestamp tokens', () => {
    const input = [
      'Now: {{current_datetime}}',
      'Date: {{current_date}}',
      'Time: {{current_time}}',
      'Unix: {{unix_timestamp}}',
    ].join('\n');

    const output = injectPromptRuntimeTokens(input, { now: fixedNow });

    expect(output).toContain('Now: 2026-02-20T08:45:27.000-05:00');
    expect(output).toContain('Date: 2026-02-20');
    expect(output).toContain('Time: 08:45:27-05:00');
    expect(output).toContain('Unix: 1771595127');
  });

  it('supports function-like aliases', () => {
    const input = 'A={{now()}} B={{date()}} C={{time()}} D={{timestamp()}}';
    const output = injectPromptRuntimeTokens(input, { now: fixedNow });

    expect(output).toBe('A=2026-02-20T08:45:27.000-05:00 B=2026-02-20 C=08:45:27-05:00 D=1771595127');
  });

  it('leaves unknown placeholders untouched', () => {
    const input = 'Keep {{unknown_token}} unchanged';
    const output = injectPromptRuntimeTokens(input, { now: fixedNow });

    expect(output).toBe('Keep {{unknown_token}} unchanged');
  });

  it('reports unresolved macro tokens explicitly', () => {
    const input = 'Known={{user}} Unknown={{unknown_token}}';
    const unresolved: string[] = [];
    const output = renderPromptRuntimeTokens(input, {
      now: fixedNow,
      variables: { user: 'PrimaryUser' },
      onUnresolvedToken: (token) => unresolved.push(token),
    });

    expect(output.text).toBe('Known=PrimaryUser Unknown={{unknown_token}}');
    expect(output.unresolvedTokens).toEqual(['unknown_token']);
    expect(unresolved).toEqual(['unknown_token']);
  });

  it('reports unresolved missing dotted keys once', () => {
    const unresolved: string[] = [];
    const output = renderPromptRuntimeTokens(
      'Missing={{character.extensions.voice_style}} Repeat={{character.extensions.voice_style}}',
      {
        now: fixedNow,
        variables: {
          character: {
            name: 'Companion',
          },
        },
        onUnresolvedToken: (token) => unresolved.push(token),
      },
    );

    expect(output.text).toBe(
      'Missing={{character.extensions.voice_style}} Repeat={{character.extensions.voice_style}}',
    );
    expect(output.unresolvedTokens).toEqual(['character.extensions.voice_style']);
    expect(unresolved).toEqual(['character.extensions.voice_style']);
  });

  it('injects simple prompt variables', () => {
    const input = 'Hello {{user}}, you are speaking with {{char}} in {{channel_id}}';
    const output = injectPromptRuntimeTokens(input, {
      now: fixedNow,
      variables: {
        user: 'PrimaryUser',
        char: 'Companion',
        channel_id: 'discord:dm:primary-user',
      },
    });

    expect(output).toBe('Hello PrimaryUser, you are speaking with Companion in discord:dm:primary-user');
  });

  it('supports dotted and snake-case aliases for variables', () => {
    const input = 'Model={{model_id}} Trust={{trust_level}} Canonical={{contact.canonicalId}}';
    const output = injectPromptRuntimeTokens(input, {
      now: fixedNow,
      variables: {
        modelId: 'moonshotai/kimi-k2.5',
        trustLevel: 'primary',
        contact: {
          canonicalId: 'contact-123',
        },
      },
    });

    expect(output).toBe('Model=moonshotai/kimi-k2.5 Trust=primary Canonical=contact-123');
  });

  it('resolves nested runtime tokens introduced by variable substitution', () => {
    const input = '{{description}}';
    const output = injectPromptRuntimeTokens(input, {
      now: fixedNow,
      variables: {
        description: 'Hello {{user}}, this is {{char}}.',
        user: 'Anon',
        char: 'Companion',
      },
    });

    expect(output).toBe('Hello Anon, this is Companion.');
  });

  it('drops wrapped prompt sections whose body resolves to empty content', () => {
    const input = [
      '<current_datetime>',
      '{{runtime_current_datetime_human}}',
      '</current_datetime>',
      '',
      '<appearance_context>',
      '{{runtime_appearance_context_body}}',
      '</appearance_context>',
    ].join('\n');

    const output = injectPromptRuntimeTokens(input, {
      now: fixedNow,
      variables: {
        runtime_current_datetime_human: 'Thursday, February 20, 2026 at 8:45 AM',
        runtime_appearance_context_body: '',
      },
    });

    expect(output).toContain('<current_datetime>');
    expect(output).not.toContain('<appearance_context>');
  });

  it('persists and applies runtime system-prompt block ordering', () => {
    const root = makeTempDir();
    const store = new PromptRuntimeLayoutStore(join(root, 'prompt-runtime-layout.json'));

    store.reorderSystemPromptBlocks([
      'session.continuity',
      'memory.core',
      'memory.retrieval',
      'runtime.persona_adaptation',
      'runtime.context',
      'runtime.scratchpad',
      'session.compaction_summary',
      'session.focus_knowledge',
    ], 'admin');

    const reloadedStore = new PromptRuntimeLayoutStore(join(root, 'prompt-runtime-layout.json'));
    expect(reloadedStore.getSystemPromptBlockOrder()).toEqual([
      'session.continuity',
      'memory.core',
      'memory.retrieval',
      'runtime.persona_adaptation',
      'runtime.context',
      'runtime.scratchpad',
      'session.compaction_summary',
      'session.focus_knowledge',
    ]);

    const ordered = orderPromptRuntimeSystemPromptSections([
      { id: 'runtime.context' as const, content: 'runtime' },
      { id: 'session.continuity' as const, content: 'continuity' },
      { id: 'memory.retrieval' as const, content: 'retrieval' },
    ], reloadedStore);

    expect(ordered.map(section => section.id)).toEqual([
      'session.continuity',
      'memory.retrieval',
      'runtime.context',
    ]);
  });

  it('rejects invalid runtime block orders that do not include the full reorderable set', () => {
    const root = makeTempDir();
    const store = new PromptRuntimeLayoutStore(join(root, 'prompt-runtime-layout.json'));

    const invalidOrder = [
      'runtime.context',
      'runtime.scratchpad',
    ] as unknown as Parameters<typeof store.reorderSystemPromptBlocks>[0];
    expect(() => store.reorderSystemPromptBlocks(invalidOrder, 'admin')).toThrow(
      'systemPromptBlockOrder must include each reorderable runtime block exactly once',
    );
  });
});
