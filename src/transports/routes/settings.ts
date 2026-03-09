import type { Express } from "express";
import { upsertUserSettings } from "../../db/queries.js";
import { config } from "../../config.js";
import { requireBearerAuth } from "../middleware/auth.js";
import type { RouteDeps } from "./types.js";

export function registerSettingsRoutes(app: Express, deps: RouteDeps): void {
  const { pool, secret } = deps;

  // POST /api/settings/timezone — web app auto-sync
  app.post("/api/settings/timezone", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res, secret)) return;

    try {
      const { timezone } = req.body as { timezone?: string };
      if (!timezone || typeof timezone !== "string") {
        res.status(400).json({ error: "timezone is required" });
        return;
      }
      // Validate timezone
      try {
        Intl.DateTimeFormat(undefined, { timeZone: timezone });
      } catch {
        res.status(400).json({ error: `Invalid timezone: ${timezone}` });
        return;
      }
      const chatId = config.telegram.allowedChatId || "0";
      await upsertUserSettings(pool, chatId, { timezone });
      res.json({ status: "ok", timezone });
    } catch (err) {
      console.error("Settings timezone error:", err);
      res.status(500).json({ error: String(err) });
    }
  });
}
