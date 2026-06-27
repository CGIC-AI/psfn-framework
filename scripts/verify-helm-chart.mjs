#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const chartDir = resolve(repoRoot, 'deploy/helm/psfn');

function render(args = []) {
  return execFileSync('helm', [
    'template',
    'psfn',
    chartDir,
    '--namespace',
    'psfn-test',
    ...args,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function assertRenderFails(args, expectedMessage) {
  try {
    render(args);
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    assertIncludes(output, expectedMessage, 'Helm validation failure');
    return;
  }

  throw new Error(`Helm render unexpectedly succeeded: ${args.join(' ')}`);
}

function assertIncludes(haystack, needle, label) {
  if (!haystack.includes(needle)) {
    throw new Error(`${label} missing: ${needle}`);
  }
}

function assertNotIncludes(haystack, needle, label) {
  if (haystack.includes(needle)) {
    throw new Error(`${label} unexpectedly contains: ${needle}`);
  }
}

function documents(rendered) {
  return rendered
    .split(/^---$/m)
    .map(doc => doc.trim())
    .filter(Boolean);
}

function findDocument(rendered, name) {
  return documents(rendered).find(doc => doc.includes(`\n  name: ${name}\n`)) ?? '';
}

function findDocumentsByKind(rendered, kind) {
  return documents(rendered).filter(doc => doc.includes(`kind: ${kind}\n`));
}

function findDocumentByKindName(rendered, kind, name) {
  return documents(rendered).find(doc => (
    doc.includes(`kind: ${kind}\n`) &&
    doc.includes(`\n  name: ${name}\n`)
  )) ?? '';
}

function assertDocumentDoesNotSelectComponent(document, component, label) {
  assertNotIncludes(
    document,
    `app.kubernetes.io/component: ${component}`,
    `${label} component selector`,
  );
  assertNotIncludes(
    document,
    `component: ${component}`,
    `${label} short component selector`,
  );
}

function assertServiceSelectorsDoNotSelectPrefetch(rendered, label) {
  const serviceDocuments = findDocumentsByKind(rendered, 'Service');
  for (const serviceDocument of serviceDocuments) {
    assertIncludes(serviceDocument, 'selector:', `${label} Service selector`);
    assertIncludes(
      serviceDocument,
      'app.kubernetes.io/component:',
      `${label} Service component selector`,
    );
    assertDocumentDoesNotSelectComponent(serviceDocument, 'model-prefetch', label);
  }
}

const rendered = render();

for (const spiffe of [
  'spiffe://cluster.local/psfn/gateway/companion',
  'spiffe://cluster.local/psfn/agent/companion',
  'spiffe://cluster.local/psfn/garden/companion',
]) {
  assertIncludes(rendered, spiffe, 'SPIFFE URI SAN contract');
}

for (const envName of [
  'SYSTEM_DATA_DIR',
  'COMPANION_DATA_DIR',
  'WORKSPACE_PATH',
  'POSTGRES_DATABASE_URL',
  'PSFN_REDIS_URL',
  'GATEWAY_RPC_ENDPOINT',
  'ADMIN_TRANSPORT_URL',
]) {
  assertIncludes(rendered, `- name: ${envName}`, 'runtime env contract');
}

assertIncludes(rendered, 'mountPath: /app/system-data', 'system-data PVC mount');
assertIncludes(rendered, 'mountPath: /app/companion-data', 'companion-data PVC mount');
assertIncludes(rendered, 'mountPath: /app/workspace', 'workspace PVC mount');
assertIncludes(rendered, 'mountPath: /app/models/transformers', 'model cache PVC mount');
assertIncludes(rendered, 'runAsUser: 999', 'numeric non-root user');
assertIncludes(rendered, 'runAsGroup: 999', 'numeric non-root group');
assertIncludes(rendered, 'CREATE EXTENSION IF NOT EXISTS vector;', 'pgvector init SQL');
assertIncludes(rendered, 'kind: NetworkPolicy', 'network policy render');
assertNotIncludes(rendered, 'ALLOW_AGENT_OUTBOUND_NETWORK', 'agent network isolation');
assertNotIncludes(rendered, 'name: psfn-model-prefetch', 'disabled model prefetch Job');

const appSecret = findDocument(rendered, 'psfn-app');
assertIncludes(appSecret, 'kind: Secret', 'app secret kind');
assertIncludes(appSecret, 'API_KEY:', 'API key secret');
assertIncludes(appSecret, 'ADMIN_TOKEN:', 'admin token secret');
assertIncludes(appSecret, 'GATEWAY_SESSION_HMAC_KEY:', 'session HMAC secret');

const defaultDenyPolicy = findDocument(rendered, 'psfn-default-deny');
assertIncludes(defaultDenyPolicy, 'podSelector: {}', 'default deny policy');
assertIncludes(defaultDenyPolicy, '- Ingress', 'default deny ingress');
assertIncludes(defaultDenyPolicy, '- Egress', 'default deny egress');

const agentPolicy = findDocument(rendered, 'psfn-agent');
assertNotIncludes(agentPolicy, '0.0.0.0/0', 'agent policy broad egress');
assertIncludes(agentPolicy, 'component: gateway', 'agent policy gateway flow');
assertIncludes(agentPolicy, 'component: postgres', 'agent policy postgres flow');
assertIncludes(agentPolicy, 'component: redis', 'agent policy redis flow');
assertNotIncludes(rendered, 'psfn-satellite-hub', 'default disabled satellite hub');

const strictSecretRendered = render([
  '--set',
  'secrets.allowMissingRequired=false',
  '--set-string',
  'secrets.values.apiKey=verify-api-key',
  '--set-string',
  'secrets.values.adminToken=verify-admin-token',
  '--set-string',
  'secrets.values.gatewaySessionHmacKey=verify-hmac-key',
]);

assertIncludes(strictSecretRendered, 'API_KEY: "verify-api-key"', 'strict app secret API key');
assertIncludes(strictSecretRendered, 'ADMIN_TOKEN: "verify-admin-token"', 'strict app secret admin token');
assertIncludes(strictSecretRendered, 'GATEWAY_SESSION_HMAC_KEY: "verify-hmac-key"', 'strict app secret HMAC key');

const externalRendered = render([
  '--set',
  'postgres.enabled=false',
  '--set',
  'postgres.external.enabled=true',
  '--set',
  'postgres.external.databaseUrlSecret.name=external-pg',
  '--set',
  'redis.mode=external',
  '--set',
  'redis.external.url=redis://external-redis:6379',
  '--set',
  'redis.external.passwordSecret.name=external-redis-secret',
]);

assertIncludes(externalRendered, 'name: external-pg', 'external Postgres secret ref');
assertIncludes(externalRendered, 'value: "redis://external-redis:6379"', 'external Redis URL');
assertNotIncludes(externalRendered, 'name: psfn-postgres\n', 'bundled Postgres resources in external mode');
assertNotIncludes(externalRendered, 'name: psfn-redis\n', 'bundled Redis resources in external mode');

const hubDigest = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const hubRendered = render([
  '--set',
  'satelliteHub.enabled=true',
  '--set',
  'satelliteHub.image.repository=localhost/psfn-satellite-hub',
  '--set',
  'satelliteHub.image.tag=0.1.0-kube-de65b21dfbc3',
  '--set-string',
  `satelliteHub.image.digest=${hubDigest}`,
  '--set-string',
  'satelliteHub.elevenLabsVoiceId=voice-verify',
  '--set-string',
  'secrets.values.deepgramApiKey=verify-deepgram',
  '--set-string',
  'secrets.values.elevenLabsApiKey=verify-eleven',
  '--set',
  'ingress.satelliteHub.enabled=true',
  '--set',
  'ingress.satelliteHub.path=/satellite',
]);

const hubSecret = findDocumentByKindName(hubRendered, 'Secret', 'psfn-app');
assertIncludes(hubSecret, 'DEEPGRAM_API_KEY: "verify-deepgram"', 'satellite hub Deepgram secret');
assertIncludes(hubSecret, 'ELEVENLABS_API_KEY: "verify-eleven"', 'satellite hub ElevenLabs secret');

const hubDeployment = findDocumentByKindName(hubRendered, 'Deployment', 'psfn-satellite-hub');
assertIncludes(hubDeployment, `image: "localhost/psfn-satellite-hub:0.1.0-kube-de65b21dfbc3@${hubDigest}"`, 'satellite hub pinned image');
assertIncludes(hubDeployment, '- node', 'satellite hub command node');
assertIncludes(hubDeployment, '- dist/ts/hub/main.js', 'satellite hub command entrypoint');
assertIncludes(hubDeployment, 'runAsUser: 999', 'satellite hub numeric user');
assertIncludes(hubDeployment, 'name: hub-ws', 'satellite hub websocket port');
assertIncludes(hubDeployment, 'containerPort: 8787', 'satellite hub websocket container port');
assertIncludes(hubDeployment, 'path: /', 'satellite hub health probe path');
assertIncludes(hubDeployment, 'mountPath: /app/.artifacts', 'satellite hub artifact mount');
assertIncludes(hubDeployment, 'name: AGENT_RUNTIME', 'satellite hub agent runtime env');
assertIncludes(hubDeployment, 'value: "psfn"', 'satellite hub PSFN runtime');
assertIncludes(hubDeployment, 'name: REALTIME_VOICE_PORT', 'satellite hub listen port env');
assertIncludes(hubDeployment, 'value: "8787"', 'satellite hub listen port value');
assertIncludes(hubDeployment, 'name: PSFN_API_BASE_URL', 'satellite hub PSFN API env');
assertIncludes(hubDeployment, 'value: "http://psfn-gateway:10053/v1"', 'satellite hub in-cluster gateway API wiring');
assertIncludes(hubDeployment, 'name: PSFN_API_KEY', 'satellite hub API key env');
assertIncludes(hubDeployment, 'key: API_KEY', 'satellite hub API key secret key');
assertIncludes(hubDeployment, 'name: DEEPGRAM_API_KEY', 'satellite hub Deepgram env');
assertIncludes(hubDeployment, 'key: DEEPGRAM_API_KEY', 'satellite hub Deepgram secret key');
assertIncludes(hubDeployment, 'name: ELEVENLABS_API_KEY', 'satellite hub ElevenLabs env');
assertIncludes(hubDeployment, 'key: ELEVENLABS_API_KEY', 'satellite hub ElevenLabs secret key');
assertIncludes(hubDeployment, 'name: ELEVENLABS_VOICE_ID', 'satellite hub ElevenLabs voice env');
assertIncludes(hubDeployment, 'value: "voice-verify"', 'satellite hub ElevenLabs voice value');
assertIncludes(hubDeployment, 'name: ARTIFACT_ROOT', 'satellite hub artifact env');
assertNotIncludes(hubDeployment, 'optional: true', 'satellite hub secret refs');

const hubService = findDocumentByKindName(hubRendered, 'Service', 'psfn-satellite-hub');
assertIncludes(hubService, 'name: hub-ws', 'satellite hub Service websocket port');
assertIncludes(hubService, 'port: 8787', 'satellite hub Service websocket port value');
assertIncludes(hubService, 'targetPort: hub-ws', 'satellite hub Service target port');

const hubIngress = findDocumentByKindName(hubRendered, 'Ingress', 'psfn-satellite-hub');
assertIncludes(hubIngress, 'path: "/satellite"', 'satellite hub configured Ingress path');
assertIncludes(hubIngress, 'name: hub-ws', 'satellite hub Ingress service port');

const hubPolicy = findDocumentByKindName(hubRendered, 'NetworkPolicy', 'psfn-satellite-hub');
assertIncludes(hubPolicy, 'app.kubernetes.io/name: traefik', 'satellite hub ingress controller policy');
assertIncludes(hubPolicy, 'k8s-app: kube-dns', 'satellite hub DNS egress');
assertIncludes(hubPolicy, 'component: gateway', 'satellite hub gateway egress');
assertIncludes(hubPolicy, 'cidr: 0.0.0.0/0', 'satellite hub provider HTTPS egress');
assertIncludes(hubPolicy, 'port: 443', 'satellite hub HTTPS egress port');

const hubEnabledAgentPolicy = findDocumentByKindName(hubRendered, 'NetworkPolicy', 'psfn-agent');
assertNotIncludes(hubEnabledAgentPolicy, '0.0.0.0/0', 'hub-enabled agent policy broad egress');
assertNotIncludes(hubEnabledAgentPolicy, 'component: satellite-hub', 'hub-enabled agent policy satellite access');

const hubDigestOnlyRendered = render([
  '--set',
  'satelliteHub.enabled=true',
  '--set',
  'satelliteHub.image.repository=localhost/psfn-satellite-hub',
  '--set-string',
  `satelliteHub.image.digest=${hubDigest}`,
  '--set-string',
  'satelliteHub.elevenLabsVoiceId=voice-verify',
]);
const hubDigestOnlyDeployment = findDocumentByKindName(hubDigestOnlyRendered, 'Deployment', 'psfn-satellite-hub');
assertIncludes(hubDigestOnlyDeployment, `image: "localhost/psfn-satellite-hub@${hubDigest}"`, 'satellite hub digest-only image');

const prefetchRendered = render([
  '--set',
  'modelPrefetch.enabled=true',
]);

const prefetchJob = findDocument(prefetchRendered, 'psfn-model-prefetch');
assertIncludes(prefetchJob, 'kind: Job', 'model prefetch Job kind');
assertIncludes(prefetchJob, 'app.kubernetes.io/component: model-prefetch', 'model prefetch Job component label');
assertIncludes(prefetchJob, 'image: "localhost/psfn-framework:0.1.0-kube"', 'model prefetch Job image');
assertIncludes(prefetchJob, '- node', 'model prefetch Job command node');
assertIncludes(prefetchJob, '- --input-type=module', 'model prefetch Job command module mode');
assertIncludes(prefetchJob, "pipeline('text-classification', model, { dtype })", 'model prefetch text emotion command');
assertIncludes(prefetchJob, 'name: TRANSFORMERS_CACHE_DIR', 'model prefetch cache env');
assertIncludes(prefetchJob, 'value: "/app/models/transformers"', 'model prefetch cache env value');
assertIncludes(prefetchJob, 'name: PSFN_PREFETCH_TEXT_EMOTION_MODEL', 'model prefetch model env');
assertIncludes(prefetchJob, 'value: "SamLowe/roberta-base-go_emotions-onnx"', 'model prefetch model value');
assertIncludes(prefetchJob, 'mountPath: /app/models/transformers', 'model prefetch model-cache mount');
assertIncludes(prefetchJob, 'claimName: psfn-model-cache', 'model prefetch model-cache PVC');
assertIncludes(prefetchJob, 'runAsUser: 999', 'model prefetch numeric user');
assertIncludes(prefetchJob, 'runAsGroup: 999', 'model prefetch numeric group');
assertIncludes(prefetchJob, 'fsGroup: 999', 'model prefetch fsGroup');
for (const component of ['gateway', 'agent', 'garden', 'satellite-hub']) {
  assertDocumentDoesNotSelectComponent(prefetchJob, component, 'model prefetch Job labels');
}
assertServiceSelectorsDoNotSelectPrefetch(prefetchRendered, 'prefetch render');

const prefetchPolicy = findDocument(prefetchRendered, 'psfn-model-prefetch-egress');
assertIncludes(prefetchPolicy, 'kind: NetworkPolicy', 'model prefetch NetworkPolicy kind');
assertIncludes(prefetchPolicy, 'component: model-prefetch', 'model prefetch NetworkPolicy selector');
assertIncludes(prefetchPolicy, 'port: 443', 'model prefetch external HTTPS egress');

const prefetchAgentPolicy = findDocument(prefetchRendered, 'psfn-agent');
assertNotIncludes(prefetchAgentPolicy, '0.0.0.0/0', 'agent policy broad egress with prefetch enabled');
assertNotIncludes(prefetchAgentPolicy, 'component: model-prefetch', 'agent policy model prefetch label');

const prefetchHubRendered = render([
  '--set',
  'modelPrefetch.enabled=true',
  '--set',
  'satelliteHub.enabled=true',
  '--set',
  'satelliteHub.image.repository=localhost/psfn-satellite-hub',
  '--set',
  'satelliteHub.image.tag=0.1.0-kube-de65b21dfbc3',
  '--set-string',
  'satelliteHub.elevenLabsVoiceId=voice-verify',
]);
assertServiceSelectorsDoNotSelectPrefetch(prefetchHubRendered, 'prefetch plus satellite hub render');

assertRenderFails(
  ['--set', 'certificates.enabled=false'],
  'certificates.enabled must be true',
);
assertRenderFails(
  [
    '--set',
    'secrets.allowMissingRequired=false',
    '--set-string',
    'secrets.values.apiKey=',
    '--set-string',
    'secrets.values.adminToken=verify-admin-token',
    '--set-string',
    'secrets.values.gatewaySessionHmacKey=verify-hmac-key',
  ],
  'secrets.values.apiKey is required when secrets.allowMissingRequired=false',
);
assertRenderFails(
  ['--set', 'postgres.enabled=false'],
  'postgres.enabled=false requires postgres.external.enabled=true',
);
assertRenderFails(
  ['--set', 'redis.mode=external', '--set', 'redis.external.passwordSecret.name=external-redis-secret'],
  'redis.external.url is required when redis.mode=external',
);
assertRenderFails(
  ['--set', 'satelliteHub.enabled=true'],
  'satelliteHub.image.repository is required when satelliteHub.enabled=true',
);
assertRenderFails(
  ['--set', 'modelPrefetch.enabled=true', '--set', 'persistence.modelCache.enabled=false'],
  'modelPrefetch.enabled=true requires persistence.modelCache.enabled=true',
);
assertRenderFails(
  [
    '--set',
    'satelliteHub.enabled=true',
    '--set',
    'satelliteHub.image.repository=localhost/psfn-satellite-hub',
    '--set-string',
    'satelliteHub.elevenLabsVoiceId=voice-verify',
  ],
  'satelliteHub.image.tag or satelliteHub.image.digest is required when satelliteHub.enabled=true',
);
assertRenderFails(
  [
    '--set',
    'satelliteHub.enabled=true',
    '--set',
    'satelliteHub.image.repository=localhost/psfn-satellite-hub',
    '--set',
    'satelliteHub.image.tag=latest',
    '--set-string',
    'satelliteHub.elevenLabsVoiceId=voice-verify',
  ],
  'satelliteHub.image.tag must be pinned',
);
assertRenderFails(
  [
    '--set',
    'satelliteHub.enabled=true',
    '--set',
    'satelliteHub.image.repository=localhost/psfn-satellite-hub',
    '--set-string',
    'satelliteHub.image.digest=deadbeef',
    '--set-string',
    'satelliteHub.elevenLabsVoiceId=voice-verify',
  ],
  'satelliteHub.image.digest must start with sha256:',
);
assertRenderFails(
  [
    '--set',
    'satelliteHub.enabled=true',
    '--set',
    'satelliteHub.image.repository=localhost/psfn-satellite-hub',
    '--set',
    'satelliteHub.image.tag=0.1.0-kube-de65b21dfbc3',
  ],
  'satelliteHub.elevenLabsVoiceId is required when satelliteHub.enabled=true',
);
assertRenderFails(
  [
    '--set',
    'satelliteHub.enabled=true',
    '--set',
    'satelliteHub.agentRuntime=hermes',
    '--set',
    'satelliteHub.image.repository=localhost/psfn-satellite-hub',
    '--set',
    'satelliteHub.image.tag=0.1.0-kube-de65b21dfbc3',
    '--set-string',
    'satelliteHub.elevenLabsVoiceId=voice-verify',
  ],
  'satelliteHub.agentRuntime must be psfn',
);
assertRenderFails(
  [
    '--set',
    'satelliteHub.enabled=true',
    '--set',
    'satelliteHub.image.repository=localhost/psfn-satellite-hub',
    '--set',
    'satelliteHub.image.tag=0.1.0-kube-de65b21dfbc3',
    '--set-string',
    'satelliteHub.elevenLabsVoiceId=voice-verify',
    '--set',
    'secrets.allowMissingRequired=false',
    '--set-string',
    'secrets.values.apiKey=verify-api-key',
    '--set-string',
    'secrets.values.adminToken=verify-admin-token',
    '--set-string',
    'secrets.values.gatewaySessionHmacKey=verify-hmac-key',
  ],
  'secrets.values.deepgramApiKey is required for satelliteHub.enabled=true',
);

console.log('Helm chart verification passed.');
