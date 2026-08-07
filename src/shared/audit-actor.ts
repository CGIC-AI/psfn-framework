/** Persisted audit actor width shared by contact and enrollment audit rows. */
export const AUDIT_ACTOR_MAX_CHARS = 120;

export function normalizeAuditActor(actor: string | undefined): string {
  const trimmed = actor?.trim();
  if (!trimmed) return 'system:unknown';
  return trimmed.slice(0, AUDIT_ACTOR_MAX_CHARS);
}
