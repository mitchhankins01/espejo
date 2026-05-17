// Pure parser for /conj callback payloads. Unit-testable without a Pool.
//
// Form:
//   conj:show:<reviewId>   → reveal English gloss in-place on the card

export type ConjCallback = { kind: "show"; reviewId: string };

function isDigitString(value: string): boolean {
  return value.length > 0 && /^\d+$/.test(value);
}

export function parseConjCallback(data: string): ConjCallback | null {
  if (!data.startsWith("conj:")) return null;
  const parts = data.split(":");
  if (parts.length !== 3) return null;
  const kind = parts[1];
  const reviewId = parts[2];
  if (!isDigitString(reviewId)) return null;
  if (kind !== "show") return null;
  return { kind: "show", reviewId };
}

export function buildConjShowPayload(reviewId: string): string {
  return `conj:show:${reviewId}`;
}
