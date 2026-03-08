import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  deleteTodo,
  getTodo,
  updateTodo,
  completeTodo,
  setFocus,
  clearFocus,
  createTodo,
  type Todo,
} from "../api.ts";
import { StatusSelect } from "../components/StatusSelect.tsx";
import { MarkdownEditor } from "../components/MarkdownEditor.tsx";
import { TagInput } from "../components/TagInput.tsx";

export function TodoEdit() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [todo, setTodo] = useState<Todo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [title, setTitle] = useState("");
  const [status, setStatus] = useState("active");
  const [nextStep, setNextStep] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [urgent, setUrgent] = useState(false);
  const [important, setImportant] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [newSubtaskTitle, setNewSubtaskTitle] = useState("");
  const [addingSubtask, setAddingSubtask] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError("");
    try {
      const item = await getTodo(id);
      setTodo(item);
      setTitle(item.title);
      setStatus(item.status);
      setNextStep(item.next_step ?? "");
      setBody(item.body);
      setTags(item.tags);
      setUrgent(item.urgent);
      setImportant(item.important);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSave() {
    if (!id || !title.trim()) return;

    setSaving(true);
    setError("");
    try {
      await updateTodo(id, {
        title: title.trim(),
        status: status as "active" | "waiting" | "done" | "someday",
        next_step: nextStep.trim() ? nextStep.trim() : null,
        body: body.trim(),
        tags,
        urgent,
        important,
      });
      navigate(-1);
    } catch (err) {
      setSaving(false);
      setError(String(err));
    }
  }

  async function handleComplete() {
    if (!id) return;
    try {
      await completeTodo(id);
      navigate(-1);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleToggleFocus() {
    if (!id || !todo) return;
    try {
      if (todo.is_focus) {
        await clearFocus();
      } else {
        await setFocus(id);
      }
      await load();
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleDelete() {
    if (!id || !confirm("Delete this todo?")) return;
    setDeleting(true);
    try {
      await deleteTodo(id);
      navigate("/todos");
    } catch (err) {
      setError(String(err));
      setDeleting(false);
    }
  }

  async function handleAddSubtask() {
    if (!id || !newSubtaskTitle.trim()) return;
    setAddingSubtask(true);
    try {
      await createTodo({
        title: newSubtaskTitle.trim(),
        parent_id: id,
      });
      setNewSubtaskTitle("");
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setAddingSubtask(false);
    }
  }

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-8">
        <div className="text-center py-16 text-text-muted">Loading...</div>
      </div>
    );
  }

  if (!todo && error) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-8">
        <div className="text-red-600 dark:text-red-400 text-sm bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg px-4 py-3 mb-4">
          {error}
        </div>
        <Link
          to="/todos"
          className="text-pine-600 dark:text-pine-400 hover:underline text-sm"
        >
          Back to todos
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Link
            to="/todos"
            className="text-text-muted text-xl leading-none hover:text-text-primary transition-colors"
          >
            &larr;
          </Link>
          <h1 className="text-xl font-semibold text-text-primary">Edit Todo</h1>
        </div>
        <div className="flex items-center gap-2">
          {/* Focus toggle */}
          <button
            className={`px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
              todo?.is_focus
                ? "bg-pine-50 dark:bg-pine-950/30 border-pine-300 dark:border-pine-700 text-pine-700 dark:text-pine-300"
                : "border-border text-text-muted hover:text-text-primary hover:bg-surface-elevated"
            }`}
            onClick={handleToggleFocus}
            title={todo?.is_focus ? "Remove focus" : "Set as The One Thing"}
          >
            {todo?.is_focus ? "★ Focus" : "☆ Focus"}
          </button>
          {/* Complete button */}
          {todo?.status !== "done" && (
            <button
              className="px-4 py-2 rounded-lg bg-badge-active-bg text-badge-active-text text-sm font-medium hover:opacity-80 transition-opacity"
              onClick={handleComplete}
            >
              Complete
            </button>
          )}
          <button
            className="px-4 py-2 rounded-lg bg-pine-600 dark:bg-pine-500 text-white text-sm font-medium hover:bg-pine-700 dark:hover:bg-pine-400 transition-colors disabled:opacity-50"
            onClick={handleSave}
            disabled={saving || !title.trim()}
          >
            {saving ? "Saving..." : "Save"}
          </button>
          <button
            className="px-4 py-2 rounded-lg text-red-600 dark:text-red-400 border border-red-300 dark:border-red-700 text-sm font-medium hover:bg-red-600 hover:text-white dark:hover:bg-red-500 transition-colors disabled:opacity-50"
            onClick={handleDelete}
            disabled={deleting}
          >
            {deleting ? "Deleting..." : "Delete"}
          </button>
        </div>
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
              htmlFor="todo-edit-status"
              className="block text-sm text-text-muted mb-1.5 font-medium"
            >
              Status
            </label>
            <StatusSelect
              id="todo-edit-status"
              value={status}
              onChange={setStatus}
            />
          </div>
          <div className="flex-1">
            <label
              htmlFor="todo-edit-title"
              className="block text-sm text-text-muted mb-1.5 font-medium"
            >
              Title
            </label>
            <input
              id="todo-edit-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
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
              className="w-4 h-4 rounded border-border accent-red-600"
            />
            <span className="text-sm font-medium text-text-primary">Urgent</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={important}
              onChange={(e) => setImportant(e.target.checked)}
              className="w-4 h-4 rounded border-border accent-blue-600"
            />
            <span className="text-sm font-medium text-text-primary">Important</span>
          </label>
        </div>

        <div>
          <label
            htmlFor="todo-edit-next-step"
            className="block text-sm text-text-muted mb-1.5 font-medium"
          >
            Next Step
          </label>
          <input
            id="todo-edit-next-step"
            value={nextStep}
            onChange={(event) => setNextStep(event.target.value)}
            maxLength={500}
            className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary placeholder:text-text-muted/60 focus:outline-none focus:ring-2 focus:ring-pine-500/30 focus:border-pine-500 text-base"
          />
        </div>

        <div>
          <label className="block text-sm text-text-muted mb-1.5 font-medium">
            Body (Markdown)
          </label>
          <MarkdownEditor value={body} onChange={setBody} />
        </div>

        <div>
          <label
            htmlFor="todo-edit-tags"
            className="block text-sm text-text-muted mb-1.5 font-medium"
          >
            Tags
          </label>
          <TagInput id="todo-edit-tags" tags={tags} onChange={setTags} />
        </div>

        {/* Children / subtasks section (only for root-level todos) */}
        {todo && !todo.parent_id && (
          <div>
            <label className="block text-sm text-text-muted mb-1.5 font-medium">
              Subtasks
            </label>
            {todo.children && todo.children.length > 0 && (
              <div className="flex flex-col gap-2 mb-3">
                {todo.children.map((child) => (
                  <Link
                    key={child.id}
                    to={`/todos/${child.id}`}
                    className="flex items-center gap-2 p-3 bg-surface-elevated rounded-lg hover:bg-border transition-colors"
                  >
                    <span
                      className={`inline-block w-2 h-2 rounded-full ${
                        child.status === "done"
                          ? "bg-badge-done-text"
                          : child.status === "active"
                          ? "bg-badge-active-text"
                          : "bg-badge-waiting-text"
                      }`}
                    />
                    <span className={`text-sm ${child.status === "done" ? "line-through text-text-muted" : "text-text-primary"}`}>
                      {child.title}
                    </span>
                  </Link>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <input
                value={newSubtaskTitle}
                onChange={(e) => setNewSubtaskTitle(e.target.value)}
                placeholder="Add subtask..."
                maxLength={300}
                className="flex-1 px-3 py-2 rounded-lg border border-border bg-surface text-text-primary placeholder:text-text-muted/60 focus:outline-none focus:ring-2 focus:ring-pine-500/30 focus:border-pine-500 text-sm"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleAddSubtask();
                  }
                }}
              />
              <button
                onClick={handleAddSubtask}
                disabled={addingSubtask || !newSubtaskTitle.trim()}
                className="px-4 py-2 rounded-lg bg-surface-elevated text-text-primary border border-border text-sm font-medium hover:bg-border transition-colors disabled:opacity-50"
              >
                {addingSubtask ? "..." : "Add"}
              </button>
            </div>
          </div>
        )}

        <div className="text-xs text-text-muted">
          Updated {todo ? new Date(todo.updated_at).toLocaleString() : ""}
          {todo?.completed_at && (
            <> | Completed {new Date(todo.completed_at).toLocaleString()}</>
          )}
        </div>
      </div>
    </div>
  );
}
