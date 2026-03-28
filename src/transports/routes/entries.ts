import type { Express } from "express";
import { z } from "zod";
import multer from "multer";
import {
  createEntry,
  updateEntry,
  deleteEntry,
  listEntries,
  getEntryByUuid,
  getEntryIdByUuid,
  insertMedia,
  deleteMedia as deleteMediaRow,
  updateEntryEmbeddingIfVersionMatches,
} from "../../db/queries.js";
import { generateEmbedding } from "../../db/embeddings.js";
import {
  createClient as createR2Client,
  uploadMediaBuffer,
  deleteMediaObject,
  getPublicUrl,
} from "../../storage/r2.js";
import { config } from "../../config.js";
import { requireBearerAuth } from "../middleware/auth.js";
import type { RouteDeps } from "./types.js";

export function registerEntryRoutes(app: Express, deps: RouteDeps): void {
  const { pool, secret } = deps;

  // GET /api/entries — list entries with filters
  app.get("/api/entries", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res, secret)) return;
    try {
      const { rows, count } = await listEntries(pool, {
        limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
        offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined,
        from: req.query.from as string | undefined,
        to: req.query.to as string | undefined,
        source: req.query.source as string | undefined,
        q: req.query.q as string | undefined,
      });
      res.json({ items: rows, total: count });
    /* v8 ignore next 4 */
    } catch (err) {
      console.error("Entry list error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/entries/:uuid — get single entry
  app.get("/api/entries/:uuid", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res, secret)) return;
    try {
      const entry = await getEntryByUuid(pool, req.params.uuid);
      if (!entry) {
        res.status(404).json({ error: "Entry not found" });
        return;
      }
      res.json(entry);
    /* v8 ignore next 4 */
    } catch (err) {
      console.error("Entry get error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/entries — create entry
  app.post("/api/entries", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res, secret)) return;
    try {
      const schema = z.object({
        text: z.string().min(1),
        timezone: z.string().optional(),
        created_at: z.string().optional(),
        city: z.string().optional(),
        country: z.string().optional(),
        place_name: z.string().optional(),
        latitude: z.number().optional(),
        longitude: z.number().optional(),
      });
      const data = schema.parse(req.body);
      const entry = await createEntry(pool, data);

      // Fire-and-forget embedding generation
      if (entry.text) {
        void generateEmbedding(entry.text)
          .then((emb) =>
            updateEntryEmbeddingIfVersionMatches(pool, entry.uuid, entry.version, emb)
          )
          .catch((err) => console.error("Entry embedding failed:", err));
      }

      res.status(201).json(entry);
    /* v8 ignore next 8 */
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: err.errors });
        return;
      }
      console.error("Entry create error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // PUT /api/entries/:uuid — update entry with optimistic locking
  app.put("/api/entries/:uuid", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res, secret)) return;
    try {
      const schema = z.object({
        text: z.string().min(1).optional(),
        timezone: z.string().optional(),
        created_at: z.string().optional(),
        city: z.string().optional(),
        country: z.string().optional(),
        place_name: z.string().optional(),
        latitude: z.number().optional(),
        longitude: z.number().optional(),
        expected_version: z.number().int().min(1),
      });
      const data = schema.parse(req.body);
      const { expected_version, ...updateData } = data;
      const result = await updateEntry(pool, req.params.uuid, expected_version, updateData);

      if (result === null) {
        res.status(404).json({ error: "Entry not found" });
        return;
      }
      if (result === "version_conflict") {
        res.status(409).json({ error: "Version conflict — entry was modified" });
        return;
      }

      // Fire-and-forget embedding if text changed
      if (updateData.text && result.text) {
        void generateEmbedding(result.text)
          .then((emb) =>
            updateEntryEmbeddingIfVersionMatches(pool, result.uuid, result.version, emb)
          )
          .catch((err) => console.error("Entry embedding failed:", err));
      }

      res.json(result);
    /* v8 ignore next 8 */
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: err.errors });
        return;
      }
      console.error("Entry update error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // DELETE /api/entries/:uuid
  app.delete("/api/entries/:uuid", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res, secret)) return;
    try {
      const deleted = await deleteEntry(pool, req.params.uuid);
      if (!deleted) {
        res.status(404).json({ error: "Entry not found" });
        return;
      }
      res.json({ status: "deleted" });
    /* v8 ignore next 4 */
    } catch (err) {
      console.error("Entry delete error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // ====================================================================
  // Media upload
  // ====================================================================

  const ALLOWED_MIME_TYPES = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/heic",
  ]);
  const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

  /* v8 ignore next 10 -- multer config is runtime-only */
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_SIZE },
    fileFilter: (_req, file, cb) => {
      if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error(`Unsupported file type: ${file.mimetype}`));
      }
    },
  });

  // POST /api/entries/:uuid/media — upload photo
  /* v8 ignore start -- media upload handler requires real multer + R2 integration */
  app.post("/api/entries/:uuid/media", (req, res, next) => {
    if (!requireBearerAuth(req, res, secret)) return;
    next();
  }, upload.single("file"), async (req, res) => {
    try {
      const file = req.file;
      if (!file) {
        res.status(400).json({ error: "No file provided" });
        return;
      }

      const entryUuid = req.params.uuid as string;
      const entryId = await getEntryIdByUuid(pool, entryUuid);
      if (entryId === null) {
        res.status(404).json({ error: "Entry not found" });
        return;
      }

      // Upload to R2
      const ext = file.originalname.split(".").pop()?.toLowerCase() || "jpg";
      const storageKey = `entries/${entryUuid}/${crypto.randomUUID()}.${ext}`;

      let url: string;
      if (config.r2.accountId && config.r2.accessKeyId && config.r2.secretAccessKey) {
        const r2 = createR2Client();
        url = await uploadMediaBuffer(r2, file.buffer, storageKey, file.mimetype);
      } else {
        // Dev mode: generate URL without uploading
        url = getPublicUrl(storageKey);
      }

      const media = await insertMedia(pool, {
        entry_id: entryId,
        type: "photo",
        storage_key: storageKey,
        url,
        file_size: file.size,
      });

      res.status(201).json(media);
    } catch (err) {
      if (err instanceof multer.MulterError) {
        res.status(400).json({ error: err.message });
        return;
      }
      console.error("Media upload error:", err);
      res.status(500).json({ error: String(err) });
    }
  });
  /* v8 ignore stop */

  // DELETE /api/media/:id — delete media row and best-effort R2 cleanup
  app.delete("/api/media/:id", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res, secret)) return;
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        res.status(400).json({ error: "Invalid media ID" });
        return;
      }
      const { deleted, storage_key } = await deleteMediaRow(pool, id);
      if (!deleted) {
        res.status(404).json({ error: "Media not found" });
        return;
      }

      // Best-effort R2 cleanup
      /* v8 ignore next 4 -- R2 cleanup is runtime-only */
      if (storage_key && config.r2.accountId && config.r2.accessKeyId && config.r2.secretAccessKey) {
        const r2 = createR2Client();
        void deleteMediaObject(r2, storage_key);
      }

      res.json({ status: "deleted" });
    /* v8 ignore next 4 */
    } catch (err) {
      console.error("Media delete error:", err);
      res.status(500).json({ error: String(err) });
    }
  });
}
