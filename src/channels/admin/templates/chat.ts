export function chatPage(): string {
  return `
    <section class="garden-chat" data-chat-cockpit>
      <div class="card chat-surface-card">
        <section class="chat-controls-bar" data-chat-controls autocomplete="off">
          <div class="chat-controls-head">
            <h3>Garden Chat Canopy</h3>
            <p class="chat-controls-note">
              Keep the conversation rooted to a canonical contact and privacy level.
            </p>
          </div>
          <div class="chat-controls-inline">
            <div class="form-group">
              <label for="chat-canonical-contact">Canonical Contact</label>
              <select id="chat-canonical-contact" name="canonicalContactId"></select>
            </div>
            <div class="form-group">
              <label for="chat-privacy">Privacy Level</label>
              <select id="chat-privacy" name="privacyLevel"></select>
            </div>
          </div>
          <details class="chat-identity-details">
            <summary>Identity details</summary>
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
          </details>
          <div class="chat-contact-meta" data-chat-contact-meta></div>
          <div class="chat-agent-context" data-chat-agent-context>Preparing session context...</div>
          <div class="chat-status" data-chat-status>Loading garden chat...</div>
        </section>

        <div class="chat-surface chat-agent-surface" id="admin-chat-surface">
          <div class="chat-agent-host" data-chat-agent-host>
            <div class="chat-agent-loading">Loading AgentInterface mount...</div>
          </div>
        </div>

        <section class="chat-debug-panel" data-chat-debug>
          <div class="chat-debug-controls">
            <label class="chat-debug-enable">
              <input type="checkbox" data-chat-debug-enable checked>
              Enable debug stream
            </label>
            <div class="chat-debug-channel">
              <label for="chat-debug-channel-filter">Channel filter</label>
              <input
                id="chat-debug-channel-filter"
                type="text"
                data-chat-debug-channel
                placeholder="optional channelId"
                autocomplete="off"
              >
            </div>
            <button type="button" class="btn chat-debug-clear" data-chat-debug-clear>Clear</button>
          </div>
          <div class="chat-debug-toggles" role="group" aria-label="Debug categories">
            <label><input type="checkbox" value="thinking" data-chat-debug-category checked>Thinking</label>
            <label><input type="checkbox" value="text" data-chat-debug-category checked>Text</label>
            <label><input type="checkbox" value="tools" data-chat-debug-category checked>Tools</label>
            <label><input type="checkbox" value="memory" data-chat-debug-category checked>Memory</label>
            <label><input type="checkbox" value="errors" data-chat-debug-category checked>Errors</label>
          </div>
          <div class="chat-debug-status" data-chat-debug-status>Connecting...</div>
          <div class="chat-debug-timeline" data-chat-debug-timeline></div>
        </section>
      </div>
    </section>
    <script type="module" src="/static/chat-debug.js"></script>
  `;
}
