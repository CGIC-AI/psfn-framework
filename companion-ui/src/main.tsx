import React from 'react';
import { createRoot } from 'react-dom/client';
import { registerCompanionServiceWorker } from './lib/service-worker-updates.js';
import { App } from './ui/App.js';
import './styles/app.css';
import './styles/approval-card.css';
import './styles/companion-selector.css';
import './styles/app-responsive.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Missing app root');
}

registerCompanionServiceWorker();

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
