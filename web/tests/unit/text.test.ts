import { describe, test, expect } from "vitest";
import {
  tiptapToPlainText,
  truncateText,
  stripMarkdown,
  markdownToHtml,
} from "$lib/utils/text";

describe("tiptapToPlainText", () => {
  test("extracts text from simple paragraph", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Hello world" }],
        },
      ],
    };
    expect(tiptapToPlainText(doc).trim()).toBe("Hello world");
  });

  test("handles multiple paragraphs", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "First paragraph" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Second paragraph" }],
        },
      ],
    };
    expect(tiptapToPlainText(doc).trim()).toBe(
      "First paragraph\nSecond paragraph"
    );
  });

  test("handles nested lists", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Item 1" }],
                },
              ],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Item 2" }],
                },
              ],
            },
          ],
        },
      ],
    };
    const result = tiptapToPlainText(doc);
    expect(result).toContain("Item 1");
    expect(result).toContain("Item 2");
  });

  test("handles empty document", () => {
    expect(tiptapToPlainText(null)).toBe("");
    expect(tiptapToPlainText(undefined)).toBe("");
  });

  test("strips formatting marks", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "bold text",
              marks: [{ type: "bold" }],
            },
          ],
        },
      ],
    };
    expect(tiptapToPlainText(doc).trim()).toBe("bold text");
  });
});

describe("truncateText", () => {
  test("returns full text if under limit", () => {
    expect(truncateText("Hello", 10)).toBe("Hello");
  });

  test("truncates and adds ellipsis", () => {
    expect(truncateText("Hello world this is long", 10)).toBe("Hello worl...");
  });

  test("handles exact length", () => {
    expect(truncateText("Hello", 5)).toBe("Hello");
  });
});

describe("stripMarkdown", () => {
  test("strips bold markers", () => {
    expect(stripMarkdown("**bold text**")).toBe("bold text");
  });

  test("strips italic markers", () => {
    expect(stripMarkdown("*italic*")).toBe("italic");
  });

  test("strips headers", () => {
    expect(stripMarkdown("# Header\nBody text")).toBe("Header\nBody text");
  });

  test("strips list markers", () => {
    expect(stripMarkdown("- item 1\n- item 2")).toBe("item 1\nitem 2");
  });

  test("strips links", () => {
    expect(stripMarkdown("[click here](https://example.com)")).toBe(
      "click here"
    );
  });

  test("handles mixed markdown", () => {
    const input = "## Title\n\n**Bold** and *italic* with `code`";
    const result = stripMarkdown(input);
    expect(result).not.toContain("**");
    expect(result).not.toContain("##");
    expect(result).toContain("Bold");
    expect(result).toContain("italic");
  });
});

describe("markdownToHtml", () => {
  test("wraps plain text in paragraphs", () => {
    expect(markdownToHtml("Hello world")).toContain("<p>Hello world</p>");
  });

  test("renders bold", () => {
    expect(markdownToHtml("**bold**")).toContain("<strong>bold</strong>");
  });

  test("renders italic", () => {
    expect(markdownToHtml("*italic*")).toContain("<em>italic</em>");
  });

  test("renders headers", () => {
    expect(markdownToHtml("# Title")).toContain("<h1>Title</h1>");
    expect(markdownToHtml("## Subtitle")).toContain("<h2>Subtitle</h2>");
  });

  test("renders horizontal rules", () => {
    expect(markdownToHtml("---")).toContain("<hr>");
  });

  test("escapes HTML entities", () => {
    expect(markdownToHtml("<script>alert('xss')</script>")).not.toContain(
      "<script>"
    );
    expect(markdownToHtml("<script>")).toContain("&lt;script&gt;");
  });

  test("handles empty string", () => {
    expect(markdownToHtml("")).toBe("");
  });
});
