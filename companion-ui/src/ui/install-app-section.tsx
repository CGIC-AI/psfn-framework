import { Check, Download, Share } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { appInstallation } from '../lib/app-installation.js';
import '../styles/install-app.css';

export function InstallAppSection({ store = appInstallation }: { store?: typeof appInstallation }) {
  const installation = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return (
    <section className="settings-section install-app-section" aria-label="Install companion app">
      <h2>Keep your companions close</h2>
      {installation.state === 'installed' ? (
        <p className="install-app-status"><Check aria-hidden /> This app is installed.</p>
      ) : (
        <>
          <p>Add PSFN Chat to your Home Screen to open your companions in their own app window.</p>
          {(installation.state === 'available' || installation.state === 'prompting') && (
            <button className="primary-action" type="button" disabled={installation.state === 'prompting'} onClick={() => { void store.install(); }}>
              <Download aria-hidden /> {installation.state === 'prompting' ? 'Opening installer…' : 'Install PSFN Chat'}
            </button>
          )}
          {installation.platform === 'ios' ? (
            <ol className="install-app-steps">
              <li>Open this page in Safari.</li>
              <li>Tap <Share aria-hidden /> <strong>Share</strong>, then <strong>Add to Home Screen</strong>.</li>
              <li>Keep <strong>Open as Web App</strong> enabled if offered, then tap <strong>Add</strong>.</li>
            </ol>
          ) : installation.state === 'manual' ? (
            <p>Open your browser menu and choose <strong>Install app</strong> or <strong>Add to Home screen</strong>, if available.</p>
          ) : null}
          <p className="install-app-note">Chat and voice need a connection. Your browser may ask you to sign in again when you first open the installed app.</p>
        </>
      )}
      {installation.detail && <p role="status">{installation.detail}</p>}
    </section>
  );
}
