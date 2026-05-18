import type Anthropic from "@anthropic-ai/sdk";

const CHARS_PER_TOK = 4;
const TOK_INTERVAL = 500;
const CHARS_INTERVAL = TOK_INTERVAL * CHARS_PER_TOK;

function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
}

export async function streamCreate(
  client: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
  label: string
): Promise<Anthropic.Message> {
  const start = Date.now();
  let chars = 0;
  let reported = 0;

  const stream = client.messages.stream(params);
  stream.on("text", (delta: string) => {
    chars += delta.length;
    while (chars - reported >= CHARS_INTERVAL) {
      reported += CHARS_INTERVAL;
      const approxTotalTok = Math.round(chars / CHARS_PER_TOK);
      console.log(
        `      [${label}] +${TOK_INTERVAL} tok (~${approxTotalTok} total, ${formatElapsed(Date.now() - start)} elapsed)`
      );
    }
  });
  const final = await stream.finalMessage();
  const totalTok = final.usage?.output_tokens ?? Math.round(chars / CHARS_PER_TOK);
  console.log(
    `      [${label}] done — ${totalTok} output tok, ${formatElapsed(Date.now() - start)}`
  );
  return final;
}
