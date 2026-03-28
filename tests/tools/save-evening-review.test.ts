import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ArtifactRow } from "../../src/db/queries.js";

const mockQueries = vi.hoisted(() => ({
  createArtifact: vi.fn(),
  findArtifactByKindAndTitle: vi.fn(),
  updateArtifact: vi.fn(),
  resolveArtifactTitleToId: vi.fn(),
  syncExplicitLinks: vi.fn(),
}));

const mockEmbeddings = vi.hoisted(() => ({
  generateEmbedding: vi.fn(),
}));

const mockDates = vi.hoisted(() => ({
  todayInTimezone: vi.fn().mockReturnValue("2026-03-28"),
  daysAgoInTimezone: vi.fn(),
  currentHourInTimezone: vi.fn(),
  todayDateInTimezone: vi.fn(),
  currentTimeLabel: vi.fn(),
}));

vi.mock("../../src/db/queries.js", () => mockQueries);
vi.mock("../../src/db/embeddings.js", () => mockEmbeddings);
vi.mock("../../src/utils/dates.js", () => mockDates);

import { handleSaveEveningReview } from "../../src/tools/save-evening-review.js";

const mockPool = {
  query: vi.fn(),
} as any;

function makeArtifact(overrides: Partial<ArtifactRow> = {}): ArtifactRow {
  return {
    id: "review-001",
    kind: "review",
    title: "2026-03-28 — Evening Checkin",
    body: "Test review body",
    tags: [],
    has_embedding: false,
    status: "pending",
    source: "mcp",
    source_path: null,
    deleted_at: null,
    created_at: new Date("2026-03-28T22:00:00Z"),
    updated_at: new Date("2026-03-28T22:00:00Z"),
    version: 1,
    source_entry_uuids: [],
    ...overrides,
  };
}

beforeEach(() => {
  Object.values(mockQueries).forEach((fn) => fn.mockReset());
  Object.values(mockEmbeddings).forEach((fn) => fn.mockReset());
  mockPool.query.mockReset();
  mockEmbeddings.generateEmbedding.mockResolvedValue([0.1, 0.2]);
  mockQueries.syncExplicitLinks.mockResolvedValue(undefined);
  mockQueries.resolveArtifactTitleToId.mockResolvedValue(null);
});

describe("handleSaveEveningReview", () => {
  it("creates a new review artifact with correct defaults", async () => {
    mockQueries.findArtifactByKindAndTitle.mockResolvedValue(null);
    mockQueries.createArtifact.mockResolvedValue(makeArtifact());

    const result = await handleSaveEveningReview(mockPool, {
      text: "**Nervous system**\nTired but grounded.",
    });

    expect(mockQueries.createArtifact).toHaveBeenCalledWith(mockPool, {
      kind: "review",
      title: "2026-03-28 — Evening Checkin",
      body: "**Nervous system**\nTired but grounded.",
      source: "mcp",
      status: "pending",
    });
    expect(result).toContain("review-001");
    expect(result).toContain("Evening review saved");
  });

  it("uses provided date for title instead of today", async () => {
    mockQueries.findArtifactByKindAndTitle.mockResolvedValue(null);
    mockQueries.createArtifact.mockResolvedValue(
      makeArtifact({ title: "2026-03-27 — Evening Checkin" })
    );

    await handleSaveEveningReview(mockPool, {
      text: "Review text",
      date: "2026-03-27",
    });

    expect(mockQueries.findArtifactByKindAndTitle).toHaveBeenCalledWith(
      mockPool,
      "review",
      "2026-03-27 — Evening Checkin"
    );
    expect(mockQueries.createArtifact).toHaveBeenCalledWith(
      mockPool,
      expect.objectContaining({ title: "2026-03-27 — Evening Checkin" })
    );
  });

  it("updates existing review instead of creating duplicate", async () => {
    const existing = makeArtifact();
    mockQueries.findArtifactByKindAndTitle.mockResolvedValue(existing);
    mockQueries.updateArtifact.mockResolvedValue(
      makeArtifact({ body: "Updated review" })
    );

    const result = await handleSaveEveningReview(mockPool, {
      text: "Updated review",
    });

    expect(mockQueries.updateArtifact).toHaveBeenCalledWith(
      mockPool,
      "review-001",
      1,
      { body: "Updated review" }
    );
    expect(mockQueries.createArtifact).not.toHaveBeenCalled();
    expect(result).toContain("Updated existing review");
  });

  it("returns error on version conflict during update", async () => {
    mockQueries.findArtifactByKindAndTitle.mockResolvedValue(makeArtifact());
    mockQueries.updateArtifact.mockResolvedValue("version_conflict");

    const result = await handleSaveEveningReview(mockPool, {
      text: "Review text",
    });

    expect(result).toContain("Version conflict");
  });

  it("fires embedding generation after create", async () => {
    mockQueries.findArtifactByKindAndTitle.mockResolvedValue(null);
    mockQueries.createArtifact.mockResolvedValue(makeArtifact());

    await handleSaveEveningReview(mockPool, { text: "Review text" });

    // Wait for fire-and-forget promises
    await vi.waitFor(() => {
      expect(mockEmbeddings.generateEmbedding).toHaveBeenCalled();
    });
  });

  it("rejects empty text", async () => {
    await expect(
      handleSaveEveningReview(mockPool, { text: "" })
    ).rejects.toThrow();
  });

  it("rejects invalid date format", async () => {
    await expect(
      handleSaveEveningReview(mockPool, {
        text: "Review",
        date: "March 28",
      })
    ).rejects.toThrow();
  });

  it("syncs wiki links when review contains them", async () => {
    mockQueries.findArtifactByKindAndTitle.mockResolvedValue(null);
    mockQueries.createArtifact.mockResolvedValue(makeArtifact());
    mockQueries.resolveArtifactTitleToId.mockResolvedValue("target-001");

    await handleSaveEveningReview(mockPool, {
      text: "Referenced [[My Artifact]] in review",
    });

    // Wait for fire-and-forget wiki link sync
    await vi.waitFor(() => {
      expect(mockQueries.resolveArtifactTitleToId).toHaveBeenCalledWith(
        mockPool,
        "My Artifact"
      );
    });
    await vi.waitFor(() => {
      expect(mockQueries.syncExplicitLinks).toHaveBeenCalledWith(
        mockPool,
        "review-001",
        ["target-001"]
      );
    });
  });

  it("syncs empty links when no wiki links present", async () => {
    mockQueries.findArtifactByKindAndTitle.mockResolvedValue(null);
    mockQueries.createArtifact.mockResolvedValue(makeArtifact());

    await handleSaveEveningReview(mockPool, {
      text: "No links here",
    });

    await vi.waitFor(() => {
      expect(mockQueries.syncExplicitLinks).toHaveBeenCalledWith(
        mockPool,
        "review-001",
        []
      );
    });
  });

  it("does not fail when embedding generation errors", async () => {
    mockQueries.findArtifactByKindAndTitle.mockResolvedValue(null);
    mockQueries.createArtifact.mockResolvedValue(makeArtifact());
    mockEmbeddings.generateEmbedding.mockRejectedValue(
      new Error("OpenAI down")
    );

    const result = await handleSaveEveningReview(mockPool, {
      text: "Review text",
    });

    // Should still succeed
    expect(result).toContain("Evening review saved");
  });

  it("fires embedding and wiki links after update too", async () => {
    const existing = makeArtifact();
    mockQueries.findArtifactByKindAndTitle.mockResolvedValue(existing);
    mockQueries.updateArtifact.mockResolvedValue(
      makeArtifact({ body: "Updated" })
    );
    mockQueries.resolveArtifactTitleToId.mockResolvedValue("target-002");

    await handleSaveEveningReview(mockPool, {
      text: "Updated with [[Link]]",
    });

    await vi.waitFor(() => {
      expect(mockEmbeddings.generateEmbedding).toHaveBeenCalled();
    });
    await vi.waitFor(() => {
      expect(mockQueries.resolveArtifactTitleToId).toHaveBeenCalledWith(
        mockPool,
        "Link"
      );
    });
  });
});
