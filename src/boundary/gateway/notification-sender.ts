export const NOTIFICATION_SENDER_KINDS = ['companion', 'system'] as const;

export type NotificationSenderKind = (typeof NOTIFICATION_SENDER_KINDS)[number];

export interface NotificationSenderMetadata {
  kind: NotificationSenderKind;
  provenance: string;
}

const NOTIFICATION_PROVENANCE_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export function normalizeNotificationSenderMetadata(
  sender: unknown,
): NotificationSenderMetadata {
  if (!sender || typeof sender !== 'object') {
    throw new Error('notify sender metadata is required');
  }

  const record = sender as { kind?: unknown; provenance?: unknown };

  const kind = typeof record.kind === 'string' ? record.kind.trim() : '';
  if (kind !== 'companion' && kind !== 'system') {
    throw new Error('notify sender kind must be "companion" or "system"');
  }

  const provenance = typeof record.provenance === 'string' ? record.provenance.trim() : '';
  if (!provenance) {
    throw new Error('notify sender provenance is required');
  }
  if (!NOTIFICATION_PROVENANCE_PATTERN.test(provenance)) {
    throw new Error('notify sender provenance must be a lowercase dotted, dashed, or underscored identifier');
  }
  if (!provenance.startsWith(`${kind}.`)) {
    throw new Error(`notify sender provenance must start with "${kind}."`);
  }

  return { kind, provenance };
}
