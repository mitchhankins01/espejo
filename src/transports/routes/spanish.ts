import type { Express } from "express";
import {
  getSpanishQuizStats,
  getSpanishAdaptiveContext,
  getRetentionByInterval,
  getVocabularyFunnel,
  getGradeTrend,
  getLapseRateTrend,
  getProgressTimeSeries,
  getRetentionByContext,
  getLatestSpanishAssessment,
  getSpanishAssessments,
} from "../../db/queries.js";
import type { RouteDeps } from "./types.js";

export function registerSpanishRoutes(app: Express, deps: RouteDeps): void {
  const { pool, secret } = deps;

  app.get("/api/spanish/:chatId/dashboard", async (req, res) => {
    if (secret) {
      const auth = req.headers.authorization;
      if (!auth || !auth.startsWith("Bearer ") || auth.slice(7) !== secret) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
    }

    const chatId = req.params.chatId;
    const days = Math.min(
      Math.max(parseInt(String(req.query.days ?? "90"), 10) || 90, 1),
      365
    );

    try {
      const [
        stats,
        adaptive,
        retention,
        funnel,
        gradeTrend,
        lapseTrend,
        progress,
        contextRetention,
        latestAssessment,
      ] = await Promise.all([
        getSpanishQuizStats(pool, chatId),
        getSpanishAdaptiveContext(pool, chatId),
        getRetentionByInterval(pool, chatId),
        getVocabularyFunnel(pool, chatId),
        getGradeTrend(pool, chatId, days),
        getLapseRateTrend(pool, chatId, days),
        getProgressTimeSeries(pool, chatId, days),
        getRetentionByContext(pool, chatId),
        getLatestSpanishAssessment(pool, chatId),
      ]);

      res.json({
        stats,
        adaptive,
        retention,
        funnel,
        grade_trend: gradeTrend,
        lapse_trend: lapseTrend,
        progress,
        context_retention: contextRetention,
        latest_assessment: latestAssessment,
      });
    } catch (err) {
      console.error("Spanish dashboard error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  app.get("/api/spanish/:chatId/assessments", async (req, res) => {
    if (secret) {
      const auth = req.headers.authorization;
      if (!auth || !auth.startsWith("Bearer ") || auth.slice(7) !== secret) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
    }

    const chatId = req.params.chatId;
    const days = Math.min(
      Math.max(parseInt(String(req.query.days ?? "90"), 10) || 90, 1),
      365
    );

    try {
      const assessments = await getSpanishAssessments(pool, chatId, days);
      res.json(assessments);
    } catch (err) {
      console.error("Spanish assessments error:", err);
      res.status(500).json({ error: String(err) });
    }
  });
}
