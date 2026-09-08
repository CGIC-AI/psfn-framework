import { ArrowDown, Check, Copy, Sparkles } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import type { HubStreamMessage, HubStreamState } from '../lib/stream/hub-stream.js';
import { AvatarMark } from './companion-sprite.js';
import { MessageContent } from './message-content.js';
import '../styles/thread-reading.css';

export function ThreadView({
  streamState,
  targetLabel,
  companionLabel = 'Companion',
  active = true,
}: {
  streamState: HubStreamState;
  targetLabel?: string;
  companionLabel?: string;
  active?: boolean;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const followingRef = useRef(true);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const [hasNewContent, setHasNewContent] = useState(false);
  const conversationKey = `${streamState.session?.sessionId ?? ''}:${streamState.session?.activeShardId ?? ''}`;
  const previousConversationRef = useRef(conversationKey);
  const lastMessage = streamState.messages.at(-1);
  const contentKey = JSON.stringify([
    streamState.messages.length, lastMessage?.id, lastMessage?.content,
    streamState.liveUser?.content, streamState.liveAssistant?.content,
  ]);
  const previousContentRef = useRef(contentKey);
  const speaker = targetLabel ?? companionLabel;

  useLayoutEffect(() => {
    const changed = previousContentRef.current !== contentKey;
    previousContentRef.current = contentKey;
    if (previousConversationRef.current !== conversationKey) {
      previousConversationRef.current = conversationKey;
      followingRef.current = true;
      setAwayFromLatest(false);
      setHasNewContent(false);
    }
    if (active && followingRef.current) {
      const list = listRef.current;
      if (list) list.scrollTop = list.scrollHeight;
      setHasNewContent(false);
    } else if (changed) setHasNewContent(true);
  }, [active, contentKey, conversationKey]);

  function observeScroll() {
    const list = listRef.current;
    if (!active || !list) return;
    // One CSS pixel allows fractional scroll rounding at the bottom edge.
    const atLatest = list.scrollHeight - list.clientHeight - list.scrollTop <= 1;
    followingRef.current = atLatest;
    setAwayFromLatest(!atLatest);
    if (atLatest) setHasNewContent(false);
  }

  function jumpToLatest() {
    followingRef.current = true;
    setAwayFromLatest(false);
    setHasNewContent(false);
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }

  return (
    <section
      className="thread-viewport"
      aria-label={targetLabel ? `Direct shard chat with ${targetLabel}` : `Chat with ${companionLabel}`}
    >
      {targetLabel && <div className="thread-target-banner">Direct shard thread · {targetLabel}</div>}
      <div
        className="message-list"
        ref={listRef}
        onScroll={observeScroll}
        role="log"
        aria-label={`Messages with ${speaker}`}
        aria-live={active && !awayFromLatest ? 'polite' : 'off'}
        tabIndex={0}
      >
        {streamState.messages.length === 0 && !streamState.liveUser && !streamState.liveAssistant ? (
          <div className="thread-empty">
            <Sparkles aria-hidden />
            <p>{streamState.connection === 'ready'
              ? `Say hello to ${speaker}.`
              : 'Your conversation will appear here when connected.'}</p>
          </div>
        ) : (
          <>
            {streamState.messages.map(message => (
              <MessageRow key={message.id} message={message} speaker={speaker} />
            ))}
            {streamState.liveUser && <MessageRow message={streamState.liveUser} speaker={speaker} streaming />}
            {streamState.liveAssistant && <MessageRow message={streamState.liveAssistant} speaker={speaker} streaming />}
          </>
        )}
      </div>
      {awayFromLatest && (
        <button className="thread-jump-latest" type="button" onClick={jumpToLatest}>
          <ArrowDown aria-hidden /> {hasNewContent ? 'New messages · Jump to latest' : 'Jump to latest'}
        </button>
      )}
    </section>
  );
}

function MessageRow({ message, speaker, streaming = false }: {
  message: HubStreamMessage;
  speaker: string;
  streaming?: boolean;
}) {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const sender = message.role === 'assistant' ? speaker : 'You';

  async function copyMessage() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard is unavailable');
      await navigator.clipboard.writeText(message.content);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('failed');
    }
  }

  return (
    <article className={`message-row ${message.role}${streaming ? ' live' : ''}`} aria-label={`${sender}${streaming ? ' is speaking' : ''}`}>
      {message.role === 'assistant' && <AvatarMark />}
      <div className="message-bubble">
        <MessageContent content={message.content} />
        {!streaming && (
          <div className="message-actions">
            <button type="button" aria-label={`Copy ${sender === 'You' ? 'your' : `${sender}'s`} message`} onClick={() => { void copyMessage(); }}>
              {copyStatus === 'copied' ? <Check aria-hidden /> : <Copy aria-hidden />}
              {copyStatus === 'copied' ? 'Copied' : 'Copy'}
            </button>
            {copyStatus === 'failed' && <span role="status">Couldn&apos;t copy. Select the message text to copy it.</span>}
          </div>
        )}
      </div>
    </article>
  );
}
