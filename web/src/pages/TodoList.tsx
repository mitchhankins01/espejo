import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { listTodos, getFocus, type Todo } from "../api.ts";
import { EisenhowerMatrix } from "../components/EisenhowerMatrix.tsx";

const PAGE_SIZE = 10;
const STATUSES = ["", "active", "waiting", "done", "someday"] as const;
const STATUS_LABELS: Record<(typeof STATUSES)[number], string> = {
  "": "All",
  active: "Active",
  waiting: "Waiting",
  done: "Done",
  someday: "Someday",
};
const STATUS_COLORS: Record<string, string> = {
  active: "bg-badge-active-bg text-badge-active-text",
  waiting: "bg-badge-waiting-bg text-badge-waiting-text",
  done: "bg-badge-done-bg text-badge-done-text",
  someday: "bg-badge-someday-bg text-badge-someday-text",
};

function quadrantLabel(urgent: boolean, important: boolean): string {
  if (urgent && important) return "Do First";
  if (!urgent && important) return "Schedule";
  if (urgent && !important) return "Delegate";
  return "Someday";
}

function quadrantColor(urgent: boolean, important: boolean): string {
  if (urgent && important) return "bg-urgent-bg text-urgent-text";
  if (!urgent && important) return "bg-important-bg text-important-text";
  if (urgent && !important) return "bg-badge-waiting-bg text-badge-waiting-text";
  return "bg-badge-someday-bg text-badge-someday-text";
}

export function TodoList() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [total, setTotal] = useState(0);
  const [focus, setFocusTodo] = useState<Todo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [statusFilter, setStatusFilter] = useState<(typeof STATUSES)[number]>("");
  const [viewMode, setViewMode] = useState<"list" | "matrix">("list");
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const page = Number(searchParams.get("page") ?? "0");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [{ items, total: count }, focusTodo] = await Promise.all([
        listTodos({
          status: statusFilter || undefined,
          include_children: true,
          parent_id: "root",
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        }),
        getFocus(),
      ]);
      setTodos(items);
      setTotal(count);
      setFocusTodo(focusTodo);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [statusFilter, page]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (page !== 0) {
      navigate("/todos");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  function goToPage(nextPage: number): void {
    navigate(nextPage === 0 ? "/todos" : `/todos?page=${nextPage}`);
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 pb-24">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-text-primary">Todos</h1>
        <div className="flex gap-2">
          <button
            onClick={() => setViewMode(viewMode === "list" ? "matrix" : "list")}
            className="px-3 py-1.5 rounded-lg bg-surface-elevated text-text-muted text-sm font-medium hover:text-text-primary hover:bg-border transition-colors"
          >
            {viewMode === "list" ? "Matrix" : "List"}
          </button>
        </div>
      </div>

      {/* Focus banner */}
      {focus && (
        <Link
          to={`/todos/${focus.id}`}
          className="block mb-6 p-4 rounded-xl bg-pine-50 dark:bg-pine-950/30 border border-pine-200 dark:border-pine-800 hover:shadow-md transition-shadow"
        >
          <div className="flex items-center gap-2 mb-1">
            <span className="text-lg">★</span>
            <span className="text-xs font-semibold uppercase tracking-wide text-pine-700 dark:text-pine-300">
              The One Thing
            </span>
          </div>
          <span className="font-medium text-text-primary">{focus.title}</span>
          {focus.next_step && (
            <p className="text-sm text-text-muted italic mt-1">{focus.next_step}</p>
          )}
        </Link>
      )}

      {viewMode === "matrix" ? (
        <EisenhowerMatrix todos={todos} />
      ) : (
        <>
          <div className="flex gap-2 mb-6 flex-wrap">
            {STATUSES.map((status) => (
              <button
                key={status}
                onClick={() => setStatusFilter(status)}
                className={`px-3.5 py-1.5 rounded-full text-sm font-medium transition-colors ${
                  statusFilter === status
                    ? "bg-pine-600 dark:bg-pine-500 text-white shadow-sm"
                    : "bg-surface-elevated text-text-muted hover:text-text-primary hover:bg-border"
                }`}
              >
                {STATUS_LABELS[status]}
              </button>
            ))}
          </div>

          {error && (
            <div className="text-red-600 dark:text-red-400 text-sm bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg px-4 py-3 mb-4">
              {error}
            </div>
          )}

          {loading ? (
            <div className="text-center py-16 text-text-muted">Loading...</div>
          ) : todos.length === 0 ? (
            <div className="text-center py-16 text-text-muted border border-dashed border-border rounded-xl">
              No todos yet. Create one to get started.
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-3">
                {todos.map((todo) => (
                  <Link
                    key={todo.id}
                    to={`/todos/${todo.id}`}
                    className="block p-5 bg-surface rounded-xl shadow-sm hover:shadow-md transition-shadow"
                  >
                    <div className="flex items-center gap-2.5 mb-2">
                      {todo.is_focus && <span className="text-pine-600 dark:text-pine-400">★</span>}
                      <span
                        className={`inline-block px-2.5 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wide ${
                          STATUS_COLORS[todo.status] ?? ""
                        }`}
                      >
                        {todo.status}
                      </span>
                      {(todo.urgent || todo.important) && (
                        <span
                          className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide ${
                            quadrantColor(todo.urgent, todo.important)
                          }`}
                        >
                          {quadrantLabel(todo.urgent, todo.important)}
                        </span>
                      )}
                      <span className="font-medium text-text-primary leading-snug">
                        {todo.title}
                      </span>
                    </div>
                    {todo.next_step && (
                      <p className="text-sm text-text-muted italic mb-2">{todo.next_step}</p>
                    )}
                    <div className="flex items-center gap-2 text-xs text-text-muted flex-wrap">
                      <span>Updated {new Date(todo.updated_at).toLocaleDateString()}</span>
                      {todo.children && todo.children.length > 0 && (
                        <span className="px-2 py-0.5 rounded-full bg-surface-elevated font-medium">
                          {todo.children.length} subtask{todo.children.length !== 1 ? "s" : ""}
                          {(() => {
                            const done = todo.children.filter((c) => c.status === "done").length;
                            return done > 0 ? `, ${done} done` : "";
                          })()}
                        </span>
                      )}
                    </div>
                  </Link>
                ))}
              </div>

              {totalPages > 1 && (
                <div className="flex items-center justify-center gap-4 mt-6 pt-4 border-t border-border">
                  <button
                    className="px-4 py-2 rounded-lg bg-surface-elevated text-text-primary border border-border text-sm font-medium hover:bg-border transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    disabled={page === 0}
                    onClick={() => goToPage(page - 1)}
                  >
                    Previous
                  </button>
                  <span className="text-sm text-text-muted">
                    Page {page + 1} of {totalPages}
                  </span>
                  <button
                    className="px-4 py-2 rounded-lg bg-surface-elevated text-text-primary border border-border text-sm font-medium hover:bg-border transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    disabled={page >= totalPages - 1}
                    onClick={() => goToPage(page + 1)}
                  >
                    Next
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}

      <Link
        to="/todos/new"
        className="fixed bottom-6 right-6 w-14 h-14 rounded-full bg-pine-600 dark:bg-pine-500 text-white shadow-lg hover:shadow-xl hover:bg-pine-700 dark:hover:bg-pine-400 transition-all flex items-center justify-center text-2xl"
        aria-label="New Todo"
      >
        +
      </Link>
    </div>
  );
}
