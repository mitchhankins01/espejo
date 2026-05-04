import { describe, it, expect, vi, beforeEach } from "vitest";

const mockR2 = vi.hoisted(() => ({
  createClient: vi.fn().mockReturnValue({}),
  putObjectContent: vi.fn().mockResolvedValue(undefined),
  getObjectContent: vi.fn(),
}));

const mockDates = vi.hoisted(() => ({
  todayInTimezone: vi.fn(),
  daysAgoInTimezone: vi.fn().mockReturnValue("2026-05-01"),
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

// Mock helper: return `today` for the today key, `yesterday` for the yesterday
// key, NoSuchKey for anything else. Tests that don't care about the cross-day
// guard pass `yesterday: null` so it 404s.
function mockKeys(opts: { today?: string | null; yesterday?: string | null }) {
  mockR2.getObjectContent.mockImplementation(async (_client, _bucket, key) => {
    if (key === "Checkpoint/2026-05-02.md") {
      if (opts.today == null) throw nf();
      return opts.today;
    }
    if (key === "Checkpoint/2026-05-01.md") {
      if (opts.yesterday == null) throw nf();
      return opts.yesterday;
    }
    throw nf();
  });
}

beforeEach(() => {
  mockR2.putObjectContent.mockReset().mockResolvedValue(undefined);
  mockR2.getObjectContent.mockReset();
  mockR2.createClient.mockReset().mockReturnValue({});
  mockDates.todayDateInTimezone.mockReturnValue("2026-05-02");
  mockDates.daysAgoInTimezone.mockReturnValue("2026-05-01");
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
    mockKeys({ today: existing });

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
    mockKeys({ today: existing });

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

  describe("duplicate suppression", () => {
    function buildExistingFile(bulletTime: string): string {
      return `---
kind: note
tags:
  - checkpoint
  - parts-work
  - substance-use
---
- ${bulletTime} Nicotine. pulse behind the breastbone. keep the directed focus escalera going. go
`;
    }

    function freezeWallClock(hhmm: string): () => void {
      const [h, m] = hhmm.split(":").map(Number);
      const fixed = new Date(Date.UTC(2026, 4, 2, h, m, 0));
      const RealDate = Date;
      const stub = function (...args: ConstructorParameters<typeof Date>) {
        return args.length === 0 ? new RealDate(fixed) : new RealDate(...args);
      } as unknown as DateConstructor;
      stub.now = () => fixed.getTime();
      stub.UTC = RealDate.UTC;
      stub.parse = RealDate.parse;
      Object.setPrototypeOf(stub, RealDate);
      Object.setPrototypeOf(stub.prototype, RealDate.prototype);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).Date = stub;
      return () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).Date = RealDate;
      };
    }

    it("rejects identical entry within 10-minute window without writing", async () => {
      // Existing bullet at 23:47, agent re-calls at 23:50 with same content.
      mockKeys({ today: buildExistingFile("23:47") });
      // Madrid timezone is UTC+2 in May; 21:50 UTC == 23:50 Madrid.
      const restore = freezeWallClock("21:50");
      try {
        const result = await handleLogCheckpoint(mockPool, {
          substance: "Nicotine",
          body: "pulse behind the breastbone",
          part_voice: "keep the directed focus escalera going",
          choice: "go",
        });
        expect(result).toMatch(/Already logged at 23:47/);
        expect(mockR2.putObjectContent).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });

    it("ignores case + whitespace + punctuation when checking duplicates", async () => {
      // The 00:07 re-hallucination case from 2026-05-03: "a pulse" vs "pulse",
      // "Nicotine" vs "Nicotine.", "Eager Excitement" vs "eager excitement".
      mockKeys({ today: buildExistingFile("23:47") });
      const restore = freezeWallClock("21:55");
      try {
        const result = await handleLogCheckpoint(mockPool, {
          substance: "Nicotine.",
          body: "  PULSE   behind the   breastbone ",
          part_voice: "Keep the Directed Focus Escalera Going",
          choice: "go",
        });
        expect(result).toMatch(/Already logged/);
        expect(mockR2.putObjectContent).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });

    it("allows re-log of the same toll after the duplicate window expires", async () => {
      mockKeys({ today: buildExistingFile("14:00") });
      // 14:15 Madrid = 12:15 UTC — 15 minutes later, outside 10-min window.
      const restore = freezeWallClock("12:15");
      try {
        const result = await handleLogCheckpoint(mockPool, {
          substance: "Nicotine",
          body: "pulse behind the breastbone",
          part_voice: "keep the directed focus escalera going",
          choice: "go",
        });
        expect(result).toMatch(/Toll logged/);
        expect(mockR2.putObjectContent).toHaveBeenCalledTimes(1);
      } finally {
        restore();
      }
    });

    it("allows different content within the duplicate window", async () => {
      mockKeys({ today: buildExistingFile("23:47") });
      const restore = freezeWallClock("21:50");
      try {
        const result = await handleLogCheckpoint(mockPool, {
          substance: "Weed",
          body: "tightness in the jaw",
          part_voice: "wants release",
          choice: "go",
        });
        expect(result).toMatch(/Toll logged/);
        expect(mockR2.putObjectContent).toHaveBeenCalledTimes(1);
      } finally {
        restore();
      }
    });

    it("does not check duplicates when file does not yet exist", async () => {
      mockR2.getObjectContent.mockRejectedValue(nf());
      const restore = freezeWallClock("21:50");
      try {
        const result = await handleLogCheckpoint(mockPool, {
          substance: "Nicotine",
          body: "pulse",
          part_voice: "go",
          choice: "go",
        });
        expect(result).toMatch(/Toll logged/);
        expect(mockR2.putObjectContent).toHaveBeenCalledTimes(1);
      } finally {
        restore();
      }
    });

    it("rejects fabrication: input matches yesterday's last bullet (2026-05-04 incident)", async () => {
      // Real-world failure mode: agent copy-pastes the most recent toll from
      // visible scrollback (the previous day's last bullet) when it has no
      // fresh user content. Today's file is empty.
      const yesterday = `---
kind: note
tags:
  - checkpoint
  - parts-work
  - substance-use
---
- 18:33 Weed. stomach, growling up toward the sternum. to flow. go
- 18:49 Ketamine. flourishing in the upper chest, almost on the surface. to be elevated at the churros party. pass
`;
      mockKeys({ today: null, yesterday });
      const restore = freezeWallClock("07:36");
      try {
        const result = await handleLogCheckpoint(mockPool, {
          substance: "Ketamine",
          body: "a flourishing in the upper chest, almost on the surface",
          part_voice: "to be elevated at the churros party",
          choice: "pass",
        });
        expect(result).toMatch(/Rejected: identical to 2026-05-01 18:49/);
        expect(mockR2.putObjectContent).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });

    it("rejects fabrication matching any (not just last) yesterday bullet", async () => {
      const yesterday = `---
kind: note
tags:
  - checkpoint
  - parts-work
  - substance-use
---
- 11:38 Nicotine. warmth behind the breastbone. find patterns, become and see more. pass
- 13:13 Weed. base of the throat. to lose the constriction. pass
- 18:49 Ketamine. flourishing. churros. pass
`;
      mockKeys({ today: null, yesterday });
      const restore = freezeWallClock("09:00");
      try {
        const result = await handleLogCheckpoint(mockPool, {
          substance: "Nicotine",
          body: "warmth behind the breastbone",
          part_voice: "find patterns, become and see more",
          choice: "pass",
        });
        expect(result).toMatch(/Rejected: identical to 2026-05-01 11:38/);
      } finally {
        restore();
      }
    });

    it("allows a fresh bullet when yesterday exists but content differs", async () => {
      const yesterday = `---
kind: note
tags:
  - checkpoint
  - parts-work
  - substance-use
---
- 18:49 Ketamine. flourishing. churros. pass
`;
      mockKeys({ today: null, yesterday });
      const restore = freezeWallClock("07:36");
      try {
        const result = await handleLogCheckpoint(mockPool, {
          substance: "Nicotine",
          body: "behind the breastbone, a desire to be up",
          part_voice: "to express",
          choice: "pass",
        });
        expect(result).toMatch(/Toll logged/);
        expect(mockR2.putObjectContent).toHaveBeenCalledTimes(1);
      } finally {
        restore();
      }
    });

    it("ignores legacy backfilled bullets without HH:MM prefix", async () => {
      const existing = `---
kind: note
tags:
  - checkpoint
  - parts-work
  - substance-use
  - backfilled
---
- Weed. some old toll without timestamp. wants something. go
- 23:47 Nicotine. pulse behind the breastbone. keep the directed focus escalera going. go
`;
      mockKeys({ today: existing });
      const restore = freezeWallClock("21:50");
      try {
        const result = await handleLogCheckpoint(mockPool, {
          substance: "Nicotine",
          body: "pulse behind the breastbone",
          part_voice: "keep the directed focus escalera going",
          choice: "go",
        });
        expect(result).toMatch(/Already logged at 23:47/);
      } finally {
        restore();
      }
    });
  });
});
