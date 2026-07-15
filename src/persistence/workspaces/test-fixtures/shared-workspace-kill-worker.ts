import { SharedCompanionWorkspaceStore } from '../shared-workspace-store.js';

const [root, reviewId, mode = 'kill'] = process.argv.slice(2);
if (!root || !reviewId) throw new Error('shared-workspace-kill-worker requires root and reviewId');
if (mode !== 'kill' && mode !== 'hold') throw new Error(`Unsupported worker mode: ${mode}`);

const store = new SharedCompanionWorkspaceStore(root, {
  lockStaleMs: 2_000,
  faultInjection: (stage) => {
    if (stage !== 'after_artifact') return;
    if (mode === 'kill') process.kill(process.pid, 'SIGKILL');
    process.stdout.write('holding-live-lock\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4_000);
  },
});

store.review({
  reviewId,
  reviewer: { id: 'operator-b', role: 'reviewer' },
  decision: 'approve',
});

if (mode === 'kill') throw new Error('kill worker unexpectedly survived publication fault');
