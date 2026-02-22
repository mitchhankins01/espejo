const RECOVERABLE_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);

const RECOVERABLE_NAMES = new Set(["AbortError", "TimeoutError"]);

const RECOVERABLE_MESSAGES = [
  "fetch failed",
  "socket hang up",
  "network error",
  "network request failed",
];

/**
 * Classify whether a network error is recoverable (worth retrying).
 * Traverses the error cause chain to find known transient error patterns.
 */
export function isRecoverableNetworkError(err: unknown): boolean {
  const visited = new Set<unknown>();
  let current: unknown = err;

  while (current && !visited.has(current)) {
    visited.add(current);

    if (current instanceof Error) {
      if (RECOVERABLE_NAMES.has(current.name)) return true;

      const code = (current as NodeJS.ErrnoException).code;
      if (code && RECOVERABLE_CODES.has(code)) return true;

      const msg = current.message.toLowerCase();
      if (RECOVERABLE_MESSAGES.some((m) => msg.includes(m))) return true;

      // Traverse cause chain
      const cause = (current as Error & { cause?: unknown }).cause;
      if (cause) {
        current = cause;
        continue;
      }

      // Check AggregateError .errors
      if ("errors" in current && Array.isArray((current as { errors: unknown[] }).errors)) {
        for (const inner of (current as { errors: unknown[] }).errors) {
          if (isRecoverableNetworkError(inner)) return true;
        }
      }
    }

    break;
  }

  return false;
}
