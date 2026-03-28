import { describe, expect, it } from 'vitest';
import {
  cancelIdentityConfirmation,
  confirmIdentityConfirmation,
  getIdentityConfirmationContent,
  initialIdentityConfirmationState,
  requestIdentityImportConfirmation,
  requestIdentityRollbackConfirmation,
} from '../../../admin-ui/src/lib/components/identity-confirmation-flow.js';

describe('identity confirmation flow', () => {
  it('creates import confirmation with trimmed path and import context text', () => {
    const state = requestIdentityImportConfirmation(
      initialIdentityConfirmationState(),
      '  /tmp/cards/companion.charx  ',
    );
    expect(state.pendingAction).toEqual({
      type: 'import',
      path: '/tmp/cards/companion.charx',
    });

    if (!state.pendingAction) {
      throw new Error('Expected pending import action');
    }

    const content = getIdentityConfirmationContent(state.pendingAction);
    expect(content.title).toBe('Import this character card?');
    expect(content.body).toContain('replaces the current identity card');
    expect(content.context).toBe('Source path: /tmp/cards/companion.charx');
    expect(content.confirmLabel).toBe('Import Card');
    expect(content.cancelLabel).toBe('Cancel');
    expect(content.tone).toBe('primary');
  });

  it('does not open import confirmation for blank paths', () => {
    const state = requestIdentityImportConfirmation(initialIdentityConfirmationState(), '    ');
    expect(state.pendingAction).toBeNull();
  });

  it('creates rollback confirmation with version-specific context text', () => {
    const state = requestIdentityRollbackConfirmation(initialIdentityConfirmationState(), 7);
    expect(state.pendingAction).toEqual({
      type: 'rollback',
      version: 7,
    });

    if (!state.pendingAction) {
      throw new Error('Expected pending rollback action');
    }

    const content = getIdentityConfirmationContent(state.pendingAction);
    expect(content.title).toBe('Restore version 7?');
    expect(content.body).toContain('rollback replaces the current identity card');
    expect(content.context).toBe('Rollback target: version 7');
    expect(content.confirmLabel).toBe('Restore Version');
    expect(content.cancelLabel).toBe('Cancel');
    expect(content.tone).toBe('danger');
  });

  it('cancels and confirms by clearing pending state', () => {
    const pending = requestIdentityRollbackConfirmation(initialIdentityConfirmationState(), 3);
    const canceled = cancelIdentityConfirmation(pending);
    expect(canceled.pendingAction).toBeNull();

    const withImport = requestIdentityImportConfirmation(initialIdentityConfirmationState(), '/tmp/new-card.json');
    const { action, nextState } = confirmIdentityConfirmation(withImport);
    expect(action).toEqual({
      type: 'import',
      path: '/tmp/new-card.json',
    });
    expect(nextState.pendingAction).toBeNull();
  });
});
