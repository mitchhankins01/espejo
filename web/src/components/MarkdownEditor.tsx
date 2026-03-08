import {
  MDXEditor,
  headingsPlugin,
  listsPlugin,
  quotePlugin,
  thematicBreakPlugin,
  markdownShortcutPlugin,
  toolbarPlugin,
  BoldItalicUnderlineToggles,
  BlockTypeSelect,
  ListsToggle,
  CreateLink,
  linkPlugin,
  linkDialogPlugin,
  codeBlockPlugin,
  codeMirrorPlugin,
  InsertCodeBlock,
  type MDXEditorMethods,
} from "@mdxeditor/editor";
import "@mdxeditor/editor/style.css";
import { useRef, useEffect, useMemo, useState } from "react";
import { listArtifactTitles, type ArtifactTitle } from "../api.ts";
import { ARTIFACT_BADGE_COLORS } from "../constants/artifacts.ts";

const TITLE_CACHE_TTL_MS = 30_000;
const titleCache: { fetchedAt: number; items: ArtifactTitle[] } = {
  fetchedAt: 0,
  items: [],
};

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  readOnly?: boolean;
  enableArtifactLinks?: boolean;
}

export function MarkdownEditor({
  value,
  onChange,
  placeholder,
  readOnly,
  enableArtifactLinks = false,
}: MarkdownEditorProps) {
  const editorRef = useRef<MDXEditorMethods>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [pickerIndex, setPickerIndex] = useState(0);
  const [titles, setTitles] = useState<ArtifactTitle[]>([]);

  useEffect(() => {
    if (editorRef.current) {
      const current = editorRef.current.getMarkdown();
      if (current !== value) {
        editorRef.current.setMarkdown(value);
      }
    }
  }, [value]);

  useEffect(() => {
    if (!pickerOpen) return;
    const onClickOutside = (event: MouseEvent) => {
      if (!pickerRef.current) return;
      if (!pickerRef.current.contains(event.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [pickerOpen]);

  async function loadTitles(): Promise<void> {
    if (Date.now() - titleCache.fetchedAt > TITLE_CACHE_TTL_MS) {
      titleCache.items = await listArtifactTitles();
      titleCache.fetchedAt = Date.now();
    }
    setTitles(titleCache.items);
  }

  async function openPicker(): Promise<void> {
    setPickerOpen(true);
    setPickerQuery("");
    setPickerIndex(0);
    try {
      await loadTitles();
    } catch {
      setTitles([]);
    }
  }

  function insertWikiLink(title: string): void {
    const current = editorRef.current?.getMarkdown() ?? value;
    const token = `[[${title}]]`;
    const next = current.trim().length === 0 ? token : `${current}\n${token}`;
    editorRef.current?.setMarkdown(next);
    onChange(next);
    setPickerOpen(false);
  }

  const filteredTitles = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase();
    if (!q) return titles.slice(0, 12);
    return titles
      .filter((item) => item.title.toLowerCase().includes(q))
      .slice(0, 12);
  }, [titles, pickerQuery]);

  useEffect(() => {
    if (pickerIndex >= filteredTitles.length) {
      setPickerIndex(0);
    }
  }, [pickerIndex, filteredTitles.length]);

  return (
    <div className="mdx-editor-wrapper border border-border rounded-lg overflow-hidden min-h-[300px] relative">
      <MDXEditor
        ref={editorRef}
        markdown={value}
        onChange={onChange}
        placeholder={placeholder}
        readOnly={readOnly}
        plugins={[
          headingsPlugin(),
          listsPlugin(),
          quotePlugin(),
          thematicBreakPlugin(),
          linkPlugin(),
          linkDialogPlugin(),
          codeBlockPlugin({ defaultCodeBlockLanguage: "" }),
          codeMirrorPlugin({
            codeBlockLanguages: {
              "": "Plain",
              js: "JavaScript",
              ts: "TypeScript",
              python: "Python",
              sql: "SQL",
              bash: "Bash",
            },
          }),
          markdownShortcutPlugin(),
          ...(readOnly
            ? []
            : [
                toolbarPlugin({
                  toolbarContents: () => (
                    <>
                      <BlockTypeSelect />
                      <BoldItalicUnderlineToggles />
                      <ListsToggle />
                      <CreateLink />
                      <InsertCodeBlock />
                      {enableArtifactLinks && (
                        <button
                          type="button"
                          onClick={() => void openPicker()}
                          className="ml-1 px-2 py-1 text-xs rounded border border-border hover:bg-surface"
                        >
                          [[]]
                        </button>
                      )}
                    </>
                  ),
                }),
              ]),
        ]}
      />
      {pickerOpen && (
        <div
          ref={pickerRef}
          className="absolute top-12 right-3 w-72 rounded-lg border border-border bg-surface shadow-xl p-2 z-20"
        >
          <div className="text-xs font-medium text-text-muted mb-2 px-1">
            Link Artifact
          </div>
          <input
            autoFocus
            value={pickerQuery}
            onChange={(e) => setPickerQuery(e.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setPickerOpen(false);
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                setPickerIndex((i) => Math.min(i + 1, filteredTitles.length - 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setPickerIndex((i) => Math.max(i - 1, 0));
              } else if (event.key === "Enter" && filteredTitles[pickerIndex]) {
                event.preventDefault();
                insertWikiLink(filteredTitles[pickerIndex].title);
              }
            }}
            placeholder="Search artifact title..."
            className="w-full mb-2 px-2.5 py-2 rounded-md border border-border bg-surface-alt text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-pine-500/30 focus:border-pine-500"
          />
          <div className="max-h-56 overflow-y-auto">
            {filteredTitles.length === 0 ? (
              <div className="px-2 py-2 text-sm text-text-muted">
                No matching artifacts
              </div>
            ) : (
              filteredTitles.map((item, index) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => insertWikiLink(item.title)}
                  className={`w-full text-left px-2 py-1.5 rounded-md flex items-center gap-2 text-sm ${
                    index === pickerIndex
                      ? "bg-pine-600/15 text-text-primary"
                      : "hover:bg-surface-alt text-text-primary"
                  }`}
                >
                  <span
                    className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide ${
                      ARTIFACT_BADGE_COLORS[item.kind]
                    }`}
                  >
                    {item.kind}
                  </span>
                  <span className="truncate">{item.title}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
