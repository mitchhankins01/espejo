import { useState, useEffect, useCallback, useMemo } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import Markdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import {
  getArtifact,
  updateArtifact,
  deleteArtifact,
  listArtifactTags,
  getRelatedArtifacts,
  listArtifactTitles,
  type Artifact,
  type RelatedArtifacts,
} from "../api.ts";
import { KindSelect } from "../components/KindSelect.tsx";
import { TagInput } from "../components/TagInput.tsx";
import { SourcePicker } from "../components/SourcePicker.tsx";
import { MarkdownEditor } from "../components/MarkdownEditor.tsx";
import { ARTIFACT_BADGE_COLORS } from "../constants/artifacts.ts";

type EditMode = "edit" | "preview";

const EMPTY_RELATED: RelatedArtifacts = {
  semantic: [],
  explicit: [],
};

export function ArtifactEdit() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [related, setRelated] = useState<RelatedArtifacts>(EMPTY_RELATED);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [kind, setKind] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [version, setVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([]);
  const [mode, setMode] = useState<EditMode>("edit");
  const [titleToId, setTitleToId] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    listArtifactTags()
      .then((t) => setTagSuggestions(t.map((x) => x.name)))
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError("");
    try {
      const [artifactResult, relatedResult, titlesResult] = await Promise.allSettled([
        getArtifact(id),
        getRelatedArtifacts(id),
        listArtifactTitles(),
      ]);

      if (artifactResult.status !== "fulfilled") {
        throw artifactResult.reason;
      }

      const a = artifactResult.value;
      setArtifact(a);
      setKind(a.kind);
      setTitle(a.title);
      setBody(a.body);
      setTags(a.tags);
      setSources(a.source_entry_uuids);
      setVersion(a.version);

      setRelated(
        relatedResult.status === "fulfilled" ? relatedResult.value : EMPTY_RELATED
      );

      if (titlesResult.status === "fulfilled") {
        setTitleToId(
          new Map(
            titlesResult.value.map((item) => [item.title.trim().toLowerCase(), item.id])
          )
        );
      } else {
        setTitleToId(new Map());
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const previewBody = useMemo(() => {
    return body.replace(/\[\[([^\]]+)\]\]/g, (_match, rawTitle: string) => {
      const cleanTitle = rawTitle.trim();
      const targetId = titleToId.get(cleanTitle.toLowerCase());
      if (!targetId) return cleanTitle;
      return `[${cleanTitle}](/${targetId})`;
    });
  }, [body, titleToId]);

  async function handleSave() {
    if (!id || !title.trim() || !body.trim()) return;

    setSaving(true);
    setError("");
    try {
      await updateArtifact(id, {
        kind,
        title: title.trim(),
        body: body.trim(),
        tags,
        source_entry_uuids: sources,
        expected_version: version,
      });
      navigate(-1);
    } catch (err) {
      setSaving(false);
      setError(String(err));
    }
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
        <Link
          to="/"
          className="text-pine-600 dark:text-pine-400 hover:underline text-sm"
        >
          Back to list
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Link
            to="/"
            className="text-text-muted text-xl leading-none hover:text-text-primary transition-colors"
          >
            &larr;
          </Link>
          <h1 className="text-xl font-semibold text-text-primary">Edit Artifact</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="px-4 py-2 rounded-lg bg-pine-600 dark:bg-pine-500 text-white text-sm font-medium hover:bg-pine-700 dark:hover:bg-pine-400 transition-colors disabled:opacity-50"
            onClick={handleSave}
            disabled={saving || !title.trim() || !body.trim()}
          >
            {saving ? "Saving..." : "Save"}
          </button>
          <button
            className="px-4 py-2 rounded-lg text-red-600 dark:text-red-400 border border-red-300 dark:border-red-700 text-sm font-medium hover:bg-red-600 hover:text-white dark:hover:bg-red-500 transition-colors disabled:opacity-50"
            onClick={handleDelete}
            disabled={deleting}
          >
            {deleting ? "Deleting..." : "Delete"}
          </button>
        </div>
      </div>

      {error && (
        <div className="text-red-600 dark:text-red-400 text-sm bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg px-4 py-3 mb-4">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-5">
        <div className="flex gap-3 max-sm:flex-col">
          <div className="w-40 max-sm:w-full shrink-0">
            <label
              htmlFor="edit-kind"
              className="block text-sm text-text-muted mb-1.5 font-medium"
            >
              Kind
            </label>
            <KindSelect id="edit-kind" value={kind} onChange={setKind} />
          </div>
          <div className="flex-1">
            <label
              htmlFor="edit-title"
              className="block text-sm text-text-muted mb-1.5 font-medium"
            >
              Title
            </label>
            <input
              id="edit-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={300}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary placeholder:text-text-muted/60 focus:outline-none focus:ring-2 focus:ring-pine-500/30 focus:border-pine-500 text-base"
            />
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="block text-sm text-text-muted font-medium">
              Body (Markdown)
            </label>
            <div className="flex items-center gap-1 rounded-md border border-border bg-surface p-1">
              <button
                type="button"
                onClick={() => setMode("edit")}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                  mode === "edit"
                    ? "bg-pine-600 dark:bg-pine-500 text-white"
                    : "text-text-muted hover:text-text-primary"
                }`}
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => setMode("preview")}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                  mode === "preview"
                    ? "bg-pine-600 dark:bg-pine-500 text-white"
                    : "text-text-muted hover:text-text-primary"
                }`}
              >
                Preview
              </button>
            </div>
          </div>
          {mode === "edit" ? (
            <MarkdownEditor value={body} onChange={setBody} enableArtifactLinks />
          ) : (
            <div className="min-h-[300px] rounded-lg border border-border bg-surface px-4 py-3">
              <Markdown
                rehypePlugins={[rehypeSanitize]}
                components={{
                  a: ({ href, children, ...props }) => {
                    if (href && href.startsWith("/")) {
                      return (
                        <Link
                          to={href}
                          className="text-pine-600 dark:text-pine-400 hover:underline"
                        >
                          {children}
                        </Link>
                      );
                    }
                    return (
                      <a href={href} {...props}>
                        {children}
                      </a>
                    );
                  },
                }}
              >
                {previewBody || "_No content yet._"}
              </Markdown>
            </div>
          )}
        </div>

        <div>
          <label
            htmlFor="edit-tags"
            className="block text-sm text-text-muted mb-1.5 font-medium"
          >
            Tags
          </label>
          <TagInput
            id="edit-tags"
            tags={tags}
            onChange={setTags}
            suggestions={tagSuggestions}
          />
        </div>

        <div>
          <label
            htmlFor="edit-sources"
            className="block text-sm text-text-muted mb-1.5 font-medium"
          >
            Source Entries
          </label>
          <SourcePicker id="edit-sources" selected={sources} onChange={setSources} />
        </div>

        <div>
          <h2 className="text-sm text-text-muted mb-2 font-medium">Related</h2>
          <div className="rounded-lg border border-border bg-surface p-4 space-y-4">
            {related.semantic.length === 0 && related.explicit.length === 0 && (
              <div className="text-sm text-text-muted">No related artifacts found.</div>
            )}

            {related.semantic.length > 0 && (
              <div>
                <div className="text-xs uppercase tracking-wide text-text-muted mb-2">
                  Semantic
                </div>
                <div className="space-y-2">
                  {related.semantic.map((item) => {
                    const normalized = Math.max(0, Math.min(1, item.similarity));
                    return (
                      <Link
                        key={`semantic-${item.id}`}
                        to={`/${item.id}`}
                        className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-elevated transition-colors"
                      >
                        <span
                          className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide ${
                            ARTIFACT_BADGE_COLORS[item.kind]
                          }`}
                        >
                          {item.kind}
                        </span>
                        <span className="text-sm text-text-primary flex-1 truncate">
                          {item.title}
                        </span>
                        <div className="w-16 h-1.5 rounded-full bg-surface-elevated overflow-hidden">
                          <div
                            className="h-full bg-pine-600 dark:bg-pine-500"
                            style={{ width: `${Math.round(normalized * 100)}%` }}
                          />
                        </div>
                        <span className="text-xs text-text-muted w-10 text-right">
                          {Math.round(item.similarity * 100)}%
                        </span>
                      </Link>
                    );
                  })}
                </div>
              </div>
            )}

            {related.explicit.length > 0 && (
              <div>
                <div className="text-xs uppercase tracking-wide text-text-muted mb-2">
                  Explicit
                </div>
                <div className="space-y-2">
                  {related.explicit.map((item) => (
                    <Link
                      key={`explicit-${item.direction}-${item.id}`}
                      to={`/${item.id}`}
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-elevated transition-colors"
                    >
                      <span className="text-text-muted text-xs w-4">
                        {item.direction === "outgoing" ? "↗" : "↙"}
                      </span>
                      <span
                        className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide ${
                          ARTIFACT_BADGE_COLORS[item.kind]
                        }`}
                      >
                        {item.kind}
                      </span>
                      <span className="text-sm text-text-primary flex-1 truncate">
                        {item.title}
                      </span>
                      <span className="text-xs text-text-muted">
                        {item.direction}
                      </span>
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="text-xs text-text-muted">
          Version {version} &middot; Updated{" "}
          {artifact ? new Date(artifact.updated_at).toLocaleString() : ""}
        </div>
      </div>
    </div>
  );
}
