export type AgentMode = "default" | "checkin";

const CHECKIN_MODE_PROMPT = `Check-in mode is ON. You initiated this conversation — the user did not ask to talk.
Be warm, curious, and open. Follow their lead. If they want to go deep, go deep.
If they give a short reply, respect it. Spanish is the primary language.
Weave in English or Dutch only for warmth, humor, or clarification.
Do not compose a summary — the system handles that separately.`;

export function getModePrompt(mode: AgentMode): string | null {
  if (mode === "checkin") return CHECKIN_MODE_PROMPT;
  return null;
}
