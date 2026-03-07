import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { getArtifact, updateArtifact, deleteArtifact, type Artifact } from "../api.ts";
import { KindSelect } from "../components/KindSelect.tsx";
import { TagInput } from "../components/TagInput.tsx";
import { SourcePicker } from "../components/SourcePicker.tsx";
import { MarkdownEditor } from "../components/MarkdownEditor.tsx";
import { useAutosave } from "../hooks/useAutosave.ts";

type SaveStatus = "idle" | "saving" | "saved" | "error" | "conflict";

export function ArtifactEdit() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [kind, setKind] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [version, setVersion] = useState(0);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [deleting, setDeleting] = useState(false);
  const dirty = useRef(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError("");
    try {
      const a = await getArtifact(id);
      setArtifact(a);
      setKind(a.kind);
      setTitle(a.title);
      setBody(a.body);
      setTags(a.tags);
      setSources(a.source_entry_uuids);
      setVersion(a.version);
      setSaveStatus("idle");
      dirty.current = false;
      bodyInitialized.current = false;
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async () => {
    if (!id || !title.trim() || !body.trim() || !dirty.current) return;

    setSaveStatus("saving");
    try {
      const updated = await updateArtifact(id, {
        kind,
        title: title.trim(),
        body: body.trim(),
        tags,
        source_entry_uuids: sources,
        expected_version: version,
      });
      setVersion(updated.version);
      setArtifact(updated);
      setSaveStatus("saved");
    } catch (err) {
      const status = (err as Error & { status?: number }).status;
      if (status === 409) {
        setSaveStatus("conflict");
      } else {
        setSaveStatus("error");
        setError(String(err));
      }
    }
  }, [id, kind, title, body, tags, sources, version]);

  const { trigger: triggerAutosave, cancel: cancelAutosave } = useAutosave(save);

  function handleChange<T>(setter: (v: T) => void) {
    return (value: T) => {
      if (saveStatus === "conflict") return;
      setter(value);
      dirty.current = true;
      setSaveStatus("idle");
      triggerAutosave();
    };
  }

  // MDXEditor fires onChange on mount with normalized markdown.
  // Suppress that first spurious change by tracking body initialization.
  const bodyInitialized = useRef(false);
  function handleBodyChange(value: string) {
    if (saveStatus === "conflict") return;
    setBody(value);
    if (!bodyInitialized.current) {
      bodyInitialized.current = true;
      return;
    }
    dirty.current = true;
    setSaveStatus("idle");
    triggerAutosave();
  }

  async function handleDelete() {
    if (!id || !confirm("Delete this artifact?")) return;
    setDeleting(true);
    try {
      await deleteArtifact(id);
      navigate("/");
    } catch (err) {
      setError(String(err));
      setDeleting(false);
    }
  }

  function handleReload() {
    cancelAutosave();
    void load();
  }

  if (loading) return <div className="layout"><div className="loading">Loading...</div></div>;
  if (!artifact && error) {
    return (
      <div className="layout">
        <div className="error-message">{error}</div>
        <Link to="/">Back to list</Link>
      </div>
    );
  }

  const statusText: Record<SaveStatus, string> = {
    idle: "",
    saving: "Saving...",
    saved: "Saved",
    error: "Save failed",
    conflict: "",
  };

  const statusClass: Record<SaveStatus, string> = {
    idle: "",
    saving: "saving",
    saved: "saved",
    error: "error",
    conflict: "",
  };

  return (
    <div className="layout">
      <div className="page-header">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Link to="/" style={{ color: "var(--text-muted)", fontSize: 20 }}>&larr;</Link>
          <h1>Edit Artifact</h1>
          {saveStatus !== "idle" && saveStatus !== "conflict" && (
            <span className={`save-status ${statusClass[saveStatus]}`}>
              {statusText[saveStatus]}
            </span>
          )}
        </div>
        <button className="btn-danger" onClick={handleDelete} disabled={deleting}>
          {deleting ? "Deleting..." : "Delete"}
        </button>
      </div>

      {saveStatus === "conflict" && (
        <div className="conflict-banner">
          <p>This artifact was modified elsewhere. Reload to get the latest version.</p>
          <button className="btn-primary" onClick={handleReload}>
            Reload
          </button>
        </div>
      )}

      {error && saveStatus !== "conflict" && <div className="error-message">{error}</div>}

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", gap: 12 }}>
          <div style={{ width: 160 }}>
            <label style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 4, display: "block" }}>
              Kind
            </label>
            <KindSelect value={kind} onChange={handleChange(setKind)} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 4, display: "block" }}>
              Title
            </label>
            <input
              value={title}
              onChange={(e) => handleChange(setTitle)(e.target.value)}
              maxLength={300}
            />
          </div>
        </div>

        <div>
          <label style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 4, display: "block" }}>
            Body (Markdown)
          </label>
          <MarkdownEditor
            value={body}
            onChange={handleBodyChange}
            readOnly={saveStatus === "conflict"}
          />
        </div>

        <div>
          <label style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 4, display: "block" }}>
            Tags
          </label>
          <TagInput tags={tags} onChange={handleChange(setTags)} />
        </div>

        <div>
          <label style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 4, display: "block" }}>
            Source Entries
          </label>
          <SourcePicker selected={sources} onChange={handleChange(setSources)} />
        </div>

        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
          Version {version} &middot; Updated {artifact ? new Date(artifact.updated_at).toLocaleString() : ""}
        </div>
      </div>
    </div>
  );
}
