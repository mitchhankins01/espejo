import type { Express } from "express";
import { z } from "zod";
import {
  listObservableTables,
  listObservableTableRows,
  listRecentDbChanges,
  isObservableDbTableName,
} from "../../db/queries.js";
import { requireBearerAuth } from "../middleware/auth.js";
import type { RouteDeps } from "./types.js";

export function registerObservabilityRoutes(app: Express, deps: RouteDeps): void {
  const { pool, secret } = deps;

  const timestampParamSchema = z.string().datetime({ offset: true });

  // GET /api/db/tables - observable table metadata
  app.get("/api/db/tables", async (req, res) => {
    if (!requireBearerAuth(req, res, secret)) return;

    try {
      const tables = await listObservableTables(pool);
      res.json(tables);
    } catch (err) {
      console.error("DB observability tables error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/db/tables/:table/rows - paginated rows for one allowlisted table
  app.get("/api/db/tables/:table/rows", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res, secret)) return;

    /* v8 ignore next */
    const table = String(req.params.table ?? "");
    if (!isObservableDbTableName(table)) {
      res.status(400).json({ error: `Unsupported table: ${table}` });
      return;
    }

    const from = req.query.from ? String(req.query.from) : undefined;
    /* v8 ignore next */
    const to = req.query.to ? String(req.query.to) : undefined;
    if (from && !timestampParamSchema.safeParse(from).success) {
      res.status(400).json({ error: "from must be an ISO timestamp with timezone" });
      return;
    }
    /* v8 ignore next 4 */
    if (to && !timestampParamSchema.safeParse(to).success) {
      res.status(400).json({ error: "to must be an ISO timestamp with timezone" });
      return;
    }

    const orderRaw = String(req.query.order ?? "desc").toLowerCase();
    const order = orderRaw === "asc" ? "asc" : orderRaw === "desc" ? "desc" : null;
    if (!order) {
      res.status(400).json({ error: "order must be asc or desc" });
      return;
    }

    try {
      /* v8 ignore next 4 */
      const limit = Math.min(
        Math.max(parseInt(String(req.query.limit ?? "50"), 10) || 50, 1),
        200
      );
      /* v8 ignore next */
      const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);
      const sort = req.query.sort ? String(req.query.sort) : undefined;
      const q = req.query.q ? String(req.query.q) : undefined;

      const rows = await listObservableTableRows(pool, table, {
        limit,
        offset,
        sort,
        order,
        q,
        from,
        to,
      });
      res.json(rows);
    } catch (err) {
      const message = String(err);
      /* v8 ignore next 4 */
      if (message.includes("Unsupported")) {
        res.status(400).json({ error: message });
        return;
      }
      /* v8 ignore next 3 */
      console.error("DB observability rows error:", err);
      res.status(500).json({ error: message });
    }
  });

  // GET /api/db/changes - merged inferred change feed + tool-call activity
  app.get("/api/db/changes", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res, secret)) return;

    const tableParam = req.query.table ? String(req.query.table) : undefined;
    if (tableParam && !isObservableDbTableName(tableParam)) {
      res.status(400).json({ error: `Unsupported table: ${tableParam}` });
      return;
    }
    const table = tableParam && isObservableDbTableName(tableParam)
      ? tableParam
      : undefined;
    const operationRaw = req.query.operation
      ? String(req.query.operation).toLowerCase()
      : undefined;
    const operation = operationRaw && ["insert", "update", "delete", "tool_call"].includes(operationRaw)
      ? operationRaw as "insert" | "update" | "delete" | "tool_call"
      : undefined;
    if (operationRaw && !operation) {
      res.status(400).json({
        error: "operation must be one of insert, update, delete, tool_call",
      });
      return;
    }

    const since = req.query.since ? String(req.query.since) : undefined;
    if (since && !timestampParamSchema.safeParse(since).success) {
      res.status(400).json({ error: "since must be an ISO timestamp with timezone" });
      return;
    }

    try {
      /* v8 ignore next 4 */
      const limit = Math.min(
        Math.max(parseInt(String(req.query.limit ?? "100"), 10) || 100, 1),
        500
      );
      const changes = await listRecentDbChanges(pool, {
        limit,
        since: since ? new Date(since) : undefined,
        table,
        operation,
      });
      res.json(changes);
    } catch (err) {
      console.error("DB observability changes error:", err);
      res.status(500).json({ error: String(err) });
    }
  });
}
