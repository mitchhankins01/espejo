// One-shot verifier for Oura ingestion. Run after every backfill or whenever
// you want to confirm that the DB still mirrors the API faithfully.
//
//   pnpm tsx scripts/verify-oura-coverage.ts
//
// Reports per-table (✅ / ⚠️ / ❌) for:
//   - Endpoint coverage: any v2 endpoint not synced.
//   - Row count parity: API rows vs DB rows in the same window.
//   - Field promotion: raw_json keys that lack a promoted column.
//   - Vestigial columns: DB columns that have no source field in raw_json.
//   - Promoted-column correctness: random spot-checks against raw_json.
//   - Date continuity: gaps in daily_sleep (canonical "ring on" signal).
//   - Heartrate sample density.
//
// Exit code: 0 if all green, 1 if any ❌.

import { pool } from "../src/db/client.js";
import { OuraClient } from "../src/oura/client.js";

interface CheckResult {
  ok: boolean;
  level: "ok" | "warn" | "fail";
  message: string;
}

const RESULTS: Array<{ section: string; check: string; result: CheckResult }> = [];

function ok(section: string, check: string, message = ""): void {
  RESULTS.push({ section, check, result: { ok: true, level: "ok", message } });
}

function warn(section: string, check: string, message: string): void {
  RESULTS.push({ section, check, result: { ok: true, level: "warn", message } });
}

function fail(section: string, check: string, message: string): void {
  RESULTS.push({ section, check, result: { ok: false, level: "fail", message } });
}

// ─── Section 1: endpoint coverage ──────────────────────────────────────────

const KNOWN_ENDPOINTS = [
  "personal_info", "ring_configuration",
  "daily_activity", "daily_cardiovascular_age", "daily_readiness",
  "daily_resilience", "daily_sleep", "daily_spo2", "daily_stress",
  "sleep", "sleep_time", "workout", "session",
  "heartrate", "enhanced_tag", "tag", "rest_mode_period", "vO2_max",
] as const;

const SYNCED_ENDPOINTS = new Set([
  "personal_info", "ring_configuration",
  "daily_activity", "daily_cardiovascular_age", "daily_readiness",
  "daily_resilience", "daily_sleep", "daily_spo2", "daily_stress",
  "sleep", "sleep_time", "workout", "session", "heartrate",
  "enhanced_tag", "rest_mode_period",
]);

const KNOWN_EMPTY_ENDPOINTS = new Set(["tag", "vO2_max"]); // empty for this user

const TOKEN = process.env.OURA_ACCESS_TOKEN ?? "";

async function probeEndpoint(ep: string): Promise<{ status: number; bodyBytes: number }> {
  const start = "2010-01-01";
  const end = "2026-12-31";
  const url = ep === "heartrate"
    ? `https://api.ouraring.com/v2/usercollection/heartrate?start_datetime=${start}T00:00:00Z&end_datetime=${start}T01:00:00Z`
    : ep === "personal_info"
    ? `https://api.ouraring.com/v2/usercollection/personal_info`
    : `https://api.ouraring.com/v2/usercollection/${ep}?start_date=${start}&end_date=${end}`;
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const body = await r.text();
    return { status: r.status, bodyBytes: body.length };
  } catch {
    return { status: 0, bodyBytes: 0 };
  }
}

async function checkEndpointCoverage(): Promise<void> {
  for (const ep of KNOWN_ENDPOINTS) {
    const { status } = await probeEndpoint(ep);
    if (status === 200 && !SYNCED_ENDPOINTS.has(ep) && !KNOWN_EMPTY_ENDPOINTS.has(ep)) {
      fail("endpoint coverage", ep, `200 OK but not synced — add to client + sync`);
    } else if (status === 200 && SYNCED_ENDPOINTS.has(ep)) {
      ok("endpoint coverage", ep);
    } else if (KNOWN_EMPTY_ENDPOINTS.has(ep)) {
      ok("endpoint coverage", ep, "(known empty for this user)");
    } else if (status >= 500) {
      warn("endpoint coverage", ep, `API returned ${status} — Oura side`);
    } else {
      warn("endpoint coverage", ep, `unexpected status ${status}`);
    }
  }
}

// ─── Section 2: row count parity ───────────────────────────────────────────

interface EndpointDbMap {
  endpoint: string;
  table: string;
  // For singletons or where API doesn't expose a paginated total, we skip parity.
  skipParity?: boolean;
}

const ENDPOINT_DB_MAP: EndpointDbMap[] = [
  { endpoint: "daily_activity", table: "oura_daily_activity" },
  { endpoint: "daily_sleep", table: "oura_daily_sleep" },
  { endpoint: "daily_readiness", table: "oura_daily_readiness" },
  { endpoint: "daily_stress", table: "oura_daily_stress" },
  { endpoint: "daily_spo2", table: "oura_daily_spo2" },
  { endpoint: "daily_resilience", table: "oura_daily_resilience" },
  { endpoint: "daily_cardiovascular_age", table: "oura_daily_cardiovascular_age" },
  { endpoint: "sleep", table: "oura_sleep_sessions" },
  { endpoint: "workout", table: "oura_workouts" },
  { endpoint: "sleep_time", table: "oura_sleep_time" },
  { endpoint: "enhanced_tag", table: "oura_enhanced_tags" },
  { endpoint: "rest_mode_period", table: "oura_rest_mode_periods" },
  { endpoint: "session", table: "oura_sessions" },
  { endpoint: "ring_configuration", table: "oura_ring_configurations" },
  { endpoint: "personal_info", table: "oura_personal_info", skipParity: true },
  { endpoint: "heartrate", table: "oura_heartrate", skipParity: true },
];

// Tables keyed on `day` collapse same-day API rows to one DB row, so parity
// must compare API distinct-days vs DB row count. Tables keyed on a record id
// (sleep, workout, session, etc.) compare raw API count vs DB row count.
const DAILY_PK_TABLES = new Set([
  "oura_daily_activity", "oura_daily_sleep", "oura_daily_readiness",
  "oura_daily_stress", "oura_daily_spo2", "oura_daily_resilience",
  "oura_daily_cardiovascular_age", "oura_sleep_time",
]);

async function fetchApiRows(client: OuraClient, ep: string): Promise<Array<Record<string, unknown>>> {
  const start = "2010-01-01";
  const end = "2026-12-31";
  const fetchers: Record<string, () => Promise<Record<string, unknown>[]>> = {
    daily_activity: () => client.getDailyActivity(start, end),
    daily_sleep: () => client.getDailySleep(start, end),
    daily_readiness: () => client.getDailyReadiness(start, end),
    daily_stress: () => client.getDailyStress(start, end),
    daily_spo2: () => client.getDailySpo2(start, end),
    daily_resilience: () => client.getDailyResilience(start, end),
    daily_cardiovascular_age: () => client.getDailyCardiovascularAge(start, end),
    sleep: () => client.getSleepSessions(start, end),
    workout: () => client.getWorkouts(start, end),
    sleep_time: () => client.getSleepTime(start, end),
    enhanced_tag: () => client.getEnhancedTags(start, end),
    rest_mode_period: () => client.getRestModePeriods(start, end),
    session: () => client.getSessions(start, end),
    ring_configuration: () => client.getRingConfigurations(start, end),
  };
  const fetcher = fetchers[ep];
  if (!fetcher) return [];
  return await fetcher();
}

async function checkRowCountParity(client: OuraClient): Promise<void> {
  for (const m of ENDPOINT_DB_MAP) {
    if (m.skipParity) continue;
    const rows = await fetchApiRows(client, m.endpoint);
    const apiCount = DAILY_PK_TABLES.has(m.table)
      ? new Set(rows.map((r) => r.day as string)).size
      : rows.length;
    const dbResult = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM ${m.table}`);
    const dbCount = Number.parseInt(dbResult.rows[0].n, 10);
    const note = DAILY_PK_TABLES.has(m.table) ? `api distinct days=${apiCount} db=${dbCount}` : `api=${apiCount} db=${dbCount}`;
    if (apiCount === dbCount) {
      ok("row parity", m.table, note);
    } else {
      const diff = apiCount - dbCount;
      const level = Math.abs(diff) <= 5 ? warn : fail;
      level("row parity", m.table, `${note} diff=${diff > 0 ? "+" : ""}${diff}`);
    }
  }
}

// ─── Section 3: field promotion completeness ───────────────────────────────

interface PromotionMap {
  table: string;
  // raw_json keys we intentionally don't promote (low signal: metadata, deprecated, etc).
  ignoreRawKeys?: string[];
  // DB columns that aren't raw_json keys (e.g. computed/derived — skip vestigial check).
  ignoreColumns?: string[];
}

const PROMOTION_AUDIT: PromotionMap[] = [
  { table: "oura_daily_activity", ignoreRawKeys: ["id", "timestamp", "day", "target_calories", "target_meters", "meters_to_target"] },
  { table: "oura_daily_sleep", ignoreRawKeys: ["id", "timestamp", "day"] },
  // Score columns come from contributors->>'X', not top-level — verifier
  // can't see nested-source columns, list as ignoreColumns instead.
  { table: "oura_daily_readiness", ignoreRawKeys: ["id", "timestamp", "day"], ignoreColumns: ["resting_heart_rate_score", "hrv_balance_score"] },
  { table: "oura_daily_stress", ignoreRawKeys: ["id", "day"] },
  { table: "oura_daily_spo2", ignoreRawKeys: ["id", "day", "spo2_percentage"], ignoreColumns: ["average_spo2"] },
  { table: "oura_daily_resilience", ignoreRawKeys: ["id", "day", "contributors"], ignoreColumns: ["sleep_recovery", "daytime_recovery", "stress"] },
  { table: "oura_daily_cardiovascular_age", ignoreRawKeys: ["id", "day"] },
  { table: "oura_sleep_sessions", ignoreRawKeys: ["id", "day", "app_sleep_phase_5_min", "low_battery_alert", "ring_id", "sleep_algorithm_version", "sleep_analysis_reason", "readiness"], ignoreColumns: ["oura_id"] },
  { table: "oura_workouts", ignoreRawKeys: ["id", "day"], ignoreColumns: ["average_heart_rate", "max_heart_rate", "oura_id"] },
  { table: "oura_sleep_time", ignoreRawKeys: ["id", "day"] },
  { table: "oura_enhanced_tags", ignoreRawKeys: ["id"], ignoreColumns: ["oura_id"] },
  { table: "oura_rest_mode_periods", ignoreRawKeys: ["id"], ignoreColumns: ["oura_id"] },
  // oura_sessions.hrv ← raw_json's heart_rate_variability (Oura uses the long name).
  { table: "oura_sessions", ignoreRawKeys: ["id", "day"], ignoreColumns: ["oura_id", "hrv"] },
  { table: "oura_ring_configurations", ignoreRawKeys: ["id"], ignoreColumns: ["oura_id"] },
  // height/weight in raw_json map to height_m/weight_kg in DB; updated_at is a meta col.
  { table: "oura_personal_info", ignoreRawKeys: ["id", "height", "weight"], ignoreColumns: ["id", "oura_user_id", "weight_kg", "height_m", "updated_at"] },
];

// Map column name → expected raw_json field (when names differ).
const COL_TO_RAW: Record<string, Record<string, string>> = {
  oura_daily_activity: {
    medium_activity_seconds: "medium_activity_time",
    high_activity_seconds: "high_activity_time",
    low_activity_seconds: "low_activity_time",
    sedentary_seconds: "sedentary_time",
    resting_seconds: "resting_time",
    non_wear_seconds: "non_wear_time",
    low_met_minutes: "low_activity_met_minutes",
    medium_met_minutes: "medium_activity_met_minutes",
    high_met_minutes: "high_activity_met_minutes",
    equivalent_walking_distance_m: "equivalent_walking_distance",
    class_5min: "class_5_min",
  },
  oura_sleep_sessions: {
    total_sleep_duration_seconds: "total_sleep_duration",
    time_in_bed_seconds: "time_in_bed",
    awake_seconds: "awake_time",
    latency_seconds: "latency",
    deep_sleep_seconds: "deep_sleep_duration",
    rem_sleep_seconds: "rem_sleep_duration",
    light_sleep_seconds: "light_sleep_duration",
    hrv_5min: "hrv",
    heart_rate_5min: "heart_rate",
    sleep_phase_5min: "sleep_phase_5_min",
    sleep_phase_30sec: "sleep_phase_30_sec",
    movement_30sec: "movement_30_sec",
    sleep_type: "type",
  },
  oura_workouts: {
    duration_seconds: "__computed__", // computed from start/end datetime
    start_time: "start_datetime",
    end_time: "end_datetime",
  },
  oura_sessions: {
    type: "type",
    start_time: "start_datetime",
    end_time: "end_datetime",
    hrv: "heart_rate_variability",
  },
  oura_daily_stress: {
    stress_high_seconds: "stress_high",
    recovery_high_seconds: "recovery_high",
  },
  oura_rest_mode_periods: {
    start_time: "start_time",
    end_time: "end_time",
  },
};

async function checkFieldPromotion(): Promise<void> {
  for (const m of PROMOTION_AUDIT) {
    // Get all raw_json keys (DISTINCT).
    const keys = await pool.query<{ k: string }>(
      `SELECT DISTINCT k FROM ${m.table}, jsonb_object_keys(raw_json) AS k`
    );
    const rawKeys = new Set(keys.rows.map((r) => r.k));

    // Get DB columns (excluding raw_json itself).
    const cols = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = $1 AND column_name != 'raw_json'`,
      [m.table]
    );
    const dbCols = new Set(cols.rows.map((r) => r.column_name));

    const ignoreKeys = new Set(m.ignoreRawKeys ?? []);
    const ignoreCols = new Set(m.ignoreColumns ?? []);
    const colToRaw = COL_TO_RAW[m.table] ?? {};
    // What raw key does each col map to?
    const colsAsRawSources = new Set<string>();
    for (const c of dbCols) {
      colsAsRawSources.add(colToRaw[c] ?? c);
    }

    // raw keys not promoted, not ignored, not the DB column source name.
    const notPromoted: string[] = [];
    for (const k of rawKeys) {
      if (ignoreKeys.has(k)) continue;
      if (colsAsRawSources.has(k)) continue;
      notPromoted.push(k);
    }

    // DB columns with no raw_json source (vestigial).
    const vestigial: string[] = [];
    for (const c of dbCols) {
      if (ignoreCols.has(c)) continue;
      const src = colToRaw[c] ?? c;
      if (src === "__computed__") continue;
      if (!rawKeys.has(src)) vestigial.push(c);
    }

    if (notPromoted.length === 0 && vestigial.length === 0) {
      ok("field promotion", m.table);
    } else {
      const parts: string[] = [];
      if (notPromoted.length) parts.push(`unpromoted keys: ${notPromoted.join(", ")}`);
      if (vestigial.length) parts.push(`vestigial columns (no API source): ${vestigial.join(", ")}`);
      warn("field promotion", m.table, parts.join(" | "));
    }
  }
}

// ─── Section 4: promoted-column correctness ────────────────────────────────

async function checkPromotionCorrectness(): Promise<void> {
  // For each (table, promoted_col, raw_key), check 5 random rows.
  const samples: Array<{ table: string; col: string; rawKey: string; cast: string }> = [
    { table: "oura_sleep_sessions", col: "deep_sleep_seconds", rawKey: "deep_sleep_duration", cast: "int" },
    { table: "oura_sleep_sessions", col: "rem_sleep_seconds", rawKey: "rem_sleep_duration", cast: "int" },
    { table: "oura_sleep_sessions", col: "lowest_heart_rate", rawKey: "lowest_heart_rate", cast: "int" },
    { table: "oura_sleep_sessions", col: "average_breath", rawKey: "average_breath", cast: "numeric" },
    { table: "oura_sleep_sessions", col: "sleep_type", rawKey: "type", cast: "text" },
    { table: "oura_daily_activity", col: "non_wear_seconds", rawKey: "non_wear_time", cast: "int" },
    { table: "oura_daily_activity", col: "high_activity_seconds", rawKey: "high_activity_time", cast: "int" },
    { table: "oura_daily_activity", col: "inactivity_alerts", rawKey: "inactivity_alerts", cast: "int" },
    { table: "oura_daily_readiness", col: "temperature_trend_deviation", rawKey: "temperature_trend_deviation", cast: "double precision" },
    { table: "oura_daily_spo2", col: "breathing_disturbance_index", rawKey: "breathing_disturbance_index", cast: "int" },
  ];

  for (const s of samples) {
    const result = await pool.query<{ mismatches: string }>(
      `SELECT COUNT(*)::text AS mismatches FROM (
         SELECT ${s.col}, (raw_json->>'${s.rawKey}')::${s.cast} AS expected
         FROM ${s.table}
         WHERE ${s.col} IS NOT NULL OR raw_json->>'${s.rawKey}' IS NOT NULL
         ORDER BY RANDOM() LIMIT 20
       ) r WHERE r.${s.col} IS DISTINCT FROM r.expected`
    );
    const mismatches = Number.parseInt(result.rows[0].mismatches, 10);
    if (mismatches === 0) {
      ok("promotion correctness", `${s.table}.${s.col}`, "20 random rows match raw_json");
    } else {
      fail("promotion correctness", `${s.table}.${s.col}`, `${mismatches}/20 mismatches`);
    }
  }
}

// ─── Section 5: continuity / freshness ─────────────────────────────────────

async function checkContinuity(): Promise<void> {
  // Daily sleep is the canonical "ring on" signal. Compute date gaps.
  const gaps = await pool.query<{ first_gap: string; days: string }>(
    `WITH expected AS (
       SELECT generate_series(MIN(day), MAX(day), '1 day')::date AS day FROM oura_daily_sleep
     ),
     missing AS (
       SELECT e.day FROM expected e LEFT JOIN oura_daily_sleep s ON s.day = e.day WHERE s.day IS NULL
     ),
     clusters AS (
       SELECT day, day - (ROW_NUMBER() OVER (ORDER BY day))::int AS grp FROM missing
     )
     SELECT MIN(day)::text AS first_gap, COUNT(*)::text AS days FROM clusters
     GROUP BY grp HAVING COUNT(*) >= 7 ORDER BY days DESC LIMIT 5`
  );
  if (gaps.rows.length === 0) {
    ok("continuity", "daily_sleep gaps ≥7d", "none");
  } else {
    const summary = gaps.rows.map((r) => `${r.first_gap} (${r.days}d)`).join(", ");
    warn("continuity", "daily_sleep gaps ≥7d", summary);
  }

  // Freshness: last day in core tables.
  const fresh = await pool.query<{ tbl: string; last_day: string }>(
    `SELECT 'daily_sleep' AS tbl, MAX(day)::text AS last_day FROM oura_daily_sleep
     UNION ALL SELECT 'daily_activity', MAX(day)::text FROM oura_daily_activity
     UNION ALL SELECT 'sleep_sessions', MAX(day)::text FROM oura_sleep_sessions
     UNION ALL SELECT 'heartrate', MAX(ts)::date::text FROM oura_heartrate`
  );
  for (const row of fresh.rows) {
    const last = new Date(row.last_day);
    const ageDays = Math.floor((Date.now() - last.getTime()) / 86400000);
    if (ageDays <= 2) ok("freshness", row.tbl, `last=${row.last_day}`);
    else if (ageDays <= 7) warn("freshness", row.tbl, `last=${row.last_day} (${ageDays}d ago)`);
    else fail("freshness", row.tbl, `last=${row.last_day} (${ageDays}d ago)`);
  }
}

// ─── Section 6: heartrate density ──────────────────────────────────────────

async function checkHeartrateDensity(): Promise<void> {
  // Per source: rest+awake should hit roughly 5-min interval = 288/day max.
  const result = await pool.query<{ source: string; samples_per_day: string }>(
    `SELECT source, ROUND(AVG(daily.cnt))::text AS samples_per_day FROM (
       SELECT source, ts::date AS d, COUNT(*) AS cnt
       FROM oura_heartrate
       WHERE ts >= CURRENT_DATE - 7
       GROUP BY source, d
     ) daily GROUP BY source`
  );
  for (const r of result.rows) {
    const n = Number.parseInt(r.samples_per_day, 10);
    if (r.source === "rest" || r.source === "awake") {
      if (n >= 50) ok("heartrate density", r.source, `~${n} samples/day (last 7d avg)`);
      else warn("heartrate density", r.source, `only ~${n} samples/day — sparse`);
    } else {
      ok("heartrate density", r.source, `~${n} samples/day`);
    }
  }
}

// ─── Driver ────────────────────────────────────────────────────────────────

const ICON = { ok: "✅", warn: "⚠️ ", fail: "❌" } as const;

async function main(): Promise<void> {
  console.log("Verifying Oura coverage...\n");

  const client = new OuraClient();

  await checkEndpointCoverage();
  await checkRowCountParity(client);
  await checkFieldPromotion();
  await checkPromotionCorrectness();
  await checkContinuity();
  await checkHeartrateDensity();

  // Print grouped report.
  const sections = Array.from(new Set(RESULTS.map((r) => r.section)));
  for (const s of sections) {
    console.log(`\n## ${s}`);
    for (const { check, result } of RESULTS.filter((r) => r.section === s)) {
      const icon = ICON[result.level];
      const msg = result.message ? `  ${result.message}` : "";
      console.log(`${icon} ${check}${msg}`);
    }
  }

  const fails = RESULTS.filter((r) => r.result.level === "fail").length;
  const warns = RESULTS.filter((r) => r.result.level === "warn").length;
  const oks = RESULTS.filter((r) => r.result.level === "ok").length;

  console.log(`\n${oks} ok, ${warns} warn, ${fails} fail`);
  process.exit(fails > 0 ? 1 : 0);
}

main()
  .catch((err) => {
    console.error("Verifier crashed:", err);
    process.exit(2);
  })
  .finally(async () => {
    await pool.end();
  });
