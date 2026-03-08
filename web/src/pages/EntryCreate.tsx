import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  createEntry,
  getTemplate,
  listEntryTags,
  uploadEntryMedia,
  type EntryTemplate,
} from "../api.ts";
import { MarkdownEditor } from "../components/MarkdownEditor.tsx";
import { TagInput } from "../components/TagInput.tsx";
import { TemplatePicker } from "../components/TemplatePicker.tsx";
import { MediaUpload, mediaUploadKey } from "../components/MediaUpload.tsx";

function defaultLocalDateTime(): string {
  const date = new Date();
  const offset = date.getTimezoneOffset();
  const local = new Date(date.getTime() - offset * 60_000);
  return local.toISOString().slice(0, 16);
}

function localDateTimeToIso(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function formatLocalDateTime(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function EntryCreate() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const templateFromQuery = searchParams.get("template");

  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(
    templateFromQuery
  );
  const [text, setText] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([]);
  const [timezone, setTimezone] = useState(
    Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  );
  const [createdAtLocal, setCreatedAtLocal] = useState(defaultLocalDateTime());
  const [files, setFiles] = useState<File[]>([]);
  const [progressByKey, setProgressByKey] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [editingDate, setEditingDate] = useState(false);
  const [editingTimezone, setEditingTimezone] = useState(false);

  useEffect(() => {
    if (!templateFromQuery) return;
    getTemplate(templateFromQuery)
      .then((template) => {
        setSelectedTemplateId(template.id);
        setText(template.body);
        setTags(template.default_tags);
      })
      .catch(() => {
        setSelectedTemplateId(null);
      });
  }, [templateFromQuery]);

  useEffect(() => {
    listEntryTags()
      .then((result) => setTagSuggestions(result.map((t) => t.name)))
      .catch(() => {});
  }, []);

  function applyTemplate(template: EntryTemplate | null): void {
    setSelectedTemplateId(template?.id ?? null);
    if (!template) return;
    setText(template.body);
    setTags(template.default_tags);
  }

  async function handleSave(): Promise<void> {
    if (!text.trim()) {
      setError("Entry text is required.");
      return;
    }

    setSaving(true);
    setError("");
    try {
      const entry = await createEntry({
        text: text.trim(),
        timezone,
        created_at: localDateTimeToIso(createdAtLocal),
        tags: tags.length > 0 ? tags : undefined,
      });

      for (const file of files) {
        const key = mediaUploadKey(file);
        setProgressByKey((prev) => ({ ...prev, [key]: 0 }));
        await uploadEntryMedia(entry.uuid, file, (percent) => {
          setProgressByKey((prev) => ({ ...prev, [key]: percent }));
        });
        setProgressByKey((prev) => ({ ...prev, [key]: 100 }));
      }

      navigate(`/journal/${entry.uuid}`);
    } catch (err) {
      setError(String(err));
      setSaving(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-2 sm:px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-text-primary">New Journal Entry</h1>
        <Link
          to="/journal"
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
        <div>
          <label className="block text-sm text-text-muted mb-1.5 font-medium">Template</label>
          <TemplatePicker selectedId={selectedTemplateId} onSelect={applyTemplate} />
        </div>

        <MarkdownEditor
          value={text}
          onChange={setText}
          placeholder="Write what happened, what you felt, what you noticed..."
        />

        <div className="flex items-center gap-2 text-sm text-text-muted">
          {editingDate ? (
            <input
              id="entry-create-date"
              type="datetime-local"
              value={createdAtLocal}
              onChange={(event) => setCreatedAtLocal(event.target.value)}
              onBlur={() => setEditingDate(false)}
              autoFocus
              className="px-2 py-1 rounded border border-border bg-surface text-text-primary text-sm"
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditingDate(true)}
              className="hover:text-text-primary transition-colors"
            >
              {formatLocalDateTime(createdAtLocal) || "Set date"}
            </button>
          )}
          <span className="text-text-muted/40">|</span>
          {editingTimezone ? (
            <input
              id="entry-create-timezone"
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
              onBlur={() => setEditingTimezone(false)}
              autoFocus
              className="px-2 py-1 rounded border border-border bg-surface text-text-primary text-sm w-48"
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditingTimezone(true)}
              className="hover:text-text-primary transition-colors"
            >
              {timezone || "Set timezone"}
            </button>
          )}
        </div>

        <div>
          <label
            htmlFor="entry-create-tags"
            className="block text-sm text-text-muted mb-1.5 font-medium"
          >
            Tags
          </label>
          <TagInput id="entry-create-tags" tags={tags} onChange={setTags} suggestions={tagSuggestions} />
        </div>

        <div>
          <label className="block text-sm text-text-muted mb-1.5 font-medium">Photos</label>
          <MediaUpload
            files={files}
            onChange={setFiles}
            progressByKey={progressByKey}
            disabled={saving}
          />
        </div>

        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || !text.trim()}
            className="px-6 py-2.5 rounded-lg bg-pine-600 dark:bg-pine-500 text-white font-medium hover:bg-pine-700 dark:hover:bg-pine-400 transition-colors disabled:opacity-50"
          >
            {saving ? "Saving..." : "Create Entry"}
          </button>
        </div>
      </div>
    </div>
  );
}
