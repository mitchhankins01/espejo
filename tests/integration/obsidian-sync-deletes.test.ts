import { describe, it, expect } from "vitest";
import { pool } from "../../src/db/client.js";
import {
  insertObsidianSyncRun,
  completeObsidianSyncRun,
  getLatestObsidianSyncRun,
  upsertObsidianArtifact,
  softDeleteMissingObsidianArtifacts,
} from "../../src/db/queries/obsidian.js";

describe("obsidian sync — deleted-path capture", () => {
  it("softDeleteMissingObsidianArtifacts returns the source_paths it deleted", async () => {
    await upsertObsidianArtifact(pool, {
      sourcePath: "Note/Stale Conflict 2.md",
      title: "Stale Conflict 2",
      body: "body",
      kind: "note",
      contentHash: "h1",
    });
    await upsertObsidianArtifact(pool, {
      sourcePath: "Note/Live.md",
      title: "Live",
      body: "body",
      kind: "note",
      contentHash: "h2",
    });

    const deleted = await softDeleteMissingObsidianArtifacts(pool, [
      "Note/Live.md",
    ]);
    expect(deleted).toEqual(["Note/Stale Conflict 2.md"]);
  });

  it("returns every path when the active list is empty", async () => {
    await upsertObsidianArtifact(pool, {
      sourcePath: "Note/A.md",
      title: "A",
      body: "x",
      kind: "note",
      contentHash: "h",
    });
    await upsertObsidianArtifact(pool, {
      sourcePath: "Note/B.md",
      title: "B",
      body: "x",
      kind: "note",
      contentHash: "h",
    });
    const deleted = await softDeleteMissingObsidianArtifacts(pool, []);
    expect(deleted.sort()).toEqual(["Note/A.md", "Note/B.md"]);
  });

  it("completeObsidianSyncRun persists deleted_paths and getLatest reads it back", async () => {
    const id = await insertObsidianSyncRun(pool);
    await completeObsidianSyncRun(
      pool,
      id,
      "success",
      0,
      2,
      0,
      [],
      ["Note/Lost.md", "Review/Also Lost.md"]
    );
    const latest = await getLatestObsidianSyncRun(pool);
    expect(latest?.id).toBe(id);
    expect(latest?.deleted_paths).toEqual([
      "Note/Lost.md",
      "Review/Also Lost.md",
    ]);
  });

  it("defaults deleted_paths to [] when not provided", async () => {
    const id = await insertObsidianSyncRun(pool);
    await completeObsidianSyncRun(pool, id, "success", 0, 0, 0, []);
    const latest = await getLatestObsidianSyncRun(pool);
    expect(latest?.deleted_paths).toEqual([]);
  });
});
