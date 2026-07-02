// ── Channel-envelope migration support (E3.2) ──
// Testable enumeration/apply/report helpers for the one-time
// migrate:channel-envelope maintenance command. The planning rules live in
// src/system/trust/channel-envelope-migration.ts; this module handles the
// store-facing edges: session-journal scanning, contact-activity row
// ingestion, report formatting, and the guarded owner-file write.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHANNELS_FILE_NAME,
  loadChannelsOwnerFile,
  parseContextEnvelopeSection,
  saveChannelsOwnerFile,
} from '../../channels/backplane/config.js';
import type { ChannelEnvelopeLabel } from '../../system/trust/context-envelope.js';
import {
  decodeObservedVisibility,
  type ChannelEnvelopeMigrationPlan,
  type ChannelEnvelopeObservation,
} from '../../system/trust/channel-envelope-migration.js';
import { isRecord } from '../../shared/utils/types.js';

export interface SessionChannelScanResult {
  observations: ChannelEnvelopeObservation[];
  scannedFiles: number;
  scannedLines: number;
  /** Lines that could not be parsed or carried no channel id (reported, not swallowed). */
  skippedLines: number;
  /** Persisted visibility stamps that failed to decode (reported, not guessed). */
  undecodableVisibilityStamps: number;
}

/**
 * Enumerates channel ids (plus persisted channel-visibility stamps) from the
 * JSONL session journals. Read-only.
 */
export function collectSessionChannelObservations(sessionsDir: string): SessionChannelScanResult {
  const result: SessionChannelScanResult = {
    observations: [],
    scannedFiles: 0,
    scannedLines: 0,
    skippedLines: 0,
    undecodableVisibilityStamps: 0,
  };
  if (!existsSync(sessionsDir)) {
    return result;
  }

  const byChannel = new Map<string, ChannelEnvelopeObservation>();
  const files = readdirSync(sessionsDir).filter(file => file.endsWith('.jsonl'));
  for (const file of files) {
    result.scannedFiles += 1;
    const text = readFileSync(join(sessionsDir, file), 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      result.scannedLines += 1;

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        result.skippedLines += 1;
        continue;
      }
      if (!isRecord(parsed) || typeof parsed.channelId !== 'string' || !parsed.channelId.trim()) {
        result.skippedLines += 1;
        continue;
      }

      const channelId = parsed.channelId.trim();
      let observation = byChannel.get(channelId);
      if (!observation) {
        observation = { channelId, storedVisibilities: [], sources: ['session_journal'] };
        byChannel.set(channelId, observation);
      }
      if (parsed.channelVisibility !== undefined) {
        const decoded = decodeObservedVisibility(parsed.channelVisibility);
        if (decoded) {
          observation.storedVisibilities.push(decoded);
        } else {
          result.undecodableVisibilityStamps += 1;
        }
      }
    }
  }

  result.observations = [...byChannel.values()];
  return result;
}

export interface ContactActivityRow {
  channelId: unknown;
  privacyLevel: unknown;
}

export interface ContactChannelScanResult {
  observations: ChannelEnvelopeObservation[];
  scannedRows: number;
  skippedRows: number;
  undecodableVisibilityStamps: number;
}

/**
 * Maps contact conversation-channel rows (contact_channel_activity) to
 * planner observations. The stored per-contact privacy value participates
 * ONLY as migration evidence here — it stays demoted from runtime gating.
 */
export function observationsFromContactActivityRows(rows: ContactActivityRow[]): ContactChannelScanResult {
  const result: ContactChannelScanResult = {
    observations: [],
    scannedRows: 0,
    skippedRows: 0,
    undecodableVisibilityStamps: 0,
  };

  const byChannel = new Map<string, ChannelEnvelopeObservation>();
  for (const row of rows) {
    result.scannedRows += 1;
    if (typeof row.channelId !== 'string' || !row.channelId.trim()) {
      result.skippedRows += 1;
      continue;
    }
    const channelId = row.channelId.trim();
    let observation = byChannel.get(channelId);
    if (!observation) {
      observation = { channelId, storedVisibilities: [], sources: ['contact_channel_activity'] };
      byChannel.set(channelId, observation);
    }
    if (row.privacyLevel !== undefined && row.privacyLevel !== null) {
      const decoded = decodeObservedVisibility(row.privacyLevel);
      if (decoded) {
        observation.storedVisibilities.push(decoded);
      } else {
        result.undecodableVisibilityStamps += 1;
      }
    }
  }

  result.observations = [...byChannel.values()];
  return result;
}

/** Loads the existing channels.json contextEnvelope labels (fail-closed). */
export function loadExistingChannelEnvelopeLabels(systemDataDir: string): Record<string, ChannelEnvelopeLabel> {
  const root = loadChannelsOwnerFile(systemDataDir);
  const scopedRoot = isRecord(root.channels) ? root.channels as Record<string, unknown> : root;
  return parseContextEnvelopeSection(scopedRoot).channels;
}

export interface ApplyChannelEnvelopeMigrationResult {
  writtenChannelIds: string[];
  filePath: string;
}

/**
 * Applies the plan's seed entries to channels.json. Existing label keys are
 * never overwritten (the planner already reports them as skips, and this
 * guard fails closed if the file changed between plan and apply).
 */
export function applyChannelEnvelopeMigrationPlan(
  systemDataDir: string,
  plan: ChannelEnvelopeMigrationPlan,
): ApplyChannelEnvelopeMigrationResult {
  const root = loadChannelsOwnerFile(systemDataDir);
  const hasChannelsWrapper = isRecord(root.channels);
  const scopedRoot: Record<string, unknown> = hasChannelsWrapper
    ? { ...(root.channels as Record<string, unknown>) }
    : { ...root };

  const existingSection = parseContextEnvelopeSection(scopedRoot);
  const nextChannels: Record<string, unknown> = isRecord(scopedRoot.contextEnvelope)
    && isRecord((scopedRoot.contextEnvelope as Record<string, unknown>).channels)
    ? { ...((scopedRoot.contextEnvelope as Record<string, unknown>).channels as Record<string, unknown>) }
    : {};

  const writtenChannelIds: string[] = [];
  for (const entry of plan.entries) {
    if (entry.action !== 'seed' && entry.action !== 'seed_ambiguous') continue;
    if (!entry.label) {
      throw new Error(`Channel envelope migration entry for '${entry.channelId}' is missing its label`);
    }
    if (Object.hasOwn(existingSection.channels, entry.channelId)) {
      throw new Error(
        `Channel envelope migration refuses to overwrite existing label for '${entry.channelId}'; re-run the dry-run plan`,
      );
    }
    nextChannels[entry.channelId] = entry.label;
    writtenChannelIds.push(entry.channelId);
  }

  const nextScopedRoot: Record<string, unknown> = {
    ...scopedRoot,
    contextEnvelope: { channels: nextChannels },
  };
  // Fail closed before writing: the merged section must survive load validation.
  parseContextEnvelopeSection(nextScopedRoot);

  const nextRoot: Record<string, unknown> = hasChannelsWrapper
    ? { ...root, channels: nextScopedRoot }
    : nextScopedRoot;
  saveChannelsOwnerFile(systemDataDir, nextRoot);

  return {
    writtenChannelIds,
    filePath: join(systemDataDir, CHANNELS_FILE_NAME),
  };
}

export function formatChannelEnvelopeMigrationReport(
  plan: ChannelEnvelopeMigrationPlan,
  meta: {
    dryRun: boolean;
    sessionScan?: SessionChannelScanResult;
    contactScan?: ContactChannelScanResult;
  },
): string[] {
  const lines: string[] = [];
  lines.push(`Mode: ${meta.dryRun ? 'dry-run (report only; pass --apply to write channels.json)' : 'apply'}`);
  if (meta.sessionScan) {
    lines.push(
      `Session journals: ${meta.sessionScan.scannedFiles} files, ${meta.sessionScan.scannedLines} lines, `
      + `${meta.sessionScan.skippedLines} skipped lines, `
      + `${meta.sessionScan.undecodableVisibilityStamps} undecodable visibility stamps`,
    );
  }
  if (meta.contactScan) {
    lines.push(
      `Contact conversation-channel rows: ${meta.contactScan.scannedRows} scanned, `
      + `${meta.contactScan.skippedRows} skipped, `
      + `${meta.contactScan.undecodableVisibilityStamps} undecodable visibility stamps`,
    );
  }
  lines.push('');
  lines.push(
    `Channels: ${plan.entries.length} total — seed=${plan.counts.seed}, `
    + `ambiguous=${plan.counts.seed_ambiguous}, existing-label=${plan.counts.skip_existing_label}, `
    + `operator-override=${plan.counts.skip_operator_override}`,
  );
  lines.push('');
  for (const entry of plan.entries) {
    const label = entry.label
      ? ` -> ${JSON.stringify(entry.label)}`
      : '';
    const badge = entry.action === 'seed_ambiguous' ? ' [NEEDS REVIEW]' : '';
    lines.push(`${entry.action.padEnd(22)} ${entry.channelId}${label}${badge}`);
    lines.push(`${''.padEnd(22)}   reason: ${entry.reason} (sources: ${entry.sources.join(', ') || 'n/a'})`);
  }
  return lines;
}
