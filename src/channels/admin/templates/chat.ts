export function chatPage(): string {
  return `
    <section class="chat-cockpit" data-chat-cockpit>
      <div class="chat-cockpit-grid">
        <div class="card chat-controls-card">
          <h3>Channel Identity Binding</h3>
          <p class="chat-controls-note">
            Select the canonical contact + channel identity used by cockpit turns.
          </p>
          <form class="chat-controls" data-chat-controls autocomplete="off">
            <div class="form-group">
              <label for="chat-canonical-contact">Canonical Contact</label>
              <select id="chat-canonical-contact" name="canonicalContactId"></select>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label for="chat-channel">Channel</label>
                <input id="chat-channel" name="channel" type="text" placeholder="discord / api / telegram">
              </div>
              <div class="form-group">
                <label for="chat-user-id">Channel User ID</label>
                <input id="chat-user-id" name="userId" type="text" placeholder="channel identity user id">
              </div>
            </div>
            <div class="form-group">
              <label for="chat-privacy">Privacy Level</label>
              <select id="chat-privacy" name="privacyLevel"></select>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label for="chat-author-name">Author Name</label>
                <input id="chat-author-name" name="defaultAuthorName" type="text" placeholder="display name">
              </div>
              <div class="form-group">
                <label for="chat-author-id">Author ID</label>
                <input id="chat-author-id" name="defaultAuthorId" type="text" placeholder="stable author id">
              </div>
            </div>
            <div class="chat-contact-meta" data-chat-contact-meta></div>
            <div class="chat-status" data-chat-status>Loading cockpit state...</div>
          </form>
        </div>
        <div class="card chat-surface-card">
          <div class="chat-surface" id="admin-chat-surface"></div>
        </div>
      </div>
    </section>
    <script type="module" src="/static/chat.js"></script>
  `;
}
