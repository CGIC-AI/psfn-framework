import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import RawSettingsMode from './RawSettingsMode.svelte';

describe('RawSettingsMode owner-file load failures', () => {
  it('shows the section error and disables editing and saving until retry succeeds', () => {
    const rendered = render(RawSettingsMode, {
      props: {
        settingsJson: '{"runtime":true}',
        rawEditors: [{
          key: 'trust-policy',
          ownerFile: 'trust-policy.json',
          loadError: 'Failed to load trust-policy.json: 503 Service Unavailable.',
        }],
        rawSaveStatus: {},
        saving: false,
        retryingRawEditorKey: null,
        validationErrorsByField: {},
        setSettingsJson: vi.fn(),
        getRawJson: vi.fn(() => ''),
        setRawJson: vi.fn(),
        saveRawSettings: vi.fn(),
        saveRawConfig: vi.fn(),
        retryRawConfig: vi.fn(),
      },
    });

    expect(rendered.body).toContain('role="alert"');
    expect(rendered.body).toContain('Failed to load trust-policy.json: 503 Service Unavailable.');
    expect(rendered.body).toContain('Retry load');
    expect(rendered.body).toMatch(/<button[^>]*disabled[^>]*>\s*Save\s*<\/button>/);
    expect(rendered.body).toMatch(/<textarea[^>]*disabled[^>]*aria-describedby="raw-editor-trust-policy-load-error"/);
    expect(rendered.body).not.toContain('value="{}"');
  });
});
