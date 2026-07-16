import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WishlistDrawer, WISHLIST_REVIEW_PROMPTS } from './wishlist-drawer.js';

describe('WishlistDrawer', () => {
  it('requests the canonical wishlist through the existing chat path', () => {
    const onRequestReview = vi.fn();
    const { getByRole } = render(
      <WishlistDrawer canSend onClose={vi.fn()} onRequestReview={onRequestReview} />,
    );

    fireEvent.click(getByRole('button', { name: 'Show active wishes' }));
    expect(onRequestReview).toHaveBeenCalledWith(WISHLIST_REVIEW_PROMPTS.active);
    expect(WISHLIST_REVIEW_PROMPTS.active).toContain('action=wish_list');
  });

  it('keeps review controls disabled while disconnected', () => {
    const { getByRole } = render(
      <WishlistDrawer canSend={false} onClose={vi.fn()} onRequestReview={vi.fn()} />,
    );

    expect(getByRole('button', { name: 'Show active wishes' }).hasAttribute('disabled')).toBe(true);
    expect(getByRole('button', { name: 'Show full history' }).hasAttribute('disabled')).toBe(true);
  });
});
