import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import {
  createArtifact,
  findArtifactByKindAndTitle,
  updateArtifact,
  resolveArtifactTitleToId,
  syncExplicitLinks,
} from "../db/queries.js";
import { generateEmbedding } from "../db/embeddings.js";
import { todayInTimezone } from "../utils/dates.js";

const WIKI_LINK_PATTERN = /\[\[([^\]]+)\]\]/g;

function extractWikiLinkTitles(markdown: string): string[] {
  const titles = new Set<string>();
  for (const match of markdown.matchAll(WIKI_LINK_PATTERN)) {
    const title = match[1]?.trim();
    if (title) titles.add(title);
  }
  return Array.from(titles);
}

async function syncWikiLinks(
  pool: pg.Pool,
  artifactId: string,
  markdown: string
): Promise<void> {
  const titles = extractWikiLinkTitles(markdown);
  if (titles.length === 0) {
    await syncExplicitLinks(pool, artifactId, []);
    return;
  }
  const targetIds = (
    await Promise.all(
      titles.map((title) => resolveArtifactTitleToId(pool, title))
    )
  ).filter((id): id is string => Boolean(id));
  await syncExplicitLinks(pool, artifactId, targetIds);
}

async function embedArtifact(
  pool: pg.Pool,
  id: string,
  text: string
): Promise<void> {
  try {
    const embedding = await generateEmbedding(text);
    await pool.query(
      `UPDATE knowledge_artifacts SET embedding = $1 WHERE id = $2`,
      [`[${embedding.join(",")}]`, id]
    );
  } catch {
    // Fire-and-forget: log but don't fail the save
  }
}

export async function handleSaveEveningReview(
  pool: pg.Pool,
  input: unknown
): Promise<string> {
  const params = validateToolInput("save_evening_review", input);
  const date = params.date ?? todayInTimezone();
  const title = `${date} — Evening Checkin`;

  // Upsert: check for existing review with same title
  const existing = await findArtifactByKindAndTitle(pool, "review", title);

  if (existing) {
    const result = await updateArtifact(pool, existing.id, existing.version, {
      body: params.text,
    });
    if (result === "version_conflict") {
      return `Error: Version conflict updating review "${title}". Please try again.`;
    }
    /* v8 ignore next 3 */
    if (result === "source_protected" || result === null) {
      return `Error: Could not update existing review "${title}".`;
    }
    // Re-embed and sync wiki links in background
    void embedArtifact(pool, existing.id, `${title}\n\n${params.text}`);
    void syncWikiLinks(pool, existing.id, params.text);
    return `Updated existing review "${title}" (ID: ${existing.id})`;
  }

  const artifact = await createArtifact(pool, {
    kind: "review",
    title,
    body: params.text,
    source: "mcp",
    status: "pending",
  });

  // Embed and sync wiki links in background
  void embedArtifact(pool, artifact.id, `${title}\n\n${params.text}`);
  void syncWikiLinks(pool, artifact.id, params.text);

  return `Evening review saved as "${title}" (ID: ${artifact.id})`;
}
