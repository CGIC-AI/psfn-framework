import type { SessionTailCachePort } from './session-tail-cache-port.js';
import { SessionTailOperations } from './store/tail-operations.js';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { JournalEntry } from '../../core/session/types.js';
import type { MessageAddressingParticipant } from '../../shared/contracts/runtime.js';
import { fsyncDirectorySync, writeFileDurableAtomicSync } from '../../shared/utils/fs.js';
import { createFilesystemSessionArchivePort } from '../journals/journal/port.js';
import { parseJournalText } from '../journals/journal/file-io.js';
import { assertNoPendingJournalChainRewrite } from '../journals/journal/chain-transaction.js';
import { CHANNEL_INDEX_FILENAME, type ChannelIndexEntry, type SessionIntegrityProvider } from './store-primitives.js';
import type { TranscriptProjectionPort } from './transcript-projection-port.js';
import { loadChannelIndex, snapshotIndexEntry, upsertChannelIndex } from './store/channel-index.js';
import { indexedChannelId } from './store/session-index-keys.js';
import { withSessionJournalWriteLock } from './store/session-journal-write-lock.js';
import { rewriteJournalArchiveChain } from './store/journal-chain-runtime.js';
import { SessionJournalRuntime } from './store/journal-runtime.js';
import { migrateJournalAddressingEntry, type JournalAddressingMigration } from './message-addressing-journal-policy.js';

export interface JournalAddressingMigrationOptions {
  /** Exact indexed logical session and canonical root; aliases are not resolved. */
  channelId: string;
  journalPath: string;
  observer: MessageAddressingParticipant;
  maxJournalBytes: number;
  maxJournalFiles: number;
  mode: 'dry-run' | 'apply';
  integrityProvider?: SessionIntegrityProvider | null;
  transcriptProjection?: TranscriptProjectionPort;
  tailCache?: SessionTailCachePort;
  expectedPlanDigest?: string;
  backupDir?: string;
  /** Offline operation: stop every process with this companion's journal/cache mounted. */
  writersStopped?: boolean;
}

export interface JournalAddressingMigrationReport {
  planDigest: string;
  migratedEntries: number;
  scannedEntries: number;
  journalFiles: number;
  journalBytes: number;
  backupPath?: string;
}

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function preflight(options: JournalAddressingMigrationOptions, renewLease: () => void) {
  if (!Number.isSafeInteger(options.maxJournalFiles) || options.maxJournalFiles <= 0
    || !Number.isSafeInteger(options.maxJournalBytes) || options.maxJournalBytes <= 0) {
    throw new Error('Canonical migration requires positive explicit file and byte bounds');
  }
  const rootPath = resolve(options.journalPath);
  if (realpathSync(rootPath) !== rootPath || !rootPath.endsWith('.jsonl')) {
    throw new Error('Canonical migration requires a real root journal path');
  }
  assertNoPendingJournalChainRewrite(rootPath);
  const sessionsDir = dirname(rootPath);
  const rootName = basename(rootPath);
  const segmentPrefix = `${rootName.slice(0, -'.jsonl'.length)}.segment-`;
  const paths = readdirSync(sessionsDir)
    .filter(name => name === rootName || (name.startsWith(segmentPrefix) && name.endsWith('.jsonl')))
    .sort().map(name => join(sessionsDir, name));
  if (paths.length > options.maxJournalFiles) throw new Error('Canonical migration exceeded file bound');
  if (paths.some((path, index) => path !== (index === 0 ? rootPath
    : `${rootPath.slice(0, -'.jsonl'.length)}.segment-${(index + 1).toString().padStart(4, '0')}.jsonl`))) {
    throw new Error('Canonical migration requires one complete ordered journal chain');
  }
  const channelIndex = new Map<string, ChannelIndexEntry>();
  const indexPath = join(sessionsDir, CHANNEL_INDEX_FILENAME);
  loadChannelIndex(indexPath, channelIndex, { persistMigration: false });
  const indexed = channelIndex.get(options.channelId);
  if (!indexed || indexed.filenames.length !== paths.length
    || indexed.filenames.some((name, index) => name !== basename(paths[index]!))) {
    throw new Error('Canonical migration target does not match the exact session index');
  }
  const physicalChannelId = indexedChannelId(options.channelId, indexed);
  const migration: JournalAddressingMigration = { kind: 'message-addressing-v1-to-v2', observer: options.observer };
  const bytes: Buffer[] = [];
  const replacements: JournalEntry[][] = [];
  let journalBytes = 0;
  let scannedEntries = 0;
  let migratedEntries = 0;
  let previousHmac: string | null = null;
  for (const path of paths) {
    const stat = lstatSync(path);
    if (!stat.isFile()) throw new Error('Canonical migration requires regular journal files');
    journalBytes += stat.size;
    if (journalBytes > options.maxJournalBytes) throw new Error('Canonical migration exceeded byte bound');
    const body = readFileSync(path);
    if (body.byteLength !== stat.size) throw new Error('Canonical journal changed during preflight');
    bytes.push(body);
    const parsed = parseJournalText(body.toString('utf8'));
    if (parsed.quarantined.length > 0) throw new Error('Canonical migration refuses malformed journal rows');
    replacements.push(parsed.entries.map(entry => {
      if (entry.channelId !== physicalChannelId) throw new Error('Canonical journal channel differs from its index');
      const signed = entry._hmac !== undefined || entry._hmacKeyVersion !== undefined;
      if (options.integrityProvider) {
        if (!options.integrityProvider.verify(entry, previousHmac).verified) {
          throw new Error('Canonical journal integrity verification failed');
        }
      } else if (signed) {
        throw new Error('Canonical journal integrity verifier is required');
      }
      previousHmac = entry._hmac ?? null;
      const replacement = migrateJournalAddressingEntry(entry, migration);
      scannedEntries += 1;
      if (replacement.metadata !== entry.metadata) migratedEntries += 1;
      renewLease();
      return replacement;
    }));
  }
  const manifest = {
    migration, logicalSessionId: options.channelId, physicalChannelId,
    files: paths.map((path, index) => ({ path, sha256: digest(bytes[index]!) })),
  };
  const report: JournalAddressingMigrationReport = {
    planDigest: digest(JSON.stringify(manifest)), migratedEntries, scannedEntries,
    journalFiles: paths.length, journalBytes,
  };
  if (options.mode === 'apply' && options.expectedPlanDigest !== report.planDigest) {
    throw new Error('Canonical migration plan digest changed or was not supplied');
  }
  return { report, paths, bytes, replacements, manifest, migration, indexPath, channelIndex, physicalChannelId };
}

/** Offline, evidence-preserving migration. No constructor recovery or runtime fallback occurs. */
export async function migrateJournalMessageAddressing(
  options: JournalAddressingMigrationOptions,
): Promise<JournalAddressingMigrationReport> {
  const requestedMode: unknown = options.mode;
  if (requestedMode !== 'dry-run' && requestedMode !== 'apply') throw new Error('Invalid migration mode');
  const rootPath = resolve(options.journalPath);
  const plan = withSessionJournalWriteLock(rootPath, renew => preflight(options, renew));
  if (options.mode === 'dry-run') return plan.report;
  const projection = options.transcriptProjection;
  if (!options.writersStopped || !projection?.assertRedactionDriftDurable || !options.backupDir || !options.tailCache) {
    throw new Error('Apply requires stopped writers, transcript projection, native tail cache, and an external backup directory');
  }
  if (projection.listProjectionDrift().some(row => row.channelId === options.channelId)) {
    throw new Error('Outstanding transcript projection drift requires native repair before migration apply');
  }
  const tail = new SessionTailOperations({
    tailCache: options.tailCache, resolveChannelKey: id => id,
    getRecent: () => { throw new Error('Offline migration never repopulates cached tails'); },
  });
  await tail.bumpSessionTailEpoch(options.channelId, 'canonical_addressing_migration');
  if (plan.report.migratedEntries === 0) return plan.report;
  const backupParent = realpathSync(options.backupDir);
  const withinSessions = relative(dirname(rootPath), backupParent);
  if (!(withinSessions === '..' || withinSessions.startsWith(`..${sep}`) || isAbsolute(withinSessions))) {
    throw new Error('Canonical migration backup must be outside the sessions directory');
  }
  // Persist the fail-closed projection fence before canonical bytes can change.
  projection.markProjectionDrift(options.channelId, 'Canonical addressing migration in progress', 'redaction');
  await projection.assertRedactionDriftDurable(options.channelId);
  const result = await tail.withPostRewriteTailFence(options.channelId, 'canonical_addressing_migration', markRewritten => withSessionJournalWriteLock(rootPath, renewLease => {
    const current = preflight(options, renewLease);
    const backupPath = join(backupParent, current.report.planDigest);
    mkdirSync(backupPath, { mode: 0o700 });
    fsyncDirectorySync(backupParent);
    current.bytes.forEach((body, index) => {
      writeFileDurableAtomicSync(join(backupPath, `${index}.jsonl`), body, { exclusive: true });
      renewLease();
    });
    writeFileDurableAtomicSync(join(backupPath, 'manifest.json'), JSON.stringify(current.manifest), { exclusive: true });
    const archivePort = createFilesystemSessionArchivePort();
    const archives = current.paths.map(path => archivePort.openArchive(current.physicalChannelId, path));
    // Fence even if the native transaction throws after publishing durable bytes.
    markRewritten();
    rewriteJournalArchiveChain(archivePort, options.integrityProvider ?? null,
      archives, current.replacements, renewLease, current.migration);
    const runtime = new SessionJournalRuntime(options.integrityProvider ?? null, archivePort);
    const cache = runtime.loadChannelChain(archives);
    upsertChannelIndex(options.channelId, snapshotIndexEntry(cache), current.indexPath, current.channelIndex);
    projection.replaceChannelEntries(options.channelId, cache.entries, { redaction: true });
    return { ...current.report, backupPath };
  }));
  await projection.flushPendingWrites?.();
  if (projection.listProjectionDrift().some(row => row.channelId === options.channelId)) {
    throw new Error('Canonical migration completed but transcript projection requires native repair');
  }
  return result;
}
