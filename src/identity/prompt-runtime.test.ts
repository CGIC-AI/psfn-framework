import { describe, expect, it } from 'vitest';
import { injectPromptRuntimeTokens } from './prompt-runtime.js';

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

    expect(output).toContain('Now: 2026-02-20T13:45:27.000Z');
    expect(output).toContain('Date: 2026-02-20');
    expect(output).toContain('Time: 13:45:27Z');
    expect(output).toContain('Unix: 1771595127');
  });

  it('supports function-like aliases', () => {
    const input = 'A={{now()}} B={{date()}} C={{time()}} D={{timestamp()}}';
    const output = injectPromptRuntimeTokens(input, { now: fixedNow });

    expect(output).toBe('A=2026-02-20T13:45:27.000Z B=2026-02-20 C=13:45:27Z D=1771595127');
  });

  it('leaves unknown placeholders untouched', () => {
    const input = 'Keep {{unknown_token}} unchanged';
    const output = injectPromptRuntimeTokens(input, { now: fixedNow });

    expect(output).toBe('Keep {{unknown_token}} unchanged');
  });

  it('injects simple prompt variables', () => {
    const input = 'Hello {{user}}, you are speaking with {{char}} in {{channel_id}}';
    const output = injectPromptRuntimeTokens(input, {
      now: fixedNow,
      variables: {
        user: 'PrimaryUser',
        char: 'Purrsephone',
        channel_id: 'discord:dm:primary-user',
      },
    });

    expect(output).toBe('Hello PrimaryUser, you are speaking with Purrsephone in discord:dm:primary-user');
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
});
