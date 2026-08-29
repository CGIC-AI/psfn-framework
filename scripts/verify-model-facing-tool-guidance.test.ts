import { describe, expect, it } from 'vitest';
import {
  scanModelFacingToolGuidanceEntries,
  validateRetiredAliasAuthority,
} from './verify-model-facing-tool-guidance.js';

describe('model-facing retired tool guidance verifier', () => {
  it.each([
    ['skills/conversation/SKILL.md', 'Use `load_tools` to activate specialized tools.'],
    ['skills/web-fetch/SKILL.md', 'Prefer the top-level `web_fetch` tool for page reads.'],
    ['skills/memory-management/SKILL.md', '`memory_write` for intentional memory creation.'],
  ])('rejects callable retired guidance in %s', (path, text) => {
    expect(scanModelFacingToolGuidanceEntries([{ path, text }]).violations).toEqual([
      expect.objectContaining({ path, alias: expect.any(String) }),
    ]);
  });

  it('accepts canonical tool-plus-action guidance', () => {
    expect(scanModelFacingToolGuidanceEntries([{
      path: 'skills/example/SKILL.md',
      text: [
        'Use `toolset` with `action="list"` to inspect registered tools.',
        'Use `web` with `action="fetch"` for page reads.',
        'Use `memory` with `action="write"` for intentional memory creation.',
      ].join('\n'),
    }]).violations).toEqual([]);
  });

  it('does not treat a retired alias as its own canonical action owner', () => {
    expect(scanModelFacingToolGuidanceEntries([{
      path: 'skills/example/SKILL.md',
      text: 'Use values_add with action="values_add".',
    }]).violations).toEqual([
      expect.objectContaining({ alias: 'values_add', canonicalName: 'orient' }),
    ]);

    expect(scanModelFacingToolGuidanceEntries([{
      path: 'skills/example/SKILL.md',
      text: 'Use `orient` with `action="values_add"`.',
    }]).violations).toEqual([]);

    expect(scanModelFacingToolGuidanceEntries([{
      path: 'skills/example/SKILL.md',
      text: 'The `orient` actions are useful; call `values_add` directly.',
    }]).violations).toEqual([
      expect.objectContaining({ alias: 'values_add', canonicalName: 'orient' }),
    ]);

    expect(scanModelFacingToolGuidanceEntries([{
      path: 'skills/example/SKILL.md',
      text: 'Call `values_add` directly; use `orient` with `action="values_add"` otherwise.',
    }]).violations).toEqual([
      expect.objectContaining({ alias: 'values_add', canonicalName: 'orient' }),
    ]);
  });

  it('admits only documented retirement maps and CogSec sink identifiers', () => {
    expect(scanModelFacingToolGuidanceEntries([
      {
        path: 'docs/tool-surface.md',
        text: '`memory_write` -> `write`\n| `web_fetch` | `web` | hidden | Retired alias. |',
      },
      {
        path: 'docs/runtime/tool-surface.md',
        text: '`memory_write` -> `write`\n| `web_fetch` | `web` | hidden | Retired alias. |',
      },
      {
        path: 'docs/cognitive-security.md',
        text: '| `memory_write` | `allow` | Cognitive-security sink classification. |',
      },
      {
        path: 'docs/security/cognitive-security.md',
        text: '| `memory_write` | `allow` | Cognitive-security sink classification. |',
      },
    ]).violations).toEqual([]);
    expect(scanModelFacingToolGuidanceEntries([{
      path: 'docs/operations.md',
      text: 'Use `memory_write` to persist this value.',
    }]).violations).toHaveLength(1);
    expect(scanModelFacingToolGuidanceEntries([{
      path: 'docs/cognitive-security.md',
      text: 'The callable memory tool is `memory_write`.',
    }]).violations).toHaveLength(1);
    expect(scanModelFacingToolGuidanceEntries([{
      path: 'docs/tool-surface.md',
      text: 'Though retired, use `web_fetch` for this request.',
    }]).violations).toHaveLength(1);
  });

  it('fails closed when the canonical alias authority is empty or malformed', () => {
    expect(() => validateRetiredAliasAuthority([])).toThrow(/must not be empty/u);
    expect(() => validateRetiredAliasAuthority([
      { alias: 'memory_write', canonicalName: 'memory' },
      { alias: 'memory_write', canonicalName: 'other' },
    ])).toThrow(/duplicate retired alias/u);
  });
});
