import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserEmbodimentRequests, parseBrowserEmbodimentStatus } from './primary-embodiment.js';

const STATUS = {
  generation: 3,
  version: 4,
  primaryPresent: true,
  currentDeviceIsPrimary: false,
  lastDecision: { decision: 'handoff', reason: 'user_requested', decidedAt: '2026-09-07T12:00:00.000Z' },
};

describe('browser embodiment projection', () => {
  it('accepts only the redacted current-device projection', () => {
    expect(parseBrowserEmbodimentStatus(STATUS)).toEqual(STATUS);
    expect(parseBrowserEmbodimentStatus({ ...STATUS, primaryPresent: false, lastDecision: null })).toBeDefined();
    expect(parseBrowserEmbodimentStatus({ ...STATUS, lastDecision: {
      decision: 'invalidated', reason: 'device_revoked', decidedAt: '2026-09-07T12:00:00.000Z',
    } })).toBeDefined();
  });

  it.each([
    { generation: -1 }, { generation: 1.5 }, { version: Number.MAX_SAFE_INTEGER + 1 },
    { currentDeviceIsPrimary: 'true' }, { primaryPresent: false, currentDeviceIsPrimary: true },
    { attachmentId: 'never-presented' }, { companionId: 'never-presented' },
    { lastDecision: { ...STATUS.lastDecision, decisionId: 'never-presented' } },
    { lastDecision: { ...STATUS.lastDecision, decision: 'automatic' } },
    { lastDecision: { ...STATUS.lastDecision, reason: 'login' } },
    { lastDecision: { ...STATUS.lastDecision, reason: 'device_revoked' } },
    { lastDecision: { ...STATUS.lastDecision, decidedAt: '1' } },
    { lastDecision: { ...STATUS.lastDecision, decidedAt: 'not-a-date' } },
  ])('rejects malformed or overbroad projection %j', patch => {
    expect(parseBrowserEmbodimentStatus({ ...STATUS, ...patch })).toBeUndefined();
  });
});

describe('browser embodiment requests', () => {
  afterEach(() => vi.useRealTimers());

  it('shares concurrent status reads and never infers a handoff', async () => {
    const send = vi.fn();
    const requests = new BrowserEmbodimentRequests({ requestId: () => 'read-1', timeoutMs: 100, send, abandon: vi.fn() });
    const first = requests.read();
    expect(requests.read()).toBe(first);
    expect(send).toHaveBeenCalledExactlyOnceWith('read-1', 'embodiment.status', {});
    expect(requests.consume('wrong-request', STATUS)).toBe(false);
    expect(requests.consume('read-1', STATUS)).toBe(true);
    await expect(first).resolves.toEqual(STATUS);
  });

  it('expires a silent request and permits a fresh status read', async () => {
    vi.useFakeTimers();
    const abandon = vi.fn();
    const requests = new BrowserEmbodimentRequests({ requestId: () => 'read-1', timeoutMs: 100, send: vi.fn(), abandon });
    const expired = expect(requests.read()).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(100);
    await expired;
    expect(abandon).toHaveBeenCalledWith('read-1');
    const next = requests.read();
    requests.consume('read-1', STATUS);
    await expect(next).resolves.toEqual(STATUS);
  });

  it('rejects invalid generations without sending or claiming', async () => {
    const send = vi.fn();
    const requests = new BrowserEmbodimentRequests({ requestId: () => 'read-1', timeoutMs: 100, send, abandon: vi.fn() });
    await expect(requests.handoff(-1)).rejects.toThrow(/current embodiment status/);
    await expect(requests.handoff(0.5)).rejects.toThrow(/current embodiment status/);
    expect(send).not.toHaveBeenCalled();
  });
});
