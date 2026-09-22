import { describe, it, expect } from "vitest";
import { parseMentions } from "../src/mentions.js";

const members = [
  { userId: "u-jane", displayName: "Jane Doe" },
  { userId: "u-janet", displayName: "Janet" },
  { userId: "u-bob", displayName: "Bob" },
];

describe("parseMentions", () => {
  it("defaults to the agent when there's no @-mention at all", () => {
    expect(parseMentions("what's the status of the PR?", members)).toEqual({
      mentionsAgent: true,
      mentionedUserIds: [],
    });
  });

  it("still reaches the agent when it's explicitly @-mentioned", () => {
    expect(parseMentions("@agent open a PR for this", members).mentionsAgent).toBe(true);
    expect(parseMentions("@AI what's the deploy status?", members).mentionsAgent).toBe(true);
    expect(parseMentions("@Bot summarize this thread", members).mentionsAgent).toBe(true);
  });

  it("hands off (agent does not run) when only a teammate is @-mentioned", () => {
    const result = parseMentions("@Bob can you take this one?", members);
    expect(result.mentionsAgent).toBe(false);
    expect(result.mentionedUserIds).toEqual(["u-bob"]);
  });

  it("still runs the agent when both the agent and a teammate are @-mentioned together", () => {
    const result = parseMentions("@agent and @Bob, can you two look at this?", members);
    expect(result.mentionsAgent).toBe(true);
    expect(result.mentionedUserIds).toEqual(["u-bob"]);
  });

  it("dedupes a teammate mentioned more than once, preserving first-seen order", () => {
    const result = parseMentions("@Bob are you there? cc @Jane Doe, also @Bob again", members);
    expect(result.mentionedUserIds).toEqual(["u-bob", "u-jane"]);
  });

  it("prefers the longest match so 'Jane Doe' doesn't get cut short at 'Jane'", () => {
    // No member named plain "Jane" exists here, but "Janet" does, and a
    // shorter greedy match could wrongly treat "@Jane" as unmatched or
    // "@Janet" as "@Jane" + trailing "t" -- word-boundary + longest-match
    // together should get both of these right.
    expect(parseMentions("@Jane Doe, take a look", members).mentionedUserIds).toEqual(["u-jane"]);
    expect(parseMentions("@Janet, take a look", members).mentionedUserIds).toEqual(["u-janet"]);
  });

  it("does not treat an email-like string as a mention", () => {
    const result = parseMentions("ping bob@bob.com about this", members);
    expect(result.mentionsAgent).toBe(true);
    expect(result.mentionedUserIds).toEqual([]);
  });

  it("ignores an @-token that doesn't match any known member or agent alias", () => {
    const result = parseMentions("@nobody-here can you help?", members);
    expect(result.mentionsAgent).toBe(true); // falls back to the default audience -- the mention didn't resolve to anyone
    expect(result.mentionedUserIds).toEqual([]);
  });
});
