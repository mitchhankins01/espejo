import OpenAI from "openai";
import { z } from "zod";
import type pg from "pg";
import { config } from "../config.js";
import { upsertDailyScreenTime } from "../db/queries/daily-screen-time.js";
import { logUsage } from "../db/queries/usage.js";
import { fetchTelegramFile } from "./media.js";
import { todayInTimezone } from "../utils/dates.js";
import type { AssembledPhoto } from "./updates.js";

const AppMinutesSchema = z.object({
  app: z.string().min(1),
  minutes: z.number().int().min(0),
});

const CategoryMinutesSchema = z.object({
  name: z.string().min(1),
  minutes: z.number().int().min(0),
});

const AppCountSchema = z.object({
  app: z.string().min(1),
  count: z.number().int().min(0),
});

const ScreenTimeJsonSchema = z.object({
  is_screen_time: z.boolean(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  total_minutes: z.number().int().min(0).nullable(),
  categories: z.array(CategoryMinutesSchema).nullable(),
  apps: z.array(AppMinutesSchema).nullable(),
  pickups: z.number().int().min(0).nullable(),
  first_pickup: z
    .string()
    .regex(/^\d{2}:\d{2}(:\d{2})?$/)
    .nullable(),
  pickup_apps: z.array(AppCountSchema).nullable(),
  notifications: z.number().int().min(0).nullable(),
  notification_apps: z.array(AppCountSchema).nullable(),
});

export type ScreenTimeJson = z.infer<typeof ScreenTimeJsonSchema>;

function buildVisionPrompt(today: string): string {
  return `You are inspecting 1-4 screenshots from a Telegram chat. Decide whether they are iOS Screen Time / Tiempo de pantalla screenshots from the iPhone Settings app, then extract structured data for a single day.

Today's date is ${today} (YYYY-MM-DD, user's local timezone).

Set "is_screen_time" to true ONLY if you see characteristic iOS Screen Time UI: bar charts of daily usage, "Screen Time" / "Tiempo de pantalla" / "Consultas del dispositivo" / "Notificaciones" headers, app usage breakdowns, pickups (consultas), or notification counts per app. Otherwise set false and leave every other field null.

When is_screen_time is true, return JSON of this exact shape:
{
  "is_screen_time": true,
  "date": "YYYY-MM-DD",
  "total_minutes": integer | null,
  "categories": [{ "name": string, "minutes": integer }, ...] | null,
  "apps":       [{ "app": string,  "minutes": integer }, ...] | null,
  "pickups": integer | null,
  "first_pickup": "HH:MM" | null,
  "pickup_apps":      [{ "app": string, "count": integer }, ...] | null,
  "notifications": integer | null,
  "notification_apps":[{ "app": string, "count": integer }, ...] | null
}

Date resolution:
- iOS shows phrases like "Yesterday, May 2", "Ayer, 2 de mayo", "Hoy", or just a weekday letter (D L M X J V S highlighted on a bar chart).
- Use today's date (${today}) as the anchor for relative phrases. "Hoy"/"Today" → ${today}; "Ayer"/"Yesterday" → the day before.
- For weekday-letter highlights, pick the most recent occurrence of that weekday on or before today.
- If you genuinely cannot determine the date, set "date" to null.

Other rules:
- Convert "1h 23m" → 83, "45m" → 45, "2h" → 120, "<1m" → 0.
- iOS shows totals like "1:23" in summary headers — these are total Screen Time hours:minutes, not pickups. Read carefully.
- For first_pickup, use 24-hour HH:MM. Convert from 12-hour if needed.
- If a section is not visible across the screenshots, set the corresponding fields to null.
- App / category names: keep exactly as displayed (e.g., "Mobile Safari", "Messages", "Telegram", "Productivity & Finance", "Social").
- Do not invent data not visible in the screenshots.

Return ONLY a JSON object — no prose, no markdown fences.`;
}

export interface ProcessScreenTimeOptions {
  pool: pg.Pool;
  chatId: string;
  messageId: number;
  photos: AssembledPhoto[];
  /** Override for tests; defaults to today in the configured timezone. */
  today?: string;
  /** Visible for testing. */
  openai?: OpenAI;
  /** Visible for testing. */
  notify?: (chatId: string, text: string) => Promise<void>;
}

export interface ProcessScreenTimeResult {
  /** Did the upsert (or detection-only path) complete without error? */
  ok: boolean;
  /** Did the model classify the photos as iOS Screen Time? */
  isScreenTime: boolean;
  /** The day-of-data when it was successfully ingested. */
  date?: string;
  /** Set when something failed (vision error, missing date, DB error). */
  error?: string;
}

let cachedOpenAI: OpenAI | null = null;
function getOpenAI(): OpenAI {
  /* v8 ignore next 3 -- cached singleton; tests inject openai explicitly */
  if (!cachedOpenAI) {
    cachedOpenAI = new OpenAI({ apiKey: config.openai.apiKey });
  }
  return cachedOpenAI;
}

export async function extractScreenTimeJson(
  photoBuffers: Buffer[],
  client: OpenAI,
  today: string
): Promise<{ json: ScreenTimeJson; raw: string }> {
  const imageContent = photoBuffers.map((buf) => ({
    type: "image_url" as const,
    image_url: {
      url: `data:image/jpeg;base64,${buf.toString("base64")}`,
    },
  }));

  const response = await client.chat.completions.create({
    model: "gpt-4.1",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You inspect iOS Settings screenshots, decide whether they are iOS Screen Time, and extract structured data when they are. Return only JSON.",
      },
      {
        role: "user",
        content: [
          { type: "text", text: buildVisionPrompt(today) },
          ...imageContent,
        ],
      },
    ],
    max_tokens: 2000,
  });

  const raw = response.choices[0]?.message?.content?.trim() ?? "";
  if (!raw) {
    throw new Error("Vision model returned empty response");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Vision model returned non-JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const validated = ScreenTimeJsonSchema.parse(parsed);
  return { json: validated, raw };
}

function normalizeFirstPickup(value: string | null | undefined): string | null {
  if (!value) return null;
  // Postgres TIME accepts HH:MM and HH:MM:SS — pad to HH:MM:SS for safety.
  return value.length === 5 ? `${value}:00` : value;
}

export async function processScreenTimePhotos(
  options: ProcessScreenTimeOptions
): Promise<ProcessScreenTimeResult> {
  const { pool, chatId, messageId, photos } = options;
  const notify = options.notify;
  const today = options.today ?? todayInTimezone();
  const startedAt = Date.now();

  if (photos.length === 0) {
    return { ok: false, isScreenTime: false, error: "no_photos" };
  }

  let json: ScreenTimeJson;
  let raw: string;
  try {
    const buffers = await Promise.all(
      photos.map(async (p) => (await fetchTelegramFile(p.fileId)).buffer)
    );
    const client = options.openai ?? getOpenAI();
    const result = await extractScreenTimeJson(buffers, client, today);
    json = result.json;
    raw = result.raw;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logUsage(pool, {
      source: "telegram",
      surface: "screen-time",
      action: "detect",
      ok: false,
      error: message,
      durationMs: Date.now() - startedAt,
      meta: { photo_count: photos.length },
    });
    // Detection itself failed — let the caller fall back to normal OCR.
    return { ok: false, isScreenTime: false, error: message };
  }

  if (!json.is_screen_time) {
    logUsage(pool, {
      source: "telegram",
      surface: "screen-time",
      action: "detect",
      ok: true,
      durationMs: Date.now() - startedAt,
      meta: { photo_count: photos.length, is_screen_time: false },
    });
    return { ok: true, isScreenTime: false };
  }

  const date = json.date;
  if (!date) {
    logUsage(pool, {
      source: "telegram",
      surface: "screen-time",
      action: "ingest",
      ok: false,
      error: "missing_date",
      durationMs: Date.now() - startedAt,
      meta: { photo_count: photos.length },
    });
    if (notify) {
      await notify(
        chatId,
        "📱 Screen Time detected but I couldn't read the date label. Crop so the date is visible and resend."
      );
    }
    return { ok: false, isScreenTime: true, error: "missing_date" };
  }

  try {
    await upsertDailyScreenTime(pool, {
      date,
      totalMinutes: json.total_minutes ?? 0,
      categories: json.categories ?? [],
      apps: json.apps ?? [],
      pickups: json.pickups,
      firstPickup: normalizeFirstPickup(json.first_pickup),
      pickupApps: json.pickup_apps,
      notifications: json.notifications,
      notificationApps: json.notification_apps,
      sourceMessageId: messageId,
      rawText: raw,
    });

    logUsage(pool, {
      source: "telegram",
      surface: "screen-time",
      action: "ingest",
      ok: true,
      durationMs: Date.now() - startedAt,
      meta: { date, photo_count: photos.length },
    });

    if (notify) {
      const total = json.total_minutes ?? 0;
      const hours = Math.floor(total / 60);
      const mins = total % 60;
      const totalLabel = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
      const appCount = json.apps?.length ?? 0;
      await notify(
        chatId,
        `📱 Screen Time saved for ${date}: ${totalLabel} total, ${appCount} apps.`
      );
    }

    return { ok: true, isScreenTime: true, date };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logUsage(pool, {
      source: "telegram",
      surface: "screen-time",
      action: "ingest",
      ok: false,
      error: message,
      durationMs: Date.now() - startedAt,
      meta: { date, photo_count: photos.length },
    });
    if (notify) {
      await notify(chatId, `⚠️ Screen Time ingest failed for ${date}: ${message}`);
    }
    return { ok: false, isScreenTime: true, error: message, date };
  }
}
