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
  starred?: boolean;
  is_pinned?: boolean;
  template_name?: string;
  tags?: string[];
  temperature?: number;
  weather_conditions?: string;
  humidity?: number;
  user_activity?: string;
  step_count?: number;
  editing_time?: number;
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

function addNoise(base: number[], noiseSeed: number, amount = 0.05): number[] {
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
    starred: true,
    tags: ["morning-review", "work"],
    temperature: 18,
    weather_conditions: "Partly Cloudy",
    humidity: 65,
    user_activity: "Stationary",
    step_count: 2100,
    editing_time: 180,
    template_name: "5 Minute AM",
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
    starred: false,
    tags: ["evening-review", "work", "burnout"],
    temperature: 16,
    weather_conditions: "Clear",
    humidity: 55,
    editing_time: 240,
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
    starred: true,
    tags: ["morning-review", "health", "routine"],
    temperature: 22,
    weather_conditions: "Sunny",
    humidity: 70,
    user_activity: "Walking",
    step_count: 8432,
    template_name: "5 Minute AM",
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
    starred: false,
    tags: ["morning-review"],
    temperature: 20,
    weather_conditions: "Sunny",
    humidity: 68,
    template_name: "5 Minute AM",
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
    starred: true,
    tags: ["travel", "barcelona"],
    temperature: 21,
    weather_conditions: "Sunny",
    humidity: 58,
    user_activity: "Walking",
    step_count: 18234,
    editing_time: 300,
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
    starred: false,
    tags: ["morning-review", "nicotine", "health"],
    temperature: 10,
    weather_conditions: "Overcast",
    humidity: 75,
    user_activity: "Stationary",
    step_count: 1200,
    template_name: "5 Minute AM",
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
    starred: true,
    tags: ["reflection", "year-review"],
    temperature: 12,
    weather_conditions: "Clear",
    humidity: 60,
    editing_time: 600,
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
    starred: false,
    tags: ["health", "sleep", "morning-review"],
    temperature: 16,
    weather_conditions: "Foggy",
    humidity: 85,
    user_activity: "Stationary",
    step_count: 500,
    template_name: "5 Minute AM",
    embedding: addNoise(healthBase, 3),
  },
  {
    uuid: "ENTRY-009-NO-METADATA",
    text: "Just a quick thought dump. Sometimes you don't need a prompt or a template. Just get the words out of your head and onto the page.",
    created_at: "2024-08-01T14:00:00Z",
    starred: false,
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
    starred: false,
    tags: ["travel"],
    temperature: 19,
    weather_conditions: "Sunny",
    humidity: 52,
    user_activity: "Walking",
    step_count: 22000,
    editing_time: 200,
    embedding: addNoise(travelBase, 5),
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
        latitude, longitude, timezone, starred, is_pinned, template_name,
        temperature, weather_conditions, humidity, user_activity, step_count,
        editing_time, embedding
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
        $14, $15, $16, $17, $18, $19, $20::vector
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
        entry.starred ?? false,
        entry.is_pinned ?? false,
        entry.template_name ?? null,
        entry.temperature ?? null,
        entry.weather_conditions ?? null,
        entry.humidity ?? null,
        entry.user_activity ?? null,
        entry.step_count ?? null,
        entry.editing_time ?? null,
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
}
