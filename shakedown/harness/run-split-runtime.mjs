#!/usr/bin/env node
import { resolveBootstrapConfig } from './lib/bootstrap-config.mjs';
import { prepareSplitRuntime, superviseSplitRuntime } from './lib/split-runtime.mjs';

try {
  const config = resolveBootstrapConfig();
  const prepared = prepareSplitRuntime(config, process.env);
  try {
    process.exitCode = await superviseSplitRuntime({ processes: prepared.processes, cwd: config.repoRoot });
  } finally {
    prepared.cleanup();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
