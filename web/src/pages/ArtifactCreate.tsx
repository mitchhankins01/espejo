import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { createArtifact, listArtifactTags } from "../api.ts";
import { KindSelect } from "../components/KindSelect.tsx";
import { TagInput } from "../components/TagInput.tsx";
import { SourcePicker } from "../components/SourcePicker.tsx";
import { MarkdownEditor } from "../components/MarkdownEditor.tsx";

export function ArtifactCreate() {
  const navigate = useNavigate();
  const [kind, setKind] = useState("insight");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([]);

  useEffect(() => {
    listArtifactTags().then((t) => setTagSuggestions(t.map((x) => x.name))).catch(() => {});
  }, []);

  async function handleSave() {
    if (!title.trim() || !body.trim()) {
      setError("Title and body are required.");
      return;
    }

    setSaving(true);
    setError("");
    try {
      const artifact = await createArtifact({
        kind,
        title: title.trim(),
        body: body.trim(),
        tags: tags.length > 0 ? tags : undefined,
        source_entry_uuids: sources.length > 0 ? sources : undefined,
      });
      navigate(`/${artifact.id}`);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-text-primary">New Artifact</h1>
        <Link to="/">
          <button className="px-4 py-2 rounded-lg bg-surface-elevated text-text-primary border border-border text-sm font-medium hover:bg-border transition-colors">
            Cancel
          </button>
        </Link>
      </div>

      {error && (
        <div className="text-red-600 dark:text-red-400 text-sm bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg px-4 py-3 mb-4">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-5">
        <div className="flex gap-3 max-sm:flex-col">
          <div className="w-40 max-sm:w-full shrink-0">
            <label htmlFor="create-kind" className="block text-sm text-text-muted mb-1.5 font-medium">Kind</label>
            <KindSelect id="create-kind" value={kind} onChange={setKind} />
          </div>
          <div className="flex-1">
            <label htmlFor="create-title" className="block text-sm text-text-muted mb-1.5 font-medium">Title</label>
            <input
              id="create-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Artifact title"
              maxLength={300}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary placeholder:text-text-muted/60 focus:outline-none focus:ring-2 focus:ring-pine-500/30 focus:border-pine-500 text-base"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm text-text-muted mb-1.5 font-medium">Body (Markdown)</label>
          <MarkdownEditor
            value={body}
            onChange={setBody}
            placeholder="Write your artifact content in markdown..."
          />
        </div>

        <div>
          <label htmlFor="create-tags" className="block text-sm text-text-muted mb-1.5 font-medium">Tags</label>
          <TagInput id="create-tags" tags={tags} onChange={setTags} suggestions={tagSuggestions} />
        </div>

        <div>
          <label htmlFor="create-sources" className="block text-sm text-text-muted mb-1.5 font-medium">Source Entries</label>
          <SourcePicker id="create-sources" selected={sources} onChange={setSources} />
        </div>

        <div className="flex justify-end">
          <button
            className="px-6 py-2.5 rounded-lg bg-pine-600 dark:bg-pine-500 text-white font-medium hover:bg-pine-700 dark:hover:bg-pine-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? "Saving..." : "Create Artifact"}
          </button>
        </div>
      </div>
    </div>
  );
}
