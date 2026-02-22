import type { SoulQualityStats } from "../db/queries.js";
import type { SoulStateSnapshot } from "./soul.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PulseStatus = "healthy" | "drifting" | "stale" | "overcorrecting";

export interface PulseDiagnosis {
  status: PulseStatus;
  personalRatio: number;
  correctionRate: number;
  recommendation: string;
  repairs: SoulRepairAction[];
}

export type SoulRepairAction =
  | { type: "add_commitment"; value: string }
  | { type: "add_tone"; value: string }
  | { type: "add_growth_note"; value: string };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEALTHY_THRESHOLD = 0.6;
const DRIFTING_THRESHOLD = 0.4;
const OVERCORRECTING_THRESHOLD = 0.5;
const MIN_SIGNALS_FOR_DIAGNOSIS = 5;
const MAX_REPAIRS_PER_PULSE = 2;

// ---------------------------------------------------------------------------
// Diagnosis — pure function
// ---------------------------------------------------------------------------

export function diagnoseQuality(stats: SoulQualityStats): PulseDiagnosis {
  const { total, personal_ratio, correction } = stats;

  // Not enough data yet
  if (total < MIN_SIGNALS_FOR_DIAGNOSIS) {
    return {
      status: "stale",
      personalRatio: personal_ratio,
      correctionRate: 0,
      recommendation:
        "Not enough feedback signals yet. Keep chatting — pulse check needs at least 5 signals.",
      repairs: [],
    };
  }

  const correctionRate = correction / total;

  // Overcorrecting: soul is changing too frequently
  if (correctionRate > OVERCORRECTING_THRESHOLD) {
    return {
      status: "overcorrecting",
      personalRatio: personal_ratio,
      correctionRate,
      recommendation:
        "Soul state is evolving too frequently. Stabilizing — fewer automatic changes until correction rate drops.",
      repairs: [
        {
          type: "add_growth_note",
          value: `pulse: correction rate ${Math.round(correctionRate * 100)}% — stabilizing evolution`,
        },
      ],
    };
  }

  // Drifting: responses feel generic to the user
  if (personal_ratio < DRIFTING_THRESHOLD) {
    const repairs: SoulRepairAction[] = [
      {
        type: "add_growth_note",
        value: `pulse: personal ratio dropped to ${Math.round(personal_ratio * 100)}% — focusing on specifics`,
      },
    ];

    return {
      status: "drifting",
      personalRatio: personal_ratio,
      correctionRate,
      recommendation:
        "Responses are feeling generic. Adding specificity commitment and tightening retrieval.",
      repairs: repairs.slice(0, MAX_REPAIRS_PER_PULSE),
    };
  }

  // Healthy
  return {
    status: "healthy",
    personalRatio: personal_ratio,
    correctionRate,
    recommendation:
      personal_ratio >= HEALTHY_THRESHOLD
        ? "Quality signals look good. No adjustments needed."
        : "Quality is acceptable but could improve. Monitoring.",
    repairs: [],
  };
}

// ---------------------------------------------------------------------------
// Repair — pure function
// ---------------------------------------------------------------------------

const SPECIFICITY_COMMITMENT = "favor specifics over generic phrasing";

export function applySoulRepairs(
  current: SoulStateSnapshot,
  repairs: SoulRepairAction[]
): SoulStateSnapshot | null {
  if (repairs.length === 0) return null;

  const commitments = [...current.relationalCommitments];
  const toneSignature = [...current.toneSignature];
  let growthNotes = [...current.growthNotes];
  let changed = false;

  for (const repair of repairs) {
    switch (repair.type) {
      case "add_commitment": {
        const normalized = repair.value.trim().toLowerCase();
        const exists = commitments.some(
          (c) => c.trim().toLowerCase() === normalized
        );
        if (!exists && commitments.length < 6) {
          commitments.push(repair.value);
          changed = true;
        }
        break;
      }
      case "add_tone": {
        const normalized = repair.value.trim().toLowerCase();
        const exists = toneSignature.some(
          (t) => t.trim().toLowerCase() === normalized
        );
        if (!exists && toneSignature.length < 6) {
          toneSignature.push(repair.value);
          changed = true;
        }
        break;
      }
      case "add_growth_note": {
        // Prevent duplicate pulse notes
        const normalized = repair.value.trim().toLowerCase();
        const exists = growthNotes.some(
          (n) => n.trim().toLowerCase() === normalized
        );
        if (!exists) {
          growthNotes.push(repair.value);
          // Keep only the most recent 8 notes
          if (growthNotes.length > 8) {
            growthNotes = growthNotes.slice(-8);
          }
          changed = true;
        }
        break;
      }
    }
  }

  if (!changed) return null;

  // For drifting diagnosis, also ensure specificity commitment exists
  const hasDriftingNote = growthNotes.some((n) =>
    n.toLowerCase().includes("pulse: personal ratio")
  );
  if (hasDriftingNote) {
    const hasSpecificity = commitments.some((c) =>
      c.toLowerCase().includes("specifics")
    );
    if (!hasSpecificity && commitments.length < 6) {
      commitments.push(SPECIFICITY_COMMITMENT);
    }
  }

  return {
    identitySummary: current.identitySummary,
    relationalCommitments: commitments,
    toneSignature: toneSignature,
    growthNotes,
    version: current.version + 1,
  };
}

// ---------------------------------------------------------------------------
// Soul-aware compaction prompt section
// ---------------------------------------------------------------------------

export function buildSoulCompactionContext(
  soul: SoulStateSnapshot | null
): string {
  if (!soul) return "";
  const commitments = soul.relationalCommitments.filter(
    (c) => c.trim().length > 0
  );
  if (commitments.length === 0) return "";

  const lines = [
    "\nThe user's relational commitments with this assistant:",
    ...commitments.map((c) => `- ${c}`),
    "",
    "Use these to guide pattern extraction. Prioritize explicit facts and events over vague behavioral inferences.",
  ];

  return lines.join("\n");
}
