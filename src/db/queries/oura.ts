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
  lowest_heart_rate: number | null;
  average_breath: number | null;
  sleep_duration_seconds: number | null;
  deep_sleep_duration_seconds: number | null;
  rem_sleep_duration_seconds: number | null;
  awake_seconds: number | null;
  efficiency: number | null;
  spo2: number | null;
  breathing_disturbance_index: number | null;
  resilience_level: string | null;
  vascular_age: number | null;
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
    `INSERT INTO oura_daily_sleep (day, score, contributors, raw_json)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (day) DO UPDATE SET
       score = EXCLUDED.score,
       contributors = EXCLUDED.contributors,
       raw_json = EXCLUDED.raw_json`,
    [row.day, row.score ?? null, contributors, row]
  );
}

export async function upsertOuraSleepSession(pool: pg.Pool, row: Record<string, unknown>): Promise<void> {
  await pool.query(
    `INSERT INTO oura_sleep_sessions (
      oura_id, day, period, sleep_type, bedtime_start, bedtime_end,
      average_hrv, average_heart_rate, lowest_heart_rate, average_breath,
      total_sleep_duration_seconds, time_in_bed_seconds, awake_seconds, latency_seconds,
      deep_sleep_seconds, rem_sleep_seconds, light_sleep_seconds, restless_periods, efficiency,
      hrv_5min, heart_rate_5min, sleep_phase_5min, sleep_phase_30sec, movement_30sec,
      sleep_score_delta, readiness_score_delta,
      raw_json
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
    ON CONFLICT (oura_id) DO UPDATE SET
      day = EXCLUDED.day,
      period = EXCLUDED.period,
      sleep_type = EXCLUDED.sleep_type,
      bedtime_start = EXCLUDED.bedtime_start,
      bedtime_end = EXCLUDED.bedtime_end,
      average_hrv = EXCLUDED.average_hrv,
      average_heart_rate = EXCLUDED.average_heart_rate,
      lowest_heart_rate = EXCLUDED.lowest_heart_rate,
      average_breath = EXCLUDED.average_breath,
      total_sleep_duration_seconds = EXCLUDED.total_sleep_duration_seconds,
      time_in_bed_seconds = EXCLUDED.time_in_bed_seconds,
      awake_seconds = EXCLUDED.awake_seconds,
      latency_seconds = EXCLUDED.latency_seconds,
      deep_sleep_seconds = EXCLUDED.deep_sleep_seconds,
      rem_sleep_seconds = EXCLUDED.rem_sleep_seconds,
      light_sleep_seconds = EXCLUDED.light_sleep_seconds,
      restless_periods = EXCLUDED.restless_periods,
      efficiency = EXCLUDED.efficiency,
      hrv_5min = EXCLUDED.hrv_5min,
      heart_rate_5min = EXCLUDED.heart_rate_5min,
      sleep_phase_5min = EXCLUDED.sleep_phase_5min,
      sleep_phase_30sec = EXCLUDED.sleep_phase_30sec,
      movement_30sec = EXCLUDED.movement_30sec,
      sleep_score_delta = EXCLUDED.sleep_score_delta,
      readiness_score_delta = EXCLUDED.readiness_score_delta,
      raw_json = EXCLUDED.raw_json`,
    [
      row.id, row.day, row.period ?? null, row.type ?? null,
      row.bedtime_start ?? null, row.bedtime_end ?? null,
      row.average_hrv ?? null, row.average_heart_rate ?? null,
      row.lowest_heart_rate ?? null, row.average_breath ?? null,
      row.total_sleep_duration ?? null, row.time_in_bed ?? null,
      row.awake_time ?? null, row.latency ?? null,
      row.deep_sleep_duration ?? null, row.rem_sleep_duration ?? null,
      row.light_sleep_duration ?? null, row.restless_periods ?? null,
      row.efficiency ?? null,
      row.hrv ?? null, row.heart_rate ?? null,
      row.sleep_phase_5_min ?? null, row.sleep_phase_30_sec ?? null, row.movement_30_sec ?? null,
      row.sleep_score_delta ?? null, row.readiness_score_delta ?? null,
      row,
    ]
  );
}

export async function upsertOuraDailyReadiness(pool: pg.Pool, row: Record<string, unknown>): Promise<void> {
  const contributors = (row.contributors ?? {}) as Record<string, unknown>;
  await pool.query(
    `INSERT INTO oura_daily_readiness (
      day, score, temperature_deviation, temperature_trend_deviation,
      resting_heart_rate_score, hrv_balance_score, contributors, raw_json
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (day) DO UPDATE SET
      score = EXCLUDED.score,
      temperature_deviation = EXCLUDED.temperature_deviation,
      temperature_trend_deviation = EXCLUDED.temperature_trend_deviation,
      resting_heart_rate_score = EXCLUDED.resting_heart_rate_score,
      hrv_balance_score = EXCLUDED.hrv_balance_score,
      contributors = EXCLUDED.contributors,
      raw_json = EXCLUDED.raw_json`,
    [
      row.day, row.score ?? null,
      row.temperature_deviation ?? null,
      row.temperature_trend_deviation ?? null,
      contributors.resting_heart_rate ?? null,
      contributors.hrv_balance ?? null,
      row.contributors ?? null,
      row,
    ]
  );
}

export async function upsertOuraDailyActivity(pool: pg.Pool, row: Record<string, unknown>): Promise<void> {
  await pool.query(
    `INSERT INTO oura_daily_activity (
      day, score, steps, active_calories, total_calories,
      sedentary_seconds, resting_seconds, non_wear_seconds,
      medium_activity_seconds, high_activity_seconds, low_activity_seconds,
      sedentary_met_minutes, low_met_minutes, medium_met_minutes, high_met_minutes,
      average_met_minutes, equivalent_walking_distance_m, inactivity_alerts,
      class_5min, met, contributors,
      raw_json
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
    ON CONFLICT (day) DO UPDATE SET
      score = EXCLUDED.score,
      steps = EXCLUDED.steps,
      active_calories = EXCLUDED.active_calories,
      total_calories = EXCLUDED.total_calories,
      sedentary_seconds = EXCLUDED.sedentary_seconds,
      resting_seconds = EXCLUDED.resting_seconds,
      non_wear_seconds = EXCLUDED.non_wear_seconds,
      medium_activity_seconds = EXCLUDED.medium_activity_seconds,
      high_activity_seconds = EXCLUDED.high_activity_seconds,
      low_activity_seconds = EXCLUDED.low_activity_seconds,
      sedentary_met_minutes = EXCLUDED.sedentary_met_minutes,
      low_met_minutes = EXCLUDED.low_met_minutes,
      medium_met_minutes = EXCLUDED.medium_met_minutes,
      high_met_minutes = EXCLUDED.high_met_minutes,
      average_met_minutes = EXCLUDED.average_met_minutes,
      equivalent_walking_distance_m = EXCLUDED.equivalent_walking_distance_m,
      inactivity_alerts = EXCLUDED.inactivity_alerts,
      class_5min = EXCLUDED.class_5min,
      met = EXCLUDED.met,
      contributors = EXCLUDED.contributors,
      raw_json = EXCLUDED.raw_json`,
    [
      row.day, row.score ?? null, row.steps ?? null,
      row.active_calories ?? null, row.total_calories ?? null,
      row.sedentary_time ?? null, row.resting_time ?? null, row.non_wear_time ?? null,
      row.medium_activity_time ?? null, row.high_activity_time ?? null, row.low_activity_time ?? null,
      row.sedentary_met_minutes ?? null, row.low_activity_met_minutes ?? null,
      row.medium_activity_met_minutes ?? null, row.high_activity_met_minutes ?? null,
      row.average_met_minutes ?? null,
      row.equivalent_walking_distance ?? null,
      row.inactivity_alerts ?? null,
      row.class_5_min ?? null, row.met ?? null, row.contributors ?? null,
      row,
    ]
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
  // The /workout endpoint returns start_datetime + end_datetime but no top-level
  // duration field. Compute duration from the timestamps when available.
  const start = row.start_datetime ? new Date(row.start_datetime as string) : null;
  const end = row.end_datetime ? new Date(row.end_datetime as string) : null;
  const computedDuration =
    start && end ? Math.round((end.getTime() - start.getTime()) / 1000) : null;

  await pool.query(
    `INSERT INTO oura_workouts (
      oura_id, day, activity, calories, distance, duration_seconds,
      start_time, end_time, intensity, label, source,
      average_heart_rate, max_heart_rate, raw_json
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    ON CONFLICT (oura_id) DO UPDATE SET
      day = EXCLUDED.day,
      activity = EXCLUDED.activity,
      calories = EXCLUDED.calories,
      distance = EXCLUDED.distance,
      duration_seconds = EXCLUDED.duration_seconds,
      start_time = EXCLUDED.start_time,
      end_time = EXCLUDED.end_time,
      intensity = EXCLUDED.intensity,
      label = EXCLUDED.label,
      source = EXCLUDED.source,
      average_heart_rate = EXCLUDED.average_heart_rate,
      max_heart_rate = EXCLUDED.max_heart_rate,
      raw_json = EXCLUDED.raw_json`,
    [
      row.id, row.day, row.activity ?? null,
      row.calories ?? null, row.distance ?? null, computedDuration,
      row.start_datetime ?? null, row.end_datetime ?? null,
      row.intensity ?? null, row.label ?? null, row.source ?? null,
      row.average_heart_rate ?? null, row.max_heart_rate ?? null,
      row,
    ]
  );
}

// All sleep queries source stages and durations from oura_sleep_sessions where
// sleep_type='long_sleep' (the main night session). The /daily_sleep endpoint
// only returns score+contributors, so oura_daily_sleep can't be the source for
// duration/stages — it's just the daily score.
const longSleepLateral = `LEFT JOIN LATERAL (
  SELECT total_sleep_duration_seconds, time_in_bed_seconds, awake_seconds, latency_seconds,
         deep_sleep_seconds, rem_sleep_seconds, light_sleep_seconds, restless_periods,
         efficiency, average_hrv, average_heart_rate, lowest_heart_rate, average_breath,
         bedtime_start, bedtime_end, hrv_5min, heart_rate_5min, raw_json
  FROM oura_sleep_sessions
  WHERE day = d.day AND sleep_type = 'long_sleep'
  LIMIT 1
) ss ON TRUE`;

const summarySelect = `d.day,
        d.score AS sleep_score,
        r.score AS readiness_score,
        a.score AS activity_score,
        a.steps,
        st.day_summary AS stress,
        ss.average_hrv,
        ss.average_heart_rate,
        ss.lowest_heart_rate,
        ss.average_breath,
        ss.total_sleep_duration_seconds AS sleep_duration_seconds,
        ss.deep_sleep_seconds AS deep_sleep_duration_seconds,
        ss.rem_sleep_seconds AS rem_sleep_duration_seconds,
        ss.awake_seconds,
        ss.efficiency,
        sp.average_spo2 AS spo2,
        sp.breathing_disturbance_index,
        rs.level AS resilience_level,
        cv.vascular_age,
        COALESCE(w.workout_count, 0)::int AS workout_count`;

const summaryJoins = `LEFT JOIN oura_daily_readiness r ON r.day = d.day
      LEFT JOIN oura_daily_activity a ON a.day = d.day
      LEFT JOIN oura_daily_stress st ON st.day = d.day
      ${longSleepLateral}
      LEFT JOIN oura_daily_spo2 sp ON sp.day = d.day
      LEFT JOIN oura_daily_resilience rs ON rs.day = d.day
      LEFT JOIN oura_daily_cardiovascular_age cv ON cv.day = d.day
      LEFT JOIN (SELECT day, COUNT(*) AS workout_count FROM oura_workouts GROUP BY day) w ON w.day = d.day`;

export async function getOuraSummaryByDay(pool: pg.Pool, day: string): Promise<OuraSummaryRow | null> {
  const result = await pool.query<OuraSummaryRow>(
    `SELECT ${summarySelect}
      FROM oura_daily_sleep d
      ${summaryJoins}
      WHERE d.day = $1`,
    [day]
  );
  return result.rows[0] ?? null;
}

export async function getOuraWeeklyRows(pool: pg.Pool, endDay: string): Promise<OuraSummaryRow[]> {
  const result = await pool.query<OuraSummaryRow>(
    `SELECT ${summarySelect}
      FROM oura_daily_sleep d
      ${summaryJoins}
      WHERE d.day BETWEEN ($1::date - INTERVAL '6 days')::date AND $1::date
      ORDER BY d.day ASC`,
    [endDay]
  );
  return result.rows;
}

export type OuraTrendMetric =
  | "sleep_score" | "hrv" | "readiness" | "activity" | "steps"
  | "sleep_duration" | "stress" | "resting_heart_rate" | "temperature"
  | "active_calories" | "heart_rate" | "efficiency"
  | "deep_sleep" | "rem_sleep" | "light_sleep" | "awake_time" | "latency"
  | "breath_rate" | "lowest_heart_rate"
  | "spo2" | "breathing_disturbance"
  | "resilience_sleep_recovery" | "resilience_daytime_recovery" | "resilience_stress"
  | "vascular_age" | "pulse_wave_velocity"
  | "non_wear_seconds";

// Maps metric → column expression. Joined tables: d=daily_sleep, r=readiness,
// a=daily_activity, ss=sleep_session(long_sleep), st=stress, sp=spo2,
// rs=resilience, cv=cv_age.
const ouraTrendColumnSql: Record<OuraTrendMetric, string> = {
  sleep_score: "d.score",
  hrv: "ss.average_hrv",
  readiness: "r.score",
  activity: "a.score",
  steps: "a.steps",
  sleep_duration: "ss.total_sleep_duration_seconds",
  stress: "st.stress_high_seconds",
  // resting_heart_rate is the canonical Oura RHR — lowest HR during sleep.
  // Pre-045 this returned r.resting_heart_rate which was actually a 0–100
  // contributor score, NULL for every row (column misnamed).
  resting_heart_rate: "ss.lowest_heart_rate",
  temperature: "r.temperature_deviation",
  active_calories: "a.active_calories",
  heart_rate: "ss.average_heart_rate",
  efficiency: "ss.efficiency",
  deep_sleep: "ss.deep_sleep_seconds",
  rem_sleep: "ss.rem_sleep_seconds",
  light_sleep: "ss.light_sleep_seconds",
  awake_time: "ss.awake_seconds",
  latency: "ss.latency_seconds",
  breath_rate: "ss.average_breath",
  lowest_heart_rate: "ss.lowest_heart_rate",
  spo2: "sp.average_spo2",
  breathing_disturbance: "sp.breathing_disturbance_index",
  resilience_sleep_recovery: "rs.sleep_recovery",
  resilience_daytime_recovery: "rs.daytime_recovery",
  resilience_stress: "rs.stress",
  vascular_age: "cv.vascular_age",
  pulse_wave_velocity: "cv.pulse_wave_velocity",
  non_wear_seconds: "a.non_wear_seconds",
};

function joinClausesFor(metric: OuraTrendMetric): string {
  const clauses: string[] = [];
  if (metric === "stress") clauses.push("LEFT JOIN oura_daily_stress st ON st.day = d.day");
  if (metric === "spo2" || metric === "breathing_disturbance") clauses.push("LEFT JOIN oura_daily_spo2 sp ON sp.day = d.day");
  if (metric.startsWith("resilience_")) clauses.push("LEFT JOIN oura_daily_resilience rs ON rs.day = d.day");
  if (metric === "vascular_age" || metric === "pulse_wave_velocity") clauses.push("LEFT JOIN oura_daily_cardiovascular_age cv ON cv.day = d.day");
  return clauses.join("\n     ");
}

export async function getOuraTrendMetric(
  pool: pg.Pool,
  metric: OuraTrendMetric,
  days: number
): Promise<Array<{ day: Date; value: number }>> {
  const result = await pool.query<{ day: Date; value: number }>(
    `SELECT d.day, ${ouraTrendColumnSql[metric]}::double precision AS value
     FROM oura_daily_sleep d
     LEFT JOIN oura_daily_readiness r ON r.day = d.day
     LEFT JOIN oura_daily_activity a ON a.day = d.day
     ${longSleepLateral}
     ${joinClausesFor(metric)}
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
  const result = await pool.query<{ day: Date; value: number }>(
    `SELECT d.day, ${ouraTrendColumnSql[metric]}::double precision AS value
     FROM oura_daily_sleep d
     LEFT JOIN oura_daily_readiness r ON r.day = d.day
     LEFT JOIN oura_daily_activity a ON a.day = d.day
     ${longSleepLateral}
     ${joinClausesFor(metric)}
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
    `SELECT d.day, d.score,
            ss.total_sleep_duration_seconds,
            (ss.raw_json->>'deep_sleep_duration')::int AS deep_sleep_duration_seconds,
            (ss.raw_json->>'rem_sleep_duration')::int AS rem_sleep_duration_seconds,
            (ss.raw_json->>'light_sleep_duration')::int AS light_sleep_duration_seconds,
            ss.efficiency,
            ss.average_hrv, ss.average_heart_rate, ss.bedtime_start, ss.bedtime_end,
            a.steps, a.score AS activity_score,
            COALESCE(w.workout_count, 0)::int AS workout_count
     FROM oura_daily_sleep d
     ${longSleepLateral}
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

// ─── New endpoint upserts ───────────────────────────────────────────────────

export async function upsertOuraDailySpo2(pool: pg.Pool, row: Record<string, unknown>): Promise<void> {
  const spo2 = (row.spo2_percentage ?? null) as Record<string, unknown> | null;
  await pool.query(
    `INSERT INTO oura_daily_spo2 (day, average_spo2, breathing_disturbance_index, raw_json)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (day) DO UPDATE SET
       average_spo2 = EXCLUDED.average_spo2,
       breathing_disturbance_index = EXCLUDED.breathing_disturbance_index,
       raw_json = EXCLUDED.raw_json`,
    [row.day, spo2?.average ?? null, row.breathing_disturbance_index ?? null, row]
  );
}

export async function upsertOuraDailyResilience(pool: pg.Pool, row: Record<string, unknown>): Promise<void> {
  const c = (row.contributors ?? {}) as Record<string, unknown>;
  await pool.query(
    `INSERT INTO oura_daily_resilience (day, level, sleep_recovery, daytime_recovery, stress, raw_json)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (day) DO UPDATE SET
       level = EXCLUDED.level,
       sleep_recovery = EXCLUDED.sleep_recovery,
       daytime_recovery = EXCLUDED.daytime_recovery,
       stress = EXCLUDED.stress,
       raw_json = EXCLUDED.raw_json`,
    [row.day, row.level ?? null, c.sleep_recovery ?? null, c.daytime_recovery ?? null, c.stress ?? null, row]
  );
}

export async function upsertOuraDailyCardiovascularAge(pool: pg.Pool, row: Record<string, unknown>): Promise<void> {
  await pool.query(
    `INSERT INTO oura_daily_cardiovascular_age (day, vascular_age, pulse_wave_velocity, raw_json)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (day) DO UPDATE SET
       vascular_age = EXCLUDED.vascular_age,
       pulse_wave_velocity = EXCLUDED.pulse_wave_velocity,
       raw_json = EXCLUDED.raw_json`,
    [row.day, row.vascular_age ?? null, row.pulse_wave_velocity ?? null, row]
  );
}

export async function upsertOuraSleepTime(pool: pg.Pool, row: Record<string, unknown>): Promise<void> {
  await pool.query(
    `INSERT INTO oura_sleep_time (day, status, recommendation, optimal_bedtime, raw_json)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (day) DO UPDATE SET
       status = EXCLUDED.status,
       recommendation = EXCLUDED.recommendation,
       optimal_bedtime = EXCLUDED.optimal_bedtime,
       raw_json = EXCLUDED.raw_json`,
    [row.day, row.status ?? null, row.recommendation ?? null, row.optimal_bedtime ?? null, row]
  );
}

export async function upsertOuraEnhancedTag(pool: pg.Pool, row: Record<string, unknown>): Promise<void> {
  await pool.query(
    `INSERT INTO oura_enhanced_tags (oura_id, start_day, end_day, start_time, end_time, tag_type_code, custom_name, comment, raw_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (oura_id) DO UPDATE SET
       start_day = EXCLUDED.start_day,
       end_day = EXCLUDED.end_day,
       start_time = EXCLUDED.start_time,
       end_time = EXCLUDED.end_time,
       tag_type_code = EXCLUDED.tag_type_code,
       custom_name = EXCLUDED.custom_name,
       comment = EXCLUDED.comment,
       raw_json = EXCLUDED.raw_json`,
    [
      row.id, row.start_day ?? null, row.end_day ?? null,
      row.start_time ?? null, row.end_time ?? null,
      row.tag_type_code ?? null, row.custom_name ?? null, row.comment ?? null, row,
    ]
  );
}

export async function upsertOuraRestModePeriod(pool: pg.Pool, row: Record<string, unknown>): Promise<void> {
  await pool.query(
    `INSERT INTO oura_rest_mode_periods (oura_id, start_day, end_day, episodes, raw_json)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (oura_id) DO UPDATE SET
       start_day = EXCLUDED.start_day,
       end_day = EXCLUDED.end_day,
       episodes = EXCLUDED.episodes,
       raw_json = EXCLUDED.raw_json`,
    [
      row.id, row.start_day ?? null, row.end_day ?? null,
      // node-postgres serializes plain JS objects to JSONB correctly, but
      // bare arrays are emitted as PostgreSQL array literals (`{a,b,c}`)
      // which JSONB rejects. Stringify explicitly.
      row.episodes != null ? JSON.stringify(row.episodes) : null,
      row,
    ]
  );
}

export async function upsertOuraSession(pool: pg.Pool, row: Record<string, unknown>): Promise<void> {
  await pool.query(
    `INSERT INTO oura_sessions (oura_id, day, type, start_time, end_time, mood, motion_count, hrv, heart_rate, raw_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (oura_id) DO UPDATE SET
       day = EXCLUDED.day,
       type = EXCLUDED.type,
       start_time = EXCLUDED.start_time,
       end_time = EXCLUDED.end_time,
       mood = EXCLUDED.mood,
       motion_count = EXCLUDED.motion_count,
       hrv = EXCLUDED.hrv,
       heart_rate = EXCLUDED.heart_rate,
       raw_json = EXCLUDED.raw_json`,
    [
      row.id, row.day, row.type ?? null,
      row.start_datetime ?? null, row.end_datetime ?? null,
      row.mood ?? null, row.motion_count ?? null,
      row.hrv ?? null, row.heart_rate ?? null, row,
    ]
  );
}

// Postgres caps a single Bind message at 65,535 parameters (16-bit count).
// At 3 params per row that's 21,845 rows max. We use a much smaller chunk so
// the 30-day routine-sync window — which can pull 150k+ samples — and the
// per-day backfill chunks both go through without hitting wire-protocol limits.
const HEARTRATE_BATCH_CHUNK = 5000;

// Heartrate is bulk-inserted in chunks; one row per (ts, source).
export async function insertOuraHeartrateBatch(
  pool: pg.Pool,
  rows: Array<{ ts: string; bpm: number; source: string }>
): Promise<number> {
  if (rows.length === 0) return 0;
  let total = 0;
  for (let start = 0; start < rows.length; start += HEARTRATE_BATCH_CHUNK) {
    const chunk = rows.slice(start, start + HEARTRATE_BATCH_CHUNK);
    const values: string[] = [];
    const params: (string | number)[] = [];
    chunk.forEach((r, i) => {
      const base = i * 3;
      values.push(`($${base + 1},$${base + 2},$${base + 3})`);
      params.push(r.ts, r.bpm, r.source);
    });
    const result = await pool.query(
      `INSERT INTO oura_heartrate (ts, bpm, source) VALUES ${values.join(",")}
       ON CONFLICT (ts, source) DO NOTHING`,
      params
    );
    total += result.rowCount ?? 0;
  }
  return total;
}

// ─── New read queries ──────────────────────────────────────────────────────

export interface OuraIntraNightHrvRow {
  day: Date;
  bedtime_start: Date | null;
  hrv_5min: { interval: number; items: Array<number | null> } | null;
  heart_rate_5min: { interval: number; items: Array<number | null> } | null;
}

// Pulls the long_sleep session for a given day, including the per-5-minute
// HRV and HR time series. Used by the get_oura_intra_night_hrv tool to answer
// "when does HRV recover during sleep" questions.
export async function getOuraIntraNightHrv(pool: pg.Pool, day: string): Promise<OuraIntraNightHrvRow | null> {
  const result = await pool.query<OuraIntraNightHrvRow>(
    `SELECT day, bedtime_start, hrv_5min, heart_rate_5min
     FROM oura_sleep_sessions
     WHERE day = $1 AND sleep_type = 'long_sleep'
     LIMIT 1`,
    [day]
  );
  return result.rows[0] ?? null;
}

export interface OuraDailySpo2Row {
  day: Date;
  average_spo2: number | null;
  breathing_disturbance_index: number | null;
}
export async function getOuraDailySpo2(pool: pg.Pool, day: string): Promise<OuraDailySpo2Row | null> {
  const result = await pool.query<OuraDailySpo2Row>(
    `SELECT day, average_spo2, breathing_disturbance_index FROM oura_daily_spo2 WHERE day = $1`,
    [day]
  );
  return result.rows[0] ?? null;
}

export interface OuraResilienceRow {
  day: Date;
  level: string | null;
  sleep_recovery: number | null;
  daytime_recovery: number | null;
  stress: number | null;
}
export async function getOuraResilience(pool: pg.Pool, day: string): Promise<OuraResilienceRow | null> {
  const result = await pool.query<OuraResilienceRow>(
    `SELECT day, level, sleep_recovery, daytime_recovery, stress FROM oura_daily_resilience WHERE day = $1`,
    [day]
  );
  return result.rows[0] ?? null;
}

export interface OuraCardiovascularAgeRow {
  day: Date;
  vascular_age: number | null;
  pulse_wave_velocity: number | null;
}
export async function getOuraCardiovascularAge(pool: pg.Pool, day: string): Promise<OuraCardiovascularAgeRow | null> {
  const result = await pool.query<OuraCardiovascularAgeRow>(
    `SELECT day, vascular_age, pulse_wave_velocity FROM oura_daily_cardiovascular_age WHERE day = $1`,
    [day]
  );
  return result.rows[0] ?? null;
}

export interface OuraHeartrateRow {
  ts: Date;
  bpm: number;
  source: string;
}
// Returns continuous heart rate samples in the requested window. Caller must
// keep windows reasonable — at workout density (1 sample/sec) a single hour is
// 3,600 rows.
export async function getOuraHeartrateRange(
  pool: pg.Pool,
  startTs: string,
  endTs: string,
  source?: string
): Promise<OuraHeartrateRow[]> {
  if (source) {
    const result = await pool.query<OuraHeartrateRow>(
      `SELECT ts, bpm, source FROM oura_heartrate
       WHERE ts >= $1::timestamptz AND ts < $2::timestamptz AND source = $3
       ORDER BY ts ASC`,
      [startTs, endTs, source]
    );
    return result.rows;
  }
  const result = await pool.query<OuraHeartrateRow>(
    `SELECT ts, bpm, source FROM oura_heartrate
     WHERE ts >= $1::timestamptz AND ts < $2::timestamptz
     ORDER BY ts ASC`,
    [startTs, endTs]
  );
  return result.rows;
}

// ─── 046 follow-up: personal_info + ring_configurations ────────────────────

export async function upsertOuraPersonalInfo(pool: pg.Pool, row: Record<string, unknown>): Promise<void> {
  await pool.query(
    `INSERT INTO oura_personal_info (id, oura_user_id, age, weight_kg, height_m, biological_sex, email, raw_json, updated_at)
     VALUES (1, $1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (id) DO UPDATE SET
       oura_user_id = EXCLUDED.oura_user_id,
       age = EXCLUDED.age,
       weight_kg = EXCLUDED.weight_kg,
       height_m = EXCLUDED.height_m,
       biological_sex = EXCLUDED.biological_sex,
       email = EXCLUDED.email,
       raw_json = EXCLUDED.raw_json,
       updated_at = NOW()`,
    [
      row.id ?? null,
      row.age ?? null,
      row.weight ?? null,
      row.height ?? null,
      row.biological_sex ?? null,
      row.email ?? null,
      row,
    ]
  );
}

export async function upsertOuraRingConfiguration(pool: pg.Pool, row: Record<string, unknown>): Promise<void> {
  await pool.query(
    `INSERT INTO oura_ring_configurations (oura_id, hardware_type, color, design, size, firmware_version, set_up_at, raw_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (oura_id) DO UPDATE SET
       hardware_type = EXCLUDED.hardware_type,
       color = EXCLUDED.color,
       design = EXCLUDED.design,
       size = EXCLUDED.size,
       firmware_version = EXCLUDED.firmware_version,
       set_up_at = EXCLUDED.set_up_at,
       raw_json = EXCLUDED.raw_json`,
    [
      row.id, row.hardware_type ?? null, row.color ?? null, row.design ?? null,
      row.size ?? null, row.firmware_version ?? null, row.set_up_at ?? null, row,
    ]
  );
}

export interface OuraPersonalInfoRow {
  id: number;
  oura_user_id: string | null;
  age: number | null;
  weight_kg: number | null;
  height_m: number | null;
  biological_sex: string | null;
  email: string | null;
  updated_at: Date;
}

export async function getOuraPersonalInfo(pool: pg.Pool): Promise<OuraPersonalInfoRow | null> {
  const result = await pool.query<OuraPersonalInfoRow>(
    `SELECT id, oura_user_id, age, weight_kg, height_m, biological_sex, email, updated_at
     FROM oura_personal_info WHERE id = 1`
  );
  return result.rows[0] ?? null;
}

export interface OuraRingConfigurationRow {
  oura_id: string;
  hardware_type: string | null;
  color: string | null;
  design: string | null;
  size: number | null;
  firmware_version: string | null;
  set_up_at: Date | null;
}

// Returns one row per distinct ring (de-duped on hardware_type+color+size since
// the API emits one row per day with the active configuration).
export async function getOuraDistinctRings(pool: pg.Pool): Promise<OuraRingConfigurationRow[]> {
  const result = await pool.query<OuraRingConfigurationRow>(
    `SELECT DISTINCT ON (hardware_type, color, size)
       oura_id, hardware_type, color, design, size, firmware_version, set_up_at
     FROM oura_ring_configurations
     ORDER BY hardware_type, color, size, set_up_at NULLS LAST`
  );
  return result.rows;
}
