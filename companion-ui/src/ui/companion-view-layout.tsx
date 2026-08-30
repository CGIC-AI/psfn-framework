import type { ReactNode } from 'react';

export type CompanionView = 'thread' | 'avatar';

export function CompanionViewLayout({
  activeView,
  avatar,
  onViewChange,
  thread,
}: {
  activeView: CompanionView;
  avatar: ReactNode;
  onViewChange: (view: CompanionView) => void;
  thread: ReactNode;
}) {
  return (
    <>
      <nav className="companion-view-switcher" aria-label="Companion view">
        <button
          type="button"
          className={activeView === 'thread' ? 'active' : ''}
          aria-pressed={activeView === 'thread'}
          onClick={() => onViewChange('thread')}
        >
          Thread
        </button>
        <button
          type="button"
          className={activeView === 'avatar' ? 'active' : ''}
          aria-pressed={activeView === 'avatar'}
          onClick={() => onViewChange('avatar')}
        >
          Avatar
        </button>
      </nav>
      <div
        className="companion-view-surface thread-surface"
        data-companion-view="thread"
        hidden={activeView !== 'thread'}
      >
        {thread}
      </div>
      <div
        className="companion-view-surface avatar-surface"
        data-companion-view="avatar"
        hidden={activeView !== 'avatar'}
      >
        {avatar}
      </div>
    </>
  );
}
