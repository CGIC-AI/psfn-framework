import { Sparkles } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { HubStreamState } from '../lib/stream/hub-stream.js';
import { AvatarMark } from './companion-sprite.js';

export function ThreadView({ streamState }: { streamState: HubStreamState }) {
  const threadEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ block: 'end' });
  }, [streamState.messages.length, streamState.liveAssistant?.content]);

  return (
    <section className="thread-viewport" aria-label="Companion chat">
      <div className="message-list" aria-live="polite">
        {streamState.messages.length === 0 && !streamState.liveAssistant ? (
          <div className="thread-empty">
            <Sparkles aria-hidden />
            <p>{streamState.connection === 'ready' ? 'Ready for the thread.' : 'Open settings to connect.'}</p>
          </div>
        ) : (
          <>
            {streamState.messages.map((message) => (
              <article className={`message-row ${message.role}`} key={message.id}>
                {message.role === 'assistant' && <AvatarMark />}
                <div className="message-bubble">
                  <p>{message.content}</p>
                </div>
              </article>
            ))}
            {streamState.liveAssistant && (
              <article className="message-row assistant live">
                <AvatarMark />
                <div className="message-bubble">
                  <p>{streamState.liveAssistant.content}</p>
                </div>
              </article>
            )}
          </>
        )}
        <div ref={threadEndRef} />
      </div>
    </section>
  );
}
