import type { CheckinWindow } from "../db/queries.js";

export function buildCheckinPrompt(
  window: CheckinWindow,
  ouraContext: string | null,
  todoContext: string | null
): string {
  const parts: string[] = [];

  if (window === "morning") {
    parts.push("Buenos días.");
    if (ouraContext) {
      parts.push(ouraContext);
    }
    parts.push("¿Cómo estás aterrizando esta mañana?");
  } else if (window === "afternoon") {
    parts.push("Hey — ¿en qué estás trabajando? ¿Algún bloqueo o victoria hasta ahora?");
    if (todoContext) {
      parts.push(todoContext);
    }
  } else if (window === "evening") {
    parts.push("¿Ya vas cerrando el día? ¿Cómo fue? ¿Algo que valga la pena nombrar antes de cerrar?");
  } else {
    // event-driven
    parts.push("Quería checkearte.");
  }

  return parts.filter(Boolean).join(" ");
}

export function buildOuraAnomalyPrompt(
  anomalies: string[]
): string {
  const anomalyText = anomalies.join(", ");
  return `Noté algo en tus datos de Oura: ${anomalyText}. ¿Cómo te sientes?`;
}

export function buildJournalPatternPrompt(
  pattern: string
): string {
  return pattern;
}
