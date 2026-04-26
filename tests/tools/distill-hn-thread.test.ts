import { describe, it, expect, vi, beforeEach } from "vitest";

const runHnDistillWorkflow = vi.hoisted(() => vi.fn());

vi.mock("../../src/hn/workflow.js", () => ({ runHnDistillWorkflow }));

import { handleDistillHnThread } from "../../src/tools/distill-hn-thread.js";

const mockPool = {} as unknown as import("pg").Pool;

beforeEach(() => {
  runHnDistillWorkflow.mockReset().mockResolvedValue(undefined);
});

describe("handleDistillHnThread", () => {
  it("kicks off the workflow and returns an immediate confirmation", async () => {
    const result = await handleDistillHnThread(mockPool, {
      url: "https://news.ycombinator.com/item?id=47892019",
    });
    expect(runHnDistillWorkflow).toHaveBeenCalledWith({
      itemId: 47892019,
      hnUrl: "https://news.ycombinator.com/item?id=47892019",
    });
    expect(result).toContain("Starting distillation of HN #47892019");
    expect(result).toContain("email");
  });

  it("accepts a bare numeric id", async () => {
    await handleDistillHnThread(mockPool, { url: "42" });
    expect(runHnDistillWorkflow).toHaveBeenCalledWith({
      itemId: 42,
      hnUrl: "https://news.ycombinator.com/item?id=42",
    });
  });

  it("does not await the workflow promise (returns even when workflow is pending)", async () => {
    let resolveWorkflow: (() => void) | undefined;
    runHnDistillWorkflow.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveWorkflow = resolve; })
    );
    const result = await handleDistillHnThread(mockPool, { url: "1" });
    expect(result).toContain("Starting distillation");
    // If the handler awaited, this Promise.race would never see "fast" first.
    const race = await Promise.race([
      Promise.resolve("fast"),
      new Promise((r) => setTimeout(() => r("slow"), 100)),
    ]);
    expect(race).toBe("fast");
    resolveWorkflow?.();
  });

  it("rejects an invalid URL with an actionable error", async () => {
    await expect(
      handleDistillHnThread(mockPool, { url: "https://example.com/x" })
    ).rejects.toThrow(/Not a Hacker News URL/);
    expect(runHnDistillWorkflow).not.toHaveBeenCalled();
  });

  it("dedupes a re-fire of the same itemId within the TTL window", async () => {
    const url = "https://news.ycombinator.com/item?id=99999001";

    const first = await handleDistillHnThread(mockPool, { url });
    expect(first).toContain("Starting distillation");
    expect(runHnDistillWorkflow).toHaveBeenCalledTimes(1);

    const second = await handleDistillHnThread(mockPool, { url });
    expect(second).toContain("already being distilled");
    expect(runHnDistillWorkflow).toHaveBeenCalledTimes(1);
  });
});
