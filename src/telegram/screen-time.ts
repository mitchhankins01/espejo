import OpenAI from "openai";
import { z } from "zod";
import type pg from "pg";
import { config } from "../config.js";
import { upsertDailyScreenTime } from "../db/queries/daily-screen-time.js";
import { logUsage } from "../db/queries/usage.js";
import { fetchTelegramFile } from "./media.js";
import type { AssembledPhoto } from "./updates.js";

// Caption format: "screen_time YYYY-MM-DD" (case-insensitive prefix).
const CAPTION_PREFIX = /^\s*screen_time\s+(\d{4}-\d{2}-\d{2})\s*$/i;

export function parseScreenTimeCaption(caption: string | undefined | null): string | null {
  if (!caption) return null;
  const match = CAPTION_PREFIX.exec(caption);
  if (!match) return null;
  const date = match[1];
  // Validate it's a real calendar date.
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.toISOString().slice(0, 10) !== date) return null;
  return date;
}

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
  total_minutes: z.number().int().min(0),
  categories: z.array(CategoryMinutesSchema),
  apps: z.array(AppMinutesSchema),
  pickups: z.number().int().min(0).nullable().optional(),
  first_pickup: z
    .string()
    .regex(/^\d{2}:\d{2}(:\d{2})?$/)
    .nullable()
    .optional(),
  pickup_apps: z.array(AppCountSchema).nullable().optional(),
  notifications: z.number().int().min(0).nullable().optional(),
  notification_apps: z.array(AppCountSchema).nullable().optional(),
});

export type ScreenTimeJson = z.infer<typeof ScreenTimeJsonSchema>;

const VISION_PROMPT = `You are extracting structured Screen Time data from iOS Settings screenshots for a *single* day.

The user provides 1–4 screenshots covering: total + per-category time, per-app time, pickups (count, first pickup time, top apps), and notifications (count, top apps).

Return ONLY a JSON object — no prose, no markdown fences — matching this exact shape:

{
  "total_minutes": integer,                       // total Screen Time for the day, in minutes
  "categories": [{ "name": string, "minutes": integer }, ...],
  "apps":       [{ "app": string,  "minutes": integer }, ...],
  "pickups": integer | null,
  "first_pickup": "HH:MM" | null,                 // 24-hour
  "pickup_apps":      [{ "app": string, "count": integer }, ...] | null,
  "notifications": integer | null,
  "notification_apps":[{ "app": string, "count": integer }, ...] | null
}

Rules:
- Convert "1h 23m" → 83 minutes; "45m" → 45; "2h" → 120; "<1m" → 0.
- iOS shows times like "1:23" in summary headers — these are total Screen Time, not pickups. Read carefully.
- For first_pickup, use 24-hour HH:MM. If shown in 12h format, convert.
- If a section is not visible in any screenshot, set the corresponding fields to null (or omit pickups/notifications fields entirely).
- App names: keep exactly as displayed (e.g., "Mobile Safari", "Messages", "Telegram").
- Categories: keep exactly as displayed (e.g., "Productivity & Finance", "Social", "Entertainment").
- Do not invent data not visible in the screenshots.`;

export interface ProcessScreenTimeOptions {
  pool: pg.Pool;
  chatId: string;
  messageId: number;
  photos: AssembledPhoto[];
  caption: string;
  /** Visible for testing. */
  openai?: OpenAI;
  /** Visible for testing. */
  notify?: (chatId: string, text: string) => Promise<void>;
}

export interface ProcessScreenTimeResult {
  ok: boolean;
  date?: string;
  error?: string;
}

let cachedOpenAI: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!cachedOpenAI) {
    cachedOpenAI = new OpenAI({ apiKey: config.openai.apiKey });
  }
  return cachedOpenAI;
}

export async function extractScreenTimeJson(
  photoBuffers: Buffer[],
  client: OpenAI
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
          "You extract structured data from iOS Screen Time screenshots. Return only JSON.",
      },
      {
        role: "user",
        content: [{ type: "text", text: VISION_PROMPT }, ...imageContent],
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
  const { pool, chatId, messageId, photos, caption } = options;
  const notify = options.notify;
  const startedAt = Date.now();

  const date = parseScreenTimeCaption(caption);
  if (!date) {
    return { ok: false, error: "invalid_caption" };
  }
  if (photos.length === 0) {
    return { ok: false, error: "no_photos" };
  }

  try {
    const buffers = await Promise.all(
      photos.map(async (p) => (await fetchTelegramFile(p.fileId)).buffer)
    );

    const client = options.openai ?? getOpenAI();
    const { json, raw } = await extractScreenTimeJson(buffers, client);

    await upsertDailyScreenTime(pool, {
      date,
      totalMinutes: json.total_minutes,
      categories: json.categories,
      apps: json.apps,
      pickups: json.pickups ?? null,
      firstPickup: normalizeFirstPickup(json.first_pickup ?? null),
      pickupApps: json.pickup_apps ?? null,
      notifications: json.notifications ?? null,
      notificationApps: json.notification_apps ?? null,
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
      const hours = Math.floor(json.total_minutes / 60);
      const mins = json.total_minutes % 60;
      const totalLabel = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
      await notify(
        chatId,
        `📱 Screen Time saved for ${date}: ${totalLabel} total, ${json.apps.length} apps.`
      );
    }

    return { ok: true, date };
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
    return { ok: false, error: message, date };
  }
}
