import { Fragment, type ReactNode } from 'react';

/** A small presentation subset: content is always React text, never HTML. */
export function MessageContent({ content }: { content: string }) {
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let code: string[] | null = null;
  let language = '';

  function flushParagraph() {
    if (paragraph.length === 0) return;
    blocks.push(<p key={blocks.length}>{renderInline(paragraph.join('\n'))}</p>);
    paragraph = [];
  }

  function flushCode() {
    blocks.push(
      <pre key={blocks.length} aria-label={language ? `${language} code` : 'Code'}>
        <code>{code?.join('\n')}</code>
      </pre>,
    );
    code = null;
  }

  for (const line of content.split('\n')) {
    const fence = /^\s*```([\w+-]*)\s*$/.exec(line);
    if (fence) {
      if (code) flushCode();
      else {
        flushParagraph();
        language = fence[1] ?? '';
        code = [];
      }
    } else if (code) code.push(line);
    else if (line.trim() === '') flushParagraph();
    else paragraph.push(line);
  }
  if (code) flushCode();
  flushParagraph();
  return <div className="message-content">{blocks}</div>;
}

function renderInline(text: string): ReactNode[] {
  const tokens = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<>]+)/g;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(tokens)) {
    const index = match.index;
    parts.push(text.slice(cursor, index));
    const token = match[0];
    let node: ReactNode = token;
    if (token.startsWith('`')) node = <code>{token.slice(1, -1)}</code>;
    else if (token.startsWith('**')) node = <strong>{token.slice(2, -2)}</strong>;
    else {
      const link = /^\[([^\]]+)\]\((.*)\)$/.exec(token);
      const rawUrl = link?.[2] ?? token;
      const url = link ? rawUrl : rawUrl.replace(/[.,;:!?)}\]]+$/, '');
      try {
        const parsed = new URL(url);
        if ((parsed.protocol === 'https:' || parsed.protocol === 'http:')
          && !parsed.username && !parsed.password) {
          node = <><a href={url} target="_blank" rel="noopener noreferrer">{link?.[1] ?? url}</a>{link ? '' : rawUrl.slice(url.length)}</>;
        }
      } catch {
        // Invalid URLs remain visible as the original message text.
      }
    }
    parts.push(<Fragment key={index}>{node}</Fragment>);
    cursor = index + token.length;
  }
  parts.push(text.slice(cursor));
  return parts;
}
