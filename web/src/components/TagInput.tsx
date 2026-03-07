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

  const allTags = [
    ...tags.slice().sort((a, b) => a.localeCompare(b)),
    ...available.sort((a, b) => a.localeCompare(b)),
  ];

  return (
    <div>
      {allTags.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {allTags.map((tag) => {
            const selected = tags.includes(tag);
            return (
              <button
                key={tag}
                type="button"
                onClick={() => (selected ? removeTag(tag) : addTag(tag))}
                aria-label={selected ? `Remove tag ${tag}` : `Add tag ${tag}`}
                className={`px-3 py-1 rounded-full text-sm font-medium transition-colors cursor-pointer ${
                  selected
                    ? "bg-pine-600 text-white dark:bg-pine-500 dark:text-white hover:bg-pine-700 dark:hover:bg-pine-600"
                    : "bg-transparent text-text-muted border border-border hover:border-pine-500 hover:text-pine-700 dark:hover:text-pine-300"
                }`}
              >
                {tag}
              </button>
            );
          })}
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
        placeholder="Create new tag..."
        className="w-full px-2.5 py-1.5 rounded-lg border border-border bg-surface text-text-primary placeholder:text-text-muted/40 focus:outline-none focus:ring-2 focus:ring-pine-500/30 focus:border-pine-500 text-sm"
      />
    </div>
  );
}
