import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSpriteManifest } from '../lib/sprites/manifest.js';
import { readLocalSpritePack, type LocalSpritePack } from '../lib/sprites/import-sprite-pack.js';
import { SpritePackPicker } from './sprite-pack-picker.js';

vi.mock('../lib/sprites/import-sprite-pack.js', () => ({ readLocalSpritePack: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function pack(): LocalSpritePack { return { manifest: buildSpriteManifest(), dispose: vi.fn() }; }

describe('sprite pack picker', () => {
  it('transfers a validated pack to the appearance controller and exposes clear', async () => {
    const imported = pack();
    vi.mocked(readLocalSpritePack).mockResolvedValue(imported);
    const onSelect = vi.fn();
    const onClear = vi.fn();
    const { getByLabelText, getByRole, unmount } = render(<SpritePackPicker onSelect={onSelect} onClear={onClear} currentLabel="Local artwork" />);
    fireEvent.change(getByLabelText('Choose sprite pack files'), { target: { files: [new File(['{}'], 'manifest.json')] } });
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(imported));
    fireEvent.click(getByRole('button', { name: 'Use default artwork' }));
    expect(onClear).toHaveBeenCalledOnce();
    unmount();
    expect(imported.dispose).not.toHaveBeenCalled();
  });

  it('displays validation failure without replacing current artwork', async () => {
    vi.mocked(readLocalSpritePack).mockRejectedValue(new Error('tool.png must be exactly 768 × 864 pixels.'));
    const onSelect = vi.fn();
    const { getByLabelText, getByRole } = render(<SpritePackPicker onSelect={onSelect} />);
    fireEvent.change(getByLabelText('Choose sprite pack files'), { target: { files: [new File(['{}'], 'manifest.json')] } });
    await waitFor(() => expect(getByRole('alert').textContent).toContain('tool.png'));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('disposes a late import after the companion picker unmounts', async () => {
    let finish: ((value: LocalSpritePack) => void) | undefined;
    vi.mocked(readLocalSpritePack).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const imported = pack();
    const onSelect = vi.fn();
    const { getByLabelText, unmount } = render(<SpritePackPicker onSelect={onSelect} />);
    fireEvent.change(getByLabelText('Choose sprite pack files'), { target: { files: [new File(['{}'], 'manifest.json')] } });
    unmount();
    finish?.(imported);
    await waitFor(() => expect(imported.dispose).toHaveBeenCalledOnce());
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('disposes the pack if selection fails before ownership transfers', async () => {
    const imported = pack();
    vi.mocked(readLocalSpritePack).mockResolvedValue(imported);
    const { getByLabelText, getByRole } = render(<SpritePackPicker onSelect={() => { throw new Error('Companion unavailable'); }} />);
    fireEvent.change(getByLabelText('Choose sprite pack files'), { target: { files: [new File(['{}'], 'manifest.json')] } });
    await waitFor(() => expect(getByRole('alert').textContent).toBe('Companion unavailable'));
    expect(imported.dispose).toHaveBeenCalledOnce();
  });
});
