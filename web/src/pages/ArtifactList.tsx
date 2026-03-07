import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { listArtifacts, searchArtifacts, type Artifact } from "../api.ts";

const KINDS = ["", "insight", "theory", "model", "reference"] as const;

/** Strip markdown syntax to get a plain text snippet */
function plainSnippet(md: string, max: number): string {
  return md
    .replace(/^#+\s+/gm, "")       // headings
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1") // bold/italic
    .replace(/_{1,3}([^_]+)_{1,3}/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links
    .replace(/^[-*>]\s+/gm, "")    // list markers, blockquotes
    .replace(/^---+$/gm, "")       // thematic breaks
    .replace(/`{1,3}[^`]*`{1,3}/g, "") // inline/fenced code
    .replace(/\n{2,}/g, " ")       // collapse blank lines
    .replace(/\n/g, " ")           // remaining newlines
    .replace(/\s{2,}/g, " ")       // collapse whitespace
    .trim()
    .slice(0, max) + (md.length > max ? "..." : "");
}

export function ArtifactList() {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      let results: Artifact[];
      if (search.trim()) {
        results = await searchArtifacts(search);
      } else {
        results = await listArtifacts({
          kind: kindFilter || undefined,
          limit: 50,
        });
      }
      setArtifacts(results);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [search, kindFilter]);

  useEffect(() => {
    const timer = setTimeout(load, search ? 400 : 0);
    return () => clearTimeout(timer);
  }, [load, search]);

  return (
    <div className="layout">
      <div className="page-header">
        <h1>Knowledge Base</h1>
        <Link to="/new">
          <button className="btn-primary">New Artifact</button>
        </Link>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search artifacts..."
          style={{ flex: 1 }}
        />
        <select
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value)}
          style={{ width: 140 }}
        >
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k ? k.charAt(0).toUpperCase() + k.slice(1) : "All kinds"}
            </option>
          ))}
        </select>
      </div>

      {error && <div className="error-message">{error}</div>}

      {loading ? (
        <div className="loading">Loading...</div>
      ) : artifacts.length === 0 ? (
        <div className="empty-state">
          {search ? "No artifacts match your search." : "No artifacts yet. Create one to get started."}
        </div>
      ) : (
        <div className="artifact-list">
          {artifacts.map((a) => (
            <Link
              key={a.id}
              to={`/${a.id}`}
              className="artifact-card"
            >
              <div className="artifact-card-header">
                <span className={`kind-badge ${a.kind}`}>{a.kind}</span>
                <span className="artifact-card-title">{a.title}</span>
              </div>
              {a.body && (
                <p className="artifact-card-snippet">
                  {plainSnippet(a.body, 180)}
                </p>
              )}
              <div className="artifact-card-meta">
                <span>{new Date(a.created_at).toLocaleDateString()}</span>
                {a.tags.map((t) => (
                  <span key={t} className="tag">{t}</span>
                ))}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
