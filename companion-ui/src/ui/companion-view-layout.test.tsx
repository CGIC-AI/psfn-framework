import { fireEvent, render } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { CompanionViewLayout } from './companion-view-layout.js';

function TestSurface() {
  const [activeView, setActiveView] = useState<'thread' | 'avatar'>('thread');
  return (
    <CompanionViewLayout
      activeView={activeView}
      onViewChange={setActiveView}
      thread={(
        <div>
          <p>live assistant draft</p>
          <input aria-label="Thread draft" defaultValue="unfinished" />
        </div>
      )}
      avatar={<p>Avatar surface</p>}
    />
  );
}

describe('companion view layout', () => {
  it('keeps the thread and its draft mounted while switching views', () => {
    const { getByLabelText, getByRole, getByText } = render(<TestSurface />);
    const draft = getByLabelText('Thread draft') as HTMLInputElement;
    fireEvent.change(draft, { target: { value: 'still composing' } });

    fireEvent.click(getByRole('button', { name: 'Avatar' }));
    expect((getByText('Avatar surface').closest('[data-companion-view]') as HTMLElement).hidden).toBe(false);
    expect((getByText('live assistant draft').closest('[data-companion-view]') as HTMLElement).hidden).toBe(true);

    fireEvent.click(getByRole('button', { name: 'Thread' }));
    expect(getByLabelText('Thread draft')).toBe(draft);
    expect(draft.value).toBe('still composing');
    expect(getByText('live assistant draft')).not.toBeNull();
  });
});
