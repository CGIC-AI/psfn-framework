// ── Host notification port (psfn-framework-kbdvl.1) ──
//
// Core-owned notification contract. Core modules (substrate agent, turn
// execution, artifact sensitivity egress, and notification tools) depend only
// on this port; concrete gateway/ntfy delivery implementations live in the host
// layer and inject a `NotificationPort` (or `null` when unwired).

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

export interface NotifyNtfyParams {
  message: string;
  title?: string;
  priority?: number;
  topic?: string;
  /** Stable caller key for providers that can collapse ambiguous retries. */
  idempotencyKey?: string;
  sender: NotificationSenderMetadata;
}

export interface NotifyNtfyResult {
  status: 'sent' | 'debounced';
  topic: string;
  messageId?: string;
}

export interface NotificationPort {
  notify(params: NotifyNtfyParams): Promise<NotifyNtfyResult>;
}
