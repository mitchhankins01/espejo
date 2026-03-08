import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { createTodo, listTodos, type Todo } from "../api.ts";
import { StatusSelect } from "../components/StatusSelect.tsx";
import { MarkdownEditor } from "../components/MarkdownEditor.tsx";
import { TagInput } from "../components/TagInput.tsx";

export function TodoCreate() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const parentIdParam = searchParams.get("parent");
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState("active");
  const [nextStep, setNextStep] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [urgent, setUrgent] = useState(false);
  const [important, setImportant] = useState(false);
  const [parentId, setParentId] = useState(parentIdParam ?? "");
  const [parentOptions, setParentOptions] = useState<Todo[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    listTodos({ parent_id: "root", limit: 100 })
      .then(({ items }) => setParentOptions(items))
      .catch(() => {});
  }, []);

  async function handleSave() {
    if (!title.trim()) {
      setError("Title is required.");
      return;
    }

    setSaving(true);
    setError("");
    try {
      const todo = await createTodo({
        title: title.trim(),
        status: status as "active" | "waiting" | "done" | "someday",
        next_step: nextStep.trim() ? nextStep.trim() : null,
        body: body.trim(),
        tags: tags.length > 0 ? tags : undefined,
        urgent,
        important,
        parent_id: parentId || undefined,
      });
      navigate(`/todos/${todo.id}`);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-text-primary">New Todo</h1>
        <Link to="/todos">
          <button className="px-4 py-2 rounded-lg bg-surface-elevated text-text-primary border border-border text-sm font-medium hover:bg-border transition-colors">
            Cancel
          </button>
        </Link>
      </div>

      {error && (
        <div className="text-red-600 dark:text-red-400 text-sm bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg px-4 py-3 mb-4">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-5">
        <div className="flex gap-3 max-sm:flex-col">
          <div className="w-40 max-sm:w-full shrink-0">
            <label
              htmlFor="todo-create-status"
              className="block text-sm text-text-muted mb-1.5 font-medium"
            >
              Status
            </label>
            <StatusSelect
              id="todo-create-status"
              value={status}
              onChange={setStatus}
            />
          </div>
          <div className="flex-1">
            <label
              htmlFor="todo-create-title"
              className="block text-sm text-text-muted mb-1.5 font-medium"
            >
              Title
            </label>
            <input
              id="todo-create-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Todo title"
              maxLength={300}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary placeholder:text-text-muted/60 focus:outline-none focus:ring-2 focus:ring-pine-500/30 focus:border-pine-500 text-base"
            />
          </div>
        </div>

        {/* Eisenhower toggles */}
        <div className="flex gap-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={urgent}
              onChange={(e) => setUrgent(e.target.checked)}
              className="w-4 h-4 rounded border-border text-urgent-text accent-red-600"
            />
            <span className="text-sm font-medium text-text-primary">Urgent</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={important}
              onChange={(e) => setImportant(e.target.checked)}
              className="w-4 h-4 rounded border-border text-important-text accent-blue-600"
            />
            <span className="text-sm font-medium text-text-primary">Important</span>
          </label>
        </div>

        {/* Parent picker */}
        <div>
          <label
            htmlFor="todo-create-parent"
            className="block text-sm text-text-muted mb-1.5 font-medium"
          >
            Parent (optional — makes this a subtask)
          </label>
          <select
            id="todo-create-parent"
            value={parentId}
            onChange={(event) => setParentId(event.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-pine-500/30 focus:border-pine-500 text-base"
          >
            <option value="">None (top-level)</option>
            {parentOptions.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label
            htmlFor="todo-create-next-step"
            className="block text-sm text-text-muted mb-1.5 font-medium"
          >
            Next Step
          </label>
          <input
            id="todo-create-next-step"
            value={nextStep}
            onChange={(event) => setNextStep(event.target.value)}
            placeholder="What is the next concrete step?"
            maxLength={500}
            className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary placeholder:text-text-muted/60 focus:outline-none focus:ring-2 focus:ring-pine-500/30 focus:border-pine-500 text-base"
          />
        </div>

        <div>
          <label className="block text-sm text-text-muted mb-1.5 font-medium">
            Body (Markdown)
          </label>
          <MarkdownEditor
            value={body}
            onChange={setBody}
            placeholder="Add notes, context, and progress..."
          />
        </div>

        <div>
          <label
            htmlFor="todo-create-tags"
            className="block text-sm text-text-muted mb-1.5 font-medium"
          >
            Tags
          </label>
          <TagInput id="todo-create-tags" tags={tags} onChange={setTags} />
        </div>

        <div className="flex justify-end">
          <button
            className="px-6 py-2.5 rounded-lg bg-pine-600 dark:bg-pine-500 text-white font-medium hover:bg-pine-700 dark:hover:bg-pine-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleSave}
            disabled={saving || !title.trim()}
          >
            {saving ? "Saving..." : "Create Todo"}
          </button>
        </div>
      </div>
    </div>
  );
}
