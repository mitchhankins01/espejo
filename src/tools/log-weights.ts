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
  const sorted = [...measurements].sort((a, b) =>
    a.date < b.date ? 1 : a.date > b.date ? -1 : 0
  );
  const pairs = sorted
    .map(({ date, weight_kg }) => `${date} (${weight_kg.toFixed(1)} kg)`)
    .join(", ");
  const weightWord = weightCount === 1 ? "weight" : "weights";
  return `Logged ${weightCount} ${weightWord}: ${pairs}`;
}
