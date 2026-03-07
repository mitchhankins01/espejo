import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { createArtifact } from "../api.ts";
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
    <div className="layout">
      <div className="page-header">
        <h1>New Artifact</h1>
        <Link to="/">
          <button className="btn-secondary">Cancel</button>
        </Link>
      </div>

      {error && <div className="error-message">{error}</div>}

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", gap: 12 }}>
          <div style={{ width: 160 }}>
            <label style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 4, display: "block" }}>
              Kind
            </label>
            <KindSelect value={kind} onChange={setKind} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 4, display: "block" }}>
              Title
            </label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Artifact title"
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
            onChange={setBody}
            placeholder="Write your artifact content in markdown..."
          />
        </div>

        <div>
          <label style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 4, display: "block" }}>
            Tags
          </label>
          <TagInput tags={tags} onChange={setTags} />
        </div>

        <div>
          <label style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 4, display: "block" }}>
            Source Entries
          </label>
          <SourcePicker selected={sources} onChange={setSources} />
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button className="btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : "Create Artifact"}
          </button>
        </div>
      </div>
    </div>
  );
}
