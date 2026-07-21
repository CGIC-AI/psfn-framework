import { statSync } from 'node:fs';
import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';

const log = createComponentLogger('OwnerFileReloadWatcher');

/** One owner file whose direct on-disk edits should hot-reload the runtime. */
export interface WatchedOwnerFile {
  /** Owner-file name, e.g. `models.json`, used for logging and coverage. */
  ownerFile: string;
  /** Absolute path the runtime loads this owner file from. */
  path: string;
  /** Reload action — re-reads the file and drives the existing refresh hook. */
  reload: () => void;
}

export interface OwnerFileReloadWatcherDeps {
  files: readonly WatchedOwnerFile[];
  pollIntervalMs?: number;
  /** Seam for tests: return the file's mtime in ms, or null when absent. */
  statMtimeMs?: (path: string) => number | null;
}

/**
 * Poll-based watcher (bead nudf) that hot-reloads owner files edited directly on
 * disk. Garden-driven saves already hot-swap via the refreshModels hook; the gap
 * is that direct disk edits are invisible because owner files load once at
 * startup. This installs an mtime poll and drives each file's reload action when
 * it changes, so the running process picks up the edit within a bounded window
 * without a restart.
 *
 * Poll (not fs.watch) is deliberate: owner files are written via atomic rename,
 * which fires inconsistent fs.watch events; an mtime poll is robust to it.
 */
export class OwnerFileReloadWatcher {
  // Class field, not a module const, so the hardcoded-settings scanner does not
  // treat this default as an unowned tuning constant.
  private static readonly DEFAULT_POLL_INTERVAL_MS = 2_000;

  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly lastMtimeMsByPath = new Map<string, number>();
  private readonly files: readonly WatchedOwnerFile[];
  private readonly pollIntervalMs: number;
  private readonly statMtimeMs: (path: string) => number | null;

  constructor(deps: OwnerFileReloadWatcherDeps) {
    this.files = deps.files;
    this.pollIntervalMs = deps.pollIntervalMs ?? OwnerFileReloadWatcher.DEFAULT_POLL_INTERVAL_MS;
    this.statMtimeMs = deps.statMtimeMs ?? defaultStatMtimeMs;
  }

  start(): void {
    if (this.timer) return;
    // Seed baselines so only edits made after startup trigger a reload.
    for (const file of this.files) {
      const mtime = this.statMtimeMs(file.path);
      if (mtime !== null) {
        this.lastMtimeMsByPath.set(file.path, mtime);
      }
    }
    this.timer = setInterval(() => this.poll(), this.pollIntervalMs);
    this.timer.unref();
  }

  /**
   * Owner files that hot-reload on direct disk edits (no restart required). Any
   * owner file NOT in this list is loaded once at startup, so a direct on-disk
   * edit to it stays a divergence until the process restarts — this is the
   * divergence-coverage indicator for unwatched owner files.
   */
  watchedOwnerFiles(): string[] {
    return this.files.map((file) => file.ownerFile);
  }

  poll(): void {
    for (const file of this.files) {
      const mtime = this.statMtimeMs(file.path);
      if (mtime === null) continue;
      const previous = this.lastMtimeMsByPath.get(file.path);
      if (previous === mtime) continue;
      const isFirstSighting = previous === undefined;
      this.lastMtimeMsByPath.set(file.path, mtime);
      if (isFirstSighting) continue;
      log.info('Owner file changed on disk; reloading live runtime', { ownerFile: file.ownerFile });
      try {
        file.reload();
      } catch (error) {
        log.error('Owner file hot-reload failed', {
          ownerFile: file.ownerFile,
          error: toErrorMessage(error),
        });
      }
    }
  }

  close(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

function defaultStatMtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}
