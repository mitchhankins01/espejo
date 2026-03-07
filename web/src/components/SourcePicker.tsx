import { useState, useRef } from "react";
import { searchEntries, type EntrySearchResult } from "../api.ts";

export function SourcePicker({
  selected,
  onChange,
}: {
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
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
          {selected.map((uuid) => (
            <span
              key={uuid}
              className="tag"
              style={{ cursor: "pointer", fontSize: 11 }}
              onClick={() => removeSource(uuid)}
            >
              {uuid.slice(0, 20)}... &times;
            </span>
          ))}
        </div>
      )}
      <input
        value={query}
        onChange={(e) => handleSearch(e.target.value)}
        placeholder="Search journal entries to link..."
      />
      {searching && <p className="save-status saving" style={{ marginTop: 4 }}>Searching...</p>}
      {results.length > 0 && (
        <div
          style={{
            marginTop: 4,
            maxHeight: 200,
            overflowY: "auto",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
          }}
        >
          {results.map((r) => (
            <div
              key={r.uuid}
              onClick={() => addSource(r.uuid)}
              style={{
                padding: "8px 12px",
                cursor: "pointer",
                borderBottom: "1px solid var(--border)",
                fontSize: 13,
                background: selected.includes(r.uuid) ? "var(--bg-elevated)" : "transparent",
              }}
            >
              <span style={{ color: "var(--text-muted)", marginRight: 8 }}>
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
