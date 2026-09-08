interface InstallPromptEvent extends Event {
  prompt(): Promise<unknown>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

interface AppInstallationSnapshot {
  readonly state: 'manual' | 'available' | 'prompting' | 'installed';
  readonly platform: 'ios' | 'other';
  readonly detail: string | null;
}

/** Browser-only presentation state. No account, authority, or storage access. */
export function createAppInstallationStore(browser: Window | undefined) {
  const navigator = browser?.navigator;
  const ios = Boolean(navigator && (/iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)));
  const standalone = browser?.matchMedia?.('(display-mode: standalone)');
  let snapshot: AppInstallationSnapshot = {
    state: standalone?.matches || (navigator && 'standalone' in navigator && navigator.standalone === true)
      ? 'installed' : 'manual',
    platform: ios ? 'ios' : 'other',
    detail: null,
  };
  let pending: InstallPromptEvent | null = null;
  const listeners = new Set<() => void>();

  function update(state: AppInstallationSnapshot['state'], detail: string | null = null) {
    snapshot = { ...snapshot, state, detail };
    for (const listener of listeners) listener();
  }

  function onInstallPrompt(event: Event) {
    if (!('prompt' in event) || typeof event.prompt !== 'function'
      || !('userChoice' in event) || snapshot.state === 'installed') return;
    event.preventDefault();
    pending = event as InstallPromptEvent;
    update('available');
  }

  function onInstalled() {
    pending = null;
    update('installed');
  }

  function isInstalled() { return snapshot.state === 'installed'; }

  function onDisplayMode(event: MediaQueryListEvent) {
    if (event.matches) onInstalled();
  }

  browser?.addEventListener('beforeinstallprompt', onInstallPrompt);
  browser?.addEventListener('appinstalled', onInstalled);
  standalone?.addEventListener('change', onDisplayMode);

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async install(): Promise<void> {
      const event = pending;
      if (!event || snapshot.state !== 'available') return;
      pending = null;
      update('prompting');
      try {
        await event.prompt();
        const choice = await event.userChoice;
        if (isInstalled()) return;
        update('manual', choice.outcome === 'accepted'
          ? 'Installation requested. Your browser will finish adding the app.'
          : 'Installation dismissed. You can still add the app from your browser menu.');
      } catch {
        if (!isInstalled()) {
          update('manual', 'The install prompt could not open. Use your browser menu to add the app.');
        }
      }
    },
    destroy() {
      browser?.removeEventListener('beforeinstallprompt', onInstallPrompt);
      browser?.removeEventListener('appinstalled', onInstalled);
      standalone?.removeEventListener('change', onDisplayMode);
      pending = null;
      listeners.clear();
    },
  };
}

// Capture installation availability at module import, before Settings opens.
export const appInstallation = createAppInstallationStore(typeof window === 'undefined' ? undefined : window);
