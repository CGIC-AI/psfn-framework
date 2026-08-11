#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CONTRACT_PATH = 'src/shared/contracts/intake-envelope.ts';

/**
 * Static production-call-site evidence for every canonical intake sink.
 *
 * The three self-authored mutation sinks deliberately share the one typed
 * `screenSelfAuthoredMutation` gate. Their entries therefore require both the
 * specific production tool call and the shared dynamic gate call, together
 * with an explicit architectural justification. All other sinks point at a
 * direct literal `gate.evaluate(...)` call.
 */
export const INTAKE_SINK_WIRING_CATALOG = Object.freeze({
  prompt_assembly: Object.freeze([{
    file: 'src/core/session/intake-sink-gating.ts',
    pattern: /gate\.evaluate\(\s*['"]prompt_assembly['"]/u,
  }]),
  memory_write: Object.freeze([{
    file: 'src/faculties/memory/writer.ts',
    pattern: /intakeSinkGate\.evaluate\(\s*['"]memory_write['"]/u,
  }]),
  wiki_write: Object.freeze([
    {
      file: 'src/faculties/wiki/tools.ts',
      pattern: /screenSelfAuthoredMutation\(\s*['"]wiki_write['"]/u,
      indirect: true,
      justification: 'The wiki tool delegates all model-authored mutation text to the shared self-authored mutation gate.',
    },
    {
      file: 'src/core/session/intake-sink-gating.ts',
      pattern: /gate\.evaluate\(\s*sink\s*,/u,
      indirect: true,
      justification: 'The typed SelfAuthoredMutationSink wrapper performs the one shared gate evaluation for wiki, persona, and trust mutations.',
    },
  ]),
  skill_write: Object.freeze([{
    file: 'src/faculties/skills/tools.ts',
    pattern: /gate\.evaluate\(\s*['"]skill_write['"]/u,
  }]),
  persona_mutation: Object.freeze([
    {
      file: 'src/core/identity/prompt-tools.ts',
      pattern: /screenSelfAuthoredMutation\(\s*['"]persona_mutation['"]/u,
      indirect: true,
      justification: 'The identity tool delegates every model-authored persona mutation to the shared self-authored mutation gate.',
    },
    {
      file: 'src/core/session/intake-sink-gating.ts',
      pattern: /gate\.evaluate\(\s*sink\s*,/u,
      indirect: true,
      justification: 'The typed SelfAuthoredMutationSink wrapper performs the one shared gate evaluation for wiki, persona, and trust mutations.',
    },
  ]),
  trust_mutation: Object.freeze([
    {
      file: 'src/core/contacts/tools.ts',
      pattern: /screenSelfAuthoredMutation\(\s*['"]trust_mutation['"]/u,
      indirect: true,
      justification: 'The contact tool delegates model-authored trust mutation text to the shared self-authored mutation gate.',
    },
    {
      file: 'src/core/session/intake-sink-gating.ts',
      pattern: /gate\.evaluate\(\s*sink\s*,/u,
      indirect: true,
      justification: 'The typed SelfAuthoredMutationSink wrapper performs the one shared gate evaluation for wiki, persona, and trust mutations.',
    },
  ]),
  tool_egress: Object.freeze([{
    file: 'src/core/agent/substrate-agent/egress-tool-guard.ts',
    pattern: /gate\.evaluate\(\s*['"]tool_egress['"]/u,
  }]),
});

function canonicalIntakeSinks(source) {
  const declaration = source.match(
    /export\s+const\s+INTAKE_SINKS\s*=\s*\[([\s\S]*?)\]\s*as\s+const\s*;/u,
  );
  if (!declaration?.[1]) {
    throw new Error(`Could not parse canonical INTAKE_SINKS from ${CONTRACT_PATH}`);
  }
  const sinks = [...declaration[1].matchAll(/['"]([^'"]+)['"]/gu)]
    .map(match => match[1]);
  if (sinks.length === 0 || new Set(sinks).size !== sinks.length) {
    throw new Error(`Canonical INTAKE_SINKS in ${CONTRACT_PATH} is empty or contains duplicates`);
  }
  return sinks;
}

/**
 * @param {{
 *   readFile?: (file: string) => string | undefined;
 *   catalog?: Record<string, readonly Array<{
 *     file: string;
 *     pattern: RegExp;
 *     indirect?: boolean;
 *     justification?: string;
 *   }>>;
 * }} [options]
 */
export function verifyIntakeSinkWiring(options = {}) {
  const readFile = options.readFile ?? (file => readFileSync(file, 'utf8'));
  const catalog = options.catalog ?? INTAKE_SINK_WIRING_CATALOG;
  const contractSource = readFile(CONTRACT_PATH);
  if (typeof contractSource !== 'string') {
    throw new Error(`Cannot read canonical IntakeSink contract: ${CONTRACT_PATH}`);
  }
  const sinks = canonicalIntakeSinks(contractSource);
  const canonical = new Set(sinks);
  const missing = sinks.filter(sink => !Object.hasOwn(catalog, sink));
  if (missing.length > 0) {
    throw new Error(`Canonical IntakeSink missing wiring evidence: ${missing.join(', ')}`);
  }
  const stale = Object.keys(catalog).filter(sink => !canonical.has(sink));
  if (stale.length > 0) {
    throw new Error(`Intake sink wiring catalog contains non-canonical entries: ${stale.join(', ')}`);
  }

  for (const sink of sinks) {
    const evidence = catalog[sink];
    if (!Array.isArray(evidence) || evidence.length === 0) {
      throw new Error(`IntakeSink ${sink} has no production wiring evidence`);
    }
    for (const entry of evidence) {
      if (entry.indirect && !entry.justification?.trim()) {
        throw new Error(`IntakeSink ${sink} indirect wiring evidence requires a justification`);
      }
      const source = readFile(entry.file);
      if (typeof source !== 'string') {
        throw new Error(`IntakeSink ${sink} wiring file cannot be read: ${entry.file}`);
      }
      const pattern = new RegExp(entry.pattern.source, entry.pattern.flags);
      if (!pattern.test(source)) {
        throw new Error(`IntakeSink ${sink} has no matching gate call site in ${entry.file}`);
      }
    }
  }
  return sinks;
}

function main() {
  const sinks = verifyIntakeSinkWiring();
  console.log(`Intake sink wiring verification passed (${String(sinks.length)} canonical sinks).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
