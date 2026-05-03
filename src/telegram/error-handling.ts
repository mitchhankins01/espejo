import Anthropic from "@anthropic-ai/sdk";

export type ErrorKind =
  | "anthropic_credits_low"
  | "anthropic_rate_limit"
  | "anthropic_auth"
  | "anthropic_bad_request"
  | "anthropic_server"
  | "anthropic_other"
  | "generic";

export interface CategorizedError {
  kind: ErrorKind;
  userMessage: string;
}

// Marker prefix on assistant messages persisted after a failed agent run.
// The system prompt instructs the agent to ignore these (treat the prior
// user turn as already-responded-to-with-an-error, not as outstanding TODO).
// Keep in sync with src/telegram/agent/context.ts.
export const ERROR_MARKER_PREFIX = "[error]";

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function extractAnthropicMessage(err: InstanceType<typeof Anthropic.APIError>): string {
  const body = err.error as { error?: { message?: unknown }; message?: unknown } | undefined;
  return (
    asString(body?.error?.message) ??
    asString(body?.message) ??
    err.message ??
    "Anthropic API error"
  );
}

export function categorizeError(err: unknown): CategorizedError {
  if (err instanceof Anthropic.APIError) {
    const detail = extractAnthropicMessage(err);
    const lc = detail.toLowerCase();

    if (lc.includes("credit balance is too low") || lc.includes("billing")) {
      return {
        kind: "anthropic_credits_low",
        userMessage: "API credits low — top up at console.anthropic.com, then resend.",
      };
    }

    if (err instanceof Anthropic.RateLimitError) {
      return {
        kind: "anthropic_rate_limit",
        userMessage: "Rate limited — wait a moment and resend.",
      };
    }

    if (
      err instanceof Anthropic.AuthenticationError ||
      err instanceof Anthropic.PermissionDeniedError
    ) {
      return {
        kind: "anthropic_auth",
        userMessage: "API auth issue — check ANTHROPIC_API_KEY in Railway env.",
      };
    }

    if (err.status && err.status >= 500) {
      return {
        kind: "anthropic_server",
        userMessage: "Anthropic API is having issues — resend in a minute.",
      };
    }

    if (err.status === 400) {
      return {
        kind: "anthropic_bad_request",
        userMessage: `API rejected the request: ${detail}`,
      };
    }

    return {
      kind: "anthropic_other",
      userMessage: `API error (${err.status ?? "?"}): ${detail}`,
    };
  }

  const message = err instanceof Error ? err.message : String(err);
  return {
    kind: "generic",
    userMessage: `Error: ${message}`,
  };
}

/**
 * Build the assistant message stored to chat_messages after a failed run.
 * The prefix is matched by the agent system prompt to suppress retroactive
 * processing of the failed user turn.
 */
export function buildErrorMarkerMessage(categorized: CategorizedError): string {
  return `${ERROR_MARKER_PREFIX} ${categorized.userMessage}`;
}
