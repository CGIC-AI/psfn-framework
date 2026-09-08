import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createInitialHubStreamState, type HubStreamMessage } from '../../src/lib/stream/hub-stream.js';
import { ThreadView } from '../../src/ui/thread-view.js';
import { InstallAppSection } from '../../src/ui/install-app-section.js';
import '../../src/styles/app.css';
import '../../src/styles/app-responsive.css';

const history: HubStreamMessage[] = Array.from({ length: 24 }, (_, index) => ({
  id: String(index), role: index % 2 ? 'assistant' : 'user',
  content: `Message ${index + 1}\nA little more room to read this conversation on a phone.`,
  sequence: index, receivedAt: '2026-01-01T00:00:00Z', live: false, final: true,
}));

function ReadingFixture() {
  const [revision, setRevision] = useState(0);
  const [active, setActive] = useState(true);
  const [install, setInstall] = useState(false);
  const state = {
    ...createInitialHubStreamState(),
    messages: history,
    liveAssistant: { ...history[1]!, content: `Streaming revision ${revision}`, live: true, final: false },
  };
  return (
    <main className="app-shell">
      <nav style={{ position: 'fixed', top: 0, zIndex: 20 }}>
        <button onClick={() => setRevision(value => value + 1)}>Next token</button>
        <button onClick={() => setActive(value => !value)}>Switch view</button>
        <button onClick={() => setInstall(value => !value)}>Installation</button>
      </nav>
      <div hidden={!active} style={{ height: '100%' }}>
        <ThreadView streamState={state} companionLabel="Aria" active={active} />
      </div>
      {install && <aside style={{ position: 'fixed', inset: '4rem 1rem auto', zIndex: 30 }}><InstallAppSection /></aside>}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<ReadingFixture />);
