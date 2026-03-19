import type { Express } from "express";
import { z } from "zod";
import {
  createArtifact,
  updateArtifact,
  deleteArtifact,
  getArtifactById,
  listArtifacts,
  countArtifacts,
  searchArtifacts,
  searchArtifactsKeyword,
  listArtifactTags,
  listArtifactTitles,
  resolveArtifactTitleToId,
  syncExplicitLinks,
  findSimilarArtifacts,
  getExplicitLinks,
  getExplicitBacklinks,
  getArtifactGraph,
  searchContent,
  searchEntriesForPicker,
} from "../../db/queries.js";
import { generateEmbedding } from "../../db/embeddings.js";
import { requireBearerAuth } from "../middleware/auth.js";
import type { RouteDeps } from "./types.js";

export function registerArtifactRoutes(app: Express, deps: RouteDeps): void {
  const { pool, secret } = deps;

  const artifactKindSchema = z.enum([
    "insight",
    "reference",
    "note",
    "project",
  ]);

  const artifactSourceSchema = z.enum(["web", "obsidian", "mcp", "telegram"]);

  const wikiLinkPattern = /\[\[([^\]]+)\]\]/g;

  const extractWikiLinkTitles = (markdown: string): string[] => {
    const titles = new Set<string>();
    for (const match of markdown.matchAll(wikiLinkPattern)) {
      const title = match[1]?.trim();
      if (title) titles.add(title);
    }
    return Array.from(titles);
  };

  const syncWikiLinksForArtifact = async (
    artifactId: string,
    markdown: string
  ): Promise<void> => {
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
  };

  // GET /api/artifacts — list or search
  app.get("/api/artifacts", async (req, res) => {
    if (!requireBearerAuth(req, res, secret)) return;

    try {
      const q = req.query.q ? String(req.query.q) : undefined;
      /* v8 ignore next */
      const kind = req.query.kind ? artifactKindSchema.parse(req.query.kind) : undefined;
      /* v8 ignore next */
      const source = req.query.source ? artifactSourceSchema.parse(req.query.source) : undefined;
      /* v8 ignore next */
      const tags = req.query.tags ? String(req.query.tags).split(",").filter(Boolean) : undefined;
      /* v8 ignore next */
      const tagsMode = (req.query.tags_mode === "all" ? "all" : "any") as "any" | "all";
      const semantic = req.query.semantic === undefined
        ? true
        : String(req.query.semantic).toLowerCase() === "true";
      /* v8 ignore next */
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "20"), 10) || 20, 1), q ? 50 : 100);
      /* v8 ignore next */
      const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);

      if (q) {
        const results = semantic
          ? await (async () => {
            const embedding = await generateEmbedding(q);
            return searchArtifacts(pool, embedding, q, { kind, source, tags, tags_mode: tagsMode }, limit);
          })()
          : await searchArtifactsKeyword(pool, q, { kind, source, tags, tags_mode: tagsMode }, limit);
        res.json(results);
      } else {
        const [results, total] = await Promise.all([
          listArtifacts(pool, { kind, source, tags, tags_mode: tagsMode, limit, offset }),
          countArtifacts(pool, { kind, source, tags, tags_mode: tagsMode }),
        ]);
        res.json({ items: results, total });
      }
    } catch (err) {
      console.error("Artifact list/search error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/artifacts/tags — list tags used on artifacts with counts
  app.get("/api/artifacts/tags", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res, secret)) return;

    try {
      const tags = await listArtifactTags(pool);
      res.json(tags);
    } catch (err) {
      console.error("Artifact tags error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/artifacts/titles — lightweight title list for quick switcher and link picker
  app.get("/api/artifacts/titles", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res, secret)) return;

    try {
      const titles = await listArtifactTitles(pool);
      res.json(titles);
    } catch (err) {
      console.error("Artifact titles error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/artifacts/graph — graph data for force-directed view
  app.get("/api/artifacts/graph", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res, secret)) return;

    try {
      const graph = await getArtifactGraph(pool);
      const nodes = graph.artifacts.map((artifact) => ({
        id: artifact.id,
        title: artifact.title,
        kind: artifact.kind,
        tags: artifact.tags,
      }));

      const edges: Array<{
        source: string;
        target: string;
        type: "semantic" | "explicit" | "tag" | "source";
        weight?: number;
      }> = [];

      for (const sim of graph.similarities) {
        edges.push({
          source: sim.id_1,
          target: sim.id_2,
          type: "semantic",
          weight: sim.similarity,
        });
      }

      for (const link of graph.explicitLinks) {
        edges.push({
          source: link.source_id,
          target: link.target_id,
          type: "explicit",
        });
      }

      const tagEdgeKeys = new Set<string>();
      for (let i = 0; i < graph.artifacts.length; i++) {
        for (let j = i + 1; j < graph.artifacts.length; j++) {
          const a = graph.artifacts[i];
          const b = graph.artifacts[j];
          const hasSharedTag = a.tags.some((tag) => b.tags.includes(tag));
          /* v8 ignore next -- mixed tag/non-tag pairs are data-dependent */
          if (!hasSharedTag) continue;

          const key = `${a.id}|${b.id}|tag`;
          /* v8 ignore next */
          if (tagEdgeKeys.has(key)) continue;
          tagEdgeKeys.add(key);
          edges.push({ source: a.id, target: b.id, type: "tag" });
        }
      }

      const sourceEdgeKeys = new Set<string>();
      for (const sourceLink of graph.sharedSources) {
        const key = `${sourceLink.artifact_id_1}|${sourceLink.artifact_id_2}|source`;
        /* v8 ignore next */
        if (sourceEdgeKeys.has(key)) continue;
        sourceEdgeKeys.add(key);
        edges.push({
          source: sourceLink.artifact_id_1,
          target: sourceLink.artifact_id_2,
          type: "source",
        });
      }

      res.json({ nodes, edges });
    } catch (err) {
      console.error("Artifact graph error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/artifacts/:id/related — semantic + explicit links/backlinks
  app.get("/api/artifacts/:id/related", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res, secret)) return;

    try {
      const artifactId = req.params.id;
      const [semantic, outgoing, incoming] = await Promise.all([
        findSimilarArtifacts(pool, artifactId, 10, 0.3),
        getExplicitLinks(pool, artifactId),
        getExplicitBacklinks(pool, artifactId),
      ]);

      const explicit = [
        ...outgoing.map((item) => ({ ...item, direction: "outgoing" as const })),
        ...incoming.map((item) => ({ ...item, direction: "incoming" as const })),
      ];

      res.json({ semantic, explicit });
    } catch (err) {
      console.error("Artifact related error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/artifacts/:id
  app.get("/api/artifacts/:id", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res, secret)) return;

    try {
      const artifact = await getArtifactById(pool, req.params.id);
      if (!artifact) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.json(artifact);
    } catch (err) {
      console.error("Artifact get error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  const createArtifactSchema = z.object({
    kind: artifactKindSchema,
    title: z.string().min(1).max(300),
    body: z.string().min(1),
    tags: z.array(z.string()).optional(),
    source_entry_uuids: z.array(z.string()).optional(),
  });

  // POST /api/artifacts
  app.post("/api/artifacts", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res, secret)) return;

    const parsed = createArtifactSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues });
      return;
    }

    try {
      const artifact = await createArtifact(pool, parsed.data);
      await syncWikiLinksForArtifact(artifact.id, artifact.body);
      res.status(201).json(artifact);
    } catch (err) {
      console.error("Artifact create error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  const updateArtifactSchema = z.object({
    kind: artifactKindSchema.optional(),
    title: z.string().min(1).max(300).optional(),
    body: z.string().min(1).optional(),
    tags: z.array(z.string()).optional(),
    source_entry_uuids: z.array(z.string()).optional(),
    expected_version: z.number().int().min(1),
  });

  // PUT /api/artifacts/:id
  app.put("/api/artifacts/:id", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res, secret)) return;

    const parsed = updateArtifactSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues });
      return;
    }

    try {
      const existing = await getArtifactById(pool, req.params.id);
      if (!existing) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      if (existing.source === "obsidian") {
        res.status(403).json({ error: "This artifact is synced from Obsidian. Edit in Obsidian instead." });
        return;
      }

      const { expected_version, ...data } = parsed.data;
      const result = await updateArtifact(pool, req.params.id, expected_version, data);

      if (result === null) {
        res.status(404).json({ error: "Not found" });
      } else if (result === "source_protected") {
        res.status(403).json({ error: "This artifact is synced from Obsidian. Edit in Obsidian instead." });
      } else if (result === "version_conflict") {
        res.status(409).json({ error: "Version conflict. Reload and try again." });
      } else {
        await syncWikiLinksForArtifact(result.id, result.body);
        res.json(result);
      }
    } catch (err) {
      console.error("Artifact update error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // DELETE /api/artifacts/:id
  app.delete("/api/artifacts/:id", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res, secret)) return;

    try {
      const existing = await getArtifactById(pool, req.params.id);
      if (!existing) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      if (existing.source === "obsidian") {
        res.status(403).json({ error: "This artifact is synced from Obsidian. Delete from your vault instead." });
        return;
      }

      const deleted = await deleteArtifact(pool, req.params.id);
      if (!deleted) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.json({ status: "deleted" });
    } catch (err) {
      console.error("Artifact delete error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/entries/search — lightweight search for source picker
  app.get("/api/entries/search", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res, secret)) return;

    const q = req.query.q ? String(req.query.q) : "";
    if (!q) {
      res.status(400).json({ error: "Missing q parameter" });
      return;
    }

    try {
      /* v8 ignore next */
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "10"), 10) || 10, 1), 50);
      const results = await searchEntriesForPicker(pool, q, limit);
      res.json(results);
    } catch (err) {
      console.error("Entry search error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/content/search — unified search
  app.get("/api/content/search", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res, secret)) return;

    const q = req.query.q ? String(req.query.q) : "";
    if (!q) {
      res.status(400).json({ error: "Missing q parameter" });
      return;
    }

    try {
      /* v8 ignore next */
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "10"), 10) || 10, 1), 50);
      const contentTypes = req.query.content_types
        ? String(req.query.content_types).split(",").filter(Boolean) as ("journal_entry" | "knowledge_artifact")[]
        : undefined;
      const embedding = await generateEmbedding(q);
      const results = await searchContent(pool, embedding, q, { content_types: contentTypes }, limit);
      res.json(results);
    } catch (err) {
      console.error("Content search error:", err);
      res.status(500).json({ error: String(err) });
    }
  });
}
