import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { upsertWeight } from "../db/queries/weights.js";

export async function handleLogWeights(
  pool: pg.Pool,
  input: unknown
): Promise<string> {
  const { measurements } = validateToolInput("log_weights", input);

  for (const { date, weight_kg } of measurements) {
    await upsertWeight(pool, date, weight_kg);
  }

  const weightCount = measurements.length;
  const dayCount = new Set(measurements.map((m) => m.date)).size;
  const weightWord = weightCount === 1 ? "weight" : "weights";
  const dayWord = dayCount === 1 ? "day" : "days";
  return `Logged ${weightCount} ${weightWord} on ${dayCount} ${dayWord}`;
}
