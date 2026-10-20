import { Fragment } from "react";
import type React from "react";
import { renderWithMentions } from "./mentionHighlight";

// Agents reply in Markdown (bold, lists, inline code, links). Chat bubbles
// used to print that literally, so "**CAL-1**" showed its asterisks. This
// renders the small subset agents actually use, building React elements
// directly -- never HTML strings -- so message text cannot inject markup.
// Links are kept only for http(s) and mailto URLs.

type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "heading"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[]; start: number }
  | { kind: "code"; text: string };

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*(\d{1,3})[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*```/;

export function parseBlocks(content: string): Block[] {
  const blocks: Block[] = [];
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) code.push(lines[i++]);
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    if (!line.trim()) continue;
    const heading = line.match(HEADING);
    if (heading) {
      blocks.push({ kind: "heading", text: heading[1] });
      continue;
    }
    const bullet = line.match(BULLET);
    const numbered = line.match(NUMBERED);
    const last = blocks[blocks.length - 1];
    if (bullet) {
      if (last?.kind === "ul") last.items.push(bullet[1]);
      else blocks.push({ kind: "ul", items: [bullet[1]] });
      continue;
    }
    if (numbered) {
      if (last?.kind === "ol") last.items.push(numbered[2]);
      else blocks.push({ kind: "ol", items: [numbered[2]], start: Number(numbered[1]) });
      continue;
    }
    // A line that directly follows a paragraph line continues it; a blank
    // line (skipped above) or any other block starts a new paragraph.
    const previousLineBlank = i === 0 || !lines[i - 1].trim();
    if (last?.kind === "p" && !previousLineBlank) last.lines.push(line);
    else blocks.push({ kind: "p", lines: [line] });
  }
  return blocks;
}

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*|__[^_\n]+?__)|(\[[^\]\n]+\]\([^)\s]+\))/g;

function safeHref(url: string): string | null {
  return /^(https?:\/\/|mailto:)/i.test(url) ? url : null;
}

export function renderInline(text: string, names: string[], keyPrefix = "i"): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > last)
      out.push(<Fragment key={`${keyPrefix}-${key++}`}>{renderWithMentions(text.slice(last, index), names)}</Fragment>);
    const [token] = match;
    if (match[1]) {
      out.push(<code key={`${keyPrefix}-${key++}`}>{token.slice(1, -1)}</code>);
    } else if (match[2]) {
      out.push(
        <strong key={`${keyPrefix}-${key++}`}>
          {renderInline(token.slice(2, -2), names, `${keyPrefix}-b${key}`)}
        </strong>,
      );
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
      const href = link ? safeHref(link[2]) : null;
      out.push(
        href && link ? (
          <a key={`${keyPrefix}-${key++}`} href={href} target="_blank" rel="noopener noreferrer">
            {link[1]}
          </a>
        ) : (
          <span key={`${keyPrefix}-${key++}`}>{token}</span>
        ),
      );
    }
    last = index + token.length;
  }
  if (last < text.length)
    out.push(<Fragment key={`${keyPrefix}-${key++}`}>{renderWithMentions(text.slice(last), names)}</Fragment>);
  return out;
}

/** Renders a chat message's Markdown subset, with @mention pills. */
export function renderMessageContent(content: string, names: string[]): React.ReactNode {
  const blocks = parseBlocks(content);
  if (blocks.length === 0) return renderWithMentions(content, names);
  return blocks.map((block, index) => {
    const key = `b${index}`;
    if (block.kind === "code") {
      return (
        <pre key={key} className="md-pre">
          <code>{block.text}</code>
        </pre>
      );
    }
    if (block.kind === "heading") {
      return (
        <p key={key} className="md-p md-heading">
          <strong>{renderInline(block.text, names, key)}</strong>
        </p>
      );
    }
    if (block.kind === "ul" || block.kind === "ol") {
      const items = block.items.map((item, itemIndex) => (
        <li key={`${key}-${itemIndex}`}>{renderInline(item, names, `${key}-${itemIndex}`)}</li>
      ));
      return block.kind === "ul" ? (
        <ul key={key} className="md-list">
          {items}
        </ul>
      ) : (
        <ol key={key} className="md-list" start={block.start}>
          {items}
        </ol>
      );
    }
    return (
      <p key={key} className="md-p">
        {block.lines.map((line, lineIndex) => (
          <Fragment key={`${key}-${lineIndex}`}>
            {lineIndex > 0 && <br />}
            {renderInline(line, names, `${key}-${lineIndex}`)}
          </Fragment>
        ))}
      </p>
    );
  });
}
