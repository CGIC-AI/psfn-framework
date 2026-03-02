export type IdentityConfirmationTone = 'primary' | 'danger';

export type IdentityConfirmationAction =
  | { type: 'import'; path: string }
  | { type: 'rollback'; version: number };

export interface IdentityConfirmationState {
  pendingAction: IdentityConfirmationAction | null;
}

export interface IdentityConfirmationContent {
  title: string;
  body: string;
  context: string;
  confirmLabel: string;
  cancelLabel: string;
  tone: IdentityConfirmationTone;
}

export function initialIdentityConfirmationState(): IdentityConfirmationState {
  return { pendingAction: null };
}

export function requestIdentityImportConfirmation(
  _state: IdentityConfirmationState,
  path: string,
): IdentityConfirmationState {
  const normalizedPath = path.trim();
  if (!normalizedPath) {
    return { pendingAction: null };
  }
  return {
    pendingAction: {
      type: 'import',
      path: normalizedPath,
    },
  };
}

export function requestIdentityRollbackConfirmation(
  _state: IdentityConfirmationState,
  version: number,
): IdentityConfirmationState {
  return {
    pendingAction: {
      type: 'rollback',
      version,
    },
  };
}

export function cancelIdentityConfirmation(_state: IdentityConfirmationState): IdentityConfirmationState {
  return { pendingAction: null };
}

export function confirmIdentityConfirmation(
  state: IdentityConfirmationState,
): { action: IdentityConfirmationAction | null; nextState: IdentityConfirmationState } {
  return {
    action: state.pendingAction,
    nextState: { pendingAction: null },
  };
}

export function getIdentityConfirmationContent(action: IdentityConfirmationAction): IdentityConfirmationContent {
  if (action.type === 'import') {
    return {
      title: 'Import this character card?',
      body: 'This replaces the current identity card with the selected file.',
      context: `Source path: ${action.path}`,
      confirmLabel: 'Import Card',
      cancelLabel: 'Cancel',
      tone: 'primary',
    };
  }

  return {
    title: `Restore version ${action.version}?`,
    body: 'This rollback replaces the current identity card with the selected historical version.',
    context: `Rollback target: version ${action.version}`,
    confirmLabel: 'Restore Version',
    cancelLabel: 'Cancel',
    tone: 'danger',
  };
}
