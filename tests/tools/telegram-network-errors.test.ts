import { describe, it, expect } from "vitest";
import { isRecoverableNetworkError } from "../../src/telegram/network-errors.js";

describe("isRecoverableNetworkError", () => {
  it("returns true for ECONNRESET", () => {
    const err = new Error("read ECONNRESET");
    (err as NodeJS.ErrnoException).code = "ECONNRESET";
    expect(isRecoverableNetworkError(err)).toBe(true);
  });

  it("returns true for ETIMEDOUT", () => {
    const err = new Error("connect ETIMEDOUT");
    (err as NodeJS.ErrnoException).code = "ETIMEDOUT";
    expect(isRecoverableNetworkError(err)).toBe(true);
  });

  it("returns true for ECONNREFUSED", () => {
    const err = new Error("connect ECONNREFUSED");
    (err as NodeJS.ErrnoException).code = "ECONNREFUSED";
    expect(isRecoverableNetworkError(err)).toBe(true);
  });

  it("returns true for ENETUNREACH", () => {
    const err = new Error("network unreachable");
    (err as NodeJS.ErrnoException).code = "ENETUNREACH";
    expect(isRecoverableNetworkError(err)).toBe(true);
  });

  it("returns true for EPIPE", () => {
    const err = new Error("write EPIPE");
    (err as NodeJS.ErrnoException).code = "EPIPE";
    expect(isRecoverableNetworkError(err)).toBe(true);
  });

  it("returns true for UND_ERR_CONNECT_TIMEOUT", () => {
    const err = new Error("undici timeout");
    (err as NodeJS.ErrnoException).code = "UND_ERR_CONNECT_TIMEOUT";
    expect(isRecoverableNetworkError(err)).toBe(true);
  });

  it("returns true for UND_ERR_HEADERS_TIMEOUT", () => {
    const err = new Error("undici timeout");
    (err as NodeJS.ErrnoException).code = "UND_ERR_HEADERS_TIMEOUT";
    expect(isRecoverableNetworkError(err)).toBe(true);
  });

  it("returns true for AbortError", () => {
    const err = new DOMException("aborted", "AbortError");
    expect(isRecoverableNetworkError(err)).toBe(true);
  });

  it("returns true for TimeoutError", () => {
    const err = new DOMException("timeout", "TimeoutError");
    expect(isRecoverableNetworkError(err)).toBe(true);
  });

  it("returns true for 'fetch failed' message", () => {
    const err = new TypeError("fetch failed");
    expect(isRecoverableNetworkError(err)).toBe(true);
  });

  it("returns true for 'socket hang up' message", () => {
    const err = new Error("socket hang up");
    expect(isRecoverableNetworkError(err)).toBe(true);
  });

  it("returns true for 'network error' message", () => {
    const err = new Error("Network Error occurred");
    expect(isRecoverableNetworkError(err)).toBe(true);
  });

  it("returns true for 'network request failed' message", () => {
    const err = new Error("Network request failed");
    expect(isRecoverableNetworkError(err)).toBe(true);
  });

  it("traverses .cause chain", () => {
    const inner = new Error("inner");
    (inner as NodeJS.ErrnoException).code = "ECONNRESET";
    const outer = new Error("outer", { cause: inner });
    expect(isRecoverableNetworkError(outer)).toBe(true);
  });

  it("traverses AggregateError .errors", () => {
    const inner = new Error("connect");
    (inner as NodeJS.ErrnoException).code = "ETIMEDOUT";
    const agg = new AggregateError([inner], "multiple");
    expect(isRecoverableNetworkError(agg)).toBe(true);
  });

  it("returns false for AggregateError with only non-recoverable errors", () => {
    const agg = new AggregateError(
      [new Error("syntax error"), new Error("type error")],
      "multiple"
    );
    expect(isRecoverableNetworkError(agg)).toBe(false);
  });

  it("returns false for non-recoverable errors", () => {
    const err = new Error("SyntaxError: unexpected token");
    expect(isRecoverableNetworkError(err)).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isRecoverableNetworkError(null)).toBe(false);
    expect(isRecoverableNetworkError(undefined)).toBe(false);
  });

  it("returns false for non-Error objects", () => {
    expect(isRecoverableNetworkError("string error")).toBe(false);
    expect(isRecoverableNetworkError(42)).toBe(false);
  });

  it("handles circular cause chains", () => {
    const err = new Error("circular") as Error & { cause: unknown };
    err.cause = err;
    expect(isRecoverableNetworkError(err)).toBe(false);
  });
});
