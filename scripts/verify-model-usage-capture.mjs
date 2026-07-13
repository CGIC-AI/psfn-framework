#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const EXCLUDED_PREFIXES = [
  'src/app/e2e/',
  'node_modules/',
  'dist/',
  'admin-ui/',
];

function sourceFiles() {
  return execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'src/**/*.ts'],
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
    'src/primitives/llm/client.ts',
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
  /new\s+ImageService\s*\(/g,
  new Set(['src/boundary/gateway/methods/image.ts']),
  'ImageService construction bypasses gateway attempt accounting',
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
      /withEmbeddingUsageAccounting\(embeddingProvider,\s*modelUsageStore,\s*\{\s*estimatedRates:\s*embeddingRates,?\s*\}\)/,
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
    patterns: [/new\s+DefaultImageVisionReviewer[\s\S]{0,300}\bllmProvider\b/],
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
