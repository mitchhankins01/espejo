import { useState } from "react";

export function TagInput({
  id,
  tags,
  onChange,
  suggestions = [],
}: {
  id?: string;
  tags: string[];
  onChange: (tags: string[]) => void;
  suggestions?: string[];
}) {
  const [input, setInput] = useState("");

  const available = suggestions.filter((s) => !tags.includes(s));

  function addTag(value?: string) {
    const tag = (value ?? input).trim().toLowerCase();
    if (tag && !tags.includes(tag)) {
      onChange([...tags, tag]);
    }
    setInput("");
  }

  function removeTag(tag: string) {
    onChange(tags.filter((t) => t !== tag));
  }

  return (
    <div>
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {tags.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => removeTag(tag)}
              aria-label={`Remove tag ${tag}`}
              className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-pine-500/10 text-pine-700 dark:text-pine-300 border border-transparent hover:border-red-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors cursor-pointer"
            >
              {tag} <span className="text-[10px]">&times;</span>
            </button>
          ))}
        </div>
      )}
      {available.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {available.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => addTag(tag)}
              className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-surface-elevated text-text-muted border border-border hover:border-pine-500 hover:text-pine-700 dark:hover:text-pine-300 transition-colors cursor-pointer"
            >
              + {tag}
            </button>
          ))}
        </div>
      )}
      <input
        id={id}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            addTag();
          }
        }}
        placeholder="New tag..."
        className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary placeholder:text-text-muted/60 focus:outline-none focus:ring-2 focus:ring-pine-500/30 focus:border-pine-500 text-base"
      />
    </div>
  );
}
