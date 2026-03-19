import { describe, it, expect } from "vitest";

import { extractWikiLinks } from "../../src/obsidian/wiki-links.js";

describe("extractWikiLinks", () => {
  it("extracts basic wiki links", () => {
    expect(extractWikiLinks("See [[Note A]] and [[Note B]].")).toEqual(["Note A", "Note B"]);
  });

  it("extracts display text links", () => {
    expect(extractWikiLinks("Check [[Real Title|display text]] out.")).toEqual(["Real Title"]);
  });

  it("strips heading fragments", () => {
    expect(extractWikiLinks("Link to [[Note#Section]].")).toEqual(["Note"]);
  });

  it("strips block references", () => {
    expect(extractWikiLinks("See [[Note#^block-id]].")).toEqual(["Note"]);
  });

  it("handles embeds as links", () => {
    expect(extractWikiLinks("Embed: ![[Some Note]].")).toEqual(["Some Note"]);
  });

  it("deduplicates links", () => {
    expect(extractWikiLinks("[[A]] and [[A]] again.")).toEqual(["A"]);
  });

  it("ignores links inside fenced code blocks", () => {
    const content = "Before [[Real]].\n```\n[[InCode]]\n```\nAfter.";
    expect(extractWikiLinks(content)).toEqual(["Real"]);
  });

  it("ignores links inside inline code", () => {
    const content = "See [[Real]] and `[[InCode]]` here.";
    expect(extractWikiLinks(content)).toEqual(["Real"]);
  });

  it("returns empty array for no links", () => {
    expect(extractWikiLinks("Just plain text.")).toEqual([]);
  });

  it("handles combined variants", () => {
    const content = "[[A]], [[B|display]], [[C#heading]], ![[D]], [[A]]";
    expect(extractWikiLinks(content)).toEqual(["A", "B", "C", "D"]);
  });

  it("handles empty link targets", () => {
    expect(extractWikiLinks("[[]] and [[  ]]")).toEqual([]);
  });

  it("handles link with pipe and hash", () => {
    expect(extractWikiLinks("[[Note#Section|display]]")).toEqual(["Note"]);
  });
});
