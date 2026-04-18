import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getPromptRuntimeBlockDefinition,
  getPromptRuntimeBlockIdsByClassification,
  getPromptRuntimeImmutableAnchorDefinitions,
  getPromptRuntimeRequiredBlockIds,
  PROMPT_RUNTIME_MACRO_HINTS,
  injectPromptRuntimeTokens,
  isPromptRuntimeBlockCompanionEditable,
  isPromptRuntimeBlockImmutable,
  isPromptRuntimeBlockRequired,
  orderPromptRuntimeSystemPromptSections,
  PromptRuntimeLayoutStore,
  renderPromptRuntimeTokens,
  validatePromptRuntimeEditableBlockContents,
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

const AFFECT_MACRO_TOKENS = [
  '{{runtime_affect_snapshot_present}}',
  '{{runtime_affect_mode}}',
  '{{runtime_affect_warmth}}',
  '{{runtime_affect_formality}}',
  '{{runtime_affect_energy}}',
  '{{runtime_affect_assertiveness}}',
  '{{runtime_affect_expressiveness}}',
  '{{runtime_affect_intensity}}',
  '{{runtime_affect_variability}}',
  '{{runtime_affect_control}}',
  '{{runtime_affect_display_range_min}}',
  '{{runtime_affect_display_range_max}}',
  '{{runtime_affect_valence}}',
  '{{runtime_affect_arousal}}',
  '{{runtime_affect_dominance}}',
  '{{runtime_affect_profile_intensity}}',
  '{{runtime_affect_profile_variability}}',
  '{{runtime_affect_profile_control}}',
  '{{runtime_affect_profile_display_range_min}}',
  '{{runtime_affect_profile_display_range_max}}',
  '{{runtime_affect_snapshot_vad_valence}}',
  '{{runtime_affect_snapshot_vad_arousal}}',
  '{{runtime_affect_snapshot_vad_dominance}}',
  '{{runtime_affect_snapshot_mood_valence}}',
  '{{runtime_affect_snapshot_mood_arousal}}',
  '{{runtime_affect_snapshot_mood_dominance}}',
  '{{runtime_affect_snapshot_confidence}}',
] as const;


describe('runtime prompt block schema', () => {
  it('classifies required, optional, immutable, and editable runtime blocks', () => {
    const persona = getPromptRuntimeBlockDefinition('runtime.persona_adaptation');
    const scratchpad = getPromptRuntimeBlockDefinition('runtime.scratchpad');
    const currentMessages = getPromptRuntimeBlockDefinition('session.current_messages');

    expect(persona?.schema.classification).toBe('required_runtime_aware');
    expect(isPromptRuntimeBlockRequired(persona!)).toBe(true);
    expect(isPromptRuntimeBlockCompanionEditable(persona!)).toBe(true);

    expect(scratchpad?.schema.classification).toBe('optional_runtime_aware');
    expect(isPromptRuntimeBlockRequired(scratchpad!)).toBe(false);
    expect(isPromptRuntimeBlockImmutable(scratchpad!)).toBe(false);

    expect(currentMessages?.schema.classification).toBe('immutable_provider_managed');
    expect(isPromptRuntimeBlockImmutable(currentMessages!)).toBe(true);
    expect(isPromptRuntimeBlockCompanionEditable(currentMessages!)).toBe(false);
  });

  it('exposes query helpers for follow-on save validation', () => {
    expect(getPromptRuntimeRequiredBlockIds({ includeImmutable: false })).toEqual([
      'runtime.persona_adaptation',
      'runtime.context',
      'memory.core',
      'memory.retrieval',
      'session.compaction_summary',
      'session.focus_knowledge',
      'session.continuity',
    ]);
    expect(getPromptRuntimeBlockIdsByClassification('immutable_provider_managed')).toEqual([
      'session.current_messages',
      'tools.active_schemas',
    ]);
    expect(getPromptRuntimeImmutableAnchorDefinitions().map(anchor => anchor.id)).toEqual([
      'constitution.immutable_human_safety_amendments',
      'foundation.card_backed_sections',
      'persona.card_backed_identity',
    ]);
  });

  it('reports missing and empty required companion-editable runtime blocks distinctly', () => {
    const result = validatePromptRuntimeEditableBlockContents({
      'runtime.persona_adaptation': '   ',
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      {
        id: 'runtime.persona_adaptation',
        label: 'Persona Adaptation',
        reason: 'empty',
      },
      {
        id: 'runtime.context',
        label: 'Runtime Context',
        reason: 'missing',
      },
    ]);
  });
});

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

  it('persists companion-editable runtime block content across reloads and reorder operations', () => {
    const root = makeTempDir();
    const store = new PromptRuntimeLayoutStore(join(root, 'prompt-runtime-layout.json'));

    store.setEditableBlockContent(
      'runtime.context',
      'Companion-specific runtime guidance.',
      'admin',
    );
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
    expect(reloadedStore.getEditableBlockContent('runtime.context')).toBe('Companion-specific runtime guidance.');
    expect(reloadedStore.getEditableBlockContentMap()).toMatchObject({
      'runtime.context': 'Companion-specific runtime guidance.',
    });
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

describe('prompt runtime macro hints', () => {
  it('documents the atomic affect macros with descriptions and examples', () => {
    const hintsByToken = new Map(PROMPT_RUNTIME_MACRO_HINTS.map(entry => [entry.token, entry]));

    for (const token of AFFECT_MACRO_TOKENS) {
      const hint = hintsByToken.get(token);
      expect(hint).toBeDefined();
      expect(hint?.description).toBeTruthy();
      expect(hint?.example).toBeTruthy();
    }
  });
});
