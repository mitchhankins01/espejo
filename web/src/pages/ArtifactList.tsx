import { useState, useEffect, useCallback, useRef } from "react";
import { Link, useSearchParams, useNavigate } from "react-router-dom";
import { listArtifacts, searchArtifacts, type Artifact } from "../api.ts";

const KINDS = ["", "insight", "theory", "model", "reference"] as const;
const KIND_LABELS: Record<string, string> = {
  "": "All",
  insight: "Insight",
  theory: "Theory",
  model: "Model",
  reference: "Reference",
};
const PAGE_SIZE = 10;

function plainSnippet(md: string, max: number): string {
  return md
    .replace(/^#+\s+/gm, "")
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
    .replace(/_{1,3}([^_]+)_{1,3}/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^[-*>]\s+/gm, "")
    .replace(/^---+$/gm, "")
    .replace(/`{1,3}[^`]*`{1,3}/g, "")
    .replace(/\n{2,}/g, " ")
    .replace(/\n/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, max) + (md.length > max ? "..." : "");
}

const BADGE_COLORS: Record<string, string> = {
  insight: "bg-badge-insight-bg text-badge-insight-text",
  theory: "bg-badge-theory-bg text-badge-theory-text",
  model: "bg-badge-model-bg text-badge-model-text",
  reference: "bg-badge-reference-bg text-badge-reference-text",
};

export function ArtifactList() {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState("");
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const page = Number(searchParams.get("page") ?? "0");

  const prevFiltersRef = useRef({ search, kindFilter });

  function goToPage(p: number): void {
    navigate(p === 0 ? "/" : `/?page=${p}`);
  }

  useEffect(() => {
    const prev = prevFiltersRef.current;
    if (prev.search !== search || prev.kindFilter !== kindFilter) {
      prevFiltersRef.current = { search, kindFilter };
      if (page !== 0) goToPage(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, kindFilter]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      if (search.trim()) {
        const results = await searchArtifacts(search, kindFilter || undefined);
        setArtifacts(results);
        setTotal(results.length);
      } else {
        const { items, total: t } = await listArtifacts({
          kind: kindFilter || undefined,
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        });
        setArtifacts(items);
        setTotal(t);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [search, kindFilter, page]);

  useEffect(() => {
    const timer = setTimeout(load, search ? 400 : 0);
    return () => clearTimeout(timer);
  }, [load, search]);

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const isSearching = !!search.trim();

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 pb-24">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-text-primary">Knowledge Base</h1>
      </div>

      {/* Search */}
      <div className="mb-4">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search artifacts..."
          className="w-full px-4 py-2.5 rounded-xl border border-border bg-surface text-text-primary placeholder:text-text-muted/60 focus:outline-none focus:ring-2 focus:ring-pine-500/30 focus:border-pine-500 text-base shadow-sm"
        />
      </div>

      {/* Kind filter pills */}
      <div className="flex gap-2 mb-6 flex-wrap">
        {KINDS.map((k) => (
          <button
            key={k}
            onClick={() => setKindFilter(k)}
            className={`px-3.5 py-1.5 rounded-full text-sm font-medium transition-colors
              ${kindFilter === k
                ? "bg-pine-600 dark:bg-pine-500 text-white shadow-sm"
                : "bg-surface-elevated text-text-muted hover:text-text-primary hover:bg-border"
              }`}
          >
            {KIND_LABELS[k]}
          </button>
        ))}
      </div>

      {error && (
        <div className="text-red-600 dark:text-red-400 text-sm bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg px-4 py-3 mb-4">
          {error}
        </div>
      )}

      {loading ? (
        <div data-testid="loading" className="text-center py-16 text-text-muted">Loading...</div>
      ) : artifacts.length === 0 ? (
        <div data-testid="empty-state" className="text-center py-16 text-text-muted border border-dashed border-border rounded-xl">
          {search ? "No artifacts match your search." : "No artifacts yet. Create one to get started."}
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-3">
            {artifacts.map((a) => (
              <Link
                key={a.id}
                to={`/${a.id}`}
                data-testid="artifact-card"
                className="block p-5 bg-surface rounded-xl shadow-sm hover:shadow-md transition-shadow"
              >
                <div className="flex items-center gap-2.5 mb-2">
                  <span data-testid="kind-badge" className={`inline-block px-2.5 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wide ${BADGE_COLORS[a.kind] ?? ""}`}>
                    {a.kind}
                  </span>
                  <span data-testid="artifact-title" className="font-medium text-text-primary leading-snug">{a.title}</span>
                </div>
                {a.body && (
                  <p className="text-sm text-text-muted leading-relaxed mb-2.5 line-clamp-2">
                    {plainSnippet(a.body, 180)}
                  </p>
                )}
                <div className="flex items-center gap-2 text-xs text-text-muted">
                  <span>{new Date(a.created_at).toLocaleDateString()}</span>
                  {a.tags.map((t) => (
                    <span key={t} className="px-2 py-0.5 rounded-full bg-pine-500/10 text-pine-700 dark:text-pine-300 font-medium">
                      {t}
                    </span>
                  ))}
                </div>
              </Link>
            ))}
          </div>

          {/* Pagination */}
          {!isSearching && totalPages > 1 && (
            <div data-testid="pagination" className="flex items-center justify-center gap-4 mt-6 pt-4 border-t border-border">
              <button
                className="px-4 py-2 rounded-lg bg-surface-elevated text-text-primary border border-border text-sm font-medium hover:bg-border transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                disabled={page === 0}
                onClick={() => goToPage(page - 1)}
              >
                Previous
              </button>
              <span data-testid="pagination-info" className="text-sm text-text-muted">
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

      {/* Floating action button */}
      <Link
        to="/new"
        className="fixed bottom-6 right-6 w-14 h-14 rounded-full bg-pine-600 dark:bg-pine-500 text-white shadow-lg hover:shadow-xl hover:bg-pine-700 dark:hover:bg-pine-400 transition-all flex items-center justify-center text-2xl"
        aria-label="New Artifact"
      >
        +
      </Link>
    </div>
  );
}
