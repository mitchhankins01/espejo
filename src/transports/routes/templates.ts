import type { Express } from "express";
import { z } from "zod";
import {
  listTemplates,
  getTemplateById,
  createTemplate,
  updateTemplate,
  deleteTemplate,
} from "../../db/queries.js";
import { requireBearerAuth } from "../middleware/auth.js";
import type { RouteDeps } from "./types.js";

const PROTECTED_SLUGS = new Set(["morning", "evening"]);

export function registerTemplateRoutes(app: Express, deps: RouteDeps): void {
  const { pool, secret } = deps;

  // GET /api/templates
  app.get("/api/templates", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res, secret)) return;
    try {
      const templates = await listTemplates(pool);
      res.json(templates);
    /* v8 ignore next 4 */
    } catch (err) {
      console.error("Template list error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/templates/:id
  app.get("/api/templates/:id", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res, secret)) return;
    try {
      const template = await getTemplateById(pool, req.params.id);
      if (!template) {
        res.status(404).json({ error: "Template not found" });
        return;
      }
      res.json(template);
    /* v8 ignore next 4 */
    } catch (err) {
      console.error("Template get error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/templates
  app.post("/api/templates", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res, secret)) return;
    try {
      const schema = z.object({
        slug: z.string().min(1).max(80),
        name: z.string().min(1).max(100),
        description: z.string().optional(),
        body: z.string().optional(),
        system_prompt: z.string().max(10_000).nullable().optional(),
        default_tags: z.array(z.string()).optional(),
        sort_order: z.number().int().optional(),
      });
      const data = schema.parse(req.body);
      const template = await createTemplate(pool, data);
      res.status(201).json(template);
    /* v8 ignore next 8 */
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: err.errors });
        return;
      }
      console.error("Template create error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // PUT /api/templates/:id
  app.put("/api/templates/:id", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res, secret)) return;
    try {
      const schema = z.object({
        slug: z.string().min(1).max(80).optional(),
        name: z.string().min(1).max(100).optional(),
        description: z.string().optional(),
        body: z.string().optional(),
        system_prompt: z.string().max(10_000).nullable().optional(),
        default_tags: z.array(z.string()).optional(),
        sort_order: z.number().int().optional(),
      });
      const data = schema.parse(req.body);
      // Protect load-bearing slugs from being renamed away
      if (data.slug !== undefined) {
        const existing = await getTemplateById(pool, req.params.id);
        if (existing && PROTECTED_SLUGS.has(existing.slug) && data.slug !== existing.slug) {
          res.status(400).json({ error: `Cannot rename protected template '${existing.slug}'` });
          return;
        }
      }
      const template = await updateTemplate(pool, req.params.id, data);
      if (!template) {
        res.status(404).json({ error: "Template not found" });
        return;
      }
      res.json(template);
    /* v8 ignore next 8 */
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: err.errors });
        return;
      }
      console.error("Template update error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // DELETE /api/templates/:id
  app.delete("/api/templates/:id", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res, secret)) return;
    try {
      // Protect load-bearing templates from deletion
      const existing = await getTemplateById(pool, req.params.id);
      if (existing && PROTECTED_SLUGS.has(existing.slug)) {
        res.status(400).json({ error: `Cannot delete protected template '${existing.slug}'` });
        return;
      }
      const deleted = await deleteTemplate(pool, req.params.id);
      if (!deleted) {
        res.status(404).json({ error: "Template not found" });
        return;
      }
      res.json({ status: "deleted" });
    /* v8 ignore next 4 */
    } catch (err) {
      console.error("Template delete error:", err);
      res.status(500).json({ error: String(err) });
    }
  });
}
