import { describe, it, expect, vi, beforeEach } from "vitest";

const mockR2 = vi.hoisted(() => ({
  createClient: vi.fn().mockReturnValue({}),
  putObjectContent: vi.fn().mockResolvedValue(undefined),
  getObjectContent: vi.fn(),
}));

const mockDates = vi.hoisted(() => ({
  todayInTimezone: vi.fn(),
  daysAgoInTimezone: vi.fn(),
  currentHourInTimezone: vi.fn(),
  todayDateInTimezone: vi.fn().mockReturnValue("2026-05-02"),
  currentTimeLabel: vi.fn(),
}));

vi.mock("../../src/storage/r2.js", () => mockR2);
vi.mock("../../src/utils/dates.js", () => mockDates);

// Lock currentHHMMInTimezone via Intl mocking is overkill; instead we accept
// the real clock and assert pattern shape (HH:MM 24h) on the bullet.
const HHMM_PATTERN = /^[0-2]\d:[0-5]\d$/;

import { handleLogCheckpoint } from "../../src/tools/log-checkpoint.js";

const mockPool = {} as never;

function nf(): Error {
  const err = new Error("not found") as Error & { name: string };
  err.name = "NoSuchKey";
  return err;
}

beforeEach(() => {
  mockR2.putObjectContent.mockReset().mockResolvedValue(undefined);
  mockR2.getObjectContent.mockReset();
  mockR2.createClient.mockReset().mockReturnValue({});
  mockDates.todayDateInTimezone.mockReturnValue("2026-05-02");
});

describe("handleLogCheckpoint", () => {
  it("creates a fresh file with frontmatter on first toll of the day", async () => {
    mockR2.getObjectContent.mockRejectedValue(nf());

    const result = await handleLogCheckpoint(mockPool, {
      substance: "Nic",
      body: "head + flutter in stomach",
      part_voice: "post-Ritalin surf, keep moving",
      choice: "pass",
    });

    expect(mockR2.putObjectContent).toHaveBeenCalledTimes(1);
    const [, bucket, key, content] = mockR2.putObjectContent.mock.calls[0];
    expect(bucket).toBe("artifacts");
    expect(key).toBe("Checkpoint/2026-05-02.md");
    expect(content).toMatch(/^---\nkind: note\ntags:\n  - checkpoint\n  - parts-work\n  - substance-use\n---\n/);
    expect(content).toContain("Nic. head + flutter in stomach. post-Ritalin surf, keep moving. pass");
    expect(result).toContain("Checkpoint/2026-05-02.md");
  });

  it("appends a bullet to an existing day's file without duplicating frontmatter", async () => {
    const existing = `---
kind: note
tags:
  - checkpoint
  - parts-work
  - substance-use
---
- 14:32 Nic. head. surf. pass
`;
    mockR2.getObjectContent.mockResolvedValue(existing);

    await handleLogCheckpoint(mockPool, {
      substance: "Weed",
      body: "chest pressure",
      part_voice: "wants to mellow",
      choice: "go",
    });

    const content = mockR2.putObjectContent.mock.calls[0][3] as string;
    const fmCount = (content.match(/^---$/gm) ?? []).length;
    expect(fmCount).toBe(2); // exactly one frontmatter (open + close)
    expect(content).toContain("- 14:32 Nic. head. surf. pass");
    expect(content).toMatch(/Weed\. chest pressure\. wants to mellow\. go\n$/);
    // Bullets are adjacent — no blank line separator between them
    const bulletLines = content.split("\n").filter((l) => l.startsWith("- "));
    expect(bulletLines).toHaveLength(2);
  });

  it("renders 'unset' choice as '(no answer)'", async () => {
    mockR2.getObjectContent.mockRejectedValue(nf());

    await handleLogCheckpoint(mockPool, {
      substance: "Weed",
      body: "buzzing belly",
      part_voice: "wants to flow",
      // omit choice — defaults to 'unset'
    });

    const content = mockR2.putObjectContent.mock.calls[0][3] as string;
    expect(content).toContain("Weed. buzzing belly. wants to flow. (no answer)");
  });

  it("uses HH:MM 24h format with leading zeros", async () => {
    mockR2.getObjectContent.mockRejectedValue(nf());

    await handleLogCheckpoint(mockPool, {
      substance: "Nic",
      body: "head",
      part_voice: "wolf",
      choice: "pass",
    });

    const content = mockR2.putObjectContent.mock.calls[0][3] as string;
    const bulletMatch = content.match(/^- (\S+) /m);
    expect(bulletMatch).not.toBeNull();
    expect(bulletMatch![1]).toMatch(HHMM_PATTERN);
  });

  it("rethrows non-404 R2 errors instead of swallowing them", async () => {
    const fatal = new Error("AccessDenied") as Error & { name: string };
    fatal.name = "AccessDenied";
    mockR2.getObjectContent.mockRejectedValue(fatal);

    await expect(
      handleLogCheckpoint(mockPool, {
        substance: "Nic",
        body: "head",
        part_voice: "wolf",
        choice: "pass",
      })
    ).rejects.toThrow("AccessDenied");
    expect(mockR2.putObjectContent).not.toHaveBeenCalled();
  });

  it("rejects empty substance", async () => {
    await expect(
      handleLogCheckpoint(mockPool, {
        substance: "",
        body: "head",
        part_voice: "wolf",
        choice: "pass",
      })
    ).rejects.toThrow();
  });

  it("rejects invalid choice value", async () => {
    await expect(
      handleLogCheckpoint(mockPool, {
        substance: "Nic",
        body: "head",
        part_voice: "wolf",
        choice: "maybe" as never,
      })
    ).rejects.toThrow();
  });

  it("preserves existing trailing whitespace shape (no blank lines between bullets)", async () => {
    const existing = `---
kind: note
tags:
  - checkpoint
  - parts-work
  - substance-use
---
- 14:32 Nic. head. surf. pass

`; // existing file with trailing blank line
    mockR2.getObjectContent.mockResolvedValue(existing);

    await handleLogCheckpoint(mockPool, {
      substance: "Weed",
      body: "chest",
      part_voice: "mellow",
      choice: "go",
    });

    const content = mockR2.putObjectContent.mock.calls[0][3] as string;
    // No blank line between the existing bullet and the new one
    expect(content).not.toMatch(/pass\n\n- /);
    expect(content).toMatch(/pass\n- /);
  });

  it("strips trailing punctuation from segments to avoid '?.' or '..' duplication", async () => {
    mockR2.getObjectContent.mockRejectedValue(nf());

    await handleLogCheckpoint(mockPool, {
      substance: "Weed",
      body: "pressure behind the eyes",
      part_voice: "wants the friction gone — the bracing?",
      choice: "go",
    });

    const content = mockR2.putObjectContent.mock.calls[0][3] as string;
    expect(content).not.toMatch(/\?\./);
    expect(content).toMatch(/the bracing\. go/);
  });
});
