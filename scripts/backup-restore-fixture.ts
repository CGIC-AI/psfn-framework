import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { captureSystemConfigSnapshot } from '../src/persistence/backups/system-config-tree.js'

const REPOSITORY_BACKUP_RESTORE_FIXTURE_ROOT = resolve('workspace/verify-backup-restore-fixture')
const REPOSITORY_BACKUP_RESTORE_FIXTURE_SNAPSHOT = '20260227T101112123Z'

const FIXTURE_SESSION_FILE_NAME = 'channel-a.jsonl'
const FIXTURE_SYSTEM_CONFIG_FILE_NAME = 'settings.json'

function fixtureBackupDir(rootDir: string): string {
  return join(rootDir, REPOSITORY_BACKUP_RESTORE_FIXTURE_SNAPSHOT)
}

function fixtureIsComplete(rootDir: string): boolean {
  const backupDir = fixtureBackupDir(rootDir)
  return existsSync(join(backupDir, 'system-config-manifest.json'))
    && existsSync(join(backupDir, 'system-config', FIXTURE_SYSTEM_CONFIG_FILE_NAME))
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
  mkdirSync(join(backupDir, 'sessions'), { recursive: true })
  const systemDataDir = join(backupDir, 'fixture-system-data')
  mkdirSync(systemDataDir, { recursive: true })
  writeFileSync(
    join(systemDataDir, FIXTURE_SYSTEM_CONFIG_FILE_NAME),
    `${JSON.stringify({ sessionHistoryBudgetPct: 6 }, null, 2)}\n`,
    'utf8',
  )
  captureSystemConfigSnapshot({
    systemDataDir,
    backupDir,
    now: () => Date.parse('2026-02-27T10:11:12.123Z'),
  })
  rmSync(systemDataDir, { recursive: true, force: true })

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
