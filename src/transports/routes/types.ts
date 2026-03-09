import type pg from "pg";

export interface RouteDeps {
  pool: pg.Pool;
  secret: string;
}
