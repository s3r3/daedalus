"use client";

// A tiny, dependency-free GitHub-flavored-Markdown renderer. The chat only
// needs headings, paragraphs, bold/italic/inline-code, links, fenced code, and
// bullet/numbered lists — enough for an agent's answer to read well without
// pulling in a full markdown library. Everything is escaped before rendering,
// so raw HTML in the source is shown as text, never injected.

import { Fragment, type ReactNode } from "react";

/** Inline spans: **bold**, *italic*, `code`, [text](url). */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\))/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > last) nodes.push(<Fragment key={`${keyPrefix}-t${index}`}>{text.slice(last, match.index)}</Fragment>);
    const [, , bold, boldU, italic, italicU, code, linkText, linkUrl] = match;
    const key = `${keyPrefix}-m${index}`;
    if (bold ?? boldU) nodes.push(<strong key={key}>{bold ?? boldU}</strong>);
    else if (italic ?? italicU) nodes.push(<em key={key}>{italic ?? italicU}</em>);
    else if (code) nodes.push(<code key={key}>{code}</code>);
    else if (linkText && linkUrl) {
      const safe = /^(https?:|mailto:|\/)/i.test(linkUrl) ? linkUrl : "#";
      nodes.push(<a key={key} href={safe} target="_blank" rel="noreferrer noopener">{linkText}</a>);
    }
    last = match.index + match[0].length;
    index += 1;
  }
  if (last < text.length) nodes.push(<Fragment key={`${keyPrefix}-t${index}`}>{text.slice(last)}</Fragment>);
  return nodes;
}

type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "code"; text: string }
  | { type: "quote"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[]; start: number }
  | { type: "p"; text: string }
  | { type: "hr" };

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }

    // fenced code
    if (/^```/.test(line.trim())) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i].trim())) { body.push(lines[i]); i += 1; }
      i += 1; // closing fence
      blocks.push({ type: "code", text: body.join("\n") });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { blocks.push({ type: "heading", level: heading[1].length, text: heading[2].trim() }); i += 1; continue; }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { blocks.push({ type: "hr" }); i += 1; continue; }

    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { body.push(lines[i].replace(/^\s*>\s?/, "")); i += 1; }
      blocks.push({ type: "quote", text: body.join(" ") });
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        i += 1;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i])) {
          items[items.length - 1] += `\n${lines[i].trim()}`;
          i += 1;
        }
      }
      blocks.push({ type: "ul", items });
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      const start = Number.parseInt(/^\s*(\d+)/.exec(line)?.[1] ?? "1", 10);
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ""));
        i += 1;
        while (
          i < lines.length
          && /^\s{2,}\S/.test(lines[i])
          && !/^\s*\d+[.)]\s+/.test(lines[i])
          && !/^\s*[-*+]\s+/.test(lines[i])
        ) {
          items[items.length - 1] += `\n${lines[i].trim()}`;
          i += 1;
        }
      }
      blocks.push({ type: "ol", items, start });
      continue;
    }

    // paragraph: gather until a blank line or a block starter
    const body: string[] = [];
    while (
      i < lines.length && lines[i].trim()
      && !/^(#{1,6})\s+/.test(lines[i]) && !/^```/.test(lines[i].trim())
      && !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i]) && !/^\s*>/.test(lines[i])
    ) { body.push(lines[i]); i += 1; }
    blocks.push({ type: "p", text: body.join("\n") });
  }
  return blocks;
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  const blocks = parseBlocks(source ?? "");
  return (
    <div className={`markdown${className ? ` ${className}` : ""}`}>
      {blocks.map((block, index) => {
        const key = `b${index}`;
        switch (block.type) {
          case "heading": {
            const Tag = (`h${Math.min(block.level + 2, 6)}`) as "h3" | "h4" | "h5" | "h6";
            return <Tag key={key}>{renderInline(block.text, key)}</Tag>;
          }
          case "code":
            return <pre key={key} className="markdown-code"><code>{block.text}</code></pre>;
          case "quote":
            return <blockquote key={key}>{renderInline(block.text, key)}</blockquote>;
          case "ul":
            return <ul key={key}>{block.items.map((item, j) => <li key={j}>{renderInline(item, `${key}-${j}`)}</li>)}</ul>;
          case "ol":
            return <ol key={key} start={block.start}>{block.items.map((item, j) => <li key={j}>{renderInline(item, `${key}-${j}`)}</li>)}</ol>;
          case "hr":
            return <hr key={key} />;
          default:
            return <p key={key}>{renderInline(block.text, key)}</p>;
        }
      })}
    </div>
  );
}
