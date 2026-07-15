const updateListeners = new Set<() => void>();

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

export function registerCompanionServiceWorker(): void {
  if (registrationStarted || !('serviceWorker' in navigator)) return;
  registrationStarted = true;

  let hasController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hasController) announceUpdateReady();
    hasController = true;
  });

  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
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
