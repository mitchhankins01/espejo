import { useEffect, useState } from "react";
import { listTemplates, type EntryTemplate } from "../api.ts";

export function TemplatePicker({
  selectedId,
  onSelect,
}: {
  selectedId?: string | null;
  onSelect: (template: EntryTemplate | null) => void;
}) {
  const [templates, setTemplates] = useState<EntryTemplate[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listTemplates()
      .then((items) => setTemplates(items))
      .catch(() => setTemplates([]))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="rounded-lg border border-border bg-surface p-3 text-sm text-text-muted">
        Loading templates...
      </div>
    );
  }

  if (templates.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface p-3 text-sm text-text-muted">
        No templates yet.
      </div>
    );
  }

  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      <button
        type="button"
        onClick={() => onSelect(null)}
        className={`min-w-[160px] rounded-lg border px-3 py-2 text-left transition-colors ${
          !selectedId
            ? "border-pine-500 bg-pine-600/10"
            : "border-border bg-surface hover:bg-surface-elevated"
        }`}
      >
        <div className="text-sm font-semibold text-text-primary">Blank</div>
        <div className="text-xs text-text-muted mt-1">Start from scratch</div>
      </button>
      {templates.map((template) => (
        <button
          key={template.id}
          type="button"
          onClick={() => onSelect(template)}
          className={`min-w-[220px] rounded-lg border px-3 py-2 text-left transition-colors ${
            selectedId === template.id
              ? "border-pine-500 bg-pine-600/10"
              : "border-border bg-surface hover:bg-surface-elevated"
          }`}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-semibold text-text-primary truncate">
              {template.name}
            </div>
            <span className="text-[11px] text-text-muted">#{template.sort_order}</span>
          </div>
          {template.description && (
            <div className="text-xs text-text-muted mt-1 line-clamp-2">
              {template.description}
            </div>
          )}
        </button>
      ))}
    </div>
  );
}
