import { useState, useRef } from "react";
import { searchEntries, type EntrySearchResult } from "../api.ts";

export function SourcePicker({
  id,
  selected,
  onChange,
}: {
  id?: string;
  selected: string[];
  onChange: (uuids: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<EntrySearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleSearch(q: string) {
    setQuery(q);
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!q.trim()) {
      setResults([]);
      return;
    }
    timerRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await searchEntries(q);
        setResults(res);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
  }

  function addSource(uuid: string) {
    if (!selected.includes(uuid)) {
      onChange([...selected, uuid]);
    }
  }

  function removeSource(uuid: string) {
    onChange(selected.filter((u) => u !== uuid));
  }

  return (
    <div>
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {selected.map((uuid) => (
            <button
              key={uuid}
              type="button"
              onClick={() => removeSource(uuid)}
              aria-label={`Remove source ${uuid.slice(0, 8)}`}
              className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-pine-500/10 text-pine-700 dark:text-pine-300 border border-transparent hover:border-red-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors cursor-pointer"
            >
              {uuid.slice(0, 20)}... <span className="text-[10px]">&times;</span>
            </button>
          ))}
        </div>
      )}
      <input
        id={id}
        value={query}
        onChange={(e) => handleSearch(e.target.value)}
        placeholder="Search journal entries to link..."
        className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary placeholder:text-text-muted/60 focus:outline-none focus:ring-2 focus:ring-pine-500/30 focus:border-pine-500 text-base"
      />
      {searching && <p className="text-sm text-text-muted mt-1">Searching...</p>}
      {results.length > 0 && (
        <div className="mt-1 max-h-48 overflow-y-auto border border-border rounded-lg bg-surface">
          {results.map((r) => (
            <div
              key={r.uuid}
              onClick={() => addSource(r.uuid)}
              className={`px-3 py-2 cursor-pointer text-sm border-b border-border last:border-b-0 transition-colors
                ${selected.includes(r.uuid)
                  ? "bg-pine-500/10"
                  : "hover:bg-surface-elevated"
                }`}
            >
              <span className="text-text-muted mr-2">
                {new Date(r.created_at).toLocaleDateString()}
              </span>
              {r.preview}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
