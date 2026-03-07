import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { getArtifact, updateArtifact, deleteArtifact, listArtifactTags, type Artifact } from "../api.ts";
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
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([]);

  useEffect(() => {
    listArtifactTags().then((t) => setTagSuggestions(t.map((x) => x.name))).catch(() => {});
  }, []);

  const savedBody = useRef("");
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
      savedBody.current = a.body;
      dirty.current = false;
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
      savedBody.current = updated.body;
      dirty.current = false;
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

  function handleBodyChange(value: string) {
    if (saveStatus === "conflict") return;
    setBody(value);
    if (value.trim() === savedBody.current.trim()) return;
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

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-8">
        <div className="text-center py-16 text-text-muted">Loading...</div>
      </div>
    );
  }

  if (!artifact && error) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-8">
        <div className="text-red-600 dark:text-red-400 text-sm bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg px-4 py-3 mb-4">
          {error}
        </div>
        <Link to="/" className="text-pine-600 dark:text-pine-400 hover:underline text-sm">Back to list</Link>
      </div>
    );
  }

  const statusLabel: Record<SaveStatus, string> = {
    idle: "",
    saving: "Saving...",
    saved: "Saved",
    error: "Save failed",
    conflict: "",
  };

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Link to="/" className="text-text-muted text-xl leading-none hover:text-text-primary transition-colors">&larr;</Link>
          <h1 className="text-xl font-semibold text-text-primary">Edit Artifact</h1>
          {saveStatus !== "idle" && saveStatus !== "conflict" && (
            <span className={`text-xs font-medium px-2.5 py-1 rounded-full
              ${saveStatus === "saving" ? "text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30" : ""}
              ${saveStatus === "saved" ? "save-status saved text-pine-600 dark:text-pine-400 bg-pine-50 dark:bg-pine-950/30" : ""}
              ${saveStatus === "error" ? "text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30" : ""}
            `}>
              {statusLabel[saveStatus]}
            </span>
          )}
        </div>
        <button
          className="px-4 py-2 rounded-lg text-red-600 dark:text-red-400 border border-red-300 dark:border-red-700 text-sm font-medium hover:bg-red-600 hover:text-white dark:hover:bg-red-500 transition-colors disabled:opacity-50"
          onClick={handleDelete}
          disabled={deleting}
        >
          {deleting ? "Deleting..." : "Delete"}
        </button>
      </div>

      {saveStatus === "conflict" && (
        <div className="flex items-center justify-between gap-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg px-4 py-3 mb-4">
          <p className="text-red-600 dark:text-red-400 text-sm">This artifact was modified elsewhere. Reload to get the latest version.</p>
          <button
            className="px-4 py-2 rounded-lg bg-pine-600 dark:bg-pine-500 text-white text-sm font-medium hover:bg-pine-700 dark:hover:bg-pine-400 transition-colors shrink-0"
            onClick={handleReload}
          >
            Reload
          </button>
        </div>
      )}

      {error && saveStatus !== "conflict" && (
        <div className="text-red-600 dark:text-red-400 text-sm bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg px-4 py-3 mb-4">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-5">
        <div className="flex gap-3 max-sm:flex-col">
          <div className="w-40 max-sm:w-full shrink-0">
            <label htmlFor="edit-kind" className="block text-sm text-text-muted mb-1.5 font-medium">Kind</label>
            <KindSelect id="edit-kind" value={kind} onChange={handleChange(setKind)} />
          </div>
          <div className="flex-1">
            <label htmlFor="edit-title" className="block text-sm text-text-muted mb-1.5 font-medium">Title</label>
            <input
              id="edit-title"
              value={title}
              onChange={(e) => handleChange(setTitle)(e.target.value)}
              maxLength={300}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary placeholder:text-text-muted/60 focus:outline-none focus:ring-2 focus:ring-pine-500/30 focus:border-pine-500 text-base"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm text-text-muted mb-1.5 font-medium">Body (Markdown)</label>
          <MarkdownEditor
            value={body}
            onChange={handleBodyChange}
            readOnly={saveStatus === "conflict"}
          />
        </div>

        <div>
          <label htmlFor="edit-tags" className="block text-sm text-text-muted mb-1.5 font-medium">Tags</label>
          <TagInput id="edit-tags" tags={tags} onChange={handleChange(setTags)} suggestions={tagSuggestions} />
        </div>

        <div>
          <label htmlFor="edit-sources" className="block text-sm text-text-muted mb-1.5 font-medium">Source Entries</label>
          <SourcePicker id="edit-sources" selected={sources} onChange={handleChange(setSources)} />
        </div>

        <div className="text-xs text-text-muted">
          Version {version} &middot; Updated {artifact ? new Date(artifact.updated_at).toLocaleString() : ""}
        </div>
      </div>
    </div>
  );
}
