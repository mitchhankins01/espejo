import type pg from "pg";

export interface FixtureEntry {
  uuid: string;
  text: string;
  created_at: string;
  city?: string;
  country?: string;
  place_name?: string;
  admin_area?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
  tags?: string[];
  temperature?: number;
  weather_conditions?: string;
  humidity?: number;
  embedding: number[];
}

// ---------------------------------------------------------------------------
// Embedding generation helpers
//
// We create deterministic 1536-dim vectors using seeded sine patterns. Entries
// about similar topics share a base pattern with small noise added, so cosine
// similarity works correctly in integration tests.
// ---------------------------------------------------------------------------

function generateBaseEmbedding(seed: number): number[] {
  const vec: number[] = [];
  for (let i = 0; i < 1536; i++) {
    vec.push(
      Math.sin(seed * 0.1 + i * 0.01) * 0.5 +
        Math.cos(seed * 0.3 + i * 0.02) * 0.3
    );
  }
  return normalize(vec);
}

function addNoise(base: number[], noiseSeed: number, amount = 0.005): number[] {
  return normalize(
    base.map(
      (v, i) =>
        v + Math.sin(noiseSeed * 7.3 + i * 0.13) * amount
    )
  );
}

function normalize(vec: number[]): number[] {
  const mag = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  return vec.map((v) => v / mag);
}

// Base patterns for different topics
const workStressBase = generateBaseEmbedding(42);
const morningRoutineBase = generateBaseEmbedding(100);
const travelBase = generateBaseEmbedding(200);
const healthBase = generateBaseEmbedding(300);
const reflectionBase = generateBaseEmbedding(400);
const patternNicotineBase = generateBaseEmbedding(500);
const patternSleepBase = generateBaseEmbedding(600);
const patternFactBase = generateBaseEmbedding(700);
const patternEventBase = generateBaseEmbedding(800);

// ---------------------------------------------------------------------------
// Fixture entries
// ---------------------------------------------------------------------------

export const fixtureEntries: FixtureEntry[] = [
  {
    uuid: "ENTRY-001-WORK-STRESS",
    text: "Feeling overwhelmed by the project deadline. The client keeps changing requirements and I can't keep up. My nervous system feels completely shot. I need to set better boundaries around work hours.",
    created_at: "2024-03-15T09:30:00Z",
    city: "Barcelona",
    country: "Spain",
    place_name: "Eixample",
    admin_area: "Catalonia",
    latitude: 41.3851,
    longitude: 2.1734,
    timezone: "Europe/Madrid",
    tags: ["morning-review", "work"],
    temperature: 18,
    weather_conditions: "Partly Cloudy",
    humidity: 65,
    embedding: workStressBase,
  },
  {
    uuid: "ENTRY-002-WORK-BURNOUT",
    text: "Another day of back-to-back meetings. I can feel the burnout creeping in. My body feels wired and I couldn't calm down last night. The dopamine baseline feels crashed. I need to seriously reconsider how I'm spending my energy.",
    created_at: "2024-03-20T21:00:00Z",
    city: "Barcelona",
    country: "Spain",
    place_name: "Gracia",
    admin_area: "Catalonia",
    latitude: 41.4035,
    longitude: 2.1567,
    timezone: "Europe/Madrid",
    tags: ["evening-review", "work", "burnout"],
    temperature: 16,
    weather_conditions: "Clear",
    humidity: 55,
    embedding: addNoise(workStressBase, 1),
  },
  {
    uuid: "ENTRY-003-MORNING-ROUTINE",
    text: "Woke up at 6am, did the cold plunge and 20 minutes of breathwork. Journaling feels clearer when I do it first thing. The morning sunlight protocol is really helping with my circadian rhythm. Feeling grounded and present.",
    created_at: "2024-06-15T06:30:00Z",
    city: "San Diego",
    country: "United States",
    place_name: "North Park",
    admin_area: "California",
    latitude: 32.7465,
    longitude: -117.1297,
    timezone: "America/Los_Angeles",
    tags: ["morning-review", "health", "routine"],
    temperature: 22,
    weather_conditions: "Sunny",
    humidity: 70,
    embedding: morningRoutineBase,
  },
  {
    uuid: "ENTRY-004-MORNING-SIMPLE",
    text: "Quick morning entry. Coffee, sunlight, a few pages of reading. Simple but effective start. The routine is becoming automatic now which is exactly what I wanted.",
    created_at: "2023-06-15T07:00:00Z",
    city: "San Diego",
    country: "United States",
    place_name: "Hillcrest",
    admin_area: "California",
    latitude: 32.7488,
    longitude: -117.1617,
    timezone: "America/Los_Angeles",
    tags: ["morning-review"],
    temperature: 20,
    weather_conditions: "Sunny",
    humidity: 68,
    embedding: addNoise(morningRoutineBase, 2),
  },
  {
    uuid: "ENTRY-005-TRAVEL-BARCELONA",
    text: "First full day in Barcelona. Walked through the Gothic Quarter and had lunch at a tiny place in El Born. The architecture here is unreal. Gaudi's work hits different in person. Feeling alive and curious in a way I haven't in months.",
    created_at: "2024-10-22T19:00:00Z",
    city: "Barcelona",
    country: "Spain",
    place_name: "El Born",
    admin_area: "Catalonia",
    latitude: 41.3851,
    longitude: 2.1821,
    timezone: "Europe/Madrid",
    tags: ["travel", "barcelona"],
    temperature: 21,
    weather_conditions: "Sunny",
    humidity: 58,
    embedding: travelBase,
  },
  {
    uuid: "ENTRY-006-HEALTH-NICOTINE",
    text: "Woke up feeling depleted. The nicotine yesterday definitely crashed my dopamine baseline. Readiness score was 34 which tracks. Need to remember that the short-term focus boost isn't worth the next-day crash. My nervous system dysregulation is real.",
    created_at: "2025-01-10T08:00:00Z",
    city: "Barcelona",
    country: "Spain",
    place_name: "Eixample",
    admin_area: "Catalonia",
    latitude: 41.3888,
    longitude: 2.1700,
    timezone: "Europe/Madrid",
    tags: ["morning-review", "nicotine", "health"],
    temperature: 10,
    weather_conditions: "Overcast",
    humidity: 75,
    embedding: healthBase,
  },
  {
    uuid: "ENTRY-007-REFLECTION",
    text: "Looking back at the past year, I've grown more than I give myself credit for. The move to Spain, starting the freelance work, building healthier habits. It hasn't been linear but the trajectory is clearly upward. Grateful for the discomfort that pushed me here.",
    created_at: "2024-12-31T23:00:00Z",
    city: "Barcelona",
    country: "Spain",
    place_name: "Eixample",
    admin_area: "Catalonia",
    latitude: 41.3870,
    longitude: 2.1690,
    timezone: "Europe/Madrid",
    tags: ["reflection", "year-review"],
    temperature: 12,
    weather_conditions: "Clear",
    humidity: 60,
    embedding: reflectionBase,
  },
  {
    uuid: "ENTRY-008-HEALTH-SLEEP",
    text: "Sleep has been terrible this week. HRV dropped to 15ms last night. I think it's the combination of late screen time and the espresso after 2pm. Going to commit to a hard cutoff: no caffeine after noon, no screens after 9pm. My body is begging me to listen.",
    created_at: "2025-03-15T07:30:00Z",
    city: "San Diego",
    country: "United States",
    place_name: "North Park",
    admin_area: "California",
    latitude: 32.7465,
    longitude: -117.1297,
    timezone: "America/Los_Angeles",
    tags: ["health", "sleep", "morning-review"],
    temperature: 16,
    weather_conditions: "Foggy",
    humidity: 85,
    embedding: addNoise(healthBase, 3),
  },
  {
    uuid: "ENTRY-009-NO-METADATA",
    text: "Just a quick thought dump. Sometimes you don't need a prompt or a template. Just get the words out of your head and onto the page.",
    created_at: "2024-08-01T14:00:00Z",
    embedding: addNoise(reflectionBase, 4),
  },
  {
    uuid: "ENTRY-010-TRAVEL-LISBON",
    text: "Lisbon is a city that rewards wandering. Got lost in Alfama for three hours and stumbled into the best pasteis de nata of my life. The light here is golden, especially in the late afternoon. Very different energy from Barcelona but equally inspiring.",
    created_at: "2024-10-28T18:00:00Z",
    city: "Lisbon",
    country: "Portugal",
    place_name: "Alfama",
    admin_area: "Lisboa",
    latitude: 38.7139,
    longitude: -9.1337,
    timezone: "Europe/Lisbon",
    tags: ["travel"],
    temperature: 19,
    weather_conditions: "Sunny",
    humidity: 52,
    embedding: addNoise(travelBase, 5),
  },
];

// ---------------------------------------------------------------------------
// Pattern fixtures for testing pattern memory
// ---------------------------------------------------------------------------

export interface FixturePattern {
  content: string;
  kind: string;
  confidence: number;
  strength: number;
  times_seen: number;
  status: string;
  embedding: number[];
  first_seen: string;
  last_seen: string;
}

export const fixturePatterns: FixturePattern[] = [
  {
    content:
      "User's dopamine baseline crashes after nicotine use, causing next-day depletion and low readiness scores.",
    kind: "causal",
    confidence: 0.85,
    strength: 3.5,
    times_seen: 4,
    status: "active",
    embedding: patternNicotineBase,
    first_seen: "2024-06-01T10:00:00Z",
    last_seen: "2025-01-10T08:00:00Z",
  },
  {
    content:
      "User experiences poor sleep when consuming caffeine after 2pm or using screens after 9pm.",
    kind: "behavior",
    confidence: 0.75,
    strength: 2.0,
    times_seen: 3,
    status: "active",
    embedding: patternSleepBase,
    first_seen: "2024-09-15T07:00:00Z",
    last_seen: "2025-03-15T07:30:00Z",
  },
  {
    content:
      "User feels grounded and present after completing morning routine (cold plunge, breathwork, journaling).",
    kind: "behavior",
    confidence: 0.9,
    strength: 5.0,
    times_seen: 8,
    status: "active",
    embedding: addNoise(patternNicotineBase, 10),
    first_seen: "2024-03-01T06:00:00Z",
    last_seen: "2025-02-01T07:00:00Z",
  },
  {
    content: "User's partner is named Ana.",
    kind: "fact",
    confidence: 0.95,
    strength: 2.5,
    times_seen: 3,
    status: "active",
    embedding: patternFactBase,
    first_seen: "2024-04-01T10:00:00Z",
    last_seen: "2025-01-12T10:00:00Z",
  },
  {
    content: "User moved to Barcelona in early 2024.",
    kind: "event",
    confidence: 0.88,
    strength: 2.0,
    times_seen: 2,
    status: "active",
    embedding: patternEventBase,
    first_seen: "2024-02-15T10:00:00Z",
    last_seen: "2024-12-31T23:00:00Z",
  },
];

// ---------------------------------------------------------------------------
// Seed function for test setup
// ---------------------------------------------------------------------------

export async function seedFixtures(pool: pg.Pool): Promise<void> {
  for (const entry of fixtureEntries) {
    // Insert entry
    const embeddingStr = `[${entry.embedding.join(",")}]`;
    const result = await pool.query(
      `INSERT INTO entries (
        uuid, text, created_at, city, country, place_name, admin_area,
        latitude, longitude, timezone,
        temperature, weather_conditions, humidity, embedding
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14::vector
      ) RETURNING id`,
      [
        entry.uuid,
        entry.text,
        entry.created_at,
        entry.city ?? null,
        entry.country ?? null,
        entry.place_name ?? null,
        entry.admin_area ?? null,
        entry.latitude ?? null,
        entry.longitude ?? null,
        entry.timezone ?? null,
        entry.temperature ?? null,
        entry.weather_conditions ?? null,
        entry.humidity ?? null,
        embeddingStr,
      ]
    );

    const entryId = result.rows[0].id as number;

    // Insert tags
    if (entry.tags && entry.tags.length > 0) {
      for (const tag of entry.tags) {
        await pool.query(
          `INSERT INTO tags (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
          [tag]
        );
        const tagResult = await pool.query(
          `SELECT id FROM tags WHERE name = $1`,
          [tag]
        );
        const tagId = tagResult.rows[0].id as number;
        await pool.query(
          `INSERT INTO entry_tags (entry_id, tag_id) VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [entryId, tagId]
        );
      }
    }
  }

  // Seed daily_metrics (weight data for some entry dates — not all)
  const weightFixtures = [
    { date: "2024-03-15", weight_kg: 82.3 },
    { date: "2024-03-20", weight_kg: 82.1 },
    { date: "2024-06-15", weight_kg: 81.5 },
    { date: "2025-01-10", weight_kg: 80.5 },
    { date: "2025-03-15", weight_kg: 79.8 },
  ];

  for (const w of weightFixtures) {
    await pool.query(
      `INSERT INTO daily_metrics (date, weight_kg) VALUES ($1, $2)`,
      [w.date, w.weight_kg]
    );
  }

  const ouraFixtures = [
    { day: "2025-03-13", sleep: 78, readiness: 74, activity: 69, steps: 8234, hrv: 42, hr: 56, duration: 26100, deep: 4200, rem: 5400, efficiency: 91 },
    { day: "2025-03-14", sleep: 81, readiness: 77, activity: 72, steps: 9560, hrv: 45, hr: 55, duration: 26820, deep: 4500, rem: 5700, efficiency: 92 },
    { day: "2025-03-15", sleep: 75, readiness: 70, activity: 66, steps: 7020, hrv: 39, hr: 58, duration: 24600, deep: 3900, rem: 5100, efficiency: 88 },
  ];
  for (const o of ouraFixtures) {
    await pool.query(`INSERT INTO oura_daily_sleep (day, score, total_sleep_duration_seconds, deep_sleep_duration_seconds, rem_sleep_duration_seconds, light_sleep_duration_seconds, efficiency, contributors, raw_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [o.day, o.sleep, o.duration, o.deep, o.rem, o.duration - o.deep - o.rem, o.efficiency, {}, { day: o.day }]);
    await pool.query(`INSERT INTO oura_daily_readiness (day, score, temperature_deviation, resting_heart_rate, hrv_balance, contributors, raw_json) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [o.day, o.readiness, 0.1, o.hr, o.hrv, {}, { day: o.day }]);
    await pool.query(`INSERT INTO oura_daily_activity (day, score, steps, active_calories, total_calories, medium_activity_seconds, high_activity_seconds, low_activity_seconds, raw_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [o.day, o.activity, o.steps, 600, 2200, 1800, 900, 6000, { day: o.day }]);
    await pool.query(`INSERT INTO oura_daily_stress (day, stress_high_seconds, recovery_high_seconds, day_summary, raw_json) VALUES ($1,$2,$3,$4,$5)`, [o.day, 7200, 5400, "normal", { day: o.day }]);
    await pool.query(`INSERT INTO oura_sleep_sessions (oura_id, day, period, average_hrv, average_heart_rate, total_sleep_duration_seconds, efficiency, raw_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [`sleep-${o.day}`, o.day, 0, o.hrv, o.hr, o.duration, o.efficiency, { day: o.day }]);
    await pool.query(`INSERT INTO oura_workouts (oura_id, day, activity, calories, distance, duration_seconds, average_heart_rate, max_heart_rate, raw_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [`workout-${o.day}`, o.day, "running", 450, 6.2, 2400, 132, 164, { day: o.day }]);
  }

  // Seed patterns
  for (const pattern of fixturePatterns) {
    const embeddingStr = `[${pattern.embedding.join(",")}]`;
    await pool.query(
      `INSERT INTO patterns (
        content, kind, confidence, embedding, strength, times_seen, status,
        first_seen, last_seen
      ) VALUES ($1, $2, $3, $4::vector, $5, $6, $7, $8, $9)`,
      [
        pattern.content,
        pattern.kind,
        pattern.confidence,
        embeddingStr,
        pattern.strength,
        pattern.times_seen,
        pattern.status,
        pattern.first_seen,
        pattern.last_seen,
      ]
    );
  }
}
