import type { Express } from "express";
import { z } from "zod";
import {
  upsertWeight,
  deleteWeight,
  listWeights,
  getWeightPatterns,
} from "../../db/queries.js";
import { requireBearerAuth } from "../middleware/auth.js";
import type { RouteDeps } from "./types.js";

export function registerWeightRoutes(app: Express, deps: RouteDeps): void {
  const { pool, secret } = deps;

  const dateParamSchema = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format");
  const weightBodySchema = z.object({
    weight_kg: z.number().positive(),
  });

  // GET /api/weights - list weight history with optional range/pagination
  app.get("/api/weights", async (req, res) => {
    if (!requireBearerAuth(req, res, secret)) return;

    const from = req.query.from ? String(req.query.from) : undefined;
    const to = req.query.to ? String(req.query.to) : undefined;
    if (from && !dateParamSchema.safeParse(from).success) {
      res.status(400).json({ error: "from must be YYYY-MM-DD" });
      return;
    }
    if (to && !dateParamSchema.safeParse(to).success) {
      res.status(400).json({ error: "to must be YYYY-MM-DD" });
      return;
    }

    try {
      const limit = Math.min(
        Math.max(parseInt(String(req.query.limit ?? "100"), 10) || 100, 1),
        1000
      );
      const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);
      const { rows, count } = await listWeights(pool, { from, to, limit, offset });
      res.json({ items: rows, total: count });
    } catch (err) {
      console.error("Weight list error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/weights/patterns - aggregate trend and consistency metrics
  app.get("/api/weights/patterns", async (req, res) => {
    if (!requireBearerAuth(req, res, secret)) return;

    const from = req.query.from ? String(req.query.from) : undefined;
    const to = req.query.to ? String(req.query.to) : undefined;
    if (from && !dateParamSchema.safeParse(from).success) {
      res.status(400).json({ error: "from must be YYYY-MM-DD" });
      return;
    }
    if (to && !dateParamSchema.safeParse(to).success) {
      res.status(400).json({ error: "to must be YYYY-MM-DD" });
      return;
    }

    try {
      const patterns = await getWeightPatterns(pool, { from, to });
      const latest = patterns.latest
        ? {
          date: patterns.latest.date.toISOString().slice(0, 10),
          weight_kg: patterns.latest.weight_kg,
        }
        : null;

      res.json({
        ...patterns,
        latest,
      });
    } catch (err) {
      console.error("Weight patterns error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // PUT /api/weights/:date - upsert a single daily weight value
  app.put("/api/weights/:date", async (req, res) => {
    if (!requireBearerAuth(req, res, secret)) return;

    const dateParsed = dateParamSchema.safeParse(req.params.date);
    if (!dateParsed.success) {
      res.status(400).json({ error: dateParsed.error.issues });
      return;
    }
    const bodyParsed = weightBodySchema.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({ error: bodyParsed.error.issues });
      return;
    }

    try {
      const saved = await upsertWeight(pool, dateParsed.data, bodyParsed.data.weight_kg);
      res.json(saved);
    } catch (err) {
      console.error("Weight upsert error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // DELETE /api/weights/:date - remove a single daily weight value
  app.delete("/api/weights/:date", async (req, res) => {
    if (!requireBearerAuth(req, res, secret)) return;

    const dateParsed = dateParamSchema.safeParse(req.params.date);
    if (!dateParsed.success) {
      res.status(400).json({ error: dateParsed.error.issues });
      return;
    }

    try {
      const deleted = await deleteWeight(pool, dateParsed.data);
      if (!deleted) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.json({ status: "deleted" });
    } catch (err) {
      console.error("Weight delete error:", err);
      res.status(500).json({ error: String(err) });
    }
  });
}
