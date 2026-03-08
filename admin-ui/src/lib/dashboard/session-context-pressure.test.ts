import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSessionContextPressureView } from './session-context-pressure';

test('resolveSessionContextPressureView fails closed when telemetry is missing or invalid', () => {
  assert.deepEqual(resolveSessionContextPressureView(undefined), {
    utilizationPct: 0,
    hasTelemetry: false,
    isOverLimit: false,
  });

  assert.deepEqual(resolveSessionContextPressureView({
    sessionId: 'discord:alpha',
    utilizationPct: Number.NaN,
    hasTelemetry: true,
  }), {
    utilizationPct: 0,
    hasTelemetry: false,
    isOverLimit: false,
  });

  assert.deepEqual(resolveSessionContextPressureView({
    sessionId: 'discord:beta',
    utilizationPct: 55,
    hasTelemetry: false,
  }), {
    utilizationPct: 0,
    hasTelemetry: false,
    isOverLimit: false,
  });
});

test('resolveSessionContextPressureView preserves valid telemetry and marks over-limit pressure', () => {
  assert.deepEqual(resolveSessionContextPressureView({
    sessionId: 'discord:alpha',
    utilizationPct: 72.4,
    hasTelemetry: true,
  }), {
    utilizationPct: 72.4,
    hasTelemetry: true,
    isOverLimit: false,
  });

  assert.deepEqual(resolveSessionContextPressureView({
    sessionId: 'discord:alpha',
    utilizationPct: 125.8,
    hasTelemetry: true,
  }), {
    utilizationPct: 125.8,
    hasTelemetry: true,
    isOverLimit: true,
  });
});
