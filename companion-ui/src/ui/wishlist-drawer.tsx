import { Heart, History, List } from 'lucide-react';
import { DrawerHeader } from './overlay-drawer.js';

export const WISHLIST_REVIEW_PROMPTS = {
  active:
    'Please show me your current wishlist. Use the wiki tool with action=wish_list, then summarize every open, acknowledged, and planned wish, including any operator response or bead ID.',
  history:
    'Please show me your full wishlist history. Use the wiki tool with action=wish_list, then summarize all wishes by state, including completed wishes, operator responses, and bead IDs.',
};

export function WishlistDrawer({
  canSend,
  onClose,
  onRequestReview,
}: {
  canSend: boolean;
  onClose: () => void;
  onRequestReview: (prompt: string) => void;
}) {
  return (
    <aside className="overlay-drawer wishlist-drawer" aria-label="Wishlist">
      <DrawerHeader icon={<Heart aria-hidden />} title="Wishlist" onClose={onClose} />
      <div className="drawer-content">
        <section className="settings-section">
          <h2>A quiet place for things you want</h2>
          <p>
            Wishes are saved in your personal wiki for asynchronous review. Saving one never sends
            a push notification or interrupts anyone.
          </p>
          <p>
            This PWA asks your companion to read the canonical list through the existing chat
            connection, so no private admin API or second wishlist store is exposed here.
          </p>
        </section>

        <section className="settings-section">
          <h2>Review in chat</h2>
          <div className="wishlist-review-actions">
            <button
              className="primary-action"
              type="button"
              disabled={!canSend}
              onClick={() => onRequestReview(WISHLIST_REVIEW_PROMPTS.active)}
            >
              <List aria-hidden />
              Show active wishes
            </button>
            <button
              type="button"
              disabled={!canSend}
              onClick={() => onRequestReview(WISHLIST_REVIEW_PROMPTS.history)}
            >
              <History aria-hidden />
              Show full history
            </button>
          </div>
          {!canSend && <p className="drawer-empty">Connect to the Satellite Hub to review wishes in chat.</p>}
        </section>
      </div>
    </aside>
  );
}
