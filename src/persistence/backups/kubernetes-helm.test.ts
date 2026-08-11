import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  KUBERNETES_HELM_CHART_MANIFEST_NAME,
  KUBERNETES_HELM_DESCRIPTOR_NAME,
  KUBERNETES_HELM_RECOVERY_MANIFEST_NAME,
  captureKubernetesHelmSnapshot,
  resolveKubernetesHelmBackupConfig,
  verifyKubernetesHelmSnapshot,
  type KubernetesHelmBackupConfig,
} from './kubernetes-helm.js';
import {
  KUBERNETES_HELM_CHART_DIGEST_FILE_NAME,
  inspectKubernetesHelmRecoveryChart,
} from './kubernetes-helm-chart.js';

const TEST_CHART_DIGEST = 'a'.repeat(64);

function refreshChartDigest(chartDir: string): string {
  const digest = inspectKubernetesHelmRecoveryChart(chartDir).contentSha256;
  writeFileSync(join(chartDir, KUBERNETES_HELM_CHART_DIGEST_FILE_NAME), `${digest}\n`, 'utf-8');
  return digest;
}

function writeChart(root: string): string {
  const chartDir = join(root, 'chart');
  mkdirSync(join(chartDir, 'templates'), { recursive: true });
  writeFileSync(join(chartDir, 'Chart.yaml'), [
    'apiVersion: v2',
    'name: psfn',
    'version: 0.1.0',
    'appVersion: 0.1.0-kube',
    '',
  ].join('\n'), 'utf-8');
  writeFileSync(join(chartDir, 'values.yaml'), [
    'secrets:',
    '  values:',
    '    apiKey: CHANGE_ME_API_KEY',
    'postgres:',
    '  auth:',
    '    password: CHANGE_ME_POSTGRES_PASSWORD',
    '',
  ].join('\n'), 'utf-8');
  writeFileSync(join(chartDir, 'templates', 'deployment.yaml'), 'kind: Deployment\n', 'utf-8');
  writeFileSync(
    join(chartDir, 'templates', 'secrets.yaml'),
    'kind: Secret\nstringData:\n  API_KEY: {{ .Values.secrets.values.apiKey | quote }}\n',
    'utf-8',
  );
  refreshChartDigest(chartDir);
  return chartDir;
}

function makeConfig(
  chartSourceDir: string,
  chartContentSha256 = inspectKubernetesHelmRecoveryChart(chartSourceDir).contentSha256,
): KubernetesHelmBackupConfig {
  const image = {
    repository: 'localhost/psfn-framework',
    tag: '0.1.0-kube-ae758a4f',
  };
  return {
    chartSourceDir,
    releaseName: 'psfn',
    namespace: 'psfn',
    revision: 33,
    chartName: 'psfn',
    chartVersion: '0.1.0',
    appVersion: '0.1.0-kube',
    chartContentSha256,
    images: {
      agent: {
        ...image,
        gitCommit: 'ae758a4f099633a921b823f9cc651f252b58ca00',
      },
      gateway: image,
      garden: image,
    },
  };
}

describe('Kubernetes Helm backup config', () => {
  it('stays disabled outside an explicitly configured Kubernetes backup runtime', () => {
    expect(resolveKubernetesHelmBackupConfig({})).toBeUndefined();
    expect(resolveKubernetesHelmBackupConfig({
      PSFN_KUBERNETES_BACKUP_ENABLED: 'false',
    })).toBeUndefined();
  });

  it('fails closed when Kubernetes backup metadata is incomplete', () => {
    expect(() => resolveKubernetesHelmBackupConfig({
      PSFN_KUBERNETES_BACKUP_ENABLED: 'true',
      PSFN_HELM_CHART_DIR: '/external/config/charts/psfn',
    })).toThrow('PSFN_HELM_RELEASE_NAME');
  });

  it('resolves only non-secret Helm and image provenance fields', () => {
    const config = resolveKubernetesHelmBackupConfig({
      PSFN_KUBERNETES_BACKUP_ENABLED: 'true',
      PSFN_HELM_CHART_DIR: '/external/config/charts/psfn',
      PSFN_HELM_RELEASE_NAME: 'psfn',
      PSFN_HELM_NAMESPACE: 'psfn',
      PSFN_HELM_CHART_NAME: 'psfn',
      PSFN_HELM_CHART_VERSION: '0.1.0',
      PSFN_HELM_APP_VERSION: '0.1.0-kube',
      PSFN_HELM_CHART_CONTENT_SHA256: TEST_CHART_DIGEST,
      PSFN_HELM_BACKUP_AGENT_IMAGE_REPOSITORY: 'localhost/psfn-framework',
      PSFN_HELM_BACKUP_AGENT_IMAGE_TAG: '0.1.0-kube-ae758a4f',
      PSFN_HELM_BACKUP_GATEWAY_IMAGE_REPOSITORY: 'localhost/psfn-framework',
      PSFN_HELM_BACKUP_GATEWAY_IMAGE_TAG: '0.1.0-kube-ae758a4f',
      PSFN_HELM_BACKUP_GARDEN_IMAGE_REPOSITORY: 'localhost/psfn-framework',
      PSFN_HELM_BACKUP_GARDEN_IMAGE_TAG: '0.1.0-kube-ae758a4f',
      PSFN_GIT_COMMIT: 'ae758a4f099633a921b823f9cc651f252b58ca00',
      API_KEY: 'must-not-be-captured',
      PSFN_BACKUP_ENCRYPTION_KEY: 'must-not-be-captured',
    });

    const { revision: _unresolvable, ...expected } = makeConfig(
      '/external/config/charts/psfn',
      TEST_CHART_DIGEST,
    );
    expect(config).toEqual(expected);
    expect(config).not.toHaveProperty('revision');
    expect(JSON.stringify(config)).not.toContain('must-not-be-captured');
  });

  // psfn-framework-6187t: the chart stopped injecting PSFN_HELM_REVISION because
  // a pod can only ever report the revision it was created at. A leftover value
  // in a stale pod's environment must not resurrect that wrong provenance.
  it('ignores a leftover PSFN_HELM_REVISION rather than recording a stale revision', () => {
    const env = {
      PSFN_KUBERNETES_BACKUP_ENABLED: 'true',
      PSFN_HELM_CHART_DIR: '/external/config/charts/psfn',
      PSFN_HELM_RELEASE_NAME: 'psfn',
      PSFN_HELM_NAMESPACE: 'psfn',
      PSFN_HELM_CHART_NAME: 'psfn',
      PSFN_HELM_CHART_VERSION: '0.1.0',
      PSFN_HELM_APP_VERSION: '0.1.0-kube',
      PSFN_HELM_CHART_CONTENT_SHA256: TEST_CHART_DIGEST,
      PSFN_HELM_BACKUP_AGENT_IMAGE_REPOSITORY: 'localhost/psfn-framework',
      PSFN_HELM_BACKUP_AGENT_IMAGE_TAG: '0.1.0-kube-ae758a4f',
      PSFN_HELM_BACKUP_GATEWAY_IMAGE_REPOSITORY: 'localhost/psfn-framework',
      PSFN_HELM_BACKUP_GATEWAY_IMAGE_TAG: '0.1.0-kube-ae758a4f',
      PSFN_HELM_BACKUP_GARDEN_IMAGE_REPOSITORY: 'localhost/psfn-framework',
      PSFN_HELM_BACKUP_GARDEN_IMAGE_TAG: '0.1.0-kube-ae758a4f',
      PSFN_GIT_COMMIT: 'ae758a4f099633a921b823f9cc651f252b58ca00',
    };

    expect(resolveKubernetesHelmBackupConfig({ ...env, PSFN_HELM_REVISION: '3' }))
      .toEqual(resolveKubernetesHelmBackupConfig(env));
  });
});

describe('Kubernetes Helm recovery snapshot', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  it('captures and verifies a versioned chart bundle without live values or Secrets', () => {
    const root = join(tmpdir(), `psfn-kube-helm-backup-${Date.now()}`);
    roots.push(root);
    const chartDir = writeChart(root);
    const backupDir = join(root, 'backup');
    const result = captureKubernetesHelmSnapshot({
      config: makeConfig(chartDir),
      backupDir,
      now: () => Date.UTC(2026, 6, 10, 12, 0, 0),
    });

    expect(result.chart.fileCount).toBe(5);
    expect(existsSync(join(chartDir, 'Chart.yaml'))).toBe(true);
    expect(existsSync(join(chartDir, 'values.yaml'))).toBe(true);
    expect(existsSync(join(backupDir, KUBERNETES_HELM_RECOVERY_MANIFEST_NAME))).toBe(true);
    expect(existsSync(join(backupDir, KUBERNETES_HELM_DESCRIPTOR_NAME))).toBe(true);
    const descriptorText = readFileSync(join(backupDir, KUBERNETES_HELM_DESCRIPTOR_NAME), 'utf-8');
    expect(descriptorText).toContain('"liveHelmValues": true');
    expect(descriptorText).toContain('"kubernetesSecrets": true');
    expect(descriptorText).not.toContain('must-not-be-captured');

    const verification = verifyKubernetesHelmSnapshot(backupDir);
    expect(verification.chart.verifiedFileCount).toBe(5);
    expect(verification.descriptor.release).toEqual({
      name: 'psfn',
      namespace: 'psfn',
      revision: 33,
    });
  });

  it('rejects an ad hoc live values overlay at the chart root', () => {
    const root = join(tmpdir(), `psfn-kube-helm-values-${Date.now()}`);
    roots.push(root);
    const chartDir = writeChart(root);
    writeFileSync(join(chartDir, 'values-live.yaml'), 'apiKey: real-secret\n', 'utf-8');

    expect(() => captureKubernetesHelmSnapshot({
      config: makeConfig(chartDir),
      backupDir: join(root, 'backup'),
    })).toThrow('unsupported file: values-live.yaml');
  });

  it('rejects deployment metadata that does not match the chart source', () => {
    const root = join(tmpdir(), `psfn-kube-helm-metadata-${Date.now()}`);
    roots.push(root);
    const chartDir = writeChart(root);

    expect(() => captureKubernetesHelmSnapshot({
      config: {
        ...makeConfig(chartDir),
        chartVersion: '9.9.9',
      },
      backupDir: join(root, 'backup'),
    })).toThrow('deployment metadata does not match the chart source');
  });

  it('validates programmatic backup configuration before reading the chart', () => {
    const root = join(tmpdir(), `psfn-kube-helm-config-${Date.now()}`);
    roots.push(root);
    const chartDir = writeChart(root);
    expect(() => captureKubernetesHelmSnapshot({
      config: {
        ...makeConfig(chartDir),
        chartSourceDir: 'relative/chart',
      },
      backupDir: '/tmp/unused-kubernetes-helm-backup',
    })).toThrow('chart source directory must be absolute');
  });

  it('rejects non-placeholder secret defaults in the source chart', () => {
    const root = join(tmpdir(), `psfn-kube-helm-secret-${Date.now()}`);
    roots.push(root);
    const chartDir = writeChart(root);
    writeFileSync(join(chartDir, 'values.yaml'), 'secrets:\n  values:\n    apiKey: real-secret\n', 'utf-8');

    expect(() => captureKubernetesHelmSnapshot({
      config: makeConfig(chartDir),
      backupDir: join(root, 'backup'),
    })).toThrow('non-placeholder secret material at values.secrets.values.apiKey');
  });

  it.each([
    ['quoted key', 'secrets:\n  values:\n    "apiKey": real-secret\n'],
    ['inline map', 'secrets: { values: { apiKey: real-secret } }\n'],
    ['snake-case key', 'api_key: real-secret\n'],
    ['compound password key', 'redisPassword: real-secret\n'],
    ['compound token key', 'accessToken: real-secret\n'],
    ['compound secret key', 'secretKey: real-secret\n'],
    ['opaque block scalar', 'apiKey: |-\n  real-secret\n'],
  ])('rejects %s secret syntax in values.yaml', (_label, values) => {
    const root = join(tmpdir(), `psfn-kube-helm-secret-syntax-${Date.now()}-${Math.random()}`);
    roots.push(root);
    const chartDir = writeChart(root);
    writeFileSync(join(chartDir, 'values.yaml'), values, 'utf-8');

    expect(() => captureKubernetesHelmSnapshot({
      config: makeConfig(chartDir),
      backupDir: join(root, 'backup'),
    })).toThrow('non-placeholder secret material');
  });

  it('rejects credentials embedded in an otherwise non-sensitive values block', () => {
    const root = join(tmpdir(), `psfn-kube-helm-embedded-secret-${Date.now()}`);
    roots.push(root);
    const chartDir = writeChart(root);
    writeFileSync(join(chartDir, 'values.yaml'), [
      'application:',
      '  config: |-',
      '    redisPassword: real-embedded-secret',
      '',
    ].join('\n'), 'utf-8');

    expect(() => makeConfig(chartDir)).toThrow('literal credential assignment');
  });

  it.each([
    ['dotenv', 'REDIS_PASSWORD=real-dotenv-secret'],
    ['exported dotenv', 'export ACCESS_TOKEN=real-exported-secret'],
    ['TOML', 'secretKey = "real-toml-secret"'],
    ['inline TOML', 'redis = { password = "real-inline-secret" }'],
    ['shell assignment list', 'SAFE=value REDIS_PASSWORD=real-shell-secret command'],
  ])('rejects credentials embedded in %s configuration', (_label, credentialLine) => {
    const root = join(tmpdir(), `psfn-kube-helm-embedded-equals-${Date.now()}-${Math.random()}`);
    roots.push(root);
    const chartDir = writeChart(root);
    writeFileSync(join(chartDir, 'values.yaml'), [
      'application:',
      '  config: |-',
      `    ${credentialLine}`,
      '',
    ].join('\n'), 'utf-8');

    expect(() => makeConfig(chartDir)).toThrow('literal credential assignment');
  });

  it('allows environment references inside embedded configuration', () => {
    const root = join(tmpdir(), `psfn-kube-helm-embedded-reference-${Date.now()}`);
    roots.push(root);
    const chartDir = writeChart(root);
    writeFileSync(join(chartDir, 'values.yaml'), [
      'application:',
      '  config: |-',
      '    api_key: "os.environ/OPENROUTER_API_KEY"',
      '    accessToken: "${ACCESS_TOKEN}"',
      '',
    ].join('\n'), 'utf-8');
    refreshChartDigest(chartDir);

    expect(() => makeConfig(chartDir)).not.toThrow();
  });

  it('allows only boolean Kubernetes automountServiceAccountToken assignments', () => {
    const root = join(tmpdir(), `psfn-kube-helm-service-account-token-${Date.now()}`);
    roots.push(root);
    const chartDir = writeChart(root);
    writeFileSync(
      join(chartDir, 'templates', 'serviceaccount.yaml'),
      [
        'apiVersion: v1',
        'kind: ServiceAccount',
        'automountServiceAccountToken: false',
        '---',
        'apiVersion: v1',
        'kind: Pod',
        'spec:',
        '  automountServiceAccountToken: {{ .Values.kubeSelfManagement.enabled }}',
        '',
      ].join('\n'),
      'utf-8',
    );
    refreshChartDigest(chartDir);

    expect(() => makeConfig(chartDir)).not.toThrow();

    writeFileSync(
      join(chartDir, 'templates', 'serviceaccount.yaml'),
      'apiVersion: v1\nkind: ServiceAccount\nautomountServiceAccountToken: actual-secret\n',
      'utf-8',
    );
    expect(() => makeConfig(chartDir)).toThrow('literal credential assignment');
  });

  it.each([
    ['environment-style key', 'API_KEY: {{ "real-template-secret" | quote }}'],
    ['quoted spaced key', '"api key": {{ "real-template-secret" | quote }}'],
    ['backtick default', 'API_KEY: {{ .Values.secrets.values.apiKey | default `real-backtick-secret` | quote }}'],
    ['numeric default', 'API_KEY: {{ .Values.secrets.values.apiKey | default 123456789 | quote }}'],
  ])('rejects a literal credential disguised as a Helm template expression: %s', (_label, assignment) => {
    const root = join(tmpdir(), `psfn-kube-helm-template-literal-${Date.now()}-${Math.random()}`);
    roots.push(root);
    const chartDir = writeChart(root);
    writeFileSync(
      join(chartDir, 'templates', 'credentials.yaml'),
      `kind: Secret\nstringData:\n  ${assignment}\n`,
      'utf-8',
    );

    expect(() => makeConfig(chartDir)).toThrow(/(?:literal credential assignment|Kubernetes Secret data)/);
  });

  it('rejects a Secret value sourced from a non-placeholder-verified values path', () => {
    const root = join(tmpdir(), `psfn-kube-helm-unverified-values-path-${Date.now()}`);
    roots.push(root);
    const chartDir = writeChart(root);
    writeFileSync(join(chartDir, 'values.yaml'), 'innocuous: real-secret\n', 'utf-8');
    writeFileSync(
      join(chartDir, 'templates', 'unverified-values-secret.yaml'),
      'apiVersion: v1\nkind: Secret\nstringData:\n  SERVICE_AUTH: {{ .Values.innocuous | quote }}\n',
      'utf-8',
    );

    expect(() => makeConfig(chartDir)).toThrow('Kubernetes Secret data');
  });

  it.each([
    [
      'arbitrary Secret key',
      'apiVersion: v1\nkind: Secret\nstringData:\n  SERVICE_AUTH: real-secret\n',
    ],
    [
      'template-generated Secret assignment',
      'apiVersion: v1\nkind: Secret\nstringData:\n{{ printf "  SERVICE_AUTH: real-printf-secret\\n" }}\n',
    ],
    [
      'inline JSON Secret',
      '{"apiVersion":"v1","kind":"Secret","stringData":{"SERVICE_AUTH":"real-json-secret"}}\n',
    ],
    [
      'quoted Secret kind key',
      'apiVersion: v1\n"kind": Secret\nstringData:\n  SERVICE_AUTH: real-quoted-kind-secret\n',
    ],
    [
      'tagged Secret kind',
      'apiVersion: v1\nkind: !!str Secret\nstringData:\n  SERVICE_AUTH: real-tagged-kind-secret\n',
    ],
    [
      'template-generated whole Secret',
      '{{ printf "apiVersion: v1\\nkind: Secret\\nstringData:\\n  SERVICE_AUTH: real-whole-secret\\n" }}\n',
    ],
    [
      'bare-action whole Secret',
      '{{ "apiVersion: v1\\nkind: Secret\\nstringData:\\n  SERVICE_AUTH: real-action-secret\\n" }}\n',
    ],
    [
      'partially templated Secret kind',
      'apiVersion: v1\nkind: Secret{{ "" }}\nstringData:\n  SERVICE_AUTH: real-partial-kind-secret\n',
    ],
    [
      'dict-toYaml Secret',
      'apiVersion: v1\n{{ dict "kind" "Secret" "metadata" (dict "name" "leak") "stringData" (dict "SERVICE_AUTH" "real-dict-secret") | toYaml }}\n',
    ],
  ])('rejects literal credential material under Kubernetes Secret data: %s', (_label, manifest) => {
    const root = join(tmpdir(), `psfn-kube-helm-secret-data-${Date.now()}-${Math.random()}`);
    roots.push(root);
    const chartDir = writeChart(root);
    writeFileSync(join(chartDir, 'templates', 'arbitrary-secret.yaml'), manifest, 'utf-8');

    expect(() => makeConfig(chartDir)).toThrow(
      /(?:Kubernetes Secret|non-placeholder secret|unscannable Kubernetes resource|unscannable templated Secret kind|unscannable Kubernetes Secret)/,
    );
  });

  it.each([
    [
      'tpl string',
      'payload: |-\n  apiVersion: v1\n  kind: Secret\n  stringData:\n    SERVICE_AUTH: real-tpl-secret\n',
      '{{ tpl .Values.payload . }}\n',
    ],
    [
      'toYaml object',
      'payload:\n  apiVersion: v1\n  kind: Secret\n  stringData:\n    SERVICE_AUTH: real-toyaml-secret\n',
      '{{ toYaml .Values.payload }}\n',
    ],
    [
      'dynamic quoted kind',
      'resourceKind: Secret\n',
      'apiVersion: v1\n"kind": {{ .Values.resourceKind }}\nstringData:\n  SERVICE_AUTH: real-dynamic-kind-secret\n',
    ],
  ])('rejects a baked Secret emitted through %s', (_label, values, template) => {
    const root = join(tmpdir(), `psfn-kube-helm-emitted-secret-${Date.now()}-${Math.random()}`);
    roots.push(root);
    const chartDir = writeChart(root);
    writeFileSync(join(chartDir, 'values.yaml'), values, 'utf-8');
    writeFileSync(join(chartDir, 'templates', 'emitted-secret.yaml'), template, 'utf-8');

    expect(() => makeConfig(chartDir)).toThrow(
      /(?:non-placeholder secret|unscannable templated Kubernetes kind)/,
    );
  });

  it('rejects credentials stored as JSON schema defaults', () => {
    const root = join(tmpdir(), `psfn-kube-helm-schema-secret-${Date.now()}`);
    roots.push(root);
    const chartDir = writeChart(root);
    writeFileSync(join(chartDir, 'values.schema.json'), JSON.stringify({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        apiKey: {
          type: 'string',
          default: 'real-schema-secret',
        },
      },
    }, null, 2), 'utf-8');

    expect(() => makeConfig(chartDir)).toThrow('non-placeholder secret material');
  });

  it('rejects sensitive JSON schema defaults hidden behind $ref', () => {
    const root = join(tmpdir(), `psfn-kube-helm-schema-ref-secret-${Date.now()}`);
    roots.push(root);
    const chartDir = writeChart(root);
    writeFileSync(join(chartDir, 'values.schema.json'), JSON.stringify({
      type: 'object',
      properties: {
        apiKey: {
          $ref: '#/$defs/credential',
        },
      },
      $defs: {
        credential: {
          type: 'string',
          default: 'real-ref-secret',
        },
      },
    }, null, 2), 'utf-8');

    expect(() => makeConfig(chartDir)).toThrow('unsupported $ref in values schema');
  });

  it.each([
    [
      'pattern property',
      {
        type: 'object',
        patternProperties: {
          '^apiKey$': {
            type: 'string',
            default: 'real-pattern-secret',
          },
        },
      },
    ],
    [
      'equivalent pattern property regex',
      {
        type: 'object',
        patternProperties: {
          '^api[Kk]ey$': {
            type: 'string',
            default: 'real-equivalent-pattern-secret',
          },
        },
      },
    ],
    [
      'object default',
      {
        type: 'object',
        properties: {
          application: {
            type: 'object',
            default: {
              apiKey: 'real-object-secret',
            },
          },
        },
      },
    ],
  ])('rejects credential-bearing JSON schema defaults in a %s', (_label, schema) => {
    const root = join(tmpdir(), `psfn-kube-helm-schema-adjacent-secret-${Date.now()}-${Math.random()}`);
    roots.push(root);
    const chartDir = writeChart(root);
    writeFileSync(
      join(chartDir, 'values.schema.json'),
      JSON.stringify(schema, null, 2),
      'utf-8',
    );

    expect(() => makeConfig(chartDir)).toThrow(
      /(?:non-placeholder secret material|unsupported patternProperties)/,
    );
  });

  it('allows a schema for a sensitive value when it contains no credential default', () => {
    const root = join(tmpdir(), `psfn-kube-helm-schema-safe-${Date.now()}`);
    roots.push(root);
    const chartDir = writeChart(root);
    writeFileSync(join(chartDir, 'values.schema.json'), JSON.stringify({
      type: 'object',
      properties: {
        apiKey: {
          type: 'string',
          default: 'CHANGE_ME_API_KEY',
        },
      },
    }, null, 2), 'utf-8');
    refreshChartDigest(chartDir);

    expect(() => makeConfig(chartDir)).not.toThrow();
  });

  it('rejects nested subchart values overlays and arbitrary template credentials', () => {
    const root = join(tmpdir(), `psfn-kube-helm-nested-${Date.now()}`);
    roots.push(root);
    const chartDir = writeChart(root);
    const subchartDir = join(chartDir, 'charts', 'nested');
    mkdirSync(join(subchartDir, 'templates'), { recursive: true });
    writeFileSync(join(subchartDir, 'Chart.yaml'), 'name: nested\nversion: 1.0.0\nappVersion: 1.0.0\n', 'utf-8');
    writeFileSync(join(subchartDir, 'values.yaml'), '{}\n', 'utf-8');
    writeFileSync(join(subchartDir, 'values-live.yaml'), 'apiKey: real-secret\n', 'utf-8');

    expect(() => makeConfig(chartDir)).toThrow('unsupported file: charts/nested/values-live.yaml');

    rmSync(join(chartDir, 'charts'), { recursive: true, force: true });
    writeFileSync(join(chartDir, 'templates', 'credentials.txt'), 'apiKey: real-secret\n', 'utf-8');
    expect(() => makeConfig(chartDir)).toThrow('literal credential assignment');
  });

  it('rejects rendered manifests outside a chart templates directory', () => {
    const root = join(tmpdir(), `psfn-kube-helm-rendered-${Date.now()}`);
    roots.push(root);
    const chartDir = writeChart(root);
    writeFileSync(join(chartDir, 'rendered.yaml'), 'kind: Deployment\n', 'utf-8');

    expect(() => makeConfig(chartDir)).toThrow('unsupported file: rendered.yaml');
  });

  it('rejects stale chart contents that do not match the active release digest', () => {
    const root = join(tmpdir(), `psfn-kube-helm-stale-${Date.now()}`);
    roots.push(root);
    const chartDir = writeChart(root);
    const config = makeConfig(chartDir);
    writeFileSync(join(chartDir, 'templates', 'deployment.yaml'), 'kind: StatefulSet\n', 'utf-8');

    expect(() => captureKubernetesHelmSnapshot({
      config,
      backupDir: join(root, 'backup'),
    })).toThrow('contents do not match recovery-chart.sha256');
  });

  it.each(['same', 'destination-inside-source', 'source-inside-destination'])(
    'rejects chart/backup overlap before modifying the source: %s',
    scenario => {
      const root = join(tmpdir(), `psfn-kube-helm-overlap-${Date.now()}-${Math.random()}`);
      roots.push(root);
      const chartDir = writeChart(root);
      let sourceDir = chartDir;
      let backupDir = chartDir;
      if (scenario === 'destination-inside-source') backupDir = join(chartDir, 'backup');
      if (scenario === 'source-inside-destination') {
        backupDir = root;
        sourceDir = chartDir;
      }
      const chartText = readFileSync(join(chartDir, 'Chart.yaml'), 'utf-8');

      expect(() => captureKubernetesHelmSnapshot({
        config: makeConfig(sourceDir),
        backupDir,
      })).toThrow('must not overlap');
      expect(readFileSync(join(chartDir, 'Chart.yaml'), 'utf-8')).toBe(chartText);
      expect(existsSync(join(chartDir, 'backup'))).toBe(false);
    },
  );

  it('rejects overlap hidden behind a symlinked backup parent', () => {
    const root = join(tmpdir(), `psfn-kube-helm-overlap-link-${Date.now()}`);
    roots.push(root);
    const chartDir = writeChart(root);
    const chartAlias = join(root, 'chart-alias');
    symlinkSync(chartDir, chartAlias, 'dir');

    expect(() => captureKubernetesHelmSnapshot({
      config: makeConfig(chartDir),
      backupDir: join(chartAlias, 'backup'),
    })).toThrow('must not overlap');
    expect(existsSync(join(chartDir, 'backup'))).toBe(false);
  });

  it('rejects chart manifest paths that escape the restore root', () => {
    const root = join(tmpdir(), `psfn-kube-helm-escape-${Date.now()}`);
    roots.push(root);
    const chartDir = writeChart(root);
    const backupDir = join(root, 'backup');
    captureKubernetesHelmSnapshot({ config: makeConfig(chartDir), backupDir });

    const manifestPath = join(backupDir, KUBERNETES_HELM_CHART_MANIFEST_NAME);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      files: Array<{ path: string }>;
    };
    manifest.files[0].path = '../escape';
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
    const recoveryManifestPath = join(backupDir, KUBERNETES_HELM_RECOVERY_MANIFEST_NAME);
    const recoveryManifest = JSON.parse(readFileSync(recoveryManifestPath, 'utf-8')) as {
      chartManifestSha256: string;
    };
    recoveryManifest.chartManifestSha256 = createHash('sha256')
      .update(readFileSync(manifestPath))
      .digest('hex');
    writeFileSync(recoveryManifestPath, `${JSON.stringify(recoveryManifest, null, 2)}\n`, 'utf-8');

    expect(() => verifyKubernetesHelmSnapshot(backupDir)).toThrow(
      'Kubernetes Helm chart manifest entry escapes the capture root',
    );
  });
});
