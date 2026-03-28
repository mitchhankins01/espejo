import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  listEntries,
  listTemplates,
  type Entry,
  type EntrySource,
  type EntryTemplate,
} from "../api.ts";

const PAGE_SIZE = 20;

function plainSnippet(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

function sourceLabel(source: EntrySource): string {
  switch (source) {
    case "dayone":
      return "Day One";
    case "web":
      return "Web";
    case "telegram":
      return "Telegram";
    default:
      return source;
  }
}

export function EntryList() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const page = Number(searchParams.get("page") ?? "0");

  const [entries, setEntries] = useState<Entry[]>([]);
  const [total, setTotal] = useState(0);
  const [templates, setTemplates] = useState<EntryTemplate[]>([]);
  const [newTemplateId, setNewTemplateId] = useState("");
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [source, setSource] = useState<"" | EntrySource>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const totalPages = Math.ceil(total / PAGE_SIZE);

  useEffect(() => {
    listTemplates()
      .then((items) => setTemplates(items))
      .catch(() => setTemplates([]));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await listEntries({
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        q: q.trim() || undefined,
        from: from || undefined,
        to: to || undefined,
        source: source || undefined,
      });
      setEntries(result.items);
      setTotal(result.total);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [page, q, from, to, source]);

  useEffect(() => {
    const timer = setTimeout(load, q ? 300 : 0);
    return () => clearTimeout(timer);
  }, [load, q]);

  const grouped = useMemo(() => {
    const byDate = new Map<string, Entry[]>();
    for (const entry of entries) {
      const dateKey = new Date(entry.created_at).toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
      const current = byDate.get(dateKey) ?? [];
      current.push(entry);
      byDate.set(dateKey, current);
    }
    return Array.from(byDate.entries());
  }, [entries]);

  function goToPage(nextPage: number): void {
    navigate(nextPage === 0 ? "/journal" : `/journal?page=${nextPage}`);
  }

  const createLink = newTemplateId
    ? `/journal/new?template=${encodeURIComponent(newTemplateId)}`
    : "/journal/new";

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 pb-24">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Journal</h1>
          <p className="text-sm text-text-muted mt-1">Timeline view of your entries</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={newTemplateId}
            onChange={(event) => setNewTemplateId(event.target.value)}
            className="px-2.5 py-2 rounded-lg border border-border bg-surface text-sm text-text-primary"
          >
            <option value="">Blank</option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </select>
          <Link
            to={createLink}
            className="px-4 py-2 rounded-lg bg-pine-600 dark:bg-pine-500 text-white text-sm font-medium hover:bg-pine-700 dark:hover:bg-pine-400 transition-colors"
          >
            New Entry
          </Link>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-surface p-4 mb-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        <input
          value={q}
          onChange={(event) => setQ(event.target.value)}
          placeholder="Search text..."
          className="lg:col-span-2 px-3 py-2 rounded-lg border border-border bg-surface-alt text-sm text-text-primary"
        />
        <input
          value={from}
          onChange={(event) => setFrom(event.target.value)}
          type="date"
          className="px-3 py-2 rounded-lg border border-border bg-surface-alt text-sm text-text-primary"
        />
        <input
          value={to}
          onChange={(event) => setTo(event.target.value)}
          type="date"
          className="px-3 py-2 rounded-lg border border-border bg-surface-alt text-sm text-text-primary"
        />
        <select
          value={source}
          onChange={(event) => setSource(event.target.value as "" | EntrySource)}
          className="px-3 py-2 rounded-lg border border-border bg-surface-alt text-sm text-text-primary"
        >
          <option value="">All sources</option>
          <option value="web">Web</option>
          <option value="dayone">Day One</option>
          <option value="telegram">Telegram</option>
        </select>
      </div>

      {error && (
        <div className="text-red-600 dark:text-red-400 text-sm bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg px-4 py-3 mb-4">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-center py-16 text-text-muted">Loading...</div>
      ) : grouped.length === 0 ? (
        <div className="text-center py-16 text-text-muted border border-dashed border-border rounded-xl">
          No entries match your filters.
        </div>
      ) : (
        <div className="space-y-7">
          {grouped.map(([dateLabel, dayEntries]) => (
            <section key={dateLabel}>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-text-muted mb-2">
                {dateLabel}
              </h2>
              <div className="space-y-2">
                {dayEntries.map((entry) => {
                  const photos = entry.media.filter((item) => item.type === "photo").slice(0, 4);
                  return (
                    <Link
                      key={entry.uuid}
                      to={`/journal/${entry.uuid}`}
                      className="block rounded-xl border border-border bg-surface p-4 hover:bg-surface-elevated transition-colors"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm text-text-muted">
                          {new Date(entry.created_at).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </div>
                        <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-surface-elevated text-text-muted">
                          {sourceLabel(entry.source)}
                        </span>
                      </div>
                      <p className="mt-2 text-sm text-text-primary">
                        {plainSnippet(entry.text, 240) || "No text content"}
                      </p>
                      {photos.length > 0 && (
                        <div className="mt-2 flex gap-2 overflow-x-auto">
                          {photos.map((photo) => (
                            <img
                              key={photo.id}
                              src={photo.url}
                              alt={`Entry ${entry.uuid} photo`}
                              className="h-14 w-14 rounded-md object-cover border border-border"
                            />
                          ))}
                        </div>
                      )}
                    </Link>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}

      {totalPages > 1 && !loading && (
        <div className="flex items-center justify-center gap-4 mt-8">
          <button
            type="button"
            onClick={() => goToPage(Math.max(page - 1, 0))}
            disabled={page <= 0}
            className="px-4 py-2 rounded-lg border border-border bg-surface text-sm disabled:opacity-50"
          >
            Previous
          </button>
          <span className="text-sm text-text-muted">
            Page {page + 1} of {totalPages}
          </span>
          <button
            type="button"
            onClick={() => goToPage(Math.min(page + 1, totalPages - 1))}
            disabled={page >= totalPages - 1}
            className="px-4 py-2 rounded-lg border border-border bg-surface text-sm disabled:opacity-50"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
