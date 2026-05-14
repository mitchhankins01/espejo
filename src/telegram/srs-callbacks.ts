// Pure parser for /srs callback payloads. Unit-testable without a Pool.
//
// Forms:
//   srs:show:<id>          → reveal gloss + rating buttons for review id
//   srs:rate:<id>:<1|2|3|4> → apply rating to review id

import type { Grade } from "../fsrs/scheduler.js";

export type SrsCallback =
  | { kind: "show"; reviewId: string }
  | { kind: "rate"; reviewId: string; rating: Grade };

function isGrade(value: number): value is Grade {
  return value === 1 || value === 2 || value === 3 || value === 4;
}

function isDigitString(value: string): boolean {
  return value.length > 0 && /^\d+$/.test(value);
}

export function parseSrsCallback(data: string): SrsCallback | null {
  if (!data.startsWith("srs:")) return null;
  const parts = data.split(":");
  if (parts.length < 3) return null;
  const kind = parts[1];
  const reviewId = parts[2];
  if (!isDigitString(reviewId)) return null;

  if (kind === "show") {
    if (parts.length !== 3) return null;
    return { kind: "show", reviewId };
  }
  if (kind === "rate") {
    if (parts.length !== 4) return null;
    const rating = Number(parts[3]);
    if (!Number.isInteger(rating) || !isGrade(rating)) return null;
    return { kind: "rate", reviewId, rating };
  }
  return null;
}

export function buildShowPayload(reviewId: string): string {
  return `srs:show:${reviewId}`;
}

export function buildRatePayload(reviewId: string, rating: Grade): string {
  return `srs:rate:${reviewId}:${rating}`;
}
