import { pool } from "../../src/db/client.js";
import { seedFixtures } from "../../specs/fixtures/seed.js";
import { beforeEach, afterAll } from "vitest";

beforeEach(async () => {
  await pool.query(
    "TRUNCATE entry_tags, media, tags, entries, daily_metrics, pattern_observations, pattern_relations, pattern_aliases, pattern_entries, chat_messages, chat_soul_state, patterns, api_usage RESTART IDENTITY CASCADE"
  );
  await seedFixtures(pool);
});

afterAll(async () => {
  await pool.end();
});
