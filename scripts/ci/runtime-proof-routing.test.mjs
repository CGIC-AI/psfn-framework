import assert from 'node:assert/strict';
import test from 'node:test';

import { buildGatePlan, GATE_PHASE } from './local-delivery-contract.mjs';

function selectedGate(path, name) {
  return buildGatePlan({ paths: [path] }).find(gate => gate.name === name && !gate.skip);
}

test('runtime changes require a real-process journey, including agent and scheduler internals', () => {
  for (const path of [
    'src/core/agent/substrate-agent.ts',
    'src/core/scheduler/scheduler.ts',
    'src/primitives/llm/client.ts',
    'src/app/gateway/main.ts',
    'src/persistence/sessions/store.ts',
    'companion-ui/src/App.tsx',
    'companion-ui/runtime-e2e/conversation.spec.ts',
    'companion-ui/runtime-e2e/conversation.test.ts',
    'companion-ui/e2e/conversation.test.ts',
    'companion-ui/playwright.runtime.config.ts',
    'companion-ui/vite.config.ts',
    'companion-ui/package-lock.json',
    'apps/satellite-hub/src/ts/hub/main.ts',
    'docker/docker-compose.smoke.yml',
    'scripts/smoke-docker.mjs',
    'scripts/smoke-docker/memory-journey.mjs',
    'scripts/ops/psfn-compose-smoke-provider-stub.mjs',
  ]) {
    const gate = selectedGate(path, 'runtime-journeys');
    assert.ok(gate, `${path} must exercise the real runtime`);
    assert.equal(gate.phase, GATE_PHASE.HEAVY, `${path} must share the resource lock`);
    assert.deepEqual([gate.executable, ...gate.args], ['npm', 'run', 'smoke:docker']);
  }
});

test('harness changes execute harness regressions rather than only policy checks', () => {
  for (const path of [
    'shakedown/harness/lib/case-execution.mjs',
    'shakedown/harness/restart-split-runtime.sh',
    'shakedown/harness/test/sse-probe.test.mjs',
  ]) {
    const gate = selectedGate(path, 'shakedown-harness');
    assert.ok(gate, path);
    assert.deepEqual([gate.executable, ...gate.args], ['npm', 'run', 'test:shakedown-harness']);
  }
});

test('companion UI changes execute browser behavior as well as component tests', () => {
  for (const path of ['companion-ui/src/App.tsx', 'companion-ui/e2e/companion-application.spec.ts']) {
    const gate = selectedGate(path, 'companion-browser');
    assert.ok(gate, path);
    assert.deepEqual([gate.executable, ...gate.args], ['npm', 'run', 'verify:companion-browser']);
  }
});

test('documentation and ordinary unit-test edits do not launch the runtime stack', () => {
  for (const path of [
    'docs/architecture.md',
    'src/core/agent/substrate-agent.test.ts',
    'src/core/session/manager.test-fixtures.ts',
    'companion-ui/src/lib/traces.test.ts',
    'scripts/ci/runtime-proof-routing.test.mjs',
  ]) {
    assert.equal(selectedGate(path, 'runtime-journeys'), undefined, path);
  }
});
