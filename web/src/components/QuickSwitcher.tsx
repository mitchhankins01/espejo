import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { listArtifactTitles, type ArtifactTitle } from "../api.ts";
import { ARTIFACT_BADGE_COLORS } from "../constants/artifacts.ts";

interface QuickResult {
  id: string;
  title: string;
  kind?: ArtifactTitle["kind"];
  path: string;
  score: number;
  isNew?: boolean;
}

function fuzzyMatch(query: string, target: string): number {
  const q = query.toLowerCase().trim();
  const t = target.toLowerCase();
  if (!q) return 0;
  if (t.startsWith(q)) return 2 + q.length / t.length;
  if (t.includes(q)) return 1 + q.length / t.length;
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length ? qi / t.length : 0;
}

export function QuickSwitcher() {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const cacheRef = useRef<{ fetchedAt: number; titles: ArtifactTitle[] }>({
    fetchedAt: 0,
    titles: [],
  });
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [titles, setTitles] = useState<ArtifactTitle[]>([]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!open) return;
    setSelectedIndex(0);
    const timer = setTimeout(() => inputRef.current?.focus(), 0);

    const fetchTitles = async () => {
      if (Date.now() - cacheRef.current.fetchedAt <= 30_000) {
        setTitles(cacheRef.current.titles);
        return;
      }
      setLoading(true);
      try {
        const items = await listArtifactTitles();
        cacheRef.current = { fetchedAt: Date.now(), titles: items };
        setTitles(items);
      } catch {
        setTitles([]);
      } finally {
        setLoading(false);
      }
    };

    void fetchTitles();
    return () => clearTimeout(timer);
  }, [open]);

  const results = useMemo(() => {
    const baseResults: QuickResult[] = titles
      .map((item) => ({
        id: item.id,
        title: item.title,
        kind: item.kind,
        path: `/${item.id}`,
        score: query.trim() ? fuzzyMatch(query, item.title) : 0,
      }))
      .filter((item) => (query.trim() ? item.score > 0 : true))
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));

    if (!query.trim()) {
      return [
        {
          id: "new-artifact",
          title: "New artifact",
          path: "/new",
          score: Number.POSITIVE_INFINITY,
          isNew: true,
        },
        ...baseResults,
      ].slice(0, 20);
    }

    return baseResults.slice(0, 20);
  }, [titles, query]);

  useEffect(() => {
    if (selectedIndex >= results.length) {
      setSelectedIndex(results.length > 0 ? results.length - 1 : 0);
    }
  }, [results.length, selectedIndex]);

  function close(): void {
    setOpen(false);
    setQuery("");
    setSelectedIndex(0);
  }

  function select(result: QuickResult | undefined): void {
    if (!result) return;
    navigate(result.path);
    close();
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center pt-[12vh] px-4"
      onClick={close}
    >
      <div
        className="w-full max-w-2xl rounded-xl border border-border bg-surface shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="p-3 border-b border-border">
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                close();
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                setSelectedIndex((index) =>
                  Math.min(index + 1, Math.max(results.length - 1, 0))
                );
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setSelectedIndex((index) => Math.max(index - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                select(results[selectedIndex]);
              }
            }}
            placeholder="Search artifacts..."
            className="w-full px-3 py-2 rounded-lg border border-border bg-surface-alt text-text-primary placeholder:text-text-muted/70 focus:outline-none focus:ring-2 focus:ring-pine-500/30 focus:border-pine-500"
          />
        </div>
        <div className="max-h-[60vh] overflow-y-auto p-2">
          {loading ? (
            <div className="px-3 py-2 text-sm text-text-muted">Loading...</div>
          ) : results.length === 0 ? (
            <div className="px-3 py-2 text-sm text-text-muted">
              No matching artifacts
            </div>
          ) : (
            results.map((result, index) => (
              <button
                key={result.id}
                onClick={() => select(result)}
                className={`w-full text-left px-3 py-2 rounded-lg flex items-center gap-2 ${
                  index === selectedIndex
                    ? "bg-pine-600/20 text-text-primary"
                    : "hover:bg-surface-alt text-text-primary"
                }`}
              >
                {result.isNew ? (
                  <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide bg-pine-600 dark:bg-pine-500 text-white">
                    New
                  </span>
                ) : (
                  <span
                    className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide ${
                      result.kind ? ARTIFACT_BADGE_COLORS[result.kind] : ""
                    }`}
                  >
                    {result.kind}
                  </span>
                )}
                <span className="truncate text-sm">{result.title}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
