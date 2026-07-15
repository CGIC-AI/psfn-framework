import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parseAllDocuments, parseDocument } from 'yaml';
import { isRecord } from '../../shared/utils/types.js';

export const KUBERNETES_HELM_CHART_DIGEST_FILE_NAME = 'recovery-chart.sha256';

const CHART_DIGEST_DOMAIN = 'kubernetes-helm-recovery-chart-v1';
const CHART_ROOT_FILES = new Set([
  '.helmignore',
  'Chart.lock',
  'Chart.yaml',
  KUBERNETES_HELM_CHART_DIGEST_FILE_NAME,
  'values.schema.json',
  'values.yaml',
]);
const CHART_ROOT_DIRECTORIES = new Set(['charts', 'crds', 'overlays', 'templates']);
const EXCLUDED_CHART_DOCUMENT_NAMES = /^(?:README(?:\.[^.]+)?|LICENSE(?:\.[^.]+)?)$/i;
const VALUES_DOCUMENT_NAME = /^values.*\.ya?ml$/i;
const NON_SECRET_KEY_MAP_PATHS = new Set([
  'values.postgres.auth.keys',
  'values.secrets.keys',
]);
const SENSITIVE_VALUE_KEYS = new Set([
  'admintoken',
  'apikey',
  'backupencryptionkey',
  'clientsecret',
  'credential',
  'deepgramapikey',
  'discordtoken',
  'elevenlabsapikey',
  'embeddingapikey',
  'falapikey',
  'gatewaysessionhmackey',
  'gatewaysessionintegrityauthtoken',
  'hftoken',
  'litellmapikey',
  'masterkey',
  'ntfytoken',
  'openaiapikey',
  'openrouterapikey',
  'password',
  'passphrase',
  'privatekey',
  'secret',
  'token',
]);
const SENSITIVE_VALUE_KEY_SUFFIXES = [
  'apikey',
  'credential',
  'encryptionkey',
  'hmackey',
  'masterkey',
  'passphrase',
  'password',
  'privatekey',
  'secretkey',
  'token',
] as const;
const SAFE_COMPOSED_SECRET_EXPRESSIONS = new Set([
  'include "psfn.satelliteApiKeysValue" $ | quote',
  'printf "postgresql://%s:%s@%s:%v/%s" .Values.postgres.auth.username .Values.postgres.auth.password (include "psfn.postgresServiceName" .) .Values.ports.postgres .Values.postgres.auth.database | quote',
]);
const SAFE_NON_SECRET_DYNAMIC_KINDS = new Set([
  '{{ .Values.certificates.issuer.kind }}',
]);

export interface KubernetesHelmChartInspection {
  contentSha256: string;
  includedPaths: string[];
  excludedPaths: string[];
}

export interface KubernetesHelmChartMetadata {
  name: string;
  version: string;
  appVersion: string;
}

function toManifestPath(path: string): string {
  return path.split(sep).join('/');
}

function normalizeSensitiveKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function isSensitiveValueKey(key: string): boolean {
  const normalizedKey = normalizeSensitiveKey(key);
  return SENSITIVE_VALUE_KEYS.has(normalizedKey)
    || SENSITIVE_VALUE_KEY_SUFFIXES.some(suffix => normalizedKey.endsWith(suffix));
}

function isPlaceholderSecretValue(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true;
  return typeof value === 'string' && /^CHANGE_ME_[A-Z0-9_]+$/.test(value);
}

function isExternalSecretReference(value: unknown): boolean {
  return typeof value === 'string'
    && (/^os\.environ\/[A-Z][A-Z0-9_]*$/.test(value)
      || /^\$\{[A-Z][A-Z0-9_]*\}$/.test(value));
}

function assertSecretValueIsPlaceholder(value: unknown, path: string): void {
  if (isPlaceholderSecretValue(value) || isExternalSecretReference(value)) return;
  if (Array.isArray(value)) {
    if (value.length === 0) return;
  } else if (isRecord(value)) {
    for (const [key, nested] of Object.entries(value)) {
      assertSecretValueIsPlaceholder(nested, `${path}.${key}`);
    }
    return;
  }
  throw new Error(`Kubernetes Helm chart contains non-placeholder secret material at ${path}`);
}

function parseYamlDocumentsIfStructured(text: string, path: string): unknown[] {
  try {
    return parseYamlDocuments(text, path).filter(value => Array.isArray(value) || isRecord(value));
  } catch {
    return [];
  }
}

function parseAssignmentScalar(rawValue: string): unknown {
  const document = parseDocument(rawValue, {
    maxAliasCount: 0,
    prettyErrors: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) return Symbol('invalid-assignment-scalar');
  return document.toJS({ maxAliasCount: 0 }) as unknown;
}

function isSafeHelmSecretExpression(rawValue: string): boolean {
  if (!/^{{-?[\s\S]*-?}}$/.test(rawValue)) return false;
  const expression = rawValue.replace(/^{{-?/, '').replace(/-?}}$/, '').trim();
  if (SAFE_COMPOSED_SECRET_EXPRESSIONS.has(expression)) return true;
  const directValue = /^\$?\.Values((?:\.[A-Za-z_][A-Za-z0-9_]*)+)(?:\s*\|\s*(?:b64enc|quote|squote|toString|trim))*$/.exec(
    expression,
  );
  if (!directValue) return false;
  const valuePath = directValue[1].slice(1);
  return /^secrets\.values\.[A-Za-z_][A-Za-z0-9_]*$/.test(valuePath)
    || valuePath === 'postgres.auth.password'
    || valuePath === 'redis.auth.password';
}

function isSafeServiceAccountTokenAutomount(
  key: string,
  rawValue: string,
  allowHelmExpressions: boolean,
): boolean {
  if (!/^automountserviceaccounttoken$/.test(normalizeSensitiveKey(key))) return false;
  if (allowHelmExpressions
    && /^{{-?\s*\.Values\.kubeSelfManagement\.enabled\s*-?}}$/.test(rawValue)) {
    return true;
  }
  return typeof parseAssignmentScalar(rawValue) === 'boolean';
}

function assertSecretAssignmentValueIsSafe(path: string, key: string, rawValue: string): void {
  const value = rawValue.replace(/\s+#.*$/, '').trim();
  if (isSafeHelmSecretExpression(value)) return;
  if (/^{{-?[\s\S]*-?}}$/.test(value)) {
    throw new Error(
      `Kubernetes Helm chart contains non-placeholder Kubernetes Secret data in ${path} at key ${key}`,
    );
  }
  const scalar = parseAssignmentScalar(value);
  if (isPlaceholderSecretValue(scalar) || isExternalSecretReference(scalar)) return;
  throw new Error(
    `Kubernetes Helm chart contains non-placeholder Kubernetes Secret data in ${path} at key ${key}`,
  );
}

function assertParsedKubernetesSecretObjectsAreSafe(value: unknown, currentPath: string): void {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertParsedKubernetesSecretObjectsAreSafe(value[index], `${currentPath}[${index}]`);
    }
    return;
  }
  if (!isRecord(value)) return;
  if (value.kind === 'Secret') {
    for (const section of ['data', 'stringData'] as const) {
      if (!Object.hasOwn(value, section)) continue;
      const secretData = value[section];
      if (!isRecord(secretData)) {
        throw new Error(`Kubernetes Helm chart contains invalid Kubernetes Secret ${section} at ${currentPath}`);
      }
      for (const [key, secretValue] of Object.entries(secretData)) {
        assertSecretValueIsPlaceholder(secretValue, `${currentPath}.${section}.${key}`);
      }
    }
  }
  for (const [key, nested] of Object.entries(value)) {
    assertParsedKubernetesSecretObjectsAreSafe(nested, `${currentPath}.${key}`);
  }
}

function assertKubernetesSecretDataIsSafe(path: string, text: string): void {
  if (!text.includes('{{')) {
    for (const value of parseYamlDocuments(text, path)) {
      assertParsedKubernetesSecretObjectsAreSafe(value, path);
    }
    return;
  }

  if (/{{-?[^\r\n]*(?:apiVersion[^\r\n]*kind|kind[ \t]*:[ \t]*Secret)[^\r\n]*-?}}/.test(text)) {
    throw new Error(`Kubernetes Helm chart emits an unscannable Kubernetes resource in ${path}`);
  }
  for (const action of text.matchAll(/{{-?[\s\S]*?-?}}/g)) {
    if (/\bdict\b/.test(action[0])
      && /["']kind["']/.test(action[0])
      && /["']Secret["']/.test(action[0])) {
      throw new Error(`Kubernetes Helm chart constructs an unscannable Kubernetes Secret in ${path}`);
    }
  }
  if (/^[ \t]*(?:["']kind["']|kind)[ \t]*:[ \t]*(?:!!str[ \t]+)?["']?Secret["']?[^\r\n]*{{/m.test(text)) {
    throw new Error(`Kubernetes Helm chart contains an unscannable templated Secret kind in ${path}`);
  }
  const documents = text.split(/^\s*---\s*$/m);
  for (const document of documents) {
    if (/^[ \t]*apiVersion[ \t]*:/m.test(document)) {
      const dynamicKind = /^[ \t]*(?:["']kind["']|kind)[ \t]*:[ \t]*({{[^\r\n]*}})[ \t]*$/m.exec(document);
      if (dynamicKind && !SAFE_NON_SECRET_DYNAMIC_KINDS.has(dynamicKind[1])) {
        throw new Error(`Kubernetes Helm chart contains an unscannable templated Kubernetes kind in ${path}`);
      }
    }
    const isSecretDocument = /^[ \t]*(?:["']kind["']|kind)[ \t]*:[ \t]*(?:!!str[ \t]+)?["']?Secret["']?[ \t]*(?:#.*)?$/m.test(
      document,
    );
    if (!isSecretDocument) continue;
    if (/[{,][ \t]*["']?(?:data|stringData)["']?[ \t]*:/.test(document)) {
      throw new Error(`Kubernetes Helm chart contains unsupported inline Kubernetes Secret data in ${path}`);
    }
    const lines = document.split(/\r?\n/);
    let secretDataIndent: number | undefined;
    for (const line of lines) {
      const dataMarker = /^(\s*)["']?(?:data|stringData)["']?[ \t]*:[ \t]*(.*)$/.exec(line);
      if (dataMarker) {
        if (dataMarker[2].trim() !== '') {
          throw new Error(`Kubernetes Helm chart contains unsupported inline Kubernetes Secret data in ${path}`);
        }
        secretDataIndent = dataMarker[1].length;
        continue;
      }
      if (secretDataIndent === undefined || /^\s*(?:#.*)?$/.test(line)) continue;

      const trimmed = line.trim();
      if (/^{{-?\s*(?:else|end|if|range|with)\b[\s\S]*-?}}$/.test(trimmed)) continue;
      const dynamicAssignment = /^\s*({{-?[\s\S]+?-?}})\s*:\s*(.*?)\s*$/.exec(line);
      if (dynamicAssignment) {
        assertSecretAssignmentValueIsSafe(path, dynamicAssignment[1], dynamicAssignment[2]);
        continue;
      }
      if (/^{{-?[\s\S]*-?}}$/.test(trimmed)) {
        throw new Error(`Kubernetes Helm chart emits unscannable Kubernetes Secret data in ${path}`);
      }

      const indentation = line.length - line.trimStart().length;
      if (indentation <= secretDataIndent) {
        secretDataIndent = undefined;
        continue;
      }
      const staticAssignment = /^\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s:][^:]*))\s*:\s*(.*?)\s*$/.exec(line);
      if (!staticAssignment) {
        throw new Error(`Kubernetes Helm chart contains unscannable Kubernetes Secret data in ${path}`);
      }
      const key = (staticAssignment.slice(1, 4) as Array<string | undefined>)
        .find((candidate): candidate is string => candidate !== undefined);
      if (key === undefined) {
        throw new Error(`Kubernetes Helm chart credential scanner failed to parse Secret data in ${path}`);
      }
      assertSecretAssignmentValueIsSafe(path, key.trim(), staticAssignment[4]);
    }
  }
}

function assertCredentialAssignmentsAreSafe(
  path: string,
  text: string,
  allowHelmExpressions: boolean,
): void {
  const assignment = /^[ \t]*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([A-Za-z][A-Za-z0-9_.-]*))[ \t]*:[ \t]*(.*?)[ \t]*$/gm;
  for (const match of text.matchAll(assignment)) {
    const key = (match.slice(1, 4) as Array<string | undefined>)
      .find((candidate): candidate is string => candidate !== undefined);
    if (key === undefined) {
      throw new Error(`Kubernetes Helm chart credential scanner failed to parse an assignment in ${path}`);
    }
    if (!isSensitiveValueKey(key)) continue;
    const rawValue = match[4].replace(/\s+#.*$/, '').trim();
    // This Kubernetes API field is a boolean policy switch, not credential
    // material. Keep the exception schema-specific and reject every non-boolean
    // value, including arbitrary Helm expressions.
    if (isSafeServiceAccountTokenAutomount(key, rawValue, allowHelmExpressions)) continue;
    if (allowHelmExpressions && isSafeHelmSecretExpression(rawValue)) continue;
    if (allowHelmExpressions && /^{{-?[\s\S]*-?}}$/.test(rawValue)) {
      throw new Error(
        `Kubernetes Helm chart contains a literal credential assignment in ${path} at key ${key}`,
      );
    }
    const scalar = parseAssignmentScalar(rawValue);
    if (isPlaceholderSecretValue(scalar) || isExternalSecretReference(scalar)) continue;
    throw new Error(
      `Kubernetes Helm chart contains a literal credential assignment in ${path} at key ${key}`,
    );
  }
}

function assertEmbeddedTextIsSecretFree(path: string, text: string): void {
  assertCredentialAssignmentsAreSafe(path, text, false);
  const equalsAssignment = /^[ \t]*(?:export[ \t]+)?(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([A-Za-z][A-Za-z0-9_.-]*))[ \t]*=[ \t]*(.*?)[ \t]*$/gm;
  for (const match of text.matchAll(equalsAssignment)) {
    const key = (match.slice(1, 4) as Array<string | undefined>)
      .find((candidate): candidate is string => candidate !== undefined);
    if (key === undefined || !isSensitiveValueKey(key)) continue;
    const rawValue = match[4].replace(/\s+#.*$/, '').trim();
    const scalar = parseAssignmentScalar(rawValue);
    if (isPlaceholderSecretValue(scalar) || isExternalSecretReference(scalar)) continue;
    throw new Error(
      `Kubernetes Helm chart contains a literal credential assignment in ${path} at key ${key}`,
    );
  }
  const inlineEqualsAssignment = /(?=[{,][ \t]*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([A-Za-z][A-Za-z0-9_.-]*))[ \t]*=[ \t]*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,}\r\n]*))/g;
  for (const match of text.matchAll(inlineEqualsAssignment)) {
    const key = (match.slice(1, 4) as Array<string | undefined>)
      .find((candidate): candidate is string => candidate !== undefined);
    if (key === undefined || !isSensitiveValueKey(key)) continue;
    const scalar = parseAssignmentScalar(match[4].trim());
    if (isPlaceholderSecretValue(scalar) || isExternalSecretReference(scalar)) continue;
    throw new Error(
      `Kubernetes Helm chart contains a literal credential assignment in ${path} at key ${key}`,
    );
  }
  const shellEqualsAssignment = /(?=(?:^|[ \t])(?:export[ \t]+)?(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([A-Za-z][A-Za-z0-9_.-]*))[ \t]*=[ \t]*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s;]+))/gm;
  for (const match of text.matchAll(shellEqualsAssignment)) {
    const key = (match.slice(1, 4) as Array<string | undefined>)
      .find((candidate): candidate is string => candidate !== undefined);
    if (key === undefined || !isSensitiveValueKey(key)) continue;
    const scalar = parseAssignmentScalar(match[4].trim());
    if (isPlaceholderSecretValue(scalar) || isExternalSecretReference(scalar)) continue;
    throw new Error(
      `Kubernetes Helm chart contains a literal credential assignment in ${path} at key ${key}`,
    );
  }
  for (const value of parseYamlDocumentsIfStructured(text, path)) {
    assertParsedKubernetesSecretObjectsAreSafe(value, path);
    assertParsedValuesAreSecretFree(value, path);
  }
}

function assertParsedValuesAreSecretFree(
  value: unknown,
  path: string,
  insideSecretValues = false,
): void {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertParsedValuesAreSecretFree(value[index], `${path}[${index}]`, insideSecretValues);
    }
    return;
  }
  if (!isRecord(value)) {
    if (insideSecretValues) assertSecretValueIsPlaceholder(value, path);
    else if (typeof value === 'string') {
      assertEmbeddedTextIsSecretFree(path, value);
    }
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    const normalizedKey = normalizeSensitiveKey(key);
    const childPath = path ? `${path}.${key}` : key;
    if (normalizedKey === 'keys' && NON_SECRET_KEY_MAP_PATHS.has(childPath)) continue;
    const childInsideSecretValues = insideSecretValues
      || (normalizeSensitiveKey(path.split('.').at(-1) ?? '') === 'secrets'
        && normalizedKey === 'values');
    if (childInsideSecretValues || isSensitiveValueKey(normalizedKey)) {
      assertSecretValueIsPlaceholder(nested, childPath);
      continue;
    }
    assertParsedValuesAreSecretFree(nested, childPath, false);
  }
}

function parseYamlDocuments(text: string, path: string): unknown[] {
  const documents = parseAllDocuments(text, {
    maxAliasCount: 0,
    prettyErrors: true,
    uniqueKeys: true,
  });
  const errors = documents.flatMap(document => document.errors);
  if (errors.length > 0) {
    throw new Error(`Kubernetes Helm chart contains invalid YAML at ${path}: ${errors[0].message}`);
  }
  return documents.map(document => document.toJS({ maxAliasCount: 0 }) as unknown);
}

function assertValuesDocumentIsSecretFree(path: string, text: string): void {
  for (const value of parseYamlDocuments(text, path)) {
    assertParsedKubernetesSecretObjectsAreSafe(value, path);
    assertParsedValuesAreSecretFree(value, 'values');
  }
}

function assertValuesSchemaIsSecretFree(path: string, text: string): void {
  let schema: unknown;
  try {
    schema = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `Kubernetes Helm chart contains invalid JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const visit = (value: unknown, currentPath: string, sensitiveProperty = false): void => {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        visit(value[index], `${currentPath}[${index}]`, sensitiveProperty);
      }
      return;
    }
    if (!isRecord(value)) {
      if (typeof value === 'string') {
        assertEmbeddedTextIsSecretFree(currentPath, value);
      }
      return;
    }

    if (typeof value.$ref === 'string') {
      throw new Error(
        `Kubernetes Helm chart uses an unsupported $ref in values schema at ${currentPath}`,
      );
    }
    if (sensitiveProperty) {
      for (const field of ['const', 'default', 'enum', 'examples'] as const) {
        if (Object.hasOwn(value, field)) {
          assertSecretValueIsPlaceholder(value[field], `${currentPath}.${field}`);
        }
      }
    }

    for (const [key, nested] of Object.entries(value)) {
      const childPath = `${currentPath}.${key}`;
      if (['const', 'default', 'enum', 'examples'].includes(key)) {
        assertParsedValuesAreSecretFree(nested, childPath);
      }
      if (key === 'patternProperties') {
        throw new Error(`Kubernetes Helm chart values schema uses unsupported patternProperties at ${childPath}`);
      }
      if (key === 'properties' && isRecord(nested)) {
        for (const [propertyName, propertySchema] of Object.entries(nested)) {
          visit(
            propertySchema,
            `${childPath}.${propertyName}`,
            isSensitiveValueKey(propertyName),
          );
        }
        continue;
      }
      visit(nested, childPath, sensitiveProperty);
    }
  };

  visit(schema, path);
}

function assertTemplateTextIsSecretFree(path: string, text: string): void {
  assertKubernetesSecretDataIsSafe(path, text);
  assertCredentialAssignmentsAreSafe(path, text, true);

  if (!text.includes('{{')) {
    for (const value of parseYamlDocuments(text, path)) {
      assertParsedValuesAreSecretFree(value, 'template');
    }
  }
}

function readUtf8ChartFile(path: string, relativePath: string): string {
  const bytes = readFileSync(path);
  if (bytes.includes(0)) {
    throw new Error(`Kubernetes Helm recovery chart contains an unsupported binary file: ${relativePath}`);
  }
  return bytes.toString('utf-8');
}

function assertRegularFile(path: string, relativePath: string): void {
  if (!lstatSync(path).isFile()) {
    throw new Error(`Kubernetes Helm recovery chart contains a non-regular path: ${relativePath}`);
  }
}

function inspectContentTree(options: {
  chartSourceDir: string;
  directoryPath: string;
  includedPaths: string[];
}): void {
  for (const entry of readdirSync(options.directoryPath, { withFileTypes: true })) {
    const absolutePath = join(options.directoryPath, entry.name);
    const relativePath = toManifestPath(relative(options.chartSourceDir, absolutePath));
    if (entry.isDirectory()) {
      inspectContentTree({ ...options, directoryPath: absolutePath });
      continue;
    }
    assertRegularFile(absolutePath, relativePath);
    if (VALUES_DOCUMENT_NAME.test(entry.name)) {
      throw new Error(`Kubernetes Helm recovery chart contains an unsupported values overlay: ${relativePath}`);
    }
    const text = readUtf8ChartFile(absolutePath, relativePath);
    assertTemplateTextIsSecretFree(relativePath, text);
    options.includedPaths.push(relativePath);
  }
}

function inspectChartRoot(options: {
  chartSourceDir: string;
  chartRootDir: string;
  isTopLevel: boolean;
  includedPaths: string[];
  excludedPaths: string[];
}): void {
  for (const requiredPath of ['Chart.yaml', 'values.yaml', 'templates']) {
    const absolutePath = join(options.chartRootDir, requiredPath);
    if (!existsSync(absolutePath)) {
      throw new Error(`Kubernetes Helm chart is incomplete: missing ${requiredPath}`);
    }
  }
  if (!lstatSync(join(options.chartRootDir, 'templates')).isDirectory()) {
    throw new Error('Kubernetes Helm chart is incomplete: templates is not a directory');
  }

  for (const entry of readdirSync(options.chartRootDir, { withFileTypes: true })) {
    const absolutePath = join(options.chartRootDir, entry.name);
    const relativePath = toManifestPath(relative(options.chartSourceDir, absolutePath));
    if (EXCLUDED_CHART_DOCUMENT_NAMES.test(entry.name)) {
      assertRegularFile(absolutePath, relativePath);
      options.excludedPaths.push(relativePath);
      continue;
    }
    if (entry.isDirectory()) {
      if (!CHART_ROOT_DIRECTORIES.has(entry.name)) {
        throw new Error(`Kubernetes Helm recovery chart contains an unsupported directory: ${relativePath}`);
      }
      if (entry.name === 'charts') {
        for (const subchart of readdirSync(absolutePath, { withFileTypes: true })) {
          const subchartPath = join(absolutePath, subchart.name);
          const subchartRelativePath = toManifestPath(relative(options.chartSourceDir, subchartPath));
          if (!subchart.isDirectory()) {
            throw new Error(
              `Kubernetes Helm recovery chart requires unpacked, auditable subcharts: ${subchartRelativePath}`,
            );
          }
          inspectChartRoot({
            ...options,
            chartRootDir: subchartPath,
            isTopLevel: false,
          });
        }
      } else {
        inspectContentTree({
          chartSourceDir: options.chartSourceDir,
          directoryPath: absolutePath,
          includedPaths: options.includedPaths,
        });
      }
      continue;
    }
    assertRegularFile(absolutePath, relativePath);
    if (!CHART_ROOT_FILES.has(entry.name)) {
      throw new Error(`Kubernetes Helm recovery chart contains an unsupported file: ${relativePath}`);
    }
    if (!options.isTopLevel && entry.name === KUBERNETES_HELM_CHART_DIGEST_FILE_NAME) {
      throw new Error(`Kubernetes Helm recovery chart subchart contains a reserved file: ${relativePath}`);
    }
    const text = readUtf8ChartFile(absolutePath, relativePath);
    if (entry.name === 'values.yaml') {
      assertValuesDocumentIsSecretFree(relativePath, text);
    } else if (entry.name === 'values.schema.json') {
      assertValuesSchemaIsSecretFree(relativePath, text);
    } else if (entry.name !== KUBERNETES_HELM_CHART_DIGEST_FILE_NAME) {
      assertTemplateTextIsSecretFree(relativePath, text);
    }
    options.includedPaths.push(relativePath);
  }
}

export function inspectKubernetesHelmRecoveryChart(
  chartSourceDir: string,
): KubernetesHelmChartInspection {
  if (!existsSync(chartSourceDir) || !lstatSync(chartSourceDir).isDirectory()) {
    throw new Error(`Kubernetes Helm chart directory missing: ${chartSourceDir}`);
  }
  const includedPaths: string[] = [];
  const excludedPaths: string[] = [];
  inspectChartRoot({
    chartSourceDir,
    chartRootDir: chartSourceDir,
    isTopLevel: true,
    includedPaths,
    excludedPaths,
  });
  includedPaths.sort((a, b) => a.localeCompare(b));
  excludedPaths.sort((a, b) => a.localeCompare(b));

  const hash = createHash('sha256');
  hash.update(`${CHART_DIGEST_DOMAIN}\0`);
  for (const relativePath of includedPaths) {
    if (relativePath === KUBERNETES_HELM_CHART_DIGEST_FILE_NAME) continue;
    const fileHash = createHash('sha256')
      .update(readFileSync(join(chartSourceDir, ...relativePath.split('/'))))
      .digest('hex');
    hash.update(relativePath);
    hash.update('\0');
    hash.update(fileHash);
    hash.update('\0');
  }
  return {
    contentSha256: hash.digest('hex'),
    includedPaths,
    excludedPaths,
  };
}

export function readKubernetesHelmRecoveryChartDigestFile(chartSourceDir: string): string {
  const digestPath = join(chartSourceDir, KUBERNETES_HELM_CHART_DIGEST_FILE_NAME);
  if (!existsSync(digestPath) || !lstatSync(digestPath).isFile()) {
    throw new Error(`Kubernetes Helm recovery chart digest file missing: ${digestPath}`);
  }
  const digest = readFileSync(digestPath, 'utf-8').trim();
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`Kubernetes Helm recovery chart digest file is invalid: ${digestPath}`);
  }
  return digest;
}

export function verifyKubernetesHelmRecoveryChart(
  chartSourceDir: string,
  expectedContentSha256?: string,
): KubernetesHelmChartInspection {
  const inspection = inspectKubernetesHelmRecoveryChart(chartSourceDir);
  const recordedDigest = readKubernetesHelmRecoveryChartDigestFile(chartSourceDir);
  if (inspection.contentSha256 !== recordedDigest) {
    throw new Error('Kubernetes Helm recovery chart contents do not match recovery-chart.sha256');
  }
  if (expectedContentSha256 !== undefined && inspection.contentSha256 !== expectedContentSha256) {
    throw new Error('Kubernetes Helm recovery chart does not match the chart rendered by the active release');
  }
  return inspection;
}

export function readKubernetesHelmChartMetadata(
  chartSourceDir: string,
): KubernetesHelmChartMetadata {
  const chartPath = join(chartSourceDir, 'Chart.yaml');
  const document = parseDocument(readFileSync(chartPath, 'utf-8'), {
    maxAliasCount: 0,
    prettyErrors: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error(`Kubernetes Helm chart metadata is invalid: ${document.errors[0].message}`);
  }
  const parsed = document.toJS({ maxAliasCount: 0 }) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`Kubernetes Helm chart metadata is invalid: ${chartPath}`);
  }
  const readMetadataField = (key: string): string => {
    const value = parsed[key];
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`Kubernetes Helm chart metadata missing ${key}: ${chartPath}`);
    }
    return value.trim();
  };
  return {
    name: readMetadataField('name'),
    version: readMetadataField('version'),
    appVersion: readMetadataField('appVersion'),
  };
}
