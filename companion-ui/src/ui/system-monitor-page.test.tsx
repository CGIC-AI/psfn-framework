import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SystemMonitorPage } from './system-monitor-page.js';
import type { SystemMonitorSnapshot } from '../lib/system-monitor.js';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
function snapshot(companionId = A): SystemMonitorSnapshot { return { companionId, fetchedAt: Date.now(), health: { status: 'available', data: { generatedAt: Date.now(), processStartedAt: 1, configuration: { companionId, freeTimeEnabled: false, socialDesireEnabled: false, weightedThoughtOutreachEnabled: true, emosimProactivityMode: 'on', proactive: { status: 'available', summary: { total: 2, states: [{ state: 'pending', count: 2, lastUpdatedAtMs: 5 }], lastFiredAtMs: 5, lastDeliveredAtMs: null } } }, lanes: [{ id: 'free_time', label: 'Free time lane', status: 'failed', source: 'event_bus', sinceProcessStart: true, lastEventAt: 10, lastSuccessAt: null, nextRunDueAt: null, reason: 'idle:rested:chooser_timeout', counts: [], recent: [] }] } }, incidents: { status: 'available', data: [{ id: 'system', code: 'database_pressure', status: 'open', at: 10, count: 1, scope: 'system' }] }, providers: { status: 'unavailable' } }; }
afterEach(() => { cleanup(); vi.useRealTimers(); });
describe('System monitor page', () => {
  it('shows failures, disabled free time and pending delivery; fleet incidents have their own view', async () => {
    const load = vi.fn().mockResolvedValue(snapshot());
    render(<SystemMonitorPage companionId={A} companionLabel="Companion A" authorized active load={load} />);
    expect(await screen.findByText('Configured: Disabled')).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getByText('Awaiting choice')).toBeTruthy();
    expect(screen.getByText(/Last confirmed delivery: No recorded evidence/)).toBeTruthy();
    expect(screen.queryByText('database pressure')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Fleet services' }));
    expect(screen.getByText('database pressure')).toBeTruthy();
    expect(screen.queryByText('Awaiting choice')).toBeNull();
  });
  it('clears prior scope immediately and ignores late responses after companion switch or signout', async () => {
    let resolveA!: (value: SystemMonitorSnapshot) => void;
    const load = vi.fn().mockImplementation((id: string) => id === A ? new Promise(resolve => { resolveA = resolve; }) : Promise.resolve(snapshot(B)));
    const view = render(<SystemMonitorPage companionId={A} companionLabel="A" authorized active load={load} />);
    view.rerender(<SystemMonitorPage companionId={B} companionLabel="B" authorized active load={load} />);
    await screen.findByText('Awaiting choice');
    await act(async () => resolveA({ ...snapshot(), health: { status: 'forbidden' } }));
    expect(screen.queryByText(/Sign in with permission/)).toBeNull();
    view.rerender(<SystemMonitorPage companionId={B} companionLabel="B" authorized={false} active load={load} />);
    expect(screen.queryByText('Awaiting choice')).toBeNull();
    expect(screen.getByText(/Sign in and select/)).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
  });
  it('labels old snapshots stale and does not fetch when hidden from the active app view', async () => {
    const old = snapshot(); if (old.health.status === 'available') old.health.data.generatedAt = 1;
    const load = vi.fn().mockResolvedValue(old);
    const view = render(<SystemMonitorPage companionId={A} companionLabel="A" authorized active={false} load={load} />);
    expect(load).not.toHaveBeenCalled();
    view.rerender(<SystemMonitorPage companionId={A} companionLabel="A" authorized active load={load} />);
    expect(await screen.findByText(/Stale snapshot/)).toBeTruthy();
  });
});
