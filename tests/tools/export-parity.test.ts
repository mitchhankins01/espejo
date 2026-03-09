import { describe, it, expect } from "vitest";
import * as queries from "../../src/db/queries.js";
import * as analysis from "../../src/oura/analysis.js";

/**
 * Phase 0 guardrail: export-parity tests.
 *
 * These tests snapshot the public API of modules being refactored.
 * If a re-export facade drops a symbol, the test fails immediately.
 */

describe("queries.ts export parity", () => {
  // Capture all exported names (both types — which won't appear at runtime — and values)
  const runtimeExports = Object.keys(queries).sort();

  it("exports all expected runtime symbols", () => {
    const expected = [
      // Entry types are compile-time only, but these functions/constants must exist at runtime:
      "searchEntries",
      "getEntryByUuid",
      "getEntriesByDateRange",
      "getEntriesOnThisDay",
      "findSimilarEntries",
      "listTags",
      "getEntryStats",
      "upsertDailyMetric",
      "getWeightByDate",
      "upsertWeight",
      "deleteWeight",
      "listWeights",
      "getWeightPatterns",
      "getSpanishProfile",
      "upsertSpanishProfile",
      "getVerbConjugations",
      "upsertSpanishVocabulary",
      "getSpanishVocabularyById",
      "getDueSpanishVocabulary",
      "getRecentSpanishVocabulary",
      "updateSpanishVocabularySchedule",
      "insertSpanishReview",
      "getSpanishQuizStats",
      "getSpanishAdaptiveContext",
      "upsertSpanishProgressSnapshot",
      "getLatestSpanishProgress",
      "getRetentionByInterval",
      "getVocabularyFunnel",
      "getGradeTrend",
      "getLapseRateTrend",
      "getProgressTimeSeries",
      "getRetentionByContext",
      "insertSpanishAssessment",
      "getSpanishAssessments",
      "getLatestSpanishAssessment",
      "insertChatMessage",
      "getRecentMessages",
      "markMessagesCompacted",
      "purgeCompactedMessages",
      "getLastCompactionTime",
      "getSoulState",
      "upsertSoulState",
      "insertPattern",
      "reinforcePattern",
      "deprecatePattern",
      "updatePatternStatus",
      "findSimilarPatterns",
      "searchPatterns",
      "textSearchPatterns",
      "searchPatternsHybrid",
      "getLanguagePreferencePatterns",
      "getTopPatterns",
      "pruneExpiredEventPatterns",
      "countStaleEventPatterns",
      "getPatternStats",
      "getStalePatterns",
      "findSimilarPatternPairs",
      "enforceActivePatternCap",
      "insertPatternObservation",
      "insertPatternRelation",
      "insertPatternAlias",
      "linkPatternToEntry",
      "logApiUsage",
      "getUsageSummary",
      "getTotalApiCostSince",
      "getLastCostNotificationTime",
      "insertCostNotification",
      "logMemoryRetrieval",
      "insertSoulQualitySignal",
      "getSoulQualityStats",
      "getLastAssistantMessageId",
      "insertPulseCheck",
      "getLastPulseCheckTime",
      "getLastPulseCheck",
      "insertSoulStateHistory",
      "insertActivityLog",
      "getActivityLog",
      "getRecentActivityLogs",
      "OBSERVABLE_DB_TABLES",
      "isObservableDbTableName",
      "listObservableTables",
      "listObservableTableRows",
      "listRecentDbChanges",
      "insertOuraSyncRun",
      "completeOuraSyncRun",
      "getOuraSyncRun",
      "upsertOuraSyncState",
      "upsertOuraDailySleep",
      "upsertOuraSleepSession",
      "upsertOuraDailyReadiness",
      "upsertOuraDailyActivity",
      "upsertOuraDailyStress",
      "upsertOuraWorkout",
      "getOuraSummaryByDay",
      "getOuraWeeklyRows",
      "getOuraTrendMetric",
      "getOuraTrendMetricForRange",
      "getOuraSleepDetailForRange",
      "getOuraTemperatureData",
      "normalizeTags",
      "listArtifactTags",
      "listArtifactTitles",
      "resolveArtifactTitleToId",
      "syncExplicitLinks",
      "getExplicitLinks",
      "getExplicitBacklinks",
      "findSimilarArtifacts",
      "createArtifact",
      "updateArtifact",
      "deleteArtifact",
      "getArtifactById",
      "listArtifacts",
      "countArtifacts",
      "searchArtifacts",
      "searchArtifactsKeyword",
      "searchContent",
      "getArtifactGraph",
      "searchEntriesForPicker",
      "listTodos",
      "getTodoById",
      "createTodo",
      "updateTodo",
      "completeTodo",
      "setTodoFocus",
      "getFocusTodo",
      "deleteTodo",
      "insertInsight",
      "insightHashExists",
      "countInsightsNotifiedToday",
      "markInsightNotified",
      "findTemporalEchoes",
      "findStaleTodos",
      "getUserSettings",
      "upsertUserSettings",
      "insertCheckin",
      "getLastCheckinForWindow",
      "markCheckinResponded",
      "markCheckinsIgnored",
      "getConsecutiveIgnoredCount",
      "findOrCreateDailyLogArtifact",
      "appendToDailyLog",
      "createEntry",
      "updateEntry",
      "deleteEntry",
      "listEntries",
      "insertMedia",
      "getMediaForEntry",
      "deleteMedia",
      "updateEntryEmbeddingIfVersionMatches",
      "listTemplates",
      "getTemplateById",
      "createTemplate",
      "updateTemplate",
      "deleteTemplate",
      "getEntryIdByUuid",
      "getTemplateBySlug",
    ].sort();

    for (const name of expected) {
      expect(runtimeExports, `Missing export: ${name}`).toContain(name);
    }
  });

  it("does not accidentally drop exports during refactor", () => {
    // Snapshot the count — if it drops, something was removed
    expect(runtimeExports.length).toBeGreaterThanOrEqual(expected_count());
  });
});

// Keep this in sync — update when intentionally adding/removing exports
function expected_count(): number {
  // Current runtime export count (functions + constants, not types/interfaces)
  return 156;
}

describe("oura/analysis.ts export parity", () => {
  const runtimeExports = Object.keys(analysis).sort();

  it("exports all expected runtime symbols", () => {
    const expected = [
      "mean",
      "standardDeviation",
      "sampleStandardDeviation",
      "quantile",
      "min",
      "max",
      "rollingAverages",
      "rollingAverageNumeric",
      "trend",
      "detectOutliersIQR",
      "detectOutliersZScore",
      "detectOutliers",
      "correlate",
      "dispersion",
      "gaussianSmooth",
      "movingAverage",
      "dayOfWeekAnalysis",
      "sleepDebt",
      "sleepRegularity",
      "sleepStageRatios",
      "computeSleepScore",
      "hrvRecoveryPattern",
      "linearTrend",
      "rollingAverage",
      "pearsonCorrelation",
      "percentage",
    ].sort();

    for (const name of expected) {
      expect(runtimeExports, `Missing export: ${name}`).toContain(name);
    }
  });
});
