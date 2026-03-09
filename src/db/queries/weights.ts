import type pg from "pg";

export async function upsertDailyMetric(
  pool: pg.Pool,
  date: string,
  weightKg: number
): Promise<void> {
  await upsertWeight(pool, date, weightKg);
}

export interface WeightRow {
  date: Date;
  weight_kg: number;
  created_at: Date;
}

export interface WeightPatternSummary {
  latest: WeightRow | null;
  delta_7d: number | null;
  delta_30d: number | null;
  weekly_pace_kg: number | null;
  consistency: number | null;
  streak_days: number;
  volatility_14d: number | null;
  plateau: boolean;
  range_days: number;
  logged_days: number;
}

function parseWeightRows(rows: Record<string, unknown>[]): WeightRow[] {
  return rows.map((row) => ({
    date: new Date(
      `${(row.date instanceof Date
        ? row.date.toISOString().slice(0, 10)
        : String(row.date).slice(0, 10))}T00:00:00.000Z`
    ),
    weight_kg: parseFloat(row.weight_kg as string),
    created_at:
      row.created_at instanceof Date
        ? row.created_at
        : new Date(String(row.created_at)),
  }));
}

export async function getWeightByDate(
  pool: pg.Pool,
  date: string
): Promise<WeightRow | null> {
  const result = await pool.query(
    `SELECT date, weight_kg, created_at
     FROM daily_metrics
     WHERE date = $1::date
       AND weight_kg IS NOT NULL`,
    [date]
  );
  if (result.rows.length === 0) return null;
  return parseWeightRows(result.rows)[0];
}

export async function upsertWeight(
  pool: pg.Pool,
  date: string,
  weightKg: number
): Promise<WeightRow> {
  const result = await pool.query(
    `INSERT INTO daily_metrics (date, weight_kg)
     VALUES ($1::date, $2)
     ON CONFLICT (date) DO UPDATE SET weight_kg = EXCLUDED.weight_kg
     RETURNING date, weight_kg, created_at`,
    [date, weightKg]
  );
  return parseWeightRows(result.rows)[0];
}

export async function deleteWeight(
  pool: pg.Pool,
  date: string
): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM daily_metrics
     WHERE date = $1::date`,
    [date]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function listWeights(
  pool: pg.Pool,
  options: {
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  } = {}
): Promise<{ rows: WeightRow[]; count: number }> {
  const whereClauses = ["weight_kg IS NOT NULL"];
  const params: unknown[] = [];

  if (options.from) {
    params.push(options.from);
    whereClauses.push(`date >= $${params.length}::date`);
  }
  if (options.to) {
    params.push(options.to);
    whereClauses.push(`date <= $${params.length}::date`);
  }

  const whereSql = whereClauses.join(" AND ");
  const limit = options.limit ?? 100;
  const offset = options.offset ?? 0;

  const listParams = [...params, limit, offset];
  const limitParam = params.length + 1;
  const offsetParam = params.length + 2;

  const [rowsResult, countResult] = await Promise.all([
    pool.query(
      `SELECT date, weight_kg, created_at
       FROM daily_metrics
       WHERE ${whereSql}
       ORDER BY date DESC
       LIMIT $${limitParam}
       OFFSET $${offsetParam}`,
      listParams
    ),
    pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM daily_metrics
       WHERE ${whereSql}`,
      params
    ),
  ]);

  return {
    rows: parseWeightRows(rowsResult.rows),
    count: Number(countResult.rows[0].count),
  };
}

function daysBetween(start: Date, end: Date): number {
  const ms = end.getTime() - start.getTime();
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

function stddev(values: number[]): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function latestAtOrBefore(weights: WeightRow[], targetDate: Date): WeightRow | null {
  for (let i = weights.length - 1; i >= 0; i--) {
    if (weights[i].date.getTime() <= targetDate.getTime()) return weights[i];
  }
  return null;
}

export async function getWeightPatterns(
  pool: pg.Pool,
  options: { from?: string; to?: string } = {}
): Promise<WeightPatternSummary> {
  const { rows } = await listWeights(pool, {
    from: options.from,
    to: options.to,
    limit: 10000,
    offset: 0,
  });
  const weights = [...rows].sort(
    (a, b) => a.date.getTime() - b.date.getTime()
  );

  if (weights.length === 0) {
    return {
      latest: null,
      delta_7d: null,
      delta_30d: null,
      weekly_pace_kg: null,
      consistency: null,
      streak_days: 0,
      volatility_14d: null,
      plateau: false,
      range_days: 0,
      logged_days: 0,
    };
  }

  const latest = weights[weights.length - 1];
  const anchor7 = latestAtOrBefore(
    weights,
    new Date(latest.date.getTime() - 7 * 24 * 60 * 60 * 1000)
  );
  const anchor30 = latestAtOrBefore(
    weights,
    new Date(latest.date.getTime() - 30 * 24 * 60 * 60 * 1000)
  );

  const delta7 = anchor7 ? latest.weight_kg - anchor7.weight_kg : null;
  const delta30 = anchor30 ? latest.weight_kg - anchor30.weight_kg : null;

  let weeklyPace: number | null = null;
  if (anchor30 && delta30 !== null) {
    const days = Math.max(daysBetween(anchor30.date, latest.date), 1);
    weeklyPace = delta30 / (days / 7);
  }

  const fromDate = options.from
    ? new Date(`${options.from}T00:00:00.000Z`)
    : weights[0].date;
  const toDate = options.to
    ? new Date(`${options.to}T00:00:00.000Z`)
    : latest.date;
  const rangeDays = Math.max(daysBetween(fromDate, toDate) + 1, 1);
  const consistency = weights.length / rangeDays;

  let streakDays = 1;
  for (let i = weights.length - 1; i > 0; i--) {
    const prev = weights[i - 1];
    const cur = weights[i];
    if (daysBetween(prev.date, cur.date) === 1) {
      streakDays += 1;
      continue;
    }
    break;
  }

  const last14 = weights.slice(Math.max(0, weights.length - 14));
  const volatility14 =
    last14.length >= 2 ? stddev(last14.map((w) => w.weight_kg)) : null;
  const plateau =
    delta30 !== null &&
    volatility14 !== null &&
    Math.abs(delta30) < 0.2 &&
    volatility14 < 0.25;

  return {
    latest,
    delta_7d: delta7,
    delta_30d: delta30,
    weekly_pace_kg: weeklyPace,
    consistency,
    streak_days: streakDays,
    volatility_14d: volatility14,
    plateau,
    range_days: rangeDays,
    logged_days: weights.length,
  };
}
