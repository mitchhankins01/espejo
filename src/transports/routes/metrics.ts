import type { Express } from "express";
import { z } from "zod";
import { upsertDailyMetric } from "../../db/queries.js";
import type { RouteDeps } from "./types.js";

export function registerMetricsRoutes(app: Express, deps: RouteDeps): void {
  const { pool, secret } = deps;

  // Legacy metrics ingestion endpoint - kept for compatibility.
  // New web weight logging uses /api/weights.
  // Accepts a single object OR an array of objects for batch ingestion
  const metricItemSchema = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format"),
    weight_kg: z.number().positive(),
  });
  const metricsBodySchema = z.union([
    metricItemSchema,
    z.array(metricItemSchema).min(1),
  ]);

  app.post("/api/metrics", async (req, res) => {
    // Bearer token auth (same MCP_SECRET)
    if (secret) {
      const auth = req.headers.authorization;
      if (!auth || !auth.startsWith("Bearer ") || auth.slice(7) !== secret) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
    }

    const parsed = metricsBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues });
      return;
    }

    const items = Array.isArray(parsed.data) ? parsed.data : [parsed.data];

    try {
      for (const item of items) {
        await upsertDailyMetric(pool, item.date, item.weight_kg);
      }
      res.json({ status: "ok", count: items.length, items });
    } catch (err) {
      console.error("Metrics upsert error:", err);
      res.status(500).json({ error: String(err) });
    }
  });
}
