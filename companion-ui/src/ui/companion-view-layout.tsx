import type { ReactNode } from 'react';

export type CompanionView = 'thread' | 'avatar' | 'system';

export function CompanionViewLayout({
  activeView,
  avatar,
  onViewChange,
  thread,
  system,
}: {
  activeView: CompanionView;
  avatar: ReactNode;
  onViewChange: (view: CompanionView) => void;
  thread: ReactNode;
  system?: ReactNode;
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
        {system && <button type="button" className={activeView === 'system' ? 'active' : ''}
          aria-pressed={activeView === 'system'} onClick={() => onViewChange('system')}>System</button>}
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
      {system && <div className="companion-view-surface system-surface" data-companion-view="system" hidden={activeView !== 'system'}>{system}</div>}
    </>
  );
}
