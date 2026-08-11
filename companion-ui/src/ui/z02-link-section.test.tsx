import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Z02LinkSection } from './z02-link-section.js';

describe('Z02LinkSection', () => {
  it('offers user-initiated badge discovery', () => {
    const onLink = vi.fn();
    render(
      <Z02LinkSection
        state={{ phase: 'idle', detail: 'Ready to discover a stock Z02 nearby.' }}
        onDisconnect={vi.fn()}
        onLink={onLink}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Link Z02' }));
    expect(onLink).toHaveBeenCalledOnce();
    expect(screen.getByRole('status').textContent).toContain('Ready to discover');
  });

  it('shows a streaming stock microphone and a disconnect control once linked', () => {
    const onDisconnect = vi.fn();
    render(
      <Z02LinkSection
        state={{
          phase: 'linked',
          deviceName: 'Z02 Test Badge',
          detail: 'PCM relay active — 4 chunks received and sent.',
          audioFrames: 4,
          relayedFrames: 4,
          microphone: 'pcm16-16khz',
          transport: 'stock-rcsp',
        }}
        onDisconnect={onDisconnect}
        onLink={vi.fn()}
      />,
    );

    expect(screen.getByText('Z02 Test Badge')).toBeTruthy();
    expect(screen.getByText('Mic relaying')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Z02' }));
    expect(onDisconnect).toHaveBeenCalledOnce();
  });

  it('distinguishes an active Stark Ruby microphone stream from a stock control link', () => {
    render(
      <Z02LinkSection
        state={{
          phase: 'linked',
          deviceName: 'Omi',
          detail: 'Audio stream active — 12 Opus frames received.',
          audioFrames: 12,
          microphone: 'opus-16khz',
          transport: 'omi-audio',
        }}
        onDisconnect={vi.fn()}
        onLink={vi.fn()}
      />,
    );

    expect(screen.getByText('Mic streaming')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('12 Opus frames');
  });

  it('explains when this browser cannot use Web Bluetooth', () => {
    render(
      <Z02LinkSection
        state={{ phase: 'unsupported', detail: 'Bluetooth linking needs Chrome on Android.' }}
        onDisconnect={vi.fn()}
        onLink={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Link Z02' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('status').textContent).toContain('Chrome on Android');
  });
});
