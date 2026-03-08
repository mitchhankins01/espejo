import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { deleteTemplate, listTemplates, type EntryTemplate } from "../api.ts";

export function TemplateList() {
  const [templates, setTemplates] = useState<EntryTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const items = await listTemplates();
      setTemplates(items);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleDelete(id: string): Promise<void> {
    if (!confirm("Delete this template?")) return;
    setDeletingId(id);
    try {
      await deleteTemplate(id);
      await load();
    } catch (err) {
      setError(String(err));
      setDeletingId(null);
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 pb-24">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Templates</h1>
          <p className="text-sm text-text-muted mt-1">Reusable starting points for entries</p>
        </div>
        <Link
          to="/templates/new"
          className="px-4 py-2 rounded-lg bg-pine-600 dark:bg-pine-500 text-white text-sm font-medium hover:bg-pine-700 dark:hover:bg-pine-400 transition-colors"
        >
          New Template
        </Link>
      </div>

      {error && (
        <div className="text-red-600 dark:text-red-400 text-sm bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg px-4 py-3 mb-4">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-center py-16 text-text-muted">Loading...</div>
      ) : templates.length === 0 ? (
        <div className="text-center py-16 text-text-muted border border-dashed border-border rounded-xl">
          No templates yet.
        </div>
      ) : (
        <div className="space-y-3">
          {templates.map((template) => (
            <div
              key={template.id}
              className="rounded-xl border border-border bg-surface p-4 flex items-start justify-between gap-4"
            >
              <Link to={`/templates/${template.id}`} className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-semibold text-text-primary truncate">
                    {template.name}
                  </h2>
                  <span className="text-xs text-text-muted">#{template.sort_order}</span>
                  <span className="text-xs text-text-muted">/{template.slug}</span>
                </div>
                {template.description && (
                  <p className="text-sm text-text-muted mt-1 line-clamp-2">
                    {template.description}
                  </p>
                )}
                {template.default_tags.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {template.default_tags.map((tag) => (
                      <span
                        key={tag}
                        className="px-2 py-0.5 rounded-full text-[11px] bg-pine-500/10 text-pine-700 dark:text-pine-300"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </Link>
              <div className="flex items-center gap-2 shrink-0">
                <Link
                  to={`/journal/new?template=${template.id}`}
                  className="px-3 py-1.5 rounded-md border border-border text-xs font-medium hover:bg-surface-elevated"
                >
                  Use
                </Link>
                <button
                  type="button"
                  onClick={() => void handleDelete(template.id)}
                  disabled={deletingId === template.id}
                  className="px-3 py-1.5 rounded-md border border-red-300 dark:border-red-700 text-red-600 dark:text-red-400 text-xs font-medium hover:bg-red-600 hover:text-white disabled:opacity-50"
                >
                  {deletingId === template.id ? "..." : "Delete"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
