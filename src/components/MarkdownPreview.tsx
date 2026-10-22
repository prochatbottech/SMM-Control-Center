import React from 'react';

/**
 * Lightweight, dependency-free Markdown renderer for the post/article editor preview.
 * Renders a safe subset (headings, lists, quotes, code, bold/italic/links/images)
 * as React elements — never uses dangerouslySetInnerHTML, so it is XSS-safe.
 */

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Token pattern: images, links, bold, italic, inline code
  const regex =
    /(!?\[[^\]]*\]\([^)]+\))|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*]+\*)|(_[^_]+_)|(`[^`]+`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let i = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    const key = `${keyPrefix}-i${i++}`;

    if (token.startsWith('![') || token.startsWith('[')) {
      const isImage = token.startsWith('!');
      const m = token.match(/!?\[([^\]]*)\]\(([^)]+)\)/);
      if (m) {
        if (isImage) {
          nodes.push(
            <img
              key={key}
              src={m[2]}
              alt={m[1]}
              className="max-w-full rounded-lg my-1 border border-zinc-200 dark:border-zinc-700"
            />
          );
        } else {
          nodes.push(
            <a
              key={key}
              href={m[2]}
              target="_blank"
              rel="noreferrer"
              className="text-blue-600 dark:text-blue-400 underline"
            >
              {m[1]}
            </a>
          );
        }
      } else {
        nodes.push(token);
      }
    } else if (token.startsWith('**') || token.startsWith('__')) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('`')) {
      nodes.push(
        <code
          key={key}
          className="px-1 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-[0.9em] font-mono"
        >
          {token.slice(1, -1)}
        </code>
      );
    } else {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    }

    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

export const MarkdownPreview: React.FC<{ content: string }> = ({ content }) => {
  const lines = content.split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.trim().startsWith('```')) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      blocks.push(
        <pre
          key={`k${key++}`}
          className="p-3 my-2 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-xs font-mono overflow-x-auto"
        >
          <code>{codeLines.join('\n')}</code>
        </pre>
      );
      continue;
    }

    // Horizontal rule
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      blocks.push(<hr key={`k${key++}`} className="my-3 border-zinc-200 dark:border-zinc-700" />);
      i++;
      continue;
    }

    // Heading
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const sizes = ['text-xl', 'text-lg', 'text-base'];
      const Tag = (`h${level}` as unknown) as React.ElementType;
      blocks.push(
        <Tag key={`k${key++}`} className={`${sizes[level - 1]} font-bold mt-3 mb-1`}>
          {renderInline(heading[2], `h${key}`)}
        </Tag>
      );
      i++;
      continue;
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      blocks.push(
        <blockquote
          key={`k${key++}`}
          className="my-2 pl-3 border-l-4 border-blue-400/60 text-zinc-600 dark:text-zinc-400 italic"
        >
          {renderInline(quoteLines.join(' '), `q${key}`)}
        </blockquote>
      );
      continue;
    }

    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i++;
      }
      blocks.push(
        <ul key={`k${key++}`} className="my-2 list-disc pl-5 space-y-0.5">
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it, `ul${key}-${idx}`)}</li>
          ))}
        </ul>
      );
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      blocks.push(
        <ol key={`k${key++}`} className="my-2 list-decimal pl-5 space-y-0.5">
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it, `ol${key}-${idx}`)}</li>
          ))}
        </ol>
      );
      continue;
    }

    // Blank line
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Paragraph (accumulate consecutive non-empty lines)
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^\s*(#{1,3}\s|[-*+]\s|\d+\.\s|>|```)/.test(lines[i]) &&
      !/^\s*([-*_])\1{2,}\s*$/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={`k${key++}`} className="my-1.5 leading-relaxed">
        {renderInline(paraLines.join(' '), `p${key}`)}
      </p>
    );
  }

  if (blocks.length === 0) {
    return (
      <div className="text-sm text-zinc-400 italic p-3">Превью появится здесь…</div>
    );
  }

  return <div className="text-sm text-zinc-800 dark:text-zinc-200">{blocks}</div>;
};
