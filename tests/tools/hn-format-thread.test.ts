import { describe, it, expect } from "vitest";
import {
  formatThreadForPrompt,
  htmlToPlainText,
} from "../../src/hn/format-thread.js";
import type { HnItem } from "../../src/hn/algolia.js";

function story(over: Partial<HnItem> = {}): HnItem {
  return {
    id: 1,
    created_at: null,
    created_at_i: null,
    type: "story",
    author: "alice",
    title: "Test thread",
    url: "https://example.com",
    text: null,
    points: 100,
    parent_id: null,
    story_id: null,
    children: [],
    ...over,
  };
}

function comment(over: Partial<HnItem> = {}): HnItem {
  return {
    id: Math.floor(Math.random() * 100_000),
    created_at: null,
    created_at_i: null,
    type: "comment",
    author: "bob",
    title: null,
    url: null,
    text: "<p>hello</p>",
    points: null,
    parent_id: 1,
    story_id: 1,
    children: [],
    ...over,
  };
}

describe("htmlToPlainText", () => {
  it("returns empty string for empty input", () => {
    expect(htmlToPlainText("")).toBe("");
  });

  it("strips paragraph tags and inserts blank lines", () => {
    expect(htmlToPlainText("<p>one</p><p>two</p>")).toBe("one\n\ntwo");
  });

  it("inlines anchors with href as 'text (url)' when href differs from text", () => {
    const out = htmlToPlainText('see <a href="https://x.example">this link</a> for more');
    expect(out).toBe("see this link (https://x.example) for more");
  });

  it("does not duplicate href when anchor text already equals the URL", () => {
    const out = htmlToPlainText('<a href="https://x.example">https://x.example</a>');
    expect(out).toBe("https://x.example");
  });

  it("collapses runs of whitespace", () => {
    expect(htmlToPlainText("<p>a   b\t\tc</p>")).toBe("a b c");
  });
});

describe("formatThreadForPrompt", () => {
  it("returns 0 comments and no body for an empty story", () => {
    const result = formatThreadForPrompt(story());
    expect(result.totalComments).toBe(0);
    expect(result.comments).toBe("");
    expect(result.selfPostBody).toBeNull();
  });

  it("flattens a single child with [1] path and 0 indent", () => {
    const item = story({
      children: [comment({ author: "bob", text: "<p>top reply</p>" })],
    });
    const result = formatThreadForPrompt(item);
    expect(result.totalComments).toBe(1);
    expect(result.comments).toBe("[1] bob: top reply");
  });

  it("flattens a nested tree using [1.1.1] paths and indents by depth", () => {
    const item = story({
      children: [
        comment({
          author: "bob",
          text: "<p>level1</p>",
          children: [
            comment({
              author: "carol",
              text: "<p>level2</p>",
              children: [
                comment({
                  author: "dan",
                  text: "<p>level3</p>",
                }),
              ],
            }),
          ],
        }),
      ],
    });
    const result = formatThreadForPrompt(item);
    expect(result.totalComments).toBe(3);
    const lines = result.comments.split("\n\n");
    expect(lines[0]).toBe("[1] bob: level1");
    expect(lines[1]).toBe("  [1.1] carol: level2");
    expect(lines[2]).toBe("    [1.1.1] dan: level3");
  });

  it("skips deleted comments with no text and no author", () => {
    const item = story({
      children: [
        comment({ author: null, text: null }),
        comment({ author: "ella", text: "<p>visible</p>" }),
      ],
    });
    const result = formatThreadForPrompt(item);
    expect(result.totalComments).toBe(1);
    expect(result.comments).toBe("[2] ella: visible");
  });

  it("indents continuation lines for multi-paragraph comments", () => {
    const item = story({
      children: [comment({ author: "bob", text: "<p>line one</p><p>line two</p>" })],
    });
    const result = formatThreadForPrompt(item);
    expect(result.comments).toBe("[1] bob: line one\n    \n    line two");
  });

  it("captures self-post body when a story has its own text", () => {
    const item = story({
      url: null,
      text: "<p>This is an Ask HN body</p>",
    });
    const result = formatThreadForPrompt(item);
    expect(result.selfPostBody).toBe("This is an Ask HN body");
  });
});
