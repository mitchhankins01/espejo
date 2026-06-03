import OpenAI from "openai";
import { z } from "zod";
import type pg from "pg";
import { config } from "../config.js";
import { logUsage } from "../db/queries/usage.js";
import { fetchTelegramFile } from "./media.js";
import type { AssembledPhoto } from "./updates.js";

// Mitch's elimination-diet profile (genetically confirmed via GenoPalate /
// SelfDecode — see Artifacts/Reference/Genoplate Sensitivity Report.md and
// Thyroid History.md). Gluten is the deciding axis; dairy is explicitly NOT a
// concern, so the screener must never flag it. Kept inline rather than vault-
// sourced because the profile is stable and a Telegram classifier can't reach
// the vault at request time.
const FOOD_PROFILE = `Gluten — PRIMARY avoid (HLA-DQ8, also a thyroid-autoimmune trigger). Treat as present when you see wheat, barley, rye, spelt, semolina, durum, farro, couscous, malt / malt extract, brewer's yeast, seitan, regular soy sauce, beer, non-GF oats, or breaded / battered / flour-thickened dishes. Hidden gluten terms: dextrin, modified food starch, caramel color, "natural flavoring", grain extract, hydrolyzed wheat protein.
Caffeine — slow metabolizer; flag when present (note it matters most after ~14:00). Hidden: chocolate/cocoa, kombucha, tea, decaf, energy drinks.
Alcohol & nicotine — flag for evening use (disrupts sleep).
Histamine — SECONDARY sensitivity; note aged/fermented items (aged cheese, cured/fermented meat, wine, vinegar, leftovers) but lower priority than gluten.
Dairy / lactose — TOLERANT. Do NOT flag dairy and never advise cutting it.`;

const VerdictSchema = z.enum(["SAFE", "CAUTION", "AVOID"]);

const FoodScreenJsonSchema = z.object({
  is_food: z.boolean(),
  verdict: VerdictSchema.nullable(),
  item: z.string().nullable(),
  reasons: z.array(z.string()).nullable(),
  ask: z.string().nullable(),
  uncertainty: z.string().nullable(),
});

export type FoodScreenJson = z.infer<typeof FoodScreenJsonSchema>;

function buildVisionPrompt(): string {
  return `You are screening 1-4 photos sent to a Telegram chat to decide whether they show FOOD the user is considering eating — a plated meal, a restaurant menu, or a packaged-food ingredient label — and if so, whether it fits the user's elimination diet.

Set "is_food" to true ONLY for a meal, menu, or ingredient/nutrition label. Set it to false for anything else (screenshots, people, scenery, documents, products that aren't food) and leave every other field null.

When is_food is true, screen the food against this profile:
${FOOD_PROFILE}

Verdict rules:
- "AVOID": gluten is present or clearly likely (named gluten grain, breaded/floured/malted item, hidden-gluten term in an ingredient list).
- "CAUTION": gluten can't be ruled out from the photo (sauces, breading, prep unknown, ambiguous "starch"/"flavoring"), OR the item is gluten-free but carries a caffeine / alcohol / nicotine / histamine note worth surfacing.
- "SAFE": clearly free of gluten and no other flag worth raising.
- Gluten decides the verdict. Caffeine/histamine/alcohol only downgrade a SAFE to CAUTION; they never override an AVOID.
- When uncertain, prefer CAUTION over SAFE — a false "safe" pollutes an elimination trial.

Return JSON of this exact shape, nothing else (no prose, no markdown fences):
{
  "is_food": true,
  "verdict": "SAFE" | "CAUTION" | "AVOID",
  "item": short description of the food/dish/product,
  "reasons": [ "ingredient- or dish-specific reason", ... ],
  "ask": "the question to ask the waiter or what to check, or null",
  "uncertainty": "what you could NOT determine from the photo, or null"
}`;
}

export interface ProcessFoodPhotosOptions {
  pool: pg.Pool;
  chatId: string;
  photos: AssembledPhoto[];
  /** Visible for testing. */
  openai?: OpenAI;
  /** Visible for testing. */
  notify?: (chatId: string, text: string) => Promise<void>;
}

export interface ProcessFoodPhotosResult {
  /** Did the screen complete without error? */
  ok: boolean;
  /** Did the model classify the photos as food/menu/label? */
  isFood: boolean;
  /** The verdict, when food was detected. */
  verdict?: z.infer<typeof VerdictSchema>;
  /** Set when something failed (vision error, parse error). */
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

export async function extractFoodScreenJson(
  photoBuffers: Buffer[],
  client: OpenAI
): Promise<{ json: FoodScreenJson; raw: string }> {
  const imageContent = photoBuffers.map((buf) => ({
    type: "image_url" as const,
    image_url: {
      url: `data:image/jpeg;base64,${buf.toString("base64")}`,
    },
  }));

  const response = await client.chat.completions.create({
    model: config.models.openaiVision,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You screen food photos against a fixed dietary profile and decide if they fit an elimination diet. Return only JSON.",
      },
      {
        role: "user",
        content: [{ type: "text", text: buildVisionPrompt() }, ...imageContent],
      },
    ],
    max_tokens: 1000,
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

  const validated = FoodScreenJsonSchema.parse(parsed);
  return { json: validated, raw };
}

const VERDICT_EMOJI: Record<z.infer<typeof VerdictSchema>, string> = {
  SAFE: "✅",
  CAUTION: "⚠️",
  AVOID: "❌",
};

export function formatFoodReply(json: FoodScreenJson): string {
  // Coerce a missing verdict to CAUTION — an undecided screen should never
  // read as a green light during an elimination trial.
  const verdict = json.verdict ?? "CAUTION";
  const item = json.item?.trim();
  const header = `${VERDICT_EMOJI[verdict]} ${verdict}${item ? ` — ${item}` : ""}`;

  const lines = [header];
  for (const reason of json.reasons ?? []) {
    const trimmed = reason.trim();
    if (trimmed) lines.push(`• ${trimmed}`);
  }
  if (json.ask?.trim()) lines.push(`❓ ${json.ask.trim()}`);
  if (json.uncertainty?.trim()) lines.push(`🔍 ${json.uncertainty.trim()}`);
  return lines.join("\n");
}

export async function processFoodPhotos(
  options: ProcessFoodPhotosOptions
): Promise<ProcessFoodPhotosResult> {
  const { pool, chatId, photos } = options;
  const notify = options.notify;
  const startedAt = Date.now();

  if (photos.length === 0) {
    return { ok: false, isFood: false, error: "no_photos" };
  }

  let json: FoodScreenJson;
  try {
    const buffers = await Promise.all(
      photos.map(async (p) => (await fetchTelegramFile(p.fileId)).buffer)
    );
    const client = options.openai ?? getOpenAI();
    json = (await extractFoodScreenJson(buffers, client)).json;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logUsage(pool, {
      source: "telegram",
      surface: "food-screen",
      action: "detect",
      ok: false,
      error: message,
      durationMs: Date.now() - startedAt,
      meta: { photo_count: photos.length },
    });
    // Detection itself failed — let the caller fall back to normal OCR.
    return { ok: false, isFood: false, error: message };
  }

  if (!json.is_food) {
    logUsage(pool, {
      source: "telegram",
      surface: "food-screen",
      action: "detect",
      ok: true,
      durationMs: Date.now() - startedAt,
      meta: { photo_count: photos.length, is_food: false },
    });
    return { ok: true, isFood: false };
  }

  const verdict = json.verdict ?? "CAUTION";
  logUsage(pool, {
    source: "telegram",
    surface: "food-screen",
    action: "screen",
    ok: true,
    durationMs: Date.now() - startedAt,
    meta: { photo_count: photos.length, verdict },
  });

  if (notify) {
    await notify(chatId, formatFoodReply(json));
  }

  return { ok: true, isFood: true, verdict };
}
