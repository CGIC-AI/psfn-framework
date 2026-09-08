import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInitialHubStreamState, type HubStreamMessage } from '../lib/stream/hub-stream.js';
import { ThreadView } from './thread-view.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function message(content: string, id = 'reply'): HubStreamMessage {
  return { id, content, role: 'assistant', live: false, final: true, sequence: 1, receivedAt: '2026-01-01T00:00:00Z' };
}

function state(content = 'Hello') {
  return { ...createInitialHubStreamState(), session: { sessionId: 'one' }, messages: [message(content)] };
}

function scrollGeometry(list: HTMLElement) {
  Object.defineProperties(list, {
    scrollHeight: { configurable: true, writable: true, value: 1200 },
    clientHeight: { configurable: true, value: 400 },
  });
}

describe('thread reading position', () => {
  it('follows replies until the reader scrolls upward and resumes only after jumping to latest', () => {
    const { getByRole, queryByRole, rerender } = render(<ThreadView streamState={state()} companionLabel="Aria" />);
    const list = getByRole('log');
    scrollGeometry(list);
    rerender(<ThreadView streamState={state('A longer reply')} companionLabel="Aria" />);
    expect(list.scrollTop).toBe(1200);

    list.scrollTop = 150;
    fireEvent.scroll(list);
    rerender(<ThreadView streamState={state('A reply that keeps streaming')} companionLabel="Aria" />);
    expect(list.scrollTop).toBe(150);
    expect(list.getAttribute('aria-live')).toBe('off');
    fireEvent.click(getByRole('button', { name: 'New messages · Jump to latest' }));
    expect(list.scrollTop).toBe(1200);
    expect(queryByRole('button', { name: /Jump to latest/ })).toBeNull();
    rerender(<ThreadView streamState={state('Next reply')} companionLabel="Aria" />);
    expect(list.getAttribute('aria-live')).toBe('polite');
  });

  it('preserves upward reading position while avatar is open and resets for another conversation', () => {
    const { getByRole, rerender } = render(<ThreadView streamState={state()} />);
    const list = getByRole('log');
    scrollGeometry(list);
    list.scrollTop = 80;
    fireEvent.scroll(list);
    rerender(<ThreadView streamState={state('Updated while hidden')} active={false} />);
    rerender(<ThreadView streamState={state('Updated while hidden')} active />);
    expect(list.scrollTop).toBe(80);
    rerender(<ThreadView streamState={{ ...state('Different companion'), session: { sessionId: 'two' } }} />);
    expect(list.scrollTop).toBe(1200);
  });

  it('follows hidden updates on return when the reader was already at latest', () => {
    const { getByRole, rerender } = render(<ThreadView streamState={state()} />);
    const list = getByRole('log');
    scrollGeometry(list);
    list.scrollTop = 800;
    fireEvent.scroll(list);
    rerender(<ThreadView streamState={state('Updated while hidden')} active={false} />);
    expect(list.scrollTop).toBe(800);
    rerender(<ThreadView streamState={state('Updated while hidden')} active />);
    expect(list.scrollTop).toBe(1200);
  });

  it('keeps streaming text available without exposing an incomplete copy action', () => {
    const current = { ...state(), messages: [], liveAssistant: { ...message('Still writing'), live: true, final: false } };
    const { getByRole, queryByRole } = render(<ThreadView streamState={current} companionLabel="Aria" />);
    expect(getByRole('article', { name: 'Aria is speaking' }).textContent).toContain('Still writing');
    expect(queryByRole('button', { name: /Copy/ })).toBeNull();
  });
});

describe('message copying', () => {
  it('copies original message content, including its formatting', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const content = '**Hello**\n\n```js\nconst greeting = 1;\n```';
    const { getByRole, getByText } = render(<ThreadView streamState={state(content)} companionLabel="Aria" />);
    fireEvent.click(getByRole('button', { name: "Copy Aria's message" }));
    await waitFor(() => expect(getByText('Copied')).not.toBeNull());
    expect(writeText).toHaveBeenCalledWith(content);
  });

  it('shows a useful message when clipboard permission is denied', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { getByRole } = render(<ThreadView streamState={state()} />);
    fireEvent.click(getByRole('button', { name: "Copy Companion's message" }));
    await waitFor(() => expect(getByRole('status').textContent).toContain('Select the message text'));
  });
});
