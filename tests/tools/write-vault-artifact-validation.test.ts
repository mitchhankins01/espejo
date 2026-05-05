import { describe, it, expect } from "vitest";
import { validateToolInput } from "../../specs/tools.spec.js";

describe("write_vault_artifact spec", () => {
  it("accepts a valid Pending path with frontmatter", () => {
    const parsed = validateToolInput("write_vault_artifact", {
      path: "Pending/2026-05-04 — Example.md",
      content: "---\nkind: insight\n---\n\nbody",
    });
    expect(parsed.overwrite).toBe(false);
    expect(parsed.path).toBe("Pending/2026-05-04 — Example.md");
  });

  it("rejects a path not starting with a kind folder", () => {
    expect(() =>
      validateToolInput("write_vault_artifact", {
        path: "foo/bar.md",
        content: "---\nkind: insight\n---\n",
      })
    ).toThrow();
  });

  it("rejects a path with nested directories", () => {
    expect(() =>
      validateToolInput("write_vault_artifact", {
        path: "Insight/sub/note.md",
        content: "---\nkind: insight\n---\n",
      })
    ).toThrow();
  });

  it("rejects a hidden filename", () => {
    expect(() =>
      validateToolInput("write_vault_artifact", {
        path: "Insight/.secret.md",
        content: "---\nkind: insight\n---\n",
      })
    ).toThrow();
  });
});
