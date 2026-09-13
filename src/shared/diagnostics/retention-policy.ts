/** Product retention floor: traffic volume must never shorten this history. */
export const MIN_OPERATIONAL_METADATA_RETENTION_DAYS = 30;

export function requireOperationalMetadataRetentionDays(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || value! < MIN_OPERATIONAL_METADATA_RETENTION_DAYS) {
    throw new Error('settings.json operationalMetadataRetentionDays must be an integer of at least 30');
  }
  return value!;
}

export function operationalMetadataCutoff(nowMs: number, retentionDays: number): number {
  return nowMs - requireOperationalMetadataRetentionDays(retentionDays) * 24 * 60 * 60 * 1000;
}
