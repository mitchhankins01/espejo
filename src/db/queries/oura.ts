import type pg from "pg";

export interface OuraSummaryRow {
  day: Date;
  sleep_score: number | null;
  readiness_score: number | null;
  activity_score: number | null;
  steps: number | null;
  stress: string | null;
  average_hrv: number | null;
  average_heart_rate: number | null;
  sleep_duration_seconds: number | null;
  deep_sleep_duration_seconds: number | null;
  rem_sleep_duration_seconds: number | null;
  efficiency: number | null;
  workout_count: number;
}

export async function insertOuraSyncRun(pool: pg.Pool): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO oura_sync_runs (status) VALUES ('running') RETURNING id`
  );
  return result.rows[0].id;
}

export async function completeOuraSyncRun(
  pool: pg.Pool,
  id: number,
  status: "success" | "partial" | "failed",
  recordsSynced: number,
  error: string | null
): Promise<void> {
  await pool.query(
    `UPDATE oura_sync_runs
     SET finished_at = NOW(), status = $2, records_synced = $3, error = $4
     WHERE id = $1`,
    [id, status, recordsSynced, error]
  );
}

export interface OuraSyncRun {
  id: number;
  started_at: string;
  finished_at: string | null;
  status: string;
  records_synced: number;
  error: string | null;
}

/* v8 ignore next 7 -- simple SELECT, tested via mocked webhook handler */
export async function getOuraSyncRun(pool: pg.Pool, id: number): Promise<OuraSyncRun | null> {
  const result = await pool.query<OuraSyncRun>(
    `SELECT id, started_at, finished_at, status, records_synced, error FROM oura_sync_runs WHERE id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

export async function upsertOuraSyncState(pool: pg.Pool, endpoint: string, lastSyncedDay: string): Promise<void> {
  await pool.query(
    `INSERT INTO oura_sync_state (endpoint, last_synced_day, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (endpoint)
     DO UPDATE SET last_synced_day = EXCLUDED.last_synced_day, updated_at = NOW()`,
    [endpoint, lastSyncedDay]
  );
}

export async function upsertOuraDailySleep(pool: pg.Pool, row: Record<string, unknown>): Promise<void> {
  const contributors = (row.contributors ?? null) as unknown;
  await pool.query(
    `INSERT INTO oura_daily_sleep (
      day, score, total_sleep_duration_seconds, deep_sleep_duration_seconds, rem_sleep_duration_seconds,
      light_sleep_duration_seconds, efficiency, contributors, raw_json
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (day) DO UPDATE SET
      score = EXCLUDED.score,
      total_sleep_duration_seconds = EXCLUDED.total_sleep_duration_seconds,
      deep_sleep_duration_seconds = EXCLUDED.deep_sleep_duration_seconds,
      rem_sleep_duration_seconds = EXCLUDED.rem_sleep_duration_seconds,
      light_sleep_duration_seconds = EXCLUDED.light_sleep_duration_seconds,
      efficiency = EXCLUDED.efficiency,
      contributors = EXCLUDED.contributors,
      raw_json = EXCLUDED.raw_json`,
    [row.day, row.score ?? null, row.total_sleep_duration ?? null, row.deep_sleep_duration ?? null, row.rem_sleep_duration ?? null, row.light_sleep_duration ?? null, row.efficiency ?? null, contributors, row]
  );
}

export async function upsertOuraSleepSession(pool: pg.Pool, row: Record<string, unknown>): Promise<void> {
  await pool.query(
    `INSERT INTO oura_sleep_sessions (
      oura_id, day, period, bedtime_start, bedtime_end, average_hrv, average_heart_rate,
      total_sleep_duration_seconds, efficiency, raw_json
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (oura_id) DO UPDATE SET
      day = EXCLUDED.day,
      period = EXCLUDED.period,
      bedtime_start = EXCLUDED.bedtime_start,
      bedtime_end = EXCLUDED.bedtime_end,
      average_hrv = EXCLUDED.average_hrv,
      average_heart_rate = EXCLUDED.average_heart_rate,
      total_sleep_duration_seconds = EXCLUDED.total_sleep_duration_seconds,
      efficiency = EXCLUDED.efficiency,
      raw_json = EXCLUDED.raw_json`,
    [row.id, row.day, row.period ?? null, row.bedtime_start ?? null, row.bedtime_end ?? null, row.average_hrv ?? null, row.average_heart_rate ?? null, row.total_sleep_duration ?? null, row.efficiency ?? null, row]
  );
}

export async function upsertOuraDailyReadiness(pool: pg.Pool, row: Record<string, unknown>): Promise<void> {
  await pool.query(
    `INSERT INTO oura_daily_readiness (
      day, score, temperature_deviation, resting_heart_rate, hrv_balance, contributors, raw_json
    ) VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (day) DO UPDATE SET
      score = EXCLUDED.score,
      temperature_deviation = EXCLUDED.temperature_deviation,
      resting_heart_rate = EXCLUDED.resting_heart_rate,
      hrv_balance = EXCLUDED.hrv_balance,
      contributors = EXCLUDED.contributors,
      raw_json = EXCLUDED.raw_json`,
    [row.day, row.score ?? null, row.temperature_deviation ?? null, row.resting_heart_rate ?? null, row.hrv_balance ?? null, row.contributors ?? null, row]
  );
}

export async function upsertOuraDailyActivity(pool: pg.Pool, row: Record<string, unknown>): Promise<void> {
  await pool.query(
    `INSERT INTO oura_daily_activity (
      day, score, steps, active_calories, total_calories, medium_activity_seconds, high_activity_seconds,
      low_activity_seconds, raw_json
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (day) DO UPDATE SET
      score = EXCLUDED.score,
      steps = EXCLUDED.steps,
      active_calories = EXCLUDED.active_calories,
      total_calories = EXCLUDED.total_calories,
      medium_activity_seconds = EXCLUDED.medium_activity_seconds,
      high_activity_seconds = EXCLUDED.high_activity_seconds,
      low_activity_seconds = EXCLUDED.low_activity_seconds,
      raw_json = EXCLUDED.raw_json`,
    [row.day, row.score ?? null, row.steps ?? null, row.active_calories ?? null, row.total_calories ?? null, row.medium_activity_time ?? null, row.high_activity_time ?? null, row.low_activity_time ?? null, row]
  );
}

export async function upsertOuraDailyStress(pool: pg.Pool, row: Record<string, unknown>): Promise<void> {
  await pool.query(
    `INSERT INTO oura_daily_stress (day, stress_high_seconds, recovery_high_seconds, day_summary, raw_json)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (day) DO UPDATE SET
      stress_high_seconds = EXCLUDED.stress_high_seconds,
      recovery_high_seconds = EXCLUDED.recovery_high_seconds,
      day_summary = EXCLUDED.day_summary,
      raw_json = EXCLUDED.raw_json`,
    [row.day, row.stress_high ?? null, row.recovery_high ?? null, row.day_summary ?? null, row]
  );
}

export async function upsertOuraWorkout(pool: pg.Pool, row: Record<string, unknown>): Promise<void> {
  await pool.query(
    `INSERT INTO oura_workouts (
      oura_id, day, activity, calories, distance, duration_seconds, average_heart_rate, max_heart_rate, raw_json
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (oura_id) DO UPDATE SET
      day = EXCLUDED.day,
      activity = EXCLUDED.activity,
      calories = EXCLUDED.calories,
      distance = EXCLUDED.distance,
      duration_seconds = EXCLUDED.duration_seconds,
      average_heart_rate = EXCLUDED.average_heart_rate,
      max_heart_rate = EXCLUDED.max_heart_rate,
      raw_json = EXCLUDED.raw_json`,
    [row.id, row.day, row.activity ?? null, row.calories ?? null, row.distance ?? null, row.duration ?? null, row.average_heart_rate ?? null, row.max_heart_rate ?? null, row]
  );
}

export async function getOuraSummaryByDay(pool: pg.Pool, day: string): Promise<OuraSummaryRow | null> {
  const result = await pool.query<OuraSummaryRow>(
    `SELECT d.day,
            d.score AS sleep_score,
            r.score AS readiness_score,
            a.score AS activity_score,
            a.steps,
            st.day_summary AS stress,
            ss.average_hrv,
            ss.average_heart_rate,
            d.total_sleep_duration_seconds AS sleep_duration_seconds,
            d.deep_sleep_duration_seconds,
            d.rem_sleep_duration_seconds,
            d.efficiency,
            COALESCE(w.workout_count, 0)::int AS workout_count
      FROM oura_daily_sleep d
      LEFT JOIN oura_daily_readiness r ON r.day = d.day
      LEFT JOIN oura_daily_activity a ON a.day = d.day
      LEFT JOIN oura_daily_stress st ON st.day = d.day
      LEFT JOIN oura_sleep_sessions ss ON ss.day = d.day AND COALESCE(ss.period, 0) = 0
      LEFT JOIN (
        SELECT day, COUNT(*) AS workout_count FROM oura_workouts GROUP BY day
      ) w ON w.day = d.day
      WHERE d.day = $1`,
    [day]
  );
  return result.rows[0] ?? null;
}

export async function getOuraWeeklyRows(pool: pg.Pool, endDay: string): Promise<OuraSummaryRow[]> {
  const result = await pool.query<OuraSummaryRow>(
    `SELECT d.day,
            d.score AS sleep_score,
            r.score AS readiness_score,
            a.score AS activity_score,
            a.steps,
            st.day_summary AS stress,
            ss.average_hrv,
            ss.average_heart_rate,
            d.total_sleep_duration_seconds AS sleep_duration_seconds,
            d.deep_sleep_duration_seconds,
            d.rem_sleep_duration_seconds,
            d.efficiency,
            COALESCE(w.workout_count, 0)::int AS workout_count
      FROM oura_daily_sleep d
      LEFT JOIN oura_daily_readiness r ON r.day = d.day
      LEFT JOIN oura_daily_activity a ON a.day = d.day
      LEFT JOIN oura_daily_stress st ON st.day = d.day
      LEFT JOIN oura_sleep_sessions ss ON ss.day = d.day AND COALESCE(ss.period, 0) = 0
      LEFT JOIN (SELECT day, COUNT(*) AS workout_count FROM oura_workouts GROUP BY day) w ON w.day = d.day
      WHERE d.day BETWEEN ($1::date - INTERVAL '6 days')::date AND $1::date
      ORDER BY d.day ASC`,
    [endDay]
  );
  return result.rows;
}

export type OuraTrendMetric = "sleep_score" | "hrv" | "readiness" | "activity" | "steps" | "sleep_duration" | "stress" | "resting_heart_rate" | "temperature" | "active_calories" | "heart_rate" | "efficiency";

const ouraTrendColumnSql: Record<OuraTrendMetric, string> = {
  sleep_score: "d.score",
  hrv: "ss.average_hrv",
  readiness: "r.score",
  activity: "a.score",
  steps: "a.steps",
  sleep_duration: "d.total_sleep_duration_seconds",
  stress: "st.stress_high_seconds",
  resting_heart_rate: "r.resting_heart_rate",
  temperature: "r.temperature_deviation",
  active_calories: "a.active_calories",
  heart_rate: "ss.average_heart_rate",
  efficiency: "d.efficiency",
};

const stressJoinMetrics: Set<OuraTrendMetric> = new Set(["stress"]);

function needsStressJoin(metric: OuraTrendMetric): boolean {
  return stressJoinMetrics.has(metric);
}

export async function getOuraTrendMetric(
  pool: pg.Pool,
  metric: OuraTrendMetric,
  days: number
): Promise<Array<{ day: Date; value: number }>> {
  const stressJoin = needsStressJoin(metric) ? "LEFT JOIN oura_daily_stress st ON st.day = d.day" : "";
  const result = await pool.query<{ day: Date; value: number }>(
    `SELECT d.day, ${ouraTrendColumnSql[metric]}::double precision AS value
     FROM oura_daily_sleep d
     LEFT JOIN oura_daily_readiness r ON r.day = d.day
     LEFT JOIN oura_daily_activity a ON a.day = d.day
     LEFT JOIN oura_sleep_sessions ss ON ss.day = d.day AND COALESCE(ss.period, 0) = 0
     ${stressJoin}
     WHERE d.day >= (CURRENT_DATE - ($1::int - 1) * INTERVAL '1 day')
       AND ${ouraTrendColumnSql[metric]} IS NOT NULL
     ORDER BY d.day ASC`,
    [days]
  );
  return result.rows;
}

export async function getOuraTrendMetricForRange(
  pool: pg.Pool,
  metric: OuraTrendMetric,
  startDate: string,
  endDate: string
): Promise<Array<{ day: Date; value: number }>> {
  const stressJoin = needsStressJoin(metric) ? "LEFT JOIN oura_daily_stress st ON st.day = d.day" : "";
  const result = await pool.query<{ day: Date; value: number }>(
    `SELECT d.day, ${ouraTrendColumnSql[metric]}::double precision AS value
     FROM oura_daily_sleep d
     LEFT JOIN oura_daily_readiness r ON r.day = d.day
     LEFT JOIN oura_daily_activity a ON a.day = d.day
     LEFT JOIN oura_sleep_sessions ss ON ss.day = d.day AND COALESCE(ss.period, 0) = 0
     ${stressJoin}
     WHERE d.day >= $1::date AND d.day <= $2::date
       AND ${ouraTrendColumnSql[metric]} IS NOT NULL
     ORDER BY d.day ASC`,
    [startDate, endDate]
  );
  return result.rows;
}

export interface OuraSleepDetailRow {
  day: Date;
  score: number | null;
  total_sleep_duration_seconds: number | null;
  deep_sleep_duration_seconds: number | null;
  rem_sleep_duration_seconds: number | null;
  light_sleep_duration_seconds: number | null;
  efficiency: number | null;
  average_hrv: number | null;
  average_heart_rate: number | null;
  bedtime_start: Date | null;
  bedtime_end: Date | null;
  steps: number | null;
  activity_score: number | null;
  workout_count: number;
}

export async function getOuraSleepDetailForRange(
  pool: pg.Pool,
  days: number
): Promise<OuraSleepDetailRow[]> {
  const result = await pool.query<OuraSleepDetailRow>(
    `SELECT d.day, d.score, d.total_sleep_duration_seconds, d.deep_sleep_duration_seconds,
            d.rem_sleep_duration_seconds, d.light_sleep_duration_seconds, d.efficiency,
            ss.average_hrv, ss.average_heart_rate, ss.bedtime_start, ss.bedtime_end,
            a.steps, a.score AS activity_score,
            COALESCE(w.workout_count, 0)::int AS workout_count
     FROM oura_daily_sleep d
     LEFT JOIN oura_sleep_sessions ss ON ss.day = d.day AND COALESCE(ss.period, 0) = 0
     LEFT JOIN oura_daily_activity a ON a.day = d.day
     LEFT JOIN (SELECT day, COUNT(*) AS workout_count FROM oura_workouts GROUP BY day) w ON w.day = d.day
     WHERE d.day >= (CURRENT_DATE - ($1::int - 1) * INTERVAL '1 day')
     ORDER BY d.day ASC`,
    [days]
  );
  return result.rows;
}

export async function getOuraTemperatureData(
  pool: pg.Pool,
  days: number
): Promise<Array<{ day: Date; temperature_deviation: number }>> {
  const result = await pool.query<{ day: Date; temperature_deviation: number }>(
    `SELECT day, temperature_deviation
     FROM oura_daily_readiness
     WHERE day >= (CURRENT_DATE - ($1::int - 1) * INTERVAL '1 day')
       AND temperature_deviation IS NOT NULL
     ORDER BY day ASC`,
    [days]
  );
  return result.rows;
}
