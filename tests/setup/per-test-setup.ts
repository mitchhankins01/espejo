import { pool } from "../../src/db/client.js";
import { seedFixtures } from "../../specs/fixtures/seed.js";
import { beforeEach, afterAll } from "vitest";

beforeEach(async () => {
  await pool.query(
    "TRUNCATE entry_tags, media, tags, entries, daily_metrics, pattern_observations, pattern_relations, pattern_aliases, pattern_entries, chat_messages, chat_soul_state, patterns, api_usage, memory_retrieval_logs, cost_notifications, soul_quality_signals, pulse_checks, soul_state_history, spanish_profiles, spanish_verbs, spanish_vocabulary, spanish_reviews, spanish_progress, activity_logs, spanish_assessments, oura_sync_state, oura_sync_runs, oura_daily_sleep, oura_sleep_sessions, oura_daily_readiness, oura_daily_activity, oura_daily_stress, oura_workouts RESTART IDENTITY CASCADE"
  );
  await seedFixtures(pool);
});

afterAll(async () => {
  await pool.end();
});
