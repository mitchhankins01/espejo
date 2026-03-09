import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  deleteEntry,
  deleteEntryMedia,
  getEntry,
  listEntryTags,
  updateEntry,
  uploadEntryMedia,
  type Entry,
} from "../api.ts";
import { MarkdownEditor } from "../components/MarkdownEditor.tsx";
import { TagInput } from "../components/TagInput.tsx";
import { MediaGallery } from "../components/MediaGallery.tsx";
import { MediaUpload, mediaUploadKey } from "../components/MediaUpload.tsx";

function isoToLocalDateTime(value: string): string {
  const date = new Date(value);
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 16);
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

export function EntryEdit() {
  const { uuid } = useParams<{ uuid: string }>();
  const navigate = useNavigate();

  const [entry, setEntry] = useState<Entry | null>(null);
  const [text, setText] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([]);
  const [timezone, setTimezone] = useState("");
  const [createdAtLocal, setCreatedAtLocal] = useState("");
  const [version, setVersion] = useState(0);
  const [newFiles, setNewFiles] = useState<File[]>([]);
  const [progressByKey, setProgressByKey] = useState<Record<string, number>>({});
  const [editingDate, setEditingDate] = useState(false);
  const [editingTimezone, setEditingTimezone] = useState(false);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deletingMediaId, setDeletingMediaId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);

  const load = useCallback(async () => {
    if (!uuid) return;
    setLoading(true);
    setError("");
    try {
      const data = await getEntry(uuid);
      setEntry(data);
      setText(data.text || "");
      setTags(data.tags || []);
      setTimezone(data.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
      setCreatedAtLocal(isoToLocalDateTime(data.created_at));
      setVersion(data.version);
      setConflict(false);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [uuid]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    listEntryTags()
      .then((result) => setTagSuggestions(result.map((t) => t.name)))
      .catch(() => {});
  }, []);

  const dayOneMetadata = useMemo(() => {
    if (!entry || entry.source !== "dayone") return null;
    const locationParts = [entry.place_name, entry.city, entry.admin_area, entry.country]
      .filter(Boolean)
      .join(", ");
    const weatherParts = [
      entry.temperature != null ? `${entry.temperature}°` : null,
      entry.weather_conditions,
      entry.humidity != null ? `Humidity ${entry.humidity}%` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    if (!locationParts && !weatherParts) return null;
    return { locationParts, weatherParts };
  }, [entry]);

  async function handleSave(): Promise<void> {
    if (!uuid || !text.trim()) {
      setError("Entry text is required.");
      return;
    }

    setSaving(true);
    setError("");
    setConflict(false);
    try {
      const updated = await updateEntry(uuid, {
        text: text.trim(),
        tags,
        timezone,
        created_at: localDateTimeToIso(createdAtLocal),
        expected_version: version,
      });
      setVersion(updated.version);
      setEntry(updated);

      if (newFiles.length > 0) {
        for (const file of newFiles) {
          const key = mediaUploadKey(file);
          setProgressByKey((prev) => ({ ...prev, [key]: 0 }));
          await uploadEntryMedia(uuid, file, (percent) => {
            setProgressByKey((prev) => ({ ...prev, [key]: percent }));
          });
          setProgressByKey((prev) => ({ ...prev, [key]: 100 }));
        }
        setNewFiles([]);
        await load();
      }
    } catch (err) {
      const status = (err as Error & { status?: number }).status;
      if (status === 409) {
        setConflict(true);
        setError("Version conflict. Reload this entry to apply your changes on the latest version.");
      } else {
        setError(String(err));
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteEntry(): Promise<void> {
    if (!uuid || !confirm("Delete this entry?")) return;
    setDeleting(true);
    try {
      await deleteEntry(uuid);
      navigate("/journal");
    } catch (err) {
      setError(String(err));
      setDeleting(false);
    }
  }

  async function handleDeleteMedia(id: number): Promise<void> {
    setDeletingMediaId(id);
    try {
      await deleteEntryMedia(id);
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setDeletingMediaId(null);
    }
  }

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto px-3 sm:px-4 py-8">
        <div className="text-center py-16 text-text-muted">Loading...</div>
      </div>
    );
  }

  if (!entry) {
    return (
      <div className="max-w-3xl mx-auto px-3 sm:px-4 py-8">
        <div className="text-red-600 dark:text-red-400 text-sm bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg px-4 py-3 mb-4">
          {error || "Entry not found."}
        </div>
        <Link to="/journal" className="text-pine-600 dark:text-pine-400 hover:underline text-sm">
          Back to journal
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto sm:px-4 py-8">
      <div className="flex items-center justify-between mb-6 px-3 sm:px-0">
        <div className="flex items-center gap-3">
          <Link
            to="/journal"
            className="text-text-muted text-xl leading-none hover:text-text-primary transition-colors"
          >
            &larr;
          </Link>
          <h1 className="text-xl font-semibold text-text-primary">Edit Entry</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || !text.trim()}
            className="px-4 py-2 rounded-lg bg-pine-600 dark:bg-pine-500 text-white text-sm font-medium hover:bg-pine-700 dark:hover:bg-pine-400 transition-colors disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save"}
          </button>
          <button
            type="button"
            onClick={() => void handleDeleteEntry()}
            disabled={deleting}
            className="px-4 py-2 rounded-lg text-red-600 dark:text-red-400 border border-red-300 dark:border-red-700 text-sm font-medium hover:bg-red-600 hover:text-white dark:hover:bg-red-500 transition-colors disabled:opacity-50"
          >
            {deleting ? "Deleting..." : "Delete"}
          </button>
        </div>
      </div>

      {error && (
        <div className="text-red-600 dark:text-red-400 text-sm bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg px-4 py-3 mb-4 mx-3 sm:mx-0">
          {error}
          {conflict && (
            <button
              type="button"
              onClick={() => void load()}
              className="ml-2 underline font-medium"
            >
              Reload
            </button>
          )}
        </div>
      )}

      <div className="space-y-5">
        <MarkdownEditor value={text} onChange={setText} />

        <div className="flex items-center gap-2 text-sm text-text-muted px-3 sm:px-0">
          {editingDate ? (
            <input
              id="entry-edit-date"
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
              id="entry-edit-timezone"
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

        <div className="px-3 sm:px-0">
          <label htmlFor="entry-edit-tags" className="block text-sm text-text-muted mb-1.5 font-medium">
            Tags
          </label>
          <TagInput id="entry-edit-tags" tags={tags} onChange={setTags} suggestions={tagSuggestions} />
        </div>

        {dayOneMetadata && (
          <div className="rounded-lg border border-border bg-surface p-4 mx-3 sm:mx-0">
            <h2 className="text-sm font-semibold text-text-primary mb-2">
              Day One Metadata (read-only)
            </h2>
            {dayOneMetadata.locationParts && (
              <p className="text-sm text-text-muted">Location: {dayOneMetadata.locationParts}</p>
            )}
            {dayOneMetadata.weatherParts && (
              <p className="text-sm text-text-muted mt-1">Weather: {dayOneMetadata.weatherParts}</p>
            )}
          </div>
        )}

        <div className="px-3 sm:px-0">
          <h2 className="block text-sm text-text-muted mb-1.5 font-medium">Current Photos</h2>
          <MediaGallery
            media={entry.media}
            onDelete={handleDeleteMedia}
            deletingId={deletingMediaId}
          />
        </div>

        <div className="px-3 sm:px-0">
          <h2 className="block text-sm text-text-muted mb-1.5 font-medium">Upload More Photos</h2>
          <MediaUpload
            files={newFiles}
            onChange={setNewFiles}
            progressByKey={progressByKey}
            disabled={saving}
          />
        </div>
      </div>
    </div>
  );
}
