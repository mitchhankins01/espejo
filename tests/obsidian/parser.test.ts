import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

describe("parseObsidianNote — frontmatter timestamps", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("extracts unquoted YYYY-MM-DD created_at and updated_at as Date", () => {
    const content =
      "---\nkind: insight\ncreated_at: 2026-03-27\nupdated_at: 2026-04-01\n---\n# Title\n\nBody.";
    const result = parseObsidianNote(content, "test.md");
    expect(result.createdAt).toBeInstanceOf(Date);
    expect(result.createdAt?.toISOString()).toBe("2026-03-27T00:00:00.000Z");
    expect(result.updatedAt).toBeInstanceOf(Date);
    expect(result.updatedAt?.toISOString()).toBe("2026-04-01T00:00:00.000Z");
    expect(result.dateParseErrors).toEqual([]);
  });

  it("extracts ISO 8601 string timestamps", () => {
    const content =
      "---\nkind: insight\ncreated_at: '2026-03-27T14:30:00Z'\nupdated_at: '2026-04-01T09:15:00+02:00'\n---\n# Title\n\nBody.";
    const result = parseObsidianNote(content, "test.md");
    expect(result.createdAt?.toISOString()).toBe("2026-03-27T14:30:00.000Z");
    expect(result.updatedAt?.toISOString()).toBe("2026-04-01T07:15:00.000Z");
    expect(result.dateParseErrors).toEqual([]);
  });

  it("extracts only created_at when updated_at is absent", () => {
    const content =
      "---\nkind: insight\ncreated_at: 2026-03-27\n---\n# Title\n\nBody.";
    const result = parseObsidianNote(content, "test.md");
    expect(result.createdAt).toBeInstanceOf(Date);
    expect(result.updatedAt).toBeUndefined();
    expect(result.dateParseErrors).toEqual([]);
  });

  it("extracts only updated_at when created_at is absent", () => {
    const content =
      "---\nkind: insight\nupdated_at: 2026-04-01\n---\n# Title\n\nBody.";
    const result = parseObsidianNote(content, "test.md");
    expect(result.createdAt).toBeUndefined();
    expect(result.updatedAt).toBeInstanceOf(Date);
    expect(result.dateParseErrors).toEqual([]);
  });

  it("returns no errors when frontmatter has no timestamp fields", () => {
    const content = "---\nkind: insight\n---\n# Title\n\nBody.";
    const result = parseObsidianNote(content, "test.md");
    expect(result.createdAt).toBeUndefined();
    expect(result.updatedAt).toBeUndefined();
    expect(result.dateParseErrors).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("records error and logs warning for unparseable date string", () => {
    const content =
      "---\nkind: insight\ncreated_at: 'not-a-date'\n---\n# Title\n\nBody.";
    const result = parseObsidianNote(content, "Insight/Test.md");
    expect(result.createdAt).toBeUndefined();
    expect(result.dateParseErrors).toHaveLength(1);
    expect(result.dateParseErrors[0]).toContain("invalid created_at");
    expect(result.dateParseErrors[0]).toContain('"not-a-date"');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[obsidian-parser] Insight/Test.md")
    );
  });

  it("records error for non-string non-Date type (number)", () => {
    const content =
      "---\nkind: insight\ncreated_at: 12345\n---\n# Title\n\nBody.";
    const result = parseObsidianNote(content, "test.md");
    expect(result.createdAt).toBeUndefined();
    expect(result.dateParseErrors).toHaveLength(1);
    expect(result.dateParseErrors[0]).toContain("expected string or Date");
    expect(result.dateParseErrors[0]).toContain("number");
  });

  it("records error for array type", () => {
    const content =
      "---\nkind: insight\nupdated_at:\n  - 2026-03-27\n  - 2026-04-01\n---\n# Title\n\nBody.";
    const result = parseObsidianNote(content, "test.md");
    expect(result.updatedAt).toBeUndefined();
    expect(result.dateParseErrors).toHaveLength(1);
    expect(result.dateParseErrors[0]).toContain("invalid updated_at");
    expect(result.dateParseErrors[0]).toContain("expected string or Date");
  });

  it("collects errors for both fields when both are bad", () => {
    const content =
      "---\nkind: insight\ncreated_at: 'bogus'\nupdated_at: 'also-bogus'\n---\n# Title\n\nBody.";
    const result = parseObsidianNote(content, "test.md");
    expect(result.createdAt).toBeUndefined();
    expect(result.updatedAt).toBeUndefined();
    expect(result.dateParseErrors).toHaveLength(2);
    expect(result.dateParseErrors[0]).toContain("created_at");
    expect(result.dateParseErrors[1]).toContain("updated_at");
  });

  it("preserves valid created_at when updated_at is malformed", () => {
    const content =
      "---\nkind: insight\ncreated_at: 2026-03-27\nupdated_at: 'nope'\n---\n# Title\n\nBody.";
    const result = parseObsidianNote(content, "test.md");
    expect(result.createdAt?.toISOString()).toBe("2026-03-27T00:00:00.000Z");
    expect(result.updatedAt).toBeUndefined();
    expect(result.dateParseErrors).toHaveLength(1);
    expect(result.dateParseErrors[0]).toContain("updated_at");
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
