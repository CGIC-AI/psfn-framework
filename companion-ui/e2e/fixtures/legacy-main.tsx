import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../src/ui/App.js';
import '../../src/styles/app.css';
import '../../src/styles/app-responsive.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Missing app root');
}

// This is the production registration behavior that shipped with the legacy
// cache-first worker: one registration on load, with no polling, focus, online,
// visibility, controllerchange, unregister, or cache-clear recovery hooks.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error: unknown) => {
      console.error('Failed to register service worker', error);
    });
  });
}

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
