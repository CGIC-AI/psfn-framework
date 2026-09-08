import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppInstallationStore } from '../lib/app-installation.js';
import { InstallAppSection } from './install-app-section.js';

let store: ReturnType<typeof createAppInstallationStore> | undefined;
afterEach(() => { cleanup(); store?.destroy(); store = undefined; vi.unstubAllGlobals(); });

function browserPrompt(outcome: 'accepted' | 'dismissed' = 'accepted') {
  const prompt = vi.fn().mockResolvedValue(undefined);
  const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
    prompt, userChoice: Promise.resolve({ outcome }),
  });
  act(() => { window.dispatchEvent(event); });
  return { prompt, event };
}

describe('app installation', () => {
  it('captures availability before Settings opens and prompts only after a click', async () => {
    store = createAppInstallationStore(window);
    const { prompt, event } = browserPrompt();
    expect(event.defaultPrevented).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
    const { getByRole, queryByRole } = render(<InstallAppSection store={store} />);
    fireEvent.click(getByRole('button', { name: 'Install PSFN Chat' }));
    await waitFor(() => expect(getByRole('status').textContent).toContain('Installation requested'));
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(queryByRole('button')).toBeNull();
    await store.install();
    expect(prompt).toHaveBeenCalledTimes(1);
    act(() => { window.dispatchEvent(new Event('appinstalled')); });
    expect(getByRole('region', { name: 'Install companion app' }).textContent).toContain('This app is installed.');
  });

  it('does not claim success after dismissal and accepts a later browser invitation', async () => {
    store = createAppInstallationStore(window);
    browserPrompt('dismissed');
    const { getByRole } = render(<InstallAppSection store={store} />);
    fireEvent.click(getByRole('button', { name: 'Install PSFN Chat' }));
    await waitFor(() => expect(getByRole('status').textContent).toContain('Installation dismissed'));
    browserPrompt();
    expect(getByRole('button', { name: 'Install PSFN Chat' })).not.toBeNull();
  });

  it('reports prompt failure without reusing a consumed browser event', async () => {
    store = createAppInstallationStore(window);
    const { prompt } = browserPrompt();
    prompt.mockRejectedValue(new Error('unavailable'));
    const { getByRole } = render(<InstallAppSection store={store} />);
    fireEvent.click(getByRole('button', { name: 'Install PSFN Chat' }));
    await waitFor(() => expect(getByRole('status').textContent).toContain('could not open'));
    expect(store.getSnapshot().state).toBe('manual');
  });

  it('provides iPhone steps and does not invent an unsupported install button', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone)', platform: 'iPhone', maxTouchPoints: 5 });
    store = createAppInstallationStore(window);
    const { getByRole, queryByRole } = render(<InstallAppSection store={store} />);
    expect(getByRole('list').textContent).toContain('Open this page in Safari');
    expect(getByRole('list').textContent).toContain('Add to Home Screen');
    expect(getByRole('list').textContent).toContain('Open as Web App');
    expect(queryByRole('button')).toBeNull();
  });

  it('recognizes iPad desktop mode and existing standalone installation', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 5, standalone: true });
    store = createAppInstallationStore(window);
    const { getByText, queryByRole } = render(<InstallAppSection store={store} />);
    expect(store.getSnapshot().platform).toBe('ios');
    expect(getByText('This app is installed.')).not.toBeNull();
    expect(queryByRole('button')).toBeNull();
  });

  it('retains installed state when appinstalled arrives before the prompt promise resolves', async () => {
    store = createAppInstallationStore(window);
    let resolveChoice: ((choice: { outcome: 'accepted' }) => void) | undefined;
    const event = Object.assign(new Event('beforeinstallprompt'), {
      prompt: vi.fn().mockResolvedValue(undefined),
      userChoice: new Promise<{ outcome: 'accepted' }>(resolve => { resolveChoice = resolve; }),
    });
    window.dispatchEvent(event);
    const installation = store.install();
    window.dispatchEvent(new Event('appinstalled'));
    resolveChoice?.({ outcome: 'accepted' });
    await installation;
    expect(store.getSnapshot().state).toBe('installed');
  });
});
