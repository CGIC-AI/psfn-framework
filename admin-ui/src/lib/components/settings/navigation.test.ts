import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  isSettingsSimpleSectionId,
  parseSettingsSimpleSectionHash,
  settingsSimpleSectionAnchorId,
  settingsSimpleSectionHref,
} from './navigation.ts';

test('section anchors and hrefs use the settings- prefix', () => {
  assert.equal(settingsSimpleSectionAnchorId('memory-budget'), 'settings-memory-budget');
  assert.equal(settingsSimpleSectionHref('memory-budget'), '#settings-memory-budget');
});

test('section id guard accepts only known settings sections', () => {
  assert.equal(isSettingsSimpleSectionId('memory-budget'), true);
  assert.equal(isSettingsSimpleSectionId('owner-files'), true);
  assert.equal(isSettingsSimpleSectionId('missing'), false);
});

test('hash parsing accepts only known settings section anchors', () => {
  assert.equal(parseSettingsSimpleSectionHash('#settings-memory-budget'), 'memory-budget');
  assert.equal(parseSettingsSimpleSectionHash('#settings-advanced-fields'), 'advanced-fields');
  assert.equal(parseSettingsSimpleSectionHash('#settings-advanced-fleet-auth'), 'advanced-fleet-auth');
  assert.equal(parseSettingsSimpleSectionHash('#settings-owner-files'), 'owner-files');
  assert.equal(parseSettingsSimpleSectionHash('#settings-missing'), null);
  assert.equal(parseSettingsSimpleSectionHash('#not-settings-memory-budget'), null);
});
