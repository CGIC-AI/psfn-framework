import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { captureSystemConfigSnapshot } from '../src/persistence/backups/system-config-tree.js'
import {
  KUBERNETES_HELM_RECOVERY_MANIFEST_NAME,
  captureKubernetesHelmSnapshot,
  readKubernetesHelmRecoveryDescriptor,
  verifyKubernetesHelmSnapshot,
} from '../src/persistence/backups/kubernetes-helm.js'
import {
  KUBERNETES_HELM_CHART_DIGEST_FILE_NAME,
  inspectKubernetesHelmRecoveryChart,
} from '../src/persistence/backups/kubernetes-helm-chart.js'
import { createBackupContentsManifest } from '../src/persistence/backups/backup-contents.js'

const REPOSITORY_BACKUP_RESTORE_FIXTURE_ROOT = resolve('workspace/verify-backup-restore-fixture')
const REPOSITORY_BACKUP_RESTORE_FIXTURE_SNAPSHOT = '20260227T101112123Z'

const FIXTURE_SESSION_FILE_NAME = 'channel-a.jsonl'
const FIXTURE_SYSTEM_CONFIG_FILE_NAME = 'settings.json'

function fixtureBackupDir(rootDir: string): string {
  return join(rootDir, REPOSITORY_BACKUP_RESTORE_FIXTURE_SNAPSHOT)
}

function fixtureIsComplete(rootDir: string): boolean {
  const backupDir = fixtureBackupDir(rootDir)
  const expectedFilesExist = existsSync(join(backupDir, 'system-config-manifest.json'))
    && existsSync(join(backupDir, KUBERNETES_HELM_RECOVERY_MANIFEST_NAME))
    && existsSync(join(backupDir, 'system-config', FIXTURE_SYSTEM_CONFIG_FILE_NAME))
    && existsSync(join(backupDir, 'sessions', FIXTURE_SESSION_FILE_NAME))
  if (!expectedFilesExist) return false
  try {
    return readKubernetesHelmRecoveryDescriptor(backupDir).chart.name === 'companion-runtime'
      && verifyKubernetesHelmSnapshot(backupDir).chart.verifiedFileCount > 0
  } catch {
    return false
  }
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

  const chartSourceDir = join(resolvedRootDir, 'fixture-helm-chart')
  rmSync(chartSourceDir, { recursive: true, force: true })
  mkdirSync(join(chartSourceDir, 'templates'), { recursive: true })
  writeFileSync(
    join(chartSourceDir, 'Chart.yaml'),
    'apiVersion: v2\nname: companion-runtime\nversion: 0.1.0\nappVersion: 0.1.0-kube\n',
    'utf8',
  )
  writeFileSync(
    join(chartSourceDir, 'values.yaml'),
    'secrets:\n  values:\n    apiKey: CHANGE_ME_API_KEY\n',
    'utf8',
  )
  writeFileSync(
    join(chartSourceDir, 'templates', 'deployment.yaml'),
    'kind: Deployment\n',
    'utf8',
  )
  const chartContentSha256 = inspectKubernetesHelmRecoveryChart(chartSourceDir).contentSha256
  writeFileSync(
    join(chartSourceDir, KUBERNETES_HELM_CHART_DIGEST_FILE_NAME),
    `${chartContentSha256}\n`,
    'utf8',
  )
  captureKubernetesHelmSnapshot({
    backupDir,
    config: {
      chartSourceDir,
      releaseName: 'companion-runtime',
      namespace: 'companion-test',
      revision: 1,
      chartName: 'companion-runtime',
      chartVersion: '0.1.0',
      appVersion: '0.1.0-kube',
      chartContentSha256,
      images: {
        agent: {
          repository: 'localhost/companion-runtime',
          tag: '0.1.0-kube-fixture',
        },
        gateway: {
          repository: 'localhost/companion-runtime',
          tag: '0.1.0-kube-fixture',
        },
        garden: {
          repository: 'localhost/companion-runtime',
          tag: '0.1.0-kube-fixture',
        },
      },
    },
    now: () => Date.parse('2026-02-27T10:11:12.123Z'),
  })
  createBackupContentsManifest({
    backupDir,
    kubernetesHelmRecovery: true,
    now: () => Date.parse('2026-02-27T10:11:12.123Z'),
  })
  rmSync(chartSourceDir, { recursive: true, force: true })

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
