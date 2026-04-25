import { pool } from "../../src/db/client.js";
import { seedFixtures } from "../../specs/fixtures/seed.js";
import { beforeEach, afterAll } from "vitest";

beforeEach(async () => {
  await pool.query(
    "TRUNCATE media, entries, daily_metrics, chat_messages, activity_logs, oura_sync_state, oura_sync_runs, oura_daily_sleep, oura_sleep_sessions, oura_daily_readiness, oura_daily_activity, oura_daily_stress, oura_workouts, knowledge_artifact_sources, artifact_links, knowledge_artifacts RESTART IDENTITY CASCADE"
  );
  await seedFixtures(pool);
});

afterAll(async () => {
  await pool.end();
});
