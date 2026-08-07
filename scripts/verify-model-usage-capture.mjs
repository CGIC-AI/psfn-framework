#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const EXCLUDED_PREFIXES = [
  'src/app/e2e/',
  'node_modules/',
  'dist/',
  'admin-ui/',
];

export const CANONICAL_LLM_TRANSPORT_FILES = new Set([
  'src/primitives/llm/client.ts',
  'src/primitives/llm/client-request-capability.ts',
  'src/primitives/llm/client-stream-capability.ts',
]);

function sourceFiles() {
  return execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'src/**/*.ts', 'scripts/**/*.ts'],
    { encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean)
    .filter(file => existsSync(file))
    .filter(file => !file.endsWith('.test.ts'))
    .filter(file => !EXCLUDED_PREFIXES.some(prefix => file.startsWith(prefix)));
}

function lineNumber(text, offset) {
  return text.slice(0, offset).split('\n').length;
}

const files = sourceFiles();
const violations = [];

function allowOnly(pattern, allowedFiles, description) {
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(pattern)) {
      if (!allowedFiles.has(file)) {
        violations.push(`${file}:${lineNumber(text, match.index ?? 0)} ${description}`);
      }
    }
  }
}

allowOnly(
  /\b(?:completeSimple|streamSimple)\s*\(/g,
  new Set([
    ...CANONICAL_LLM_TRANSPORT_FILES,
    'src/primitives/images/vision-reviewer.ts',
  ]),
  'direct pi-ai model call bypasses the canonical LLM client',
);
allowOnly(
  /new\s+LLMClient\s*\(/g,
  new Set(['src/system/config/provider-runtime-factory.ts']),
  'LLMClient construction bypasses canonical provider composition',
);
allowOnly(
  /\bcreateEmbeddingProviderFrom(?:Config|Env)\s*\(/g,
  new Set([
    'src/faculties/memory/embedding.ts',
    'src/system/config/provider-runtime-factory.ts',
  ]),
  'raw embedding provider factory bypasses canonical provider composition',
);
allowOnly(
  /new\s+(?:ApiEmbeddingProvider|OllamaEmbeddingProvider|TransformersEmbeddingProvider)\s*\(/g,
  new Set([
    'src/faculties/memory/embedding.ts',
    'scripts/prefetch-hf-models.ts',
  ]),
  'embedding provider construction bypasses the canonical embedding factory',
);
allowOnly(
  /\bwithEmbeddingUsageAccounting\s*\(/g,
  new Set([
    'src/faculties/memory/embedding-accounting.ts',
    'src/system/config/provider-runtime-factory.ts',
  ]),
  'embedding accounting wrapper is constructed outside canonical provider composition',
);
allowOnly(
  /new\s+ImageService\s*\(/g,
  new Set(['src/boundary/gateway/methods/image.ts']),
  'ImageService construction bypasses gateway attempt accounting',
);
allowOnly(
  /new\s+(?:FalImageClient|ComfyUiImageClient)\s*\(/g,
  new Set(['src/primitives/images/service.ts']),
  'raw image provider construction bypasses the gateway-accounted image service',
);
allowOnly(
  /new\s+GatewayImageOps\s*\(/g,
  new Set(['src/app/agent/core-runtime.ts']),
  'image gateway operations are constructed outside the accounted agent entrypoint',
);
allowOnly(
  /\bcreate(?:OpenAICompatibleEndpointModel|LiteLLMModel|Model)\s*\(/g,
  new Set([
    ...CANONICAL_LLM_TRANSPORT_FILES,
    'src/primitives/llm/models.ts',
    'src/core/agent/stream-adapter.ts',
  ]),
  'provider model construction is outside the canonical LLM routing stack',
);
allowOnly(
  /\bresolveRegisteredModel\s*\(/g,
  new Set([
    ...CANONICAL_LLM_TRANSPORT_FILES,
    'src/primitives/llm/models.ts',
    'src/core/agent/stream-adapter.ts',
  ]),
  'registered provider model resolution is outside the canonical LLM routing stack',
);
allowOnly(
  /new\s+DefaultImageVisionReviewer\s*\(/g,
  new Set(['src/app/agent/core-runtime.ts']),
  'vision reviewer construction is outside the accounted agent entrypoint',
);

const requiredWiring = [
  {
    file: 'src/system/config/provider-runtime-factory.ts',
    patterns: [
      /usageRecorder:\s*options\.llmOptions\?\.usageRecorder\s*\?\?\s*modelUsageStore/,
      /usageBudgetQuery:\s*options\.llmOptions\?\.usageBudgetQuery\s*\?\?\s*modelUsageStore/,
      /withEmbeddingUsageAccounting\(embeddingProvider,\s*modelUsageStore,\s*\{[\s\S]{0,240}?estimatedRates:\s*embeddingRates,[\s\S]{0,240}?companionId:[\s\S]{0,120}?\}\s*\)/,
    ],
  },
  {
    file: 'src/boundary/gateway/privileged-services.ts',
    patterns: [/createProviderRuntimeServices\(/, /consumeActiveGatewayCapturedProviderCost/],
  },
  {
    file: 'src/app/cli/chat-cli.ts',
    patterns: [/createProviderRuntimeServices\(\{\s*config\s*\}\)/],
  },
  {
    file: 'src/app/agent/core-runtime.ts',
    patterns: [
      /const\s+llmProvider\s*=\s*createLLMProviderPort\(gateway\)/,
      /composeSubstrateAgent\([\s\S]{0,800}\bllmProvider\b/,
      /new\s+DefaultImageVisionReviewer[\s\S]{0,300}\bllmProvider\b/,
    ],
  },
  {
    file: 'src/app/agent/main.ts',
    patterns: [
      /GatewayClient\.connectEndpoint\(/,
      /bootstrapAgentCoreRuntime\([\s\S]{0,800}\bgateway\b/,
    ],
  },
];

for (const assertion of requiredWiring) {
  const text = readFileSync(assertion.file, 'utf8');
  for (const pattern of assertion.patterns) {
    if (!pattern.test(text)) {
      violations.push(`${assertion.file}: canonical model-usage entrypoint wiring is missing (${pattern})`);
    }
  }
}

if (violations.length > 0) {
  console.error('Canonical model-usage capture verification failed:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log('Canonical model-usage capture verification passed.');
}
