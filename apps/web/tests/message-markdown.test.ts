import { describe, expect, it } from "vitest";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseBlocks, renderMessageContent } from "../lib/messageMarkdown";

const html = (content: string, names: string[] = []) =>
  renderToStaticMarkup(createElement(Fragment, null, renderMessageContent(content, names)));

describe("chat message Markdown", () => {
  it("renders bold, inline code and bullet lists instead of showing the syntax", () => {
    const markup = html("The project has 2 issues:\n\n- **CAL-1** — Fix missing `script.js`\n- **CAL-2** — Dark mode");
    expect(markup).toContain("<strong>CAL-1</strong>");
    expect(markup).toContain("<code>script.js</code>");
    expect(markup).toContain('<ul class="md-list"><li>');
    expect(markup).not.toContain("**");
  });

  it("keeps numbered lists, headings, code fences and line breaks", () => {
    expect(parseBlocks("### Status\n1. One\n2. Two\n```\nnpm test\n```\nline a\nline b").map((block) => block.kind)).toEqual(["heading", "ol", "code", "p"]);
    const markup = html("line a\nline b");
    expect(markup).toContain("line a");
    expect(markup).toContain("<br/>");
  });

  it("never renders HTML from message text and only links http(s) URLs", () => {
    const markup = html('<img src=x onerror="alert(1)"> [safe](https://github.com/henakharwa/Test) [bad](javascript:alert(1))');
    expect(markup).not.toContain("<img");
    expect(markup).toContain("&lt;img");
    expect(markup).toContain('<a href="https://github.com/henakharwa/Test" target="_blank" rel="noopener noreferrer">safe</a>');
    expect(markup).not.toContain('href="javascript');
  });

  it("still highlights @mentions inside formatted text", () => {
    expect(html("**Heads up** @agent please check", ["Stevens"])).toContain('<span class="mention-pill">@agent</span>');
  });

  it("leaves plain messages unchanged", () => {
    expect(html("hello from admin")).toBe('<p class="md-p">hello from admin</p>');
  });
});
