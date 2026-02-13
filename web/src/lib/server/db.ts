import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is required. Set it in your environment or .env file."
  );
}

export const pool = new pg.Pool({ connectionString: databaseUrl });
