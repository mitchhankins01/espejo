import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { deleteTemplate, getTemplate, updateTemplate } from "../api.ts";
import { MarkdownEditor } from "../components/MarkdownEditor.tsx";

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

export function TemplateEdit() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [sortOrder, setSortOrder] = useState(0);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError("");
    try {
      const template = await getTemplate(id);
      setName(template.name);
      setSlug(template.slug);
      setDescription(template.description ?? "");
      setBody(template.body);
      setSortOrder(template.sort_order);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSave(): Promise<void> {
    if (!id || !name.trim()) {
      setError("Name is required.");
      return;
    }

    setSaving(true);
    setError("");
    try {
      await updateTemplate(id, {
        name: name.trim(),
        slug: slugify(slug || name),
        description: description.trim() || null,
        body,
        sort_order: sortOrder,
      });
      navigate("/templates");
    } catch (err) {
      setError(String(err));
      setSaving(false);
    }
  }

  async function handleDelete(): Promise<void> {
    if (!id || !confirm("Delete this template?")) return;
    setDeleting(true);
    try {
      await deleteTemplate(id);
      navigate("/templates");
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

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Link
            to="/templates"
            className="text-text-muted text-xl leading-none hover:text-text-primary transition-colors"
          >
            &larr;
          </Link>
          <h1 className="text-xl font-semibold text-text-primary">Edit Template</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || !name.trim()}
            className="px-4 py-2 rounded-lg bg-pine-600 dark:bg-pine-500 text-white text-sm font-medium hover:bg-pine-700 dark:hover:bg-pine-400 transition-colors disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save"}
          </button>
          <button
            type="button"
            onClick={() => void handleDelete()}
            disabled={deleting}
            className="px-4 py-2 rounded-lg text-red-600 dark:text-red-400 border border-red-300 dark:border-red-700 text-sm font-medium hover:bg-red-600 hover:text-white dark:hover:bg-red-500 transition-colors disabled:opacity-50"
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

      <div className="space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label
              htmlFor="template-edit-name"
              className="block text-sm text-text-muted mb-1.5 font-medium"
            >
              Name
            </label>
            <input
              id="template-edit-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={100}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary"
            />
          </div>
          <div>
            <label
              htmlFor="template-edit-slug"
              className="block text-sm text-text-muted mb-1.5 font-medium"
            >
              Slug
            </label>
            <input
              id="template-edit-slug"
              value={slug}
              onChange={(event) => setSlug(slugify(event.target.value))}
              maxLength={80}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary"
            />
          </div>
        </div>

        <div>
          <label
            htmlFor="template-edit-description"
            className="block text-sm text-text-muted mb-1.5 font-medium"
          >
            Description
          </label>
          <input
            id="template-edit-description"
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
            htmlFor="template-edit-sort"
            className="block text-sm text-text-muted mb-1.5 font-medium"
          >
            Sort order
          </label>
          <input
            id="template-edit-sort"
            type="number"
            value={sortOrder}
            onChange={(event) => setSortOrder(Number(event.target.value) || 0)}
            className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary"
          />
        </div>
      </div>
    </div>
  );
}
