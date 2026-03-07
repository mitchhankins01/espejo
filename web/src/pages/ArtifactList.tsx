import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { listArtifacts, searchArtifacts, type Artifact } from "../api.ts";
import { MarkdownPreview } from "../components/MarkdownPreview.tsx";

const KINDS = ["", "insight", "theory", "model", "reference"] as const;

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

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
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
        <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          {artifacts.map((a) => (
            <Link
              key={a.id}
              to={`/${a.id}`}
              style={{ textDecoration: "none", color: "inherit" }}
            >
              <div
                style={{
                  padding: "12px 16px",
                  background: "var(--bg-surface)",
                  borderRadius: "var(--radius)",
                  marginBottom: 4,
                  transition: "background 0.15s",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-elevated)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "var(--bg-surface)")}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <span className={`kind-badge ${a.kind}`}>{a.kind}</span>
                  <span style={{ fontWeight: 500 }}>{a.title}</span>
                </div>
                {a.body && (
                  <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 4 }}>
                    <MarkdownPreview content={a.body} maxLength={150} />
                  </div>
                )}
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                  <span style={{ color: "var(--text-muted)" }}>
                    {new Date(a.created_at).toLocaleDateString()}
                  </span>
                  {a.tags.map((t) => (
                    <span key={t} className="tag">
                      {t}
                    </span>
                  ))}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
