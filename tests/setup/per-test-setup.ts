import { pool } from "../../src/db/client.js";
import { seedFixtures } from "../../specs/fixtures/seed.js";
import { beforeEach, afterAll } from "vitest";

beforeEach(async () => {
  await pool.query(
    "TRUNCATE entry_tags, media, tags, entries RESTART IDENTITY CASCADE"
  );
  await seedFixtures(pool);
});

afterAll(async () => {
  await pool.end();
});
