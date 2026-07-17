import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CURATED_SETTINGS_FIELD_KEYS,
  SAVE_SUCCESS_AUTO_DISMISS_MS,
  buildValidationNavigationNotice,
  hasCuratedControl,
  resolveSaveFeedback,
  resolveValidationNavigation,
} from './settings-page-helpers';

// ── qq67: persistent save-feedback state machine ──
// Errors must persist (no auto-dismiss); only plain successes auto-dismiss;
// a success that skipped owner files carries an actionable note and persists.

test('validation/save errors persist until dismissed (no auto-dismiss)', () => {
  const feedback = resolveSaveFeedback({ ok: false, message: 'Failed to save runtime settings' });
  assert.equal(feedback.tone, 'error');
  assert.equal(feedback.message, 'Failed to save runtime settings');
  assert.equal(feedback.autoDismissMs, null, 'errors must not auto-dismiss');
});

test('plain success auto-dismisses', () => {
  const feedback = resolveSaveFeedback({ ok: true, message: 'Settings updated.' });
  assert.equal(feedback.tone, 'success');
  assert.equal(feedback.autoDismissMs, SAVE_SUCCESS_AUTO_DISMISS_MS);
});

test('success that skipped owner files persists so the skipped note stays visible', () => {
  const message = 'Settings updated. Skipped scheduler.json — staged raw edits on the Raw JSON tab are preserved; save or discard them there.';
  const feedback = resolveSaveFeedback({ ok: true, message, hasSkippedOwnerFiles: true });
  assert.equal(feedback.tone, 'success', 'mixed success+skipped keeps the success tone');
  assert.equal(feedback.message, message, 'the skipped-owner-file note is preserved verbatim');
  assert.equal(feedback.autoDismissMs, null, 'mixed success+skipped persists until dismissed');
});

// ── ybm3: navigate to All Fields only for fields with no curated control ──

test('every invalid field with a curated control keeps the operator on their tab', () => {
  const navigation = resolveValidationNavigation({
    invalidFields: ['retryMaxAttempts', 'webFetchDomainAllowlist', 'ttsProvider'],
  });
  assert.equal(navigation.navigate, false, 'must not teleport to All Fields');
  assert.deepEqual(navigation.uncoveredFields, []);
});

test('a nested array-element path is still covered by its curated key', () => {
  assert.equal(hasCuratedControl('webFetchDomainAllowlist.0'), true);
  const navigation = resolveValidationNavigation({
    invalidFields: ['webFetchDomainAllowlist.0'],
  });
  assert.equal(navigation.navigate, false);
});

test('an invalid field with no curated control triggers the All Fields fallback', () => {
  // compositionalPolicy has no curated (simple-panel) control — it lives only in
  // the All Fields view — so it is the reason to navigate.
  const navigation = resolveValidationNavigation({
    invalidFields: ['retryMaxAttempts', 'compositionalPolicy.allowedTiers'],
  });
  assert.equal(navigation.navigate, true);
  assert.deepEqual(navigation.uncoveredFields, ['compositionalPolicy.allowedTiers']);
});

test('$root pseudo-field never forces navigation', () => {
  const navigation = resolveValidationNavigation({ invalidFields: ['$root'] });
  assert.equal(navigation.navigate, false);
  assert.deepEqual(navigation.uncoveredFields, []);
});

test('curated field key set is non-empty and includes representative keys', () => {
  assert.ok(CURATED_SETTINGS_FIELD_KEYS.size > 0);
  assert.ok(CURATED_SETTINGS_FIELD_KEYS.has('retryMaxAttempts'));
  assert.ok(CURATED_SETTINGS_FIELD_KEYS.has('discordTriggerListenWindowMs'));
  assert.ok(!CURATED_SETTINGS_FIELD_KEYS.has('compositionalPolicy'));
});

test('navigation notice names the uncovered fields explicitly', () => {
  assert.equal(buildValidationNavigationNotice([]), '');
  assert.equal(
    buildValidationNavigationNotice(['compositionalPolicy.allowedTiers']),
    'No curated control exists for compositionalPolicy.allowedTiers; showing it in All Fields.',
  );
  assert.equal(
    buildValidationNavigationNotice(['a', 'b']),
    'No curated control exists for a, b; showing them in All Fields.',
  );
});
