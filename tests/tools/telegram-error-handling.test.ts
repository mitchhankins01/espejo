import { describe, it, expect } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import {
  categorizeError,
  buildErrorMarkerMessage,
  ERROR_MARKER_PREFIX,
} from "../../src/telegram/error-handling.js";

function makeBadRequest(message: string): Anthropic.BadRequestError {
  return new Anthropic.BadRequestError(
    400,
    {
      type: "error",
      error: { type: "invalid_request_error", message },
    },
    "bad request",
    new Headers()
  );
}

describe("categorizeError", () => {
  it("recognizes Anthropic 400 credit-low as anthropic_credits_low", () => {
    const err = makeBadRequest(
      "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."
    );
    const result = categorizeError(err);
    expect(result.kind).toBe("anthropic_credits_low");
    expect(result.userMessage).toContain("credits low");
    expect(result.userMessage).not.toContain("{");
    expect(result.userMessage).not.toContain("invalid_request_error");
  });

  it("recognizes Anthropic 429 as anthropic_rate_limit", () => {
    const err = new Anthropic.RateLimitError(
      429,
      { type: "error", error: { type: "rate_limit_error", message: "rate limited" } },
      "rate limited",
      new Headers()
    );
    const result = categorizeError(err);
    expect(result.kind).toBe("anthropic_rate_limit");
    expect(result.userMessage).toContain("Rate limited");
  });

  it("recognizes Anthropic 401 as anthropic_auth", () => {
    const err = new Anthropic.AuthenticationError(
      401,
      { type: "error", error: { type: "authentication_error", message: "bad key" } },
      "bad key",
      new Headers()
    );
    const result = categorizeError(err);
    expect(result.kind).toBe("anthropic_auth");
    expect(result.userMessage).toContain("ANTHROPIC_API_KEY");
  });

  it("recognizes Anthropic 5xx as anthropic_server", () => {
    const err = new Anthropic.InternalServerError(
      503,
      { type: "error", error: { type: "overloaded_error", message: "overloaded" } },
      "overloaded",
      new Headers()
    );
    const result = categorizeError(err);
    expect(result.kind).toBe("anthropic_server");
  });

  it("falls back to generic for non-Anthropic errors", () => {
    const result = categorizeError(new Error("network unreachable"));
    expect(result.kind).toBe("generic");
    expect(result.userMessage).toBe("Error: network unreachable");
  });

  it("handles non-Error thrown values", () => {
    const result = categorizeError("string thrown");
    expect(result.kind).toBe("generic");
    expect(result.userMessage).toBe("Error: string thrown");
  });

  it("recognizes 'billing' substring in 400 messages too", () => {
    const err = makeBadRequest("billing issue: please update your payment method");
    expect(categorizeError(err).kind).toBe("anthropic_credits_low");
  });

  it("non-credit 400s become anthropic_bad_request, not anthropic_other", () => {
    const err = makeBadRequest("max_tokens must be greater than 0");
    const result = categorizeError(err);
    expect(result.kind).toBe("anthropic_bad_request");
    expect(result.userMessage).toContain("max_tokens");
  });
});

describe("buildErrorMarkerMessage", () => {
  it("prefixes the user message with the [error] marker", () => {
    const out = buildErrorMarkerMessage({
      kind: "anthropic_credits_low",
      userMessage: "API credits low — top up at console.anthropic.com, then resend.",
    });
    expect(out.startsWith(ERROR_MARKER_PREFIX)).toBe(true);
    expect(out).toContain("API credits low");
  });
});
