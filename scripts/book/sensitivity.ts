import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../src/config.js";

export interface JuliaSensitivityResult {
  flagged: boolean;
  reason: string;
  snippet: string;
}

const SYSTEM = `You are a sensitivity classifier. Mitch is about to share a Spanish-language book chapter ("tomo") with Julia (also spelled Iulia), a close friend. Decide whether to flag it for his review before sending.

Flag if the tomo contains ANY of:
(a) any mention of "Julia" / "Iulia" or oblique reference to her (e.g. "mi amiga", "ella" in context that points to her);
(b) friendship-private moments — conversations, vulnerabilities of hers, things she said in confidence;
(c) Mitch's processing OF her or the friendship — frustrations, doubts, things he hasn't said to her;
(d) her own private struggles he's witnessed.

The ONLY content that does not flag is content with no reference to her at all. When uncertain, flag.

Respond with EXACTLY one JSON object and nothing else:
{"flagged": boolean, "reason": "<one short sentence>", "snippet": "<10-30 words quoted verbatim from the tomo, or empty string if not flagged>"}`;

export async function checkJuliaSensitivity(
  markdown: string
): Promise<JuliaSensitivityResult> {
  if (!config.anthropic.apiKey) {
    return {
      flagged: true,
      reason: "ANTHROPIC_API_KEY missing — cannot run check, defaulting to flagged",
      snippet: "",
    };
  }
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });
  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 400,
    temperature: 0,
    system: SYSTEM,
    messages: [{ role: "user", content: markdown }],
  });
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    return { flagged: true, reason: "classifier returned no text", snippet: "" };
  }
  const raw = textBlock.text.trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return {
      flagged: true,
      reason: `classifier returned non-JSON: ${raw.slice(0, 80)}`,
      snippet: "",
    };
  }
  try {
    const parsed = JSON.parse(jsonMatch[0]) as Partial<JuliaSensitivityResult>;
    return {
      flagged: parsed.flagged === true,
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
      snippet: typeof parsed.snippet === "string" ? parsed.snippet : "",
    };
  } catch {
    return {
      flagged: true,
      reason: `classifier JSON parse failed: ${raw.slice(0, 80)}`,
      snippet: "",
    };
  }
}
