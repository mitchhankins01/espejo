import { useState, useRef } from "react";

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
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = input.trim()
    ? suggestions.filter(
        (s) => s.includes(input.trim().toLowerCase()) && !tags.includes(s)
      )
    : [];

  function addTag(value?: string) {
    const tag = (value ?? input).trim().toLowerCase();
    if (tag && !tags.includes(tag)) {
      onChange([...tags, tag]);
    }
    setInput("");
    setShowSuggestions(false);
    setSelectedIdx(-1);
  }

  function removeTag(tag: string) {
    onChange(tags.filter((t) => t !== tag));
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" && filtered.length > 0) {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp" && filtered.length > 0) {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      if (selectedIdx >= 0 && selectedIdx < filtered.length) {
        addTag(filtered[selectedIdx]);
      } else {
        addTag();
      }
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
      setSelectedIdx(-1);
    }
  }

  return (
    <div className="relative">
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
      <input
        ref={inputRef}
        id={id}
        value={input}
        onChange={(e) => {
          setInput(e.target.value);
          setShowSuggestions(true);
          setSelectedIdx(-1);
        }}
        onFocus={() => setShowSuggestions(true)}
        onBlur={() => setShowSuggestions(false)}
        onKeyDown={handleKeyDown}
        placeholder="Add tag and press Enter"
        className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary placeholder:text-text-muted/60 focus:outline-none focus:ring-2 focus:ring-pine-500/30 focus:border-pine-500 text-base"
      />
      {showSuggestions && filtered.length > 0 && (
        <ul className="absolute z-10 mt-1 w-full max-h-48 overflow-auto rounded-lg border border-border bg-surface shadow-lg">
          {filtered.map((s, i) => (
            <li
              key={s}
              onMouseDown={(e) => {
                e.preventDefault();
                addTag(s);
              }}
              className={`px-3 py-2 text-sm cursor-pointer ${
                i === selectedIdx
                  ? "bg-pine-500/15 text-pine-700 dark:text-pine-300"
                  : "text-text-primary hover:bg-pine-500/10"
              }`}
            >
              {s}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
