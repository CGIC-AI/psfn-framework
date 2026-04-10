import BetterSqlite3 from 'better-sqlite3'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const REPOSITORY_BACKUP_RESTORE_FIXTURE_ROOT = resolve('workspace/verify-backup-restore-fixture')
export const REPOSITORY_BACKUP_RESTORE_FIXTURE_SNAPSHOT = '20260227T101112123Z'

const FIXTURE_DATABASE_FILE_NAME = 'companion.sqlite'
const FIXTURE_SESSION_FILE_NAME = 'channel-a.jsonl'

function fixtureBackupDir(rootDir: string): string {
  return join(rootDir, REPOSITORY_BACKUP_RESTORE_FIXTURE_SNAPSHOT)
}

function fixtureIsComplete(rootDir: string): boolean {
  const backupDir = fixtureBackupDir(rootDir)
  return existsSync(join(backupDir, 'database', FIXTURE_DATABASE_FILE_NAME))
    && existsSync(join(backupDir, 'sessions', FIXTURE_SESSION_FILE_NAME))
}

export function ensureRepositoryBackupRestoreFixture(
  rootDir: string = REPOSITORY_BACKUP_RESTORE_FIXTURE_ROOT,
): string {
  const resolvedRootDir = resolve(rootDir)
  if (fixtureIsComplete(resolvedRootDir)) {
    return resolvedRootDir
  }

  const backupDir = fixtureBackupDir(resolvedRootDir)
  rmSync(backupDir, { recursive: true, force: true })
  mkdirSync(join(backupDir, 'database'), { recursive: true })
  mkdirSync(join(backupDir, 'sessions'), { recursive: true })

  const databasePath = join(backupDir, 'database', FIXTURE_DATABASE_FILE_NAME)
  const db = new BetterSqlite3(databasePath)
  try {
    db.exec('CREATE TABLE IF NOT EXISTS runtime_state (id INTEGER PRIMARY KEY, value TEXT NOT NULL, captured_at TEXT NOT NULL)')
    db.prepare('INSERT INTO runtime_state (value, captured_at) VALUES (?, ?)').run(
      'ok',
      REPOSITORY_BACKUP_RESTORE_FIXTURE_SNAPSHOT,
    )
  } finally {
    db.close()
  }

  writeFileSync(
    join(backupDir, 'sessions', FIXTURE_SESSION_FILE_NAME),
    `${JSON.stringify({
      channelId: 'channel-a',
      turnId: 'turn-1',
      role: 'assistant',
      content: 'backup restore fixture',
      timestamp: REPOSITORY_BACKUP_RESTORE_FIXTURE_SNAPSHOT,
    })}\n`,
    'utf8',
  )

  return resolvedRootDir
}
