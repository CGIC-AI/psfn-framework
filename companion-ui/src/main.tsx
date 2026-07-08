import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App.js';
import './styles/app.css';
import './styles/app-responsive.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Missing app root');
}

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
