import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createTemplate } from "../api.ts";
import { MarkdownEditor } from "../components/MarkdownEditor.tsx";
import { TagInput } from "../components/TagInput.tsx";

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

export function TemplateCreate() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [defaultTags, setDefaultTags] = useState<string[]>([]);
  const [sortOrder, setSortOrder] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSave(): Promise<void> {
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }

    setSaving(true);
    setError("");
    try {
      const created = await createTemplate({
        name: name.trim(),
        slug: (slug || slugify(name)).trim(),
        description: description.trim() || null,
        body,
        default_tags: defaultTags,
        sort_order: sortOrder,
      });
      navigate(`/templates/${created.id}`);
    } catch (err) {
      setError(String(err));
      setSaving(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-text-primary">New Template</h1>
        <Link
          to="/templates"
          className="px-4 py-2 rounded-lg bg-surface-elevated text-text-primary border border-border text-sm font-medium hover:bg-border transition-colors"
        >
          Cancel
        </Link>
      </div>

      {error && (
        <div className="text-red-600 dark:text-red-400 text-sm bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg px-4 py-3 mb-4">
          {error}
        </div>
      )}

      <div className="space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label
              htmlFor="template-create-name"
              className="block text-sm text-text-muted mb-1.5 font-medium"
            >
              Name
            </label>
            <input
              id="template-create-name"
              value={name}
              onChange={(event) => {
                const next = event.target.value;
                setName(next);
                if (!slug.trim()) setSlug(slugify(next));
              }}
              maxLength={100}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary"
            />
          </div>
          <div>
            <label
              htmlFor="template-create-slug"
              className="block text-sm text-text-muted mb-1.5 font-medium"
            >
              Slug
            </label>
            <input
              id="template-create-slug"
              value={slug}
              onChange={(event) => setSlug(slugify(event.target.value))}
              maxLength={80}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary"
            />
          </div>
        </div>

        <div>
          <label
            htmlFor="template-create-description"
            className="block text-sm text-text-muted mb-1.5 font-medium"
          >
            Description
          </label>
          <input
            id="template-create-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={300}
            className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary"
          />
        </div>

        <div>
          <label className="block text-sm text-text-muted mb-1.5 font-medium">
            Body (Markdown)
          </label>
          <MarkdownEditor value={body} onChange={setBody} />
        </div>

        <div>
          <label
            htmlFor="template-create-tags"
            className="block text-sm text-text-muted mb-1.5 font-medium"
          >
            Default tags
          </label>
          <TagInput id="template-create-tags" tags={defaultTags} onChange={setDefaultTags} />
        </div>

        <div>
          <label
            htmlFor="template-create-sort"
            className="block text-sm text-text-muted mb-1.5 font-medium"
          >
            Sort order
          </label>
          <input
            id="template-create-sort"
            type="number"
            value={sortOrder}
            onChange={(event) => setSortOrder(Number(event.target.value) || 0)}
            className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary"
          />
        </div>

        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || !name.trim()}
            className="px-6 py-2.5 rounded-lg bg-pine-600 dark:bg-pine-500 text-white font-medium hover:bg-pine-700 dark:hover:bg-pine-400 transition-colors disabled:opacity-50"
          >
            {saving ? "Saving..." : "Create Template"}
          </button>
        </div>
      </div>
    </div>
  );
}
