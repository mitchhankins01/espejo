import type { Express } from "express";
import { z } from "zod";
import {
  listTodos,
  getTodoById,
  createTodo,
  updateTodo,
  completeTodo,
  deleteTodo,
  setTodoFocus,
  getFocusTodo,
} from "../../db/queries.js";
import { requireBearerAuth } from "../middleware/auth.js";
import type { RouteDeps } from "./types.js";

export function registerTodoRoutes(app: Express, deps: RouteDeps): void {
  const { pool, secret } = deps;

  const todoStatusSchema = z.enum(["active", "waiting", "done", "someday"]);
  const createTodoSchema = z.object({
    title: z.string().min(1).max(300),
    status: todoStatusSchema.optional(),
    next_step: z.string().max(500).nullable().optional(),
    body: z.string().optional(),
    urgent: z.boolean().optional(),
    important: z.boolean().optional(),
    parent_id: z.string().optional(),
  });
  const updateTodoSchema = z.object({
    title: z.string().min(1).max(300).optional(),
    status: todoStatusSchema.optional(),
    next_step: z.string().max(500).nullable().optional(),
    body: z.string().optional(),
    urgent: z.boolean().optional(),
    important: z.boolean().optional(),
  });

  // GET /api/todos/focus — get current focus todo
  app.get("/api/todos/focus", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res, secret)) return;

    try {
      const todo = await getFocusTodo(pool);
      res.json(todo ?? null);
    } catch (err) {
      console.error("Todo focus error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/todos
  app.get("/api/todos", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res, secret)) return;

    try {
      const status = req.query.status
        ? todoStatusSchema.parse(req.query.status)
        : undefined;
      const urgent = req.query.urgent !== undefined
        ? req.query.urgent === "true"
        : undefined;
      const important = req.query.important !== undefined
        ? req.query.important === "true"
        : undefined;
      const parent_id = req.query.parent_id
        ? String(req.query.parent_id)
        : undefined;
      const focus_only = req.query.focus_only === "true" || undefined;
      const include_children = req.query.include_children === "true" || undefined;
      /* v8 ignore next 4 */
      const limit = Math.min(
        Math.max(parseInt(String(req.query.limit ?? "20"), 10) || 20, 1),
        100
      );
      /* v8 ignore next */
      const offset = Math.max(
        parseInt(String(req.query.offset ?? "0"), 10) || 0,
        0
      );

      const { rows, count } = await listTodos(pool, {
        status, urgent, important, parent_id, focus_only, include_children,
        limit, offset,
      });
      res.json({ items: rows, total: count });
    } catch (err) {
      console.error("Todo list error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/todos/:id
  app.get("/api/todos/:id", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res, secret)) return;

    try {
      const todo = await getTodoById(pool, req.params.id);
      if (!todo) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.json(todo);
    } catch (err) {
      console.error("Todo get error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/todos
  app.post("/api/todos", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res, secret)) return;

    const parsed = createTodoSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues });
      return;
    }

    try {
      const todo = await createTodo(pool, parsed.data);
      res.status(201).json(todo);
    } catch (err) {
      console.error("Todo create error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // PUT /api/todos/:id
  app.put("/api/todos/:id", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res, secret)) return;

    const parsed = updateTodoSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues });
      return;
    }

    try {
      const todo = await updateTodo(pool, req.params.id, parsed.data);
      if (!todo) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.json(todo);
    } catch (err) {
      console.error("Todo update error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/todos/:id/complete
  app.post("/api/todos/:id/complete", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res, secret)) return;

    try {
      const todo = await completeTodo(pool, req.params.id);
      if (!todo) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.json(todo);
    } catch (err) {
      console.error("Todo complete error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/todos/focus
  app.post("/api/todos/focus", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res, secret)) return;

    try {
      if (req.body.clear) {
        await setTodoFocus(pool);
        res.json({ status: "cleared" });
        return;
      }
      if (!req.body.id) {
        res.status(400).json({ error: "Provide id or clear: true" });
        return;
      }
      const todo = await setTodoFocus(pool, req.body.id);
      if (!todo) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.json(todo);
    } catch (err) {
      console.error("Todo focus error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // DELETE /api/todos/:id
  app.delete("/api/todos/:id", async (req, res) => {
    /* v8 ignore next */
    if (!requireBearerAuth(req, res, secret)) return;

    try {
      const deleted = await deleteTodo(pool, req.params.id);
      if (!deleted) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.json({ status: "deleted" });
    } catch (err) {
      console.error("Todo delete error:", err);
      res.status(500).json({ error: String(err) });
    }
  });
}
