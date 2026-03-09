import type { Express } from "express";
import {
  getActivityLog,
  getRecentActivityLogs,
} from "../../db/queries.js";
import type { RouteDeps } from "./types.js";

export function registerActivityRoutes(app: Express, deps: RouteDeps): void {
  const { pool, secret } = deps;

  // Activity log endpoints — bearer token auth (same as /api/metrics)
  app.get("/api/activity", async (req, res) => {
    if (secret) {
      const auth = req.headers.authorization;
      if (!auth || !auth.startsWith("Bearer ") || auth.slice(7) !== secret) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
    }

    try {
      const limit = Math.min(
        Math.max(parseInt(String(req.query.limit ?? "20"), 10) || 20, 1),
        100
      );
      const since = req.query.since
        ? new Date(String(req.query.since))
        : undefined;
      const toolName = req.query.tool ? String(req.query.tool) : undefined;

      const logs = await getRecentActivityLogs(pool, {
        toolName,
        since,
        limit,
      });
      res.json(logs);
    } catch (err) {
      console.error("Activity log list error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  app.get("/api/activity/:id", async (req, res) => {
    if (secret) {
      const auth = req.headers.authorization;
      const queryToken = req.query.token;
      if (queryToken === secret) {
        // Allow token-based auth via query param (for Telegram detail links)
      } else if (!auth || !auth.startsWith("Bearer ") || auth.slice(7) !== secret) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
    }

    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        res.status(400).json({ error: "Invalid ID" });
        return;
      }
      const log = await getActivityLog(pool, id);
      if (!log) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.json(log);
    } catch (err) {
      console.error("Activity log error:", err);
      res.status(500).json({ error: String(err) });
    }
  });
}
