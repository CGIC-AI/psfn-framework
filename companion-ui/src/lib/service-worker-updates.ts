const updateListeners = new Set<() => void>();
const APP_SCOPE = '/companion-ui/';
const LEGACY_CACHE_NAME = 'psfn-satellite-mobile-chat-app-v1';

declare const __PSFN_COMPANION_UI_SW_UPDATE_INTERVAL_MS__: number;

let registrationStarted = false;
let updateReady = false;

function announceUpdateReady(): void {
  if (updateReady) return;
  updateReady = true;
  for (const listener of updateListeners) listener();
}

export function getServiceWorkerUpdateReady(): boolean {
  return updateReady;
}

export function subscribeToServiceWorkerUpdates(listener: () => void): () => void {
  updateListeners.add(listener);
  return () => {
    updateListeners.delete(listener);
  };
}

async function retireLegacyRootRegistration(): Promise<void> {
  if (!await caches.has(LEGACY_CACHE_NAME)) return;
  const legacyScriptUrl = new URL('/sw.js', window.location.origin).href;
  const legacyScope = new URL('/', window.location.origin).href;
  const registrations = await navigator.serviceWorker.getRegistrations();
  const legacyRegistrations = registrations.filter((registration) => (
    registration.active?.scriptURL === legacyScriptUrl
    && registration.scope === legacyScope
  ));
  for (const registration of legacyRegistrations) {
    if (!await registration.unregister()) {
      throw new Error('Failed to retire the legacy root-scoped companion-ui service worker');
    }
  }
}

export function registerCompanionServiceWorker(): void {
  if (registrationStarted || !('serviceWorker' in navigator)) return;
  registrationStarted = true;

  let hasController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hasController) announceUpdateReady();
    hasController = true;
  });

  window.addEventListener('load', () => {
    void retireLegacyRootRegistration()
      .then(() => navigator.serviceWorker.register(`${APP_SCOPE}sw.js`, {
        scope: APP_SCOPE,
        updateViaCache: 'none',
      }))
      .then((registration) => {
        let updateInFlight = false;
        const checkForUpdate = (): void => {
          if (updateInFlight || !navigator.onLine) return;
          updateInFlight = true;
          void registration.update()
            .catch((error: unknown) => {
              console.error('Failed to check for a companion-ui update', error);
            })
            .finally(() => {
              updateInFlight = false;
            });
        };

        window.addEventListener('focus', checkForUpdate);
        window.addEventListener('online', checkForUpdate);
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') checkForUpdate();
        });
        window.setInterval(checkForUpdate, __PSFN_COMPANION_UI_SW_UPDATE_INTERVAL_MS__);
        checkForUpdate();
      })
      .catch((error: unknown) => {
        console.error('Failed to register service worker', error);
      });
  }, { once: true });
}
