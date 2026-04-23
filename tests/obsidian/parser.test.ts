import { describe, it, expect } from "vitest";

import { parseObsidianNote, stripSources } from "../../src/obsidian/parser.js";

describe("parseObsidianNote", () => {
  it("parses frontmatter with kind", () => {
    const content = "---\nkind: insight\ntags: [self-reflection, health]\n---\n# My Insight\n\nSome body text.";
    const result = parseObsidianNote(content, "test.md");
    expect(result.kind).toBe("insight");
    expect(result.title).toBe("My Insight");
    expect(result.body).toBe("Some body text.");
  });

  it("handles Obsidian frontmatter with blank lines", () => {
    const content = "---\n\nkind: reference\n\ntags: [books]\n\n---\n# Book Notes\n\nGood book.";
    const result = parseObsidianNote(content, "test.md");
    expect(result.kind).toBe("reference");
    expect(result.title).toBe("Book Notes");
  });

  it("defaults to note kind when frontmatter missing", () => {
    const content = "Just some text with a [[link]].";
    const result = parseObsidianNote(content, "My Note.md");
    expect(result.kind).toBe("note");
    expect(result.title).toBe("My Note");
    expect(result.body).toBe("Just some text with a [[link]].");
  });

  it("defaults invalid kind to note", () => {
    const content = "---\nkind: recipe\n---\n# Cooking\n\nSome recipe.";
    const result = parseObsidianNote(content, "test.md");
    expect(result.kind).toBe("note");
  });

  it("falls back to filename stem when no heading", () => {
    const content = "## Not a title heading\n\nSome text.";
    const result = parseObsidianNote(content, "Directory/Sub note.md");
    expect(result.title).toBe("Sub note");
    expect(result.body).toBe("## Not a title heading\n\nSome text.");
  });

  it("strips markdown formatting from title", () => {
    const content = "# My **Bold** Title\n\nBody.";
    const result = parseObsidianNote(content, "test.md");
    expect(result.title).toBe("My Bold Title");
  });

  it("strips wiki links from title", () => {
    const content = "# Notes on [[Some Topic]]\n\nBody.";
    const result = parseObsidianNote(content, "test.md");
    expect(result.title).toBe("Notes on Some Topic");
  });

  it("truncates title to 300 chars", () => {
    const longTitle = "A".repeat(350);
    const content = `# ${longTitle}\n\nBody.`;
    const result = parseObsidianNote(content, "test.md");
    expect(result.title.length).toBe(300);
  });

  it("uses title as body for heading-only notes", () => {
    const content = "# Just a Title";
    const result = parseObsidianNote(content, "test.md");
    expect(result.title).toBe("Just a Title");
    expect(result.body).toBe("Just a Title");
  });

  it("extracts wiki links from body", () => {
    const content = "# Title\n\nSee [[Note A]] and [[Note B|display]] for details.";
    const result = parseObsidianNote(content, "test.md");
    expect(result.wikiLinks).toEqual(["Note A", "Note B"]);
  });

  it("handles project kind", () => {
    const content = "---\nkind: project\n---\n# My Project\n\nDetails here.";
    const result = parseObsidianNote(content, "test.md");
    expect(result.kind).toBe("project");
  });
});

describe("stripSources", () => {
  it("removes the ## Sources section and everything after it", () => {
    const body = "Body paragraph one.\n\nBody paragraph two.\n\n## Sources\n[[Link A]]\n[[Link B]]";
    expect(stripSources(body)).toBe("Body paragraph one.\n\nBody paragraph two.");
  });

  it("returns body unchanged when no Sources section exists", () => {
    const body = "Body paragraph with [[Inline Link]] but no sources section.";
    expect(stripSources(body)).toBe(body);
  });

  it("does not strip other ## headings", () => {
    const body = "Body.\n\n## Context\n\nMore body.\n\n## Sources\n[[X]]";
    expect(stripSources(body)).toBe("Body.\n\n## Context\n\nMore body.");
  });

  it("handles trailing whitespace on the Sources heading", () => {
    const body = "Body.\n\n## Sources   \n[[X]]";
    expect(stripSources(body)).toBe("Body.");
  });

  it("is case-sensitive (vault convention uses capital S)", () => {
    const body = "Body.\n\n## sources\n[[X]]";
    expect(stripSources(body)).toBe(body);
  });
});
