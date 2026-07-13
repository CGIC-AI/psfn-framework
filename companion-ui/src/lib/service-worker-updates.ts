const updateListeners = new Set<() => void>();

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
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch((error: unknown) => {
      console.error('Failed to register service worker', error);
    });
  }, { once: true });
}
